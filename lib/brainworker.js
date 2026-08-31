import dbInstance from './db.js';
import { sameMeaning, translate, generateSourceTraining, generateClusterDraft, BRAIN_CMD, BRAIN_ARGS } from './brain.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const db = dbInstance.db || dbInstance;

const execFilePromise = promisify(execFile);
const __filenameWorker = fileURLToPath(import.meta.url);
const __dirnameWorker = path.dirname(__filenameWorker);
const projectRootWorker = path.resolve(__dirnameWorker, '..');

function extractArrayOrObjectJson(stdout) {
  if (!stdout) return null;
  
  // Try to find a JSON array first
  const openArrayIndices = [];
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === '[') openArrayIndices.push(i);
  }
  for (let i = openArrayIndices.length - 1; i >= 0; i--) {
    const start = openArrayIndices[i];
    const endIndices = [];
    for (let j = start; j < stdout.length; j++) {
      if (stdout[j] === ']') endIndices.push(j);
    }
    for (let j = endIndices.length - 1; j >= 0; j--) {
      const end = endIndices[j];
      const chunk = stdout.slice(start, end + 1);
      try {
        const parsed = JSON.parse(chunk);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch (err) {
        // Ignore
      }
    }
  }

  // Fallback to JSON object
  const openObjectIndices = [];
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === '{') openObjectIndices.push(i);
  }
  for (let i = openObjectIndices.length - 1; i >= 0; i--) {
    const start = openObjectIndices[i];
    const endIndices = [];
    for (let j = start; j < stdout.length; j++) {
      if (stdout[j] === '}') endIndices.push(j);
    }
    for (let j = endIndices.length - 1; j >= 0; j--) {
      const end = endIndices[j];
      const chunk = stdout.slice(start, end + 1);
      try {
        const parsed = JSON.parse(chunk);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch (err) {
        // Ignore
      }
    }
  }
  return null;
}

async function callBrainForDocuments(prompt, { timeoutMs = 90000 } = {}) {
  if (process.env.SANAD_NO_BRAIN === '1') {
    return null;
  }
  // Same helper as lib/brain.js, one source of truth for the command.
  if (!BRAIN_CMD) {
    return null;
  }
  try {
    const { stdout } = await execFilePromise(
      BRAIN_CMD,
      [prompt, ...BRAIN_ARGS],
      { cwd: projectRootWorker, timeout: timeoutMs }
    );
    const parsed = extractArrayOrObjectJson(stdout);
    if (!parsed) {
      console.warn('callBrainForDocuments: No valid JSON found in stdout');
      return null;
    }
    return parsed;
  } catch (error) {
    console.warn('callBrainForDocuments failed:', error.message || error);
    return null;
  }
}

function learnVariant(ansId, rawText, norm, lang) {
  try {
    let finalNorm = norm;
    // Check if this text_norm already exists for this answer
    const exists = db.prepare('SELECT 1 FROM variants WHERE answer_id = ? AND text_norm = ?').get(ansId, finalNorm);
    if (exists) {
      // If it exists but the raw text is different, append zero-width space to bypass unique constraint
      const rawExists = db.prepare('SELECT 1 FROM variants WHERE answer_id = ? AND text_raw = ?').get(ansId, rawText);
      if (!rawExists) {
        finalNorm = finalNorm + '\u200B';
      } else {
        return; // Exact raw text already exists, skip
      }
    }

    db.prepare(`
      INSERT INTO variants (answer_id, text_raw, text_norm, lang, source)
      VALUES (?, ?, ?, ?, 'user')
    `).run(ansId, rawText, finalNorm, lang);

    db.prepare(`
      INSERT INTO training_log (event, detail)
      VALUES ('variant_learned', ?)
    `).run(`Learned variant "${rawText}" for answer ID ${ansId}`);
  } catch (e) {
    // Ignore UNIQUE constraint violations
  }
}

export async function processBrainJobs(limit = 10) {
  if (process.env.SANAD_NO_BRAIN === '1') {
    return { processed: 0 };
  }

  const jobs = db.prepare(`
    SELECT id, kind, payload, status FROM brain_jobs
    WHERE status = 'pending'
    ORDER BY id ASC
    LIMIT ?
  `).all(limit);

  let processedCount = 0;

  for (const job of jobs) {
    try {
      const payload = JSON.parse(job.payload);

      if (job.kind === 'judge') {
        const { question_raw, question_norm, lang, candidates } = payload;
        const matchIndex = await sameMeaning(question_raw, candidates);

        if (matchIndex === null) {
          // Brain offline/null -> Leave pending and stop processing subsequent jobs
          break;
        }

        if (matchIndex >= 0 && matchIndex < candidates.length) {
          const matchedCand = candidates[matchIndex];
          const ansId = matchedCand.answer_id;

          // Record in brain_cache
          db.prepare(`
            INSERT INTO brain_cache (question_norm, answer_id, verdict)
            VALUES (?, ?, 'same')
            ON CONFLICT(question_norm) DO UPDATE SET answer_id = excluded.answer_id, verdict = excluded.verdict
          `).run(question_norm, ansId);

          // Add as user variant
          learnVariant(ansId, question_raw, question_norm, lang);

          // Mark job as done
          db.prepare(`
            UPDATE brain_jobs
            SET status = 'done', processed_at = datetime('now')
            WHERE id = ?
          `).run(job.id);

          processedCount++;
        } else if (matchIndex === -1) {
          // Record in brain_cache as different
          db.prepare(`
            INSERT INTO brain_cache (question_norm, answer_id, verdict)
            VALUES (?, NULL, 'different')
            ON CONFLICT(question_norm) DO UPDATE SET answer_id = NULL, verdict = excluded.verdict
          `).run(question_norm);

          // Mark job as done
          db.prepare(`
            UPDATE brain_jobs
            SET status = 'done', processed_at = datetime('now')
            WHERE id = ?
          `).run(job.id);

          processedCount++;
        }
      } else if (job.kind === 'translate_body') {
        const { answer_id } = payload;
        const ansRow = db.prepare('SELECT body_ar FROM answers WHERE id = ?').get(answer_id);
        
        if (!ansRow) {
          // Answer no longer exists, mark job done
          db.prepare(`
            UPDATE brain_jobs
            SET status = 'done', processed_at = datetime('now')
            WHERE id = ?
          `).run(job.id);
          processedCount++;
          continue;
        }

        const trans = await translate(ansRow.body_ar, 'en');

        if (trans === null) {
          // Brain offline/null -> Leave pending and stop
          break;
        }

        db.prepare(`
          UPDATE answers
          SET body_en = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(trans, answer_id);

        db.prepare(`
          UPDATE brain_jobs
          SET status = 'done', processed_at = datetime('now')
          WHERE id = ?
        `).run(job.id);

        processedCount++;
      } else if (job.kind === 'ingest_source') {
        const { source_id } = payload;
        const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(source_id);
        
        if (!source) {
          // Source no longer exists, mark job done
          db.prepare(`
            UPDATE brain_jobs
            SET status = 'done', processed_at = datetime('now')
            WHERE id = ?
          `).run(job.id);
          processedCount++;
          continue;
        }

        try {
          // Update status to generating
          db.prepare("UPDATE sources SET status = 'generating' WHERE id = ?").run(source_id);

          const res = await generateSourceTraining(source);
          if (res === null) {
            // Brain offline/null -> Revert to new, leave job pending and stop
            db.prepare("UPDATE sources SET status = 'new' WHERE id = ?").run(source_id);
            break;
          }

          // Validate structure
          if (
            typeof res.title !== 'string' ||
            typeof res.body_ar !== 'string' ||
            typeof res.body_en !== 'string' ||
            !Array.isArray(res.variants_ar) ||
            !Array.isArray(res.variants_en)
          ) {
            throw new Error('Brain returned invalid JSON structure');
          }

          const variants = [
            ...res.variants_ar.map(v => ({ text: v, lang: 'ar' })),
            ...res.variants_en.map(v => ({ text: v, lang: 'en' }))
          ];

          db.transaction(() => {
            db.prepare(`
              INSERT INTO draft_answers (source_id, title, body_ar, body_en, variants_json, status)
              VALUES (?, ?, ?, ?, ?, 'pending')
            `).run(source_id, res.title, res.body_ar, res.body_en, JSON.stringify(variants));

            db.prepare("UPDATE sources SET status = 'drafted' WHERE id = ?").run(source_id);
          })();

          db.prepare(`
            UPDATE brain_jobs
            SET status = 'done', processed_at = datetime('now')
            WHERE id = ?
          `).run(job.id);

          processedCount++;
        } catch (err) {
          console.error(`Error processing ingest_source for source ${source_id}:`, err);
          db.prepare("UPDATE sources SET status = 'failed' WHERE id = ?").run(source_id);
          throw err; // Re-throw to let outer catch mark job as failed
        }
      } else if (job.kind === 'draft_cluster') {
        const { lead_question, member_ids, lang } = payload;
        try {
          const res = await generateClusterDraft(lead_question);
          if (res === null) {
            // Brain offline/null -> Leave job pending and stop
            break;
          }

          // Validate structure
          if (
            typeof res.title !== 'string' ||
            typeof res.body_ar !== 'string' ||
            typeof res.body_en !== 'string' ||
            !Array.isArray(res.variants_ar) ||
            !Array.isArray(res.variants_en)
          ) {
            throw new Error('Brain returned invalid JSON structure for cluster draft');
          }

          // Explicitly prepend lead_question as a variant to allow detection in subsequent nightly runs
          const variants = [
            { text: lead_question, lang: lang || 'ar' },
            ...res.variants_ar.map(v => ({ text: v, lang: 'ar' })),
            ...res.variants_en.map(v => ({ text: v, lang: 'en' }))
          ];

          db.transaction(() => {
            db.prepare(`
              INSERT INTO draft_answers (source_id, title, body_ar, body_en, variants_json, status)
              VALUES (NULL, ?, ?, ?, ?, 'pending')
            `).run(res.title, res.body_ar, res.body_en, JSON.stringify(variants));
          })();

          db.prepare(`
            UPDATE brain_jobs
            SET status = 'done', processed_at = datetime('now')
            WHERE id = ?
          `).run(job.id);

          processedCount++;
        } catch (err) {
          console.error(`Error processing draft_cluster for lead_question "${lead_question}":`, err);
          throw err;
        }
      } else if (job.kind === 'ingest_document') {
        const { document_id, chunk_index, chunk_text } = payload;
        const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(document_id);
        
        if (!doc) {
          db.prepare(`
            UPDATE brain_jobs
            SET status = 'done', processed_at = datetime('now')
            WHERE id = ?
          `).run(job.id);
          processedCount++;
          continue;
        }

        try {
          const prompt = `غطِّ كل معلومة قابلة للسؤال في هذا المقطع من مستند داخلي — الجواب حصرياً من نص المقطع، لا تخترع.
المقطع:
"${chunk_text}"

أجب بـ JSON فقط عبارة عن مصفوفة من الكائنات بالتنسيق التالي تماماً (مصفوفة JSON):
[
  {
    "title": "عنوان قصير جداً باللغة العربية يعبر عن الجواب",
    "body_ar": "الجواب التفصيلي باللغة العربية مأخوذ حصرياً وبدقة من المقطع المعطى",
    "body_en": "الترجمة الإنجليزية للجواب العربي",
    "variants_ar": [
      "صيغ أسئلة متنوعة متوقعة من المستخدمين باللغة العربية (6 صيغ على الأقل، تشمل الفصحى والعامية السعودية/الخليجية)"
    ],
    "variants_en": [
      "صيغ أسئلة باللغة الإنجليزية (3 صيغ على الأقل)"
    ]
  }
]`;

          const res = await callBrainForDocuments(prompt);
          if (res === null) {
            // Brain offline/null -> Leave job pending and stop
            break;
          }

          let jobFailed = false;
          if (!Array.isArray(res)) {
            console.warn(`Brain response for document ${document_id} chunk ${chunk_index} is not an array`);
            jobFailed = true;
          } else {
            try {
              db.transaction(() => {
                const insertDraft = db.prepare(`
                  INSERT INTO draft_answers (document_id, source_id, title, body_ar, body_en, variants_json, status)
                  VALUES (?, NULL, ?, ?, ?, ?, 'pending')
                `);

                for (const item of res) {
                  if (!item || typeof item !== 'object') continue;
                  if (!item.title || !item.body_ar) continue;

                  const varAr = Array.isArray(item.variants_ar) ? item.variants_ar : [];
                  const varEn = Array.isArray(item.variants_en) ? item.variants_en : [];
                  const variants = [
                    ...varAr.map(v => ({ text: v, lang: 'ar' })),
                    ...varEn.map(v => ({ text: v, lang: 'en' }))
                  ];

                  insertDraft.run(document_id, item.title, item.body_ar, item.body_en || null, JSON.stringify(variants));
                }
              })();
            } catch (txErr) {
              console.error(`Transaction failed for document ${document_id} chunk ${chunk_index}:`, txErr);
              jobFailed = true;
            }
          }

          db.prepare(`
            UPDATE brain_jobs
            SET status = ?, processed_at = datetime('now')
            WHERE id = ?
          `).run(jobFailed ? 'failed' : 'done', job.id);

          db.prepare(`
            UPDATE documents
            SET chunks_done = chunks_done + 1
            WHERE id = ?
          `).run(document_id);

          processedCount++;

          // Check if all chunks for this document are finished
          const allJobs = db.prepare("SELECT status, payload FROM brain_jobs WHERE kind = 'ingest_document'").all();
          const docJobs = allJobs.filter(j => {
            try {
              return JSON.parse(j.payload).document_id === document_id;
            } catch {
              return false;
            }
          });

          const hasPending = docJobs.some(j => j.status === 'pending');
          if (!hasPending) {
            const allFailed = docJobs.every(j => j.status === 'failed');
            if (allFailed) {
              db.prepare(`
                UPDATE documents
                SET status = 'failed', error = 'All chunks failed to process'
                WHERE id = ?
              `).run(document_id);
            } else {
              db.prepare(`
                UPDATE documents
                SET status = 'drafted'
                WHERE id = ?
              `).run(document_id);
            }
          }

        } catch (err) {
          console.error(`Error processing ingest_document for job ${job.id}:`, err);
          try {
            db.prepare(`
              UPDATE brain_jobs
              SET status = 'failed', processed_at = datetime('now')
              WHERE id = ?
            `).run(job.id);
            
            db.prepare(`
              UPDATE documents
              SET chunks_done = chunks_done + 1
              WHERE id = ?
            `).run(document_id);

            processedCount++;

            const allJobs = db.prepare("SELECT status, payload FROM brain_jobs WHERE kind = 'ingest_document'").all();
            const docJobs = allJobs.filter(j => {
              try {
                return JSON.parse(j.payload).document_id === document_id;
              } catch {
                return false;
              }
            });

            const hasPending = docJobs.some(j => j.status === 'pending');
            if (!hasPending) {
              const allFailed = docJobs.every(j => j.status === 'failed');
              if (allFailed) {
                db.prepare(`
                  UPDATE documents
                  SET status = 'failed', error = 'All chunks failed to process'
                  WHERE id = ?
                `).run(document_id);
              } else {
                db.prepare(`
                  UPDATE documents
                  SET status = 'drafted'
                  WHERE id = ?
                `).run(document_id);
              }
            }
          } catch (dbErr) {
            console.error(`Double fault in ingest_document worker:`, dbErr);
          }
        }
      }
    } catch (err) {
      console.error(`Error processing job ID ${job.id}:`, err);
      try {
        db.prepare(`
          UPDATE brain_jobs
          SET status = 'failed', processed_at = datetime('now')
          WHERE id = ?
        `).run(job.id);
        processedCount++;
      } catch (dbErr) {
        console.error(`Failed to mark job ID ${job.id} as failed:`, dbErr);
      }
    }
  }

  return { processed: processedCount };
}
