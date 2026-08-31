import dbInstance from './db.js';
import { normalize } from './normalize.js';
import { similarity, bestMatches } from './matcher.js';
import { paraphrase } from './brain.js';
import { processBrainJobs } from './brainworker.js';

const db = dbInstance.db || dbInstance;

/**
 * Executes the self-training loops: paraphrasing, merge detection, and logging.
 * Returns: { added: number, suggestions: any[], tookMs: number }
 */
export async function selfTrain(answerId = null) {
  const startTime = Date.now();
  let addedCount = 0;
  const suggestions = [];

  // If brain is disabled, return immediately
  if (process.env.SANAD_NO_BRAIN === '1') {
    return { added: 0, suggestions: [], tookMs: Date.now() - startTime };
  }

  const answers = answerId
    ? db.prepare('SELECT * FROM answers WHERE id = ?').all(answerId)
    : db.prepare('SELECT * FROM answers').all();

  let allVariants = db.prepare('SELECT answer_id, text_norm, lang FROM variants').all();

  // 1. Variant Expansion
  for (const ans of answers) {
    const vars = db.prepare('SELECT * FROM variants WHERE answer_id = ?').all(ans.id);
    if (vars.length < 12) {
      const arVars = vars.filter(v => v.lang === 'ar');
      const enVars = vars.filter(v => v.lang === 'en');

      // Sort variants so manual ones are prioritized as "best"
      const sortVars = (list) => {
        const priority = { manual: 0, user: 1, paraphrase: 2 };
        return [...list].sort((a, b) => {
          if (priority[a.source] !== priority[b.source]) {
            return priority[a.source] - priority[b.source];
          }
          return a.id - b.id;
        });
      };

      const bestAr = sortVars(arVars)[0];
      const bestEn = sortVars(enVars)[0];

      // Paraphrase best Arabic variant
      if (bestAr) {
        const arParas = await paraphrase(bestAr.text_raw, 'ar', 4);
        if (arParas && Array.isArray(arParas)) {
          for (const p of arParas) {
            const normP = normalize(p);
            if (!normP) continue;

            let isDuplicate = false;
            for (const ext of allVariants) {
              if (similarity(normP, ext.text_norm) >= 0.95) {
                isDuplicate = true;
                break;
              }
            }

            if (!isDuplicate) {
              try {
                db.prepare(`
                  INSERT INTO variants (answer_id, text_raw, text_norm, lang, source)
                  VALUES (?, ?, ?, 'ar', 'paraphrase')
                `).run(ans.id, p, normP);

                allVariants.push({
                  answer_id: ans.id,
                  text_norm: normP,
                  lang: 'ar'
                });
                addedCount++;
              } catch (e) {
                // Ignore unique constraint or DB errors
              }
            }
          }
        }
      }

      // Paraphrase best English variant
      if (bestEn) {
        const enParas = await paraphrase(bestEn.text_raw, 'en', 4);
        if (enParas && Array.isArray(enParas)) {
          for (const p of enParas) {
            const normP = normalize(p);
            if (!normP) continue;

            let isDuplicate = false;
            for (const ext of allVariants) {
              if (similarity(normP, ext.text_norm) >= 0.95) {
                isDuplicate = true;
                break;
              }
            }

            if (!isDuplicate) {
              try {
                db.prepare(`
                  INSERT INTO variants (answer_id, text_raw, text_norm, lang, source)
                  VALUES (?, ?, ?, 'en', 'paraphrase')
                `).run(ans.id, p, normP);

                allVariants.push({
                  answer_id: ans.id,
                  text_norm: normP,
                  lang: 'en'
                });
                addedCount++;
              } catch (e) {
                // Ignore unique constraint or DB errors
              }
            }
          }
        }
      }
    }
  }

  // 2. Suggest merge: Any pair of answers with similar variants (similarity >= 0.9)
  // Reload variants to include newly added ones
  const allVarsForMerge = db.prepare('SELECT answer_id, text_norm, text_raw FROM variants').all();
  const suggestedPairs = new Set();

  for (let i = 0; i < allVarsForMerge.length; i++) {
    for (let j = i + 1; j < allVarsForMerge.length; j++) {
      const v1 = allVarsForMerge[i];
      const v2 = allVarsForMerge[j];

      if (v1.answer_id === v2.answer_id) continue;

      // If answerId is specified, only suggest merges involving this answerId
      if (answerId && v1.answer_id !== answerId && v2.answer_id !== answerId) continue;

      const pairKey = [v1.answer_id, v2.answer_id].sort((a, b) => a - b).join('-');
      if (suggestedPairs.has(pairKey)) continue;

      const sim = similarity(v1.text_norm, v2.text_norm);
      if (sim >= 0.9) {
        suggestedPairs.add(pairKey);

        const title1 = db.prepare('SELECT title FROM answers WHERE id = ?').get(v1.answer_id)?.title || `ID ${v1.answer_id}`;
        const title2 = db.prepare('SELECT title FROM answers WHERE id = ?').get(v2.answer_id)?.title || `ID ${v2.answer_id}`;

        const detail = `Suggest merge between "${title1}" (ID ${v1.answer_id}) and "${title2}" (ID ${v2.answer_id}) due to similar variants: "${v1.text_raw}" and "${v2.text_raw}"`;

        db.prepare(`
          INSERT INTO training_log (event, detail)
          VALUES ('merge_suggested', ?)
        `).run(detail);

        suggestions.push({
          answer_id_1: v1.answer_id,
          answer_id_2: v2.answer_id,
          title1,
          title2,
          detail
        });
      }
    }
  }

  // 3. Log summary
  db.prepare(`
    INSERT INTO training_log (event, detail)
    VALUES ('paraphrase_added', ?)
  `).run(`Added ${addedCount} paraphrased variants`);

  // Enqueue translate_body tasks for any answers missing body_en
  const missingTranslationAnswers = db.prepare(`
    SELECT id FROM answers WHERE body_en IS NULL OR TRIM(body_en) = ''
  `).all();

  for (const ans of missingTranslationAnswers) {
    const payloadStr = JSON.stringify({ answer_id: ans.id });
    const exists = db.prepare(`
      SELECT 1 FROM brain_jobs
      WHERE kind = 'translate_body' AND status = 'pending' AND payload = ?
    `).get(payloadStr);

    if (!exists) {
      db.prepare(`
        INSERT INTO brain_jobs (kind, payload, status)
        VALUES ('translate_body', ?, 'pending')
      `).run(payloadStr);
    }
  }

  // Run the brain worker to process jobs asynchronously
  await processBrainJobs(50);

  const tookMs = Date.now() - startTime;
  return {
    added: addedCount,
    suggestions,
    tookMs
  };
}

/**
 * Clusters queue items with mutual similarity >= 0.75.
 */
export function clusterQueue(items) {
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const clusters = [];

  for (const item of sorted) {
    let matchedCluster = null;
    for (const cluster of clusters) {
      if (similarity(item.question_norm, cluster.question_norm) >= 0.75) {
        matchedCluster = cluster;
        break;
      }
    }

    if (matchedCluster) {
      matchedCluster.similar.push(item);
    } else {
      clusters.push({
        ...item,
        similar: []
      });
    }
  }

  // Sort clusters by ID descending
  return clusters.sort((a, b) => b.id - a.id);
}
