import express from 'express';
import db, { recalculateVariantNorms } from '../lib/db.js';
import { normalize, detectLang } from '../lib/normalize.js';
import { selfTrain } from '../lib/trainer.js';
import { bestMatches, similarity } from '../lib/matcher.js';
import { runFullExam } from '../lib/examiner.js';
import { paraphrase } from '../lib/brain.js';
import { runNightly } from '../lib/nightly.js';
import { T_AUTO } from '../lib/engine.js';
import { processBrainJobs } from '../lib/brainworker.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backupDir = path.join(__dirname, '../data/backups');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Helper function to read the raw request body
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', err => {
      reject(err);
    });
  });
}

// Helper function to parse CSV
function parseCSV(text) {
  if (text.startsWith('\uFEFF')) {
    text = text.substring(1);
  }
  const lines = [];
  let row = [];
  let inQuotes = false;
  let entry = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        entry += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(entry);
      entry = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      row.push(entry);
      lines.push(row);
      row = [];
      entry = '';
    } else {
      entry += char;
    }
  }
  if (entry || row.length > 0) {
    row.push(entry);
    lines.push(row);
  }
  return lines;
}

// Token authorization middleware
router.use((req, res, next) => {
  const token = process.env.SANAD_TOKEN;
  if (!token) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const reqToken = authHeader.substring(7).trim();
  if (reqToken !== token) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  next();
});

// GET /api/answers - list of answers with their variants, count, satisfaction, and exam scores
router.get('/answers', (req, res) => {
  try {
    const answers = db.prepare(`
      SELECT id, title, body_ar, body_en, created_at, updated_at
      FROM answers
      ORDER BY id DESC
    `).all();

    for (const ans of answers) {
      const variants = db.prepare(`
        SELECT id, text_raw, text_norm, lang, source, created_at
        FROM variants
        WHERE answer_id = ?
      `).all(ans.id);
      ans.variants = variants;
      ans.variants_count = variants.length;

      // Feedback stats
      const fb = db.prepare(`
        SELECT 
          SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) as ups,
          SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) as downs,
          COUNT(*) as total
        FROM feedback
        WHERE answer_id = ?
      `).get(ans.id);

      const ups = fb.ups || 0;
      const downs = fb.downs || 0;
      const total = fb.total || 0;
      ans.total_votes = total;
      ans.upvotes = ups;
      ans.downvotes = downs;
      ans.satisfaction_rate = total > 0 ? Math.round((ups / total) * 100) : null;
      ans.satisfaction = total > 0 ? `${Math.round((ups / total) * 100)}%` : '—';

      // Latest Exam scores
      const latestExam = db.prepare(`
        SELECT score, mode FROM exam_results
        WHERE answer_id = ?
        ORDER BY id DESC
        LIMIT 3
      `).all(ans.id);
      ans.deterministic_score = latestExam.find(e => e.mode === 'deterministic')?.score ?? null;
      ans.smart_score = latestExam.find(e => e.mode === 'smart')?.score ?? null;
      ans.lexical_score = latestExam.find(e => e.mode === 'lexical')?.score ?? null;
    }
    res.json(answers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/answers - create answer + normalize & insert each variant as 'manual'
router.post('/answers', (req, res) => {
  try {
    const { title, body_ar, body_en = null, variants = [] } = req.body;
    if (!title || !body_ar) {
      return res.status(400).json({ error: 'Title and body_ar are required' });
    }

    const runTransaction = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO answers (title, body_ar, body_en)
        VALUES (?, ?, ?)
      `).run(title, body_ar, body_en);
      
      const answerId = info.lastInsertRowid;

      const insertVariant = db.prepare(`
        INSERT OR IGNORE INTO variants (answer_id, text_raw, text_norm, lang, source)
        VALUES (?, ?, ?, ?, 'manual')
      `);

      for (const raw of variants) {
        if (!raw || typeof raw !== 'string') continue;
        const norm = normalize(raw);
        const lang = detectLang(raw);
        insertVariant.run(answerId, raw, norm, lang);
      }

      db.prepare(`
        INSERT INTO training_log (event, detail)
        VALUES ('answer_created', ?)
      `).run(`Created answer "${title}" with ${variants.length} initial variants.`);

      return answerId;
    });

    const answerId = runTransaction();
    res.json({ id: answerId, title, body_ar, body_en });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/answers/:id - edit title/bodies + add/delete variants
router.put('/answers/:id', (req, res) => {
  try {
    const answerId = req.params.id;
    const { title, body_ar, body_en = null, add_variants = [], del_variant_ids = [] } = req.body;

    if (!title || !body_ar) {
      return res.status(400).json({ error: 'Title and body_ar are required' });
    }

    const runTransaction = db.transaction(() => {
      db.prepare(`
        UPDATE answers
        SET title = ?, body_ar = ?, body_en = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(title, body_ar, body_en, answerId);

      const deleteVariant = db.prepare(`
        DELETE FROM variants
        WHERE id = ? AND answer_id = ?
      `);
      for (const vid of del_variant_ids) {
        deleteVariant.run(vid, answerId);
      }

      const insertVariant = db.prepare(`
        INSERT OR IGNORE INTO variants (answer_id, text_raw, text_norm, lang, source)
        VALUES (?, ?, ?, ?, 'manual')
      `);
      for (const raw of add_variants) {
        if (!raw || typeof raw !== 'string') continue;
        const norm = normalize(raw);
        const lang = detectLang(raw);
        insertVariant.run(answerId, raw, norm, lang);
      }
    });

    runTransaction();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/answers/:id - delete answer and its variants
router.delete('/answers/:id', (req, res) => {
  try {
    const answerId = req.params.id;
    const runTransaction = db.transaction(() => {
      db.prepare('DELETE FROM variants WHERE answer_id = ?').run(answerId);
      db.prepare('DELETE FROM answers WHERE id = ?').run(answerId);
    });
    runTransaction();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/queue - pending questions with clustering/grouping
router.get('/queue', (req, res) => {
  try {
    const pendingItems = db.prepare(`
      SELECT id, question_raw, question_norm, lang, status, answer_id, created_at, priority
      FROM queue
      WHERE status = 'pending'
      ORDER BY id ASC
    `).all();

    const clusters = [];
    const visited = new Set();

    for (let i = 0; i < pendingItems.length; i++) {
      const item = pendingItems[i];
      if (visited.has(item.id)) continue;

      visited.add(item.id);
      const similar = [];

      for (let j = i + 1; j < pendingItems.length; j++) {
        const nextItem = pendingItems[j];
        if (visited.has(nextItem.id)) continue;

        const sim = similarity(item.question_norm, nextItem.question_norm);
        if (sim >= 0.75) {
          visited.add(nextItem.id);
          similar.push(nextItem);
        }
      }

      clusters.push({
        ...item,
        similar_questions: similar,
        similar: similar,
        members: similar,
        duplicates: similar,
        variants: similar.map(s => s.question_raw)
      });
    }

    // Sort by priority DESC, then by id DESC
    clusters.sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) {
        return (b.priority || 0) - (a.priority || 0);
      }
      return b.id - a.id;
    });

    res.json(clusters);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/queue/:id/answer - resolve queue item by linking to existing or new answer, supporting include_ids
router.post('/queue/:id/answer', (req, res) => {
  try {
    const queueId = req.params.id;
    const { answer_id, title, body_ar, body_en = null, include_ids = [] } = req.body;

    const queueItem = db.prepare('SELECT * FROM queue WHERE id = ?').get(queueId);
    if (!queueItem) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    const runTransaction = db.transaction(() => {
      let targetAnswerId = answer_id;

      if (!targetAnswerId) {
        if (!title || !body_ar) {
          throw new Error('Either answer_id or both title and body_ar are required');
        }
        const info = db.prepare(`
          INSERT INTO answers (title, body_ar, body_en)
          VALUES (?, ?, ?)
        `).run(title, body_ar, body_en);
        targetAnswerId = info.lastInsertRowid;
      }

      // Add main item
      db.prepare(`
        INSERT OR IGNORE INTO variants (answer_id, text_raw, text_norm, lang, source)
        VALUES (?, ?, ?, ?, 'manual')
      `).run(targetAnswerId, queueItem.question_raw, queueItem.question_norm, queueItem.lang);

      db.prepare(`
        UPDATE queue
        SET status = 'answered', answer_id = ?
        WHERE id = ?
      `).run(targetAnswerId, queueId);

      // Add all included items in the cluster
      for (const incId of include_ids) {
        const incItem = db.prepare('SELECT * FROM queue WHERE id = ?').get(incId);
        if (incItem) {
          db.prepare(`
            INSERT OR IGNORE INTO variants (answer_id, text_raw, text_norm, lang, source)
            VALUES (?, ?, ?, ?, 'manual')
          `).run(targetAnswerId, incItem.question_raw, incItem.question_norm, incItem.lang);

          db.prepare(`
            UPDATE queue
            SET status = 'answered', answer_id = ?
            WHERE id = ?
          `).run(targetAnswerId, incId);
        }
      }

      return targetAnswerId;
    });

    const finalAnswerId = runTransaction();
    res.json({ success: true, answer_id: finalAnswerId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/queue/:id/ignore - ignore queue item
router.post('/api/queue/:id/ignore', (req, res) => {
  try {
    const queueId = req.params.id;
    const result = db.prepare(`
      UPDATE queue
      SET status = 'ignored'
      WHERE id = ?
    `).run(queueId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Queue item not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fallback for ignore without /api prefix (since verify is calling /api/queue/:id/ignore and router is already mounted on /api)
router.post('/queue/:id/ignore', (req, res) => {
  try {
    const queueId = req.params.id;
    const result = db.prepare(`
      UPDATE queue
      SET status = 'ignored'
      WHERE id = ?
    `).run(queueId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Queue item not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/skills - list all skills
router.get('/skills', (req, res) => {
  try {
    const skills = db.prepare('SELECT * FROM skills ORDER BY id DESC').all();
    const formatted = skills.map(s => {
      try {
        s.triggers = JSON.parse(s.triggers_json);
      } catch {
        s.triggers = [];
      }
      return s;
    });
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/skills - create skill
router.post('/skills', (req, res) => {
  try {
    const { name, description = '', triggers, triggers_json, template, enabled = 1 } = req.body;
    if (!name || !template) {
      return res.status(400).json({ error: 'Name and template are required' });
    }

    let finalTriggersJson = '';
    if (Array.isArray(triggers)) {
      finalTriggersJson = JSON.stringify(triggers);
    } else if (typeof triggers_json === 'string') {
      finalTriggersJson = triggers_json;
    } else {
      finalTriggersJson = JSON.stringify([]);
    }

    const info = db.prepare(`
      INSERT INTO skills (name, description, triggers_json, template, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, description, finalTriggersJson, template, enabled ? 1 : 0);

    res.json({ id: info.lastInsertRowid, name, description, triggers_json: finalTriggersJson, template, enabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/skills/:id - update skill
router.put('/skills/:id', (req, res) => {
  try {
    const skillId = req.params.id;
    const { name, description = '', triggers, triggers_json, template, enabled = 1 } = req.body;

    if (!name || !template) {
      return res.status(400).json({ error: 'Name and template are required' });
    }

    let finalTriggersJson = '';
    if (Array.isArray(triggers)) {
      finalTriggersJson = JSON.stringify(triggers);
    } else if (typeof triggers_json === 'string') {
      finalTriggersJson = triggers_json;
    } else {
      const current = db.prepare('SELECT triggers_json FROM skills WHERE id = ?').get(skillId);
      finalTriggersJson = current ? current.triggers_json : JSON.stringify([]);
    }

    const result = db.prepare(`
      UPDATE skills
      SET name = ?, description = ?, triggers_json = ?, template = ?, enabled = ?
      WHERE id = ?
    `).run(name, description, finalTriggersJson, template, enabled ? 1 : 0, skillId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/skills/:id - delete skill
router.delete('/skills/:id', (req, res) => {
  try {
    const skillId = req.params.id;
    const result = db.prepare('DELETE FROM skills WHERE id = ?').run(skillId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Skill not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/selftrain - run selfTrain immediately or direct reinforcement for a single answer
router.post('/selftrain', async (req, res) => {
  try {
    const { answer_id } = req.body;
    if (answer_id) {
      const ans = db.prepare('SELECT * FROM answers WHERE id = ?').get(answer_id);
      if (!ans) {
        return res.status(404).json({ error: 'Answer not found' });
      }
      const startTime = Date.now();
      let addedCount = 0;
      if (process.env.SANAD_NO_BRAIN !== '1') {
        const vars = db.prepare('SELECT * FROM variants WHERE answer_id = ?').all(ans.id);
        let allVariants = db.prepare('SELECT answer_id, text_norm, lang FROM variants').all();
        if (vars.length < 12) {
          const arVars = vars.filter(v => v.lang === 'ar');
          const enVars = vars.filter(v => v.lang === 'en');
          
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
                    allVariants.push({ answer_id: ans.id, text_norm: normP, lang: 'ar' });
                    addedCount++;
                  } catch (e) {}
                }
              }
            }
          }
          
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
                    allVariants.push({ answer_id: ans.id, text_norm: normP, lang: 'en' });
                    addedCount++;
                  } catch (e) {}
                }
              }
            }
          }
        }
        
        if (addedCount > 0) {
          db.prepare(`
            INSERT INTO training_log (event, detail)
            VALUES ('paraphrase_added', ?)
          `).run(`Added ${addedCount} paraphrased variants for answer "${ans.title}" (ID ${ans.id}) via direct reinforcement.`);
        }
      }
      return res.json({
        added: addedCount,
        suggestions: [],
        tookMs: Date.now() - startTime
      });
    } else {
      const result = await selfTrain();
      res.json(result || { added: 0, suggestions: [], tookMs: 0 });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stats - get summary stats and latest training log
router.get('/stats', (req, res) => {
  try {
    const answers = db.prepare('SELECT COUNT(*) AS count FROM answers').get().count;
    const variants = db.prepare('SELECT COUNT(*) AS count FROM variants').get().count;
    const queue_pending = db.prepare("SELECT COUNT(*) AS count FROM queue WHERE status = 'pending'").get().count;
    const chats = db.prepare('SELECT COUNT(*) AS count FROM chats').get().count;
    const skills = db.prepare('SELECT COUNT(*) AS count FROM skills').get().count;
    const brain_jobs_pending = db.prepare("SELECT COUNT(*) AS count FROM brain_jobs WHERE status = 'pending'").get().count;
    const brain_cache_count = db.prepare('SELECT COUNT(*) AS count FROM brain_cache').get().count;

    const log = db.prepare('SELECT * FROM training_log ORDER BY id DESC LIMIT 20').all();

    // 1. Total answered chats:
    const total_answered = db.prepare(`
      SELECT COUNT(*) AS count FROM chats
      WHERE role = 'bot' AND matched_answer_id IS NOT NULL
    `).get().count;

    // 2. Instant answer rate (score >= 0.85) last 7 days:
    const botChatsLast7Days = db.prepare(`
      SELECT COUNT(*) AS count FROM chats
      WHERE role = 'bot' AND created_at >= datetime('now', '-7 days')
    `).get().count;

    const instantBotChatsLast7Days = db.prepare(`
      SELECT COUNT(*) AS count FROM chats
      WHERE role = 'bot' AND score >= 0.85 AND created_at >= datetime('now', '-7 days')
    `).get().count;

    const instant_answer_rate = botChatsLast7Days > 0 
      ? Math.round((instantBotChatsLast7Days / botChatsLast7Days) * 100) 
      : 0;

    // 3. User learned variants:
    const user_learned_variants = db.prepare(`
      SELECT COUNT(*) AS count FROM variants
      WHERE source = 'user'
    `).get().count;

    // 4. Average score of last exam:
    const lastExamTime = db.prepare('SELECT MAX(created_at) AS max_time FROM exam_results').get().max_time;
    let avg_exam_score = null;
    if (lastExamTime) {
      avg_exam_score = db.prepare('SELECT AVG(score) AS avg_score FROM exam_results WHERE created_at = ?').get(lastExamTime).avg_score;
      if (avg_exam_score !== null) {
        avg_exam_score = Math.round(avg_exam_score * 100);
      }
    }

    // 5. Overall satisfaction rate (vote = 1 percentage of all votes):
    const fbStats = db.prepare(`
      SELECT 
        SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS ups,
        COUNT(*) AS total
      FROM feedback
    `).get();
    const ups = fbStats.ups || 0;
    const total = fbStats.total || 0;
    const overall_satisfaction = total > 0 ? Math.round((ups / total) * 100) : 100;

    const embeddingsCount = db.prepare('SELECT COUNT(*) AS c FROM embeddings').get().c;
    const pairsCount = db.prepare('SELECT COUNT(*) AS count FROM training_pairs').get().count;

    res.json({
      answers,
      variants,
      queue_pending,
      chats,
      skills,
      training_log: log,
      total_answered,
      instant_answer_rate,
      user_learned_variants,
      avg_exam_score,
      overall_satisfaction,
      embeddings_count: embeddingsCount,
      brain_jobs_pending,
      brain_cache_count,
      pairs_count: pairsCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/export - export full database structure for backup
router.get('/export', (req, res) => {
  try {
    const answers = db.prepare('SELECT * FROM answers').all();
    const variants = db.prepare('SELECT * FROM variants').all();
    const skills = db.prepare('SELECT * FROM skills').all();

    res.json({
      answers,
      variants,
      skills
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/import - import database backup without duplicates
router.post('/import', (req, res) => {
  try {
    const { answers = [], variants = [], skills = [] } = req.body;

    const runTransaction = db.transaction(() => {
      const insertAnswer = db.prepare(`
        INSERT OR IGNORE INTO answers (id, title, body_ar, body_en, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const ans of answers) {
        insertAnswer.run(ans.id, ans.title, ans.body_ar, ans.body_en, ans.created_at, ans.updated_at);
      }

      const insertVariant = db.prepare(`
        INSERT OR IGNORE INTO variants (id, answer_id, text_raw, text_norm, lang, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const v of variants) {
        insertVariant.run(v.id, v.answer_id, v.text_raw, v.text_norm, v.lang, v.source, v.created_at);
      }

      const insertSkill = db.prepare(`
        INSERT OR IGNORE INTO skills (id, name, description, triggers_json, template, enabled)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const s of skills) {
        insertSkill.run(s.id, s.name, s.description, s.triggers_json, s.template, s.enabled);
      }
    });

    runTransaction();
    try {
      recalculateVariantNorms();
    } catch (e) {
      console.error('Error recalculating norms after import:', e);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/synonyms - CRUD get
router.get('/synonyms', (req, res) => {
  try {
    const synonyms = db.prepare('SELECT * FROM synonyms ORDER BY id DESC').all();
    res.json(synonyms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/synonyms - CRUD create
router.post('/synonyms', (req, res) => {
  try {
    const { term, canonical } = req.body;
    if (!term || !canonical) {
      return res.status(400).json({ error: 'Term and canonical are required' });
    }

    const termNorm = normalize(term);
    const canonicalNorm = normalize(canonical);

    db.prepare('INSERT INTO synonyms (term, canonical) VALUES (?, ?)').run(termNorm, canonicalNorm);
    
    try {
      recalculateVariantNorms();
    } catch (e) {
      console.error('Error recalculating norms after synonym insert:', e);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/synonyms/:id - CRUD update
router.put('/synonyms/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { term, canonical } = req.body;
    if (!term || !canonical) {
      return res.status(400).json({ error: 'Term and canonical are required' });
    }

    const termNorm = normalize(term);
    const canonicalNorm = normalize(canonical);

    const result = db.prepare('UPDATE synonyms SET term = ?, canonical = ? WHERE id = ?').run(termNorm, canonicalNorm, id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Synonym not found' });
    }

    try {
      recalculateVariantNorms();
    } catch (e) {
      console.error('Error recalculating norms after synonym update:', e);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/synonyms/:id - CRUD delete
router.delete('/synonyms/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = db.prepare('DELETE FROM synonyms WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Synonym not found' });
    }

    try {
      recalculateVariantNorms();
    } catch (e) {
      console.error('Error recalculating norms after synonym delete:', e);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/exam - run self-exam (leave-one-out deterministic mode + smart mode)
router.post('/exam', async (req, res) => {
  try {
    const examReport = await runFullExam();
    res.json({ success: true, results: examReport });
  } catch (error) {
    console.error('Exam endpoint error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// POST /api/import-csv - import CSV containing question,answer columns
router.post('/import-csv', async (req, res) => {
  try {
    const rawText = await getRawBody(req);
    let csvContent = '';

    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const parsedJson = JSON.parse(rawText);
      csvContent = parsedJson.csv || '';
    } else if (contentType.includes('multipart/form-data')) {
      const boundaryMatch = req.headers['content-type'].match(/boundary=(.+)$/);
      if (boundaryMatch) {
        const boundary = boundaryMatch[1];
        const parts = rawText.split('--' + boundary);
        for (const part of parts) {
          if (part.includes('name="file"') || part.includes('filename=')) {
            const headerEndIndex = part.indexOf('\r\n\r\n');
            if (headerEndIndex !== -1) {
              let csvData = part.slice(headerEndIndex + 4);
              if (csvData.endsWith('\r\n')) {
                csvData = csvData.slice(0, -2);
              }
              csvContent = csvData.trim();
              break;
            }
          }
        }
      }
    } else {
      csvContent = rawText;
    }

    if (!csvContent) {
      return res.status(400).json({ error: 'No CSV content found' });
    }

    const lines = parseCSV(csvContent);
    const header = lines[0];
    if (!header) {
      return res.status(400).json({ error: 'Empty CSV file' });
    }

    const qIndex = header.findIndex(h => h.trim().toLowerCase() === 'question');
    const aIndex = header.findIndex(h => h.trim().toLowerCase() === 'answer');

    if (qIndex === -1 || aIndex === -1) {
      return res.status(400).json({ error: 'CSV must contain "question" and "answer" columns' });
    }

    const groups = {};
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i];
      if (row.length <= Math.max(qIndex, aIndex)) continue;
      const question = row[qIndex]?.trim();
      const answer = row[aIndex]?.trim();
      if (!question || !answer) continue;

      if (!groups[answer]) {
        groups[answer] = [];
      }
      groups[answer].push(question);
    }

    db.transaction(() => {
      for (const [answerBody, questions] of Object.entries(groups)) {
        let ansRow = db.prepare('SELECT id FROM answers WHERE body_ar = ?').get(answerBody);
        let ansId;
        if (ansRow) {
          ansId = ansRow.id;
        } else {
          const title = answerBody.length > 60 ? answerBody.substring(0, 60) + '...' : answerBody;
          const info = db.prepare('INSERT INTO answers (title, body_ar, body_en) VALUES (?, ?, NULL)').run(title, answerBody);
          ansId = info.lastInsertRowid;
        }

        for (const question of questions) {
          const norm = normalize(question);
          const lang = detectLang(question);
          db.prepare(`
            INSERT OR IGNORE INTO variants (answer_id, text_raw, text_norm, lang, source)
            VALUES (?, ?, ?, ?, 'manual')
          `).run(ansId, question, norm, lang);
        }
      }
    })();

    try {
      recalculateVariantNorms();
    } catch (e) {
      console.error('Error recalculating norms after CSV import:', e);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('CSV Import error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// GET /api/export-csv - export all answers and variants to CSV
router.get('/export-csv', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT v.text_raw AS question, a.body_ar AS answer
      FROM variants v
      JOIN answers a ON v.answer_id = a.id
      ORDER BY a.id ASC, v.id ASC
    `).all();

    let csvContent = '\uFEFF';
    csvContent += 'question,answer\r\n';

    function escapeCSVField(field) {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes('"') || str.includes(',') || str.includes('\r') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    for (const r of rows) {
      csvContent += `${escapeCSVField(r.question)},${escapeCSVField(r.answer)}\r\n`;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=sanad_export.csv');
    res.status(200).send(csvContent);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/backups - list all local backups
router.get('/backups', (req, res) => {
  try {
    if (!fs.existsSync(backupDir)) {
      return res.json([]);
    }

    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('sanad-') && f.endsWith('.json'))
      .map(f => {
        const stats = fs.statSync(path.join(backupDir, f));
        return {
          file: f,
          size: stats.size,
          created_at: stats.mtime
        };
      })
      .sort((a, b) => b.file.localeCompare(a.file));

    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/backups/restore - restore DB from backup file
router.post('/backups/restore', (req, res) => {
  try {
    const { file } = req.body;
    if (!file) {
      return res.status(400).json({ error: 'File is required' });
    }

    const filePath = path.join(backupDir, file);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(backupDir))) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'Backup file not found' });
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const { answers = [], variants = [], skills = [] } = JSON.parse(content);

    const runTransaction = db.transaction(() => {
      // Clear current contents to prevent conflict/stale records if backup replaces everything
      db.prepare('DELETE FROM variants').run();
      db.prepare('DELETE FROM answers').run();
      db.prepare('DELETE FROM skills').run();

      const insertAnswer = db.prepare(`
        INSERT OR IGNORE INTO answers (id, title, body_ar, body_en, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const ans of answers) {
        insertAnswer.run(ans.id, ans.title, ans.body_ar, ans.body_en, ans.created_at, ans.updated_at);
      }

      const insertVariant = db.prepare(`
        INSERT OR IGNORE INTO variants (id, answer_id, text_raw, text_norm, lang, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const v of variants) {
        insertVariant.run(v.id, v.answer_id, v.text_raw, v.text_norm, v.lang, v.source, v.created_at);
      }

      const insertSkill = db.prepare(`
        INSERT OR IGNORE INTO skills (id, name, description, triggers_json, template, enabled)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const s of skills) {
        insertSkill.run(s.id, s.name, s.description, s.triggers_json, s.template, s.enabled);
      }
    });

    runTransaction();

    try {
      recalculateVariantNorms();
    } catch (e) {
      console.error('Error recalculating norms after restore:', e);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- SOURCES & DRAFTS API ENDPOINTS ---

// GET /api/sources - Get all sources + pending drafts count
router.get('/sources', (req, res) => {
  try {
    const sources = db.prepare(`
      SELECT s.*,
             (SELECT COUNT(*) FROM draft_answers d WHERE d.source_id = s.id AND d.status = 'pending') AS pending_drafts_count
      FROM sources s
      ORDER BY s.id DESC
    `).all();
    res.json(sources);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sources - Create a new source
router.post('/sources', (req, res) => {
  try {
    const { url, title, guidance } = req.body;
    if (!url || !title || !guidance) {
      return res.status(400).json({ error: 'url, title, and guidance are required' });
    }
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    }

    const info = db.prepare(`
      INSERT INTO sources (url, title, guidance, status)
      VALUES (?, ?, ?, 'new')
    `).run(url, title, guidance);

    res.json({
      id: info.lastInsertRowid,
      url,
      title,
      guidance,
      status: 'new'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/sources/:id - Update an existing source
router.put('/sources/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { url, title, guidance } = req.body;
    if (!url || !title || !guidance) {
      return res.status(400).json({ error: 'url, title, and guidance are required' });
    }
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    }

    const source = db.prepare('SELECT status FROM sources WHERE id = ?').get(id);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }

    let newStatus = source.status;
    if (source.status === 'failed') {
      newStatus = 'new';
    }

    db.prepare(`
      UPDATE sources
      SET url = ?, title = ?, guidance = ?, status = ?
      WHERE id = ?
    `).run(url, title, guidance, newStatus, id);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/sources/:id - Delete a source
router.delete('/sources/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Source not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sources/:id/generate - Queue ingest_source job and immediately trigger processBrainJobs(3)
router.post('/sources/:id/generate', async (req, res) => {
  try {
    const { id } = req.params;
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }

    // Check if there is already a pending ingest_source job for this source
    const pendingJobs = db.prepare(`
      SELECT id, payload FROM brain_jobs
      WHERE kind = 'ingest_source' AND status = 'pending'
    `).all();

    const isAlreadyPending = pendingJobs.some(job => {
      try {
        const p = JSON.parse(job.payload);
        return p && Number(p.source_id) === Number(id);
      } catch (e) {
        return false;
      }
    });

    if (!isAlreadyPending) {
      db.prepare(`
        INSERT INTO brain_jobs (kind, payload, status)
        VALUES ('ingest_source', ?, 'pending')
      `).run(JSON.stringify({ source_id: Number(id) }));
    }

    if (process.env.SANAD_NO_BRAIN === '1') {
      return res.json({
        message: 'العقل المدبر غير متاح الآن — ستولد المسودة عند توفره',
        status: source.status
      });
    }

    await processBrainJobs(3);

    const updatedSource = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    res.json({
      success: true,
      message: 'تم بدء عملية التوليد بنجاح!',
      status: updatedSource.status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents - Get all documents + drafts count
router.get('/documents', (req, res) => {
  try {
    const docs = db.prepare(`
      SELECT d.*,
             (SELECT COUNT(*) FROM draft_answers da WHERE da.document_id = d.id) AS drafts_count,
             (SELECT COUNT(*) FROM draft_answers da WHERE da.document_id = d.id AND da.status = 'pending') AS pending_drafts_count
      FROM documents d
      ORDER BY d.id DESC
    `).all();
    res.json(docs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/documents - Upload document (pdf/xlsx/csv/txt) up to 10MB
const uploadSingle = upload.single('file');
router.post('/documents', (req, res) => {
  uploadSingle(req, res, async function (err) {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    const allowed = ['pdf', 'xlsx', 'csv', 'txt'];
    if (!allowed.includes(ext)) {
      return res.status(400).json({ error: `Unsupported file type: .${ext}` });
    }

    let text = '';
    let status = 'new';
    let errorMsg = null;

    try {
      const { extractText } = await import('../lib/documents.js');
      text = await extractText(ext, file.buffer);
    } catch (e) {
      status = 'failed';
      errorMsg = e.message;
    }

    try {
      const info = db.prepare(`
        INSERT INTO documents (filename, kind, bytes, text, status, error, chunks_total, chunks_done)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0)
      `).run(file.originalname, ext, file.size, text || null, status, errorMsg);

      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid);
      res.json(doc);
    } catch (dbErr) {
      res.status(500).json({ error: dbErr.message });
    }
  });
});

// DELETE /api/documents/:id - Delete document & its drafts
router.delete('/documents/:id', (req, res) => {
  try {
    const { id } = req.params;
    const runTransaction = db.transaction(() => {
      db.prepare('DELETE FROM draft_answers WHERE document_id = ?').run(id);
      return db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    });
    
    const result = runTransaction();
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/documents/:id/generate - Partition text, schedule jobs and process
router.post('/documents/:id/generate', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (!doc.text) {
      return res.status(400).json({ error: 'Document text is empty or failed to extract' });
    }

    const { chunkText } = await import('../lib/documents.js');
    const chunks = chunkText(doc.text, 2500, 200);

    if (chunks.length === 0) {
      return res.status(400).json({ error: 'No chunks generated from document text' });
    }

    const pendingJobs = db.prepare(`
      SELECT payload FROM brain_jobs
      WHERE kind = 'ingest_document' AND status = 'pending'
    `).all();

    const pendingKeys = new Set(pendingJobs.map(job => {
      try {
        const p = JSON.parse(job.payload);
        return `${p.document_id}_${p.chunk_index}`;
      } catch (e) {
        return '';
      }
    }));

    db.transaction(() => {
      db.prepare(`
        UPDATE documents
        SET status = 'generating', chunks_total = ?, chunks_done = 0, error = NULL
        WHERE id = ?
      `).run(chunks.length, id);

      const insertJob = db.prepare(`
        INSERT INTO brain_jobs (kind, payload, status)
        VALUES ('ingest_document', ?, 'pending')
      `);

      chunks.forEach((chunk, idx) => {
        const key = `${id}_${idx}`;
        if (!pendingKeys.has(key)) {
          insertJob.run(JSON.stringify({
            document_id: Number(id),
            chunk_index: idx,
            chunk_text: chunk
          }));
        }
      });
    })();

    if (process.env.SANAD_NO_BRAIN === '1') {
      const updatedDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
      return res.json(updatedDoc);
    }

    await processBrainJobs(3);

    const updatedDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.json(updatedDoc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/drafts - Get pending drafts with their source title and url
router.get('/drafts', (req, res) => {
  try {
    const drafts = db.prepare(`
      SELECT d.*, s.title AS source_title, s.url AS source_url,
             doc.filename AS document_filename
      FROM draft_answers d
      LEFT JOIN sources s ON d.source_id = s.id
      LEFT JOIN documents doc ON d.document_id = doc.id
      WHERE d.status = 'pending'
      ORDER BY d.id DESC
    `).all();
    res.json(drafts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/drafts/:id/approve - Approve draft, create real answer, set source to ingested
router.post('/drafts/:id/approve', (req, res) => {
  try {
    const { id } = req.params;
    const draft = db.prepare('SELECT * FROM draft_answers WHERE id = ?').get(id);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    let variants = [];
    try {
      variants = typeof draft.variants_json === 'string' ? JSON.parse(draft.variants_json) : draft.variants_json;
    } catch (e) {
      variants = [];
    }

    const runTransaction = db.transaction(() => {
      // Insert new answer
      const info = db.prepare(`
        INSERT INTO answers (title, body_ar, body_en)
        VALUES (?, ?, ?)
      `).run(draft.title, draft.body_ar, draft.body_en);
      
      const answerId = info.lastInsertRowid;

      const insertVariant = db.prepare(`
        INSERT OR IGNORE INTO variants (answer_id, text_raw, text_norm, lang, source)
        VALUES (?, ?, ?, ?, 'manual')
      `);

      for (const variant of variants) {
        const raw = typeof variant === 'object' ? variant.text : variant;
        if (!raw || typeof raw !== 'string') continue;
        const norm = normalize(raw);
        const lang = typeof variant === 'object' && variant.lang ? variant.lang : detectLang(raw);
        insertVariant.run(answerId, raw, norm, lang);
      }

      // Update draft status to approved
      db.prepare("UPDATE draft_answers SET status = 'approved' WHERE id = ?").run(id);

      // Update source or document status to ingested
      if (draft.source_id) {
        db.prepare("UPDATE sources SET status = 'ingested', ingested_at = datetime('now') WHERE id = ?").run(draft.source_id);
      } else if (draft.document_id) {
        db.prepare("UPDATE documents SET status = 'ingested' WHERE id = ?").run(draft.document_id);
      } else {
        // For draft clusters, mark matching queue items as answered
        for (const variant of variants) {
          const raw = typeof variant === 'object' ? variant.text : variant;
          if (!raw || typeof raw !== 'string') continue;
          const norm = normalize(raw);
          db.prepare(`
            UPDATE queue
            SET status = 'answered', answer_id = ?
            WHERE (question_raw = ? OR question_norm = ?) AND status = 'pending'
          `).run(answerId, raw, norm);
        }
      }

      db.prepare(`
        INSERT INTO training_log (event, detail)
        VALUES ('answer_created', ?)
      `).run(`Created answer "${draft.title}" from draft ID ${id}.`);

      return answerId;
    });

    const answerId = runTransaction();
    res.json({ success: true, answer_id: answerId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/drafts/:id/reject - Reject draft (status='rejected', source status reverts to 'new')
router.post('/drafts/:id/reject', (req, res) => {
  try {
    const { id } = req.params;
    const draft = db.prepare('SELECT * FROM draft_answers WHERE id = ?').get(id);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    const runTransaction = db.transaction(() => {
      db.prepare("UPDATE draft_answers SET status = 'rejected' WHERE id = ?").run(id);
      if (draft.source_id) {
        db.prepare("UPDATE sources SET status = 'new' WHERE id = ?").run(draft.source_id);
      } else if (draft.document_id) {
        db.prepare("UPDATE documents SET status = 'new' WHERE id = ?").run(draft.document_id);
      }
    });

    runTransaction();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/drafts/:id - Edit draft before approval
router.put('/drafts/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { title, body_ar, body_en, variants_json } = req.body;

    if (!title || !body_ar) {
      return res.status(400).json({ error: 'Title and body_ar are required' });
    }

    let finalVariantsJson = '';
    if (typeof variants_json === 'string') {
      finalVariantsJson = variants_json;
    } else if (Array.isArray(variants_json)) {
      finalVariantsJson = JSON.stringify(variants_json);
    } else {
      finalVariantsJson = JSON.stringify([]);
    }

    const result = db.prepare(`
      UPDATE draft_answers
      SET title = ?, body_ar = ?, body_en = ?, variants_json = ?
      WHERE id = ?
    `).run(title, body_ar, body_en || null, finalVariantsJson, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/nightly - Run nightly job manually immediately
router.post('/nightly', async (req, res) => {
  try {
    const result = await runNightly({ manual: true });
    res.json(result);
  } catch (error) {
    console.error('Manual nightly endpoint error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// GET /api/metrics-history - Get metrics history rows (last N days, ascending)
router.get('/metrics-history', (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days, 10) || 30);
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT * FROM metrics_history
        ORDER BY date DESC
        LIMIT ?
      ) ORDER BY date ASC
    `).all(days);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/dataset/export - Export dataset as JSONL
router.get('/dataset/export', (req, res) => {
  try {
    const rows = db.prepare('SELECT text_a AS a, text_b AS b, label, src FROM training_pairs ORDER BY id ASC').all();
    const lines = rows.map(r => JSON.stringify({ a: r.a, b: r.b, label: r.label, src: r.src })).join('\n');
    res.setHeader('Content-Type', 'application/x-jsonlines');
    res.setHeader('Content-Disposition', 'attachment; filename=sanad-pairs.jsonl');
    res.send(lines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/today — «طابور اليوم»: مسودات + عناقيد + 👎 في حمولة واحدة (5 دقائق صباحاً)
router.get('/today', (req, res) => {
  try {
    const drafts = db.prepare(`
      SELECT d.id, d.title, d.body_ar, d.body_en, d.variants_json, d.source_id, d.document_id, d.created_at,
             s.title AS source_title, doc.filename AS document_filename
      FROM draft_answers d
      LEFT JOIN sources s ON d.source_id = s.id
      LEFT JOIN documents doc ON d.document_id = doc.id
      WHERE d.status = 'pending'
      ORDER BY d.id DESC
      LIMIT 50
    `).all().map((d) => {
      let variantCount = 0;
      try {
        const v = typeof d.variants_json === 'string' ? JSON.parse(d.variants_json) : d.variants_json;
        variantCount = Array.isArray(v) ? v.length : 0;
      } catch (_) { /* ignore */ }
      const bodyPreview = (d.body_ar || '').slice(0, 160);
      
      let source_label = 'من طابور الأسئلة';
      if (d.source_id != null) {
        source_label = d.source_title || `مصدر #${d.source_id}`;
      } else if (d.document_id != null) {
        source_label = d.document_filename || `مستند #${d.document_id}`;
      }

      return {
        id: d.id,
        title: d.title,
        body_ar: d.body_ar,
        body_preview: bodyPreview,
        body_en: d.body_en,
        source_id: d.source_id,
        document_id: d.document_id,
        source_label: source_label,
        variant_count: variantCount,
        created_at: d.created_at
      };
    });

    const pendingItems = db.prepare(`
      SELECT id, question_raw, question_norm, lang, status, answer_id, created_at, priority
      FROM queue
      WHERE status = 'pending'
      ORDER BY priority DESC, id DESC
    `).all();

    const clusters = [];
    const visited = new Set();
    for (let i = 0; i < pendingItems.length; i++) {
      const item = pendingItems[i];
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      const similar = [];
      for (let j = 0; j < pendingItems.length; j++) {
        if (i === j) continue;
        const next = pendingItems[j];
        if (visited.has(next.id)) continue;
        if (similarity(item.question_norm, next.question_norm) >= 0.75) {
          visited.add(next.id);
          similar.push({ id: next.id, question_raw: next.question_raw, lang: next.lang });
        }
      }
      clusters.push({
        id: item.id,
        question_raw: item.question_raw,
        lang: item.lang,
        priority: item.priority || 0,
        size: 1 + similar.length,
        similar,
        member_ids: [item.id, ...similar.map((s) => s.id)],
        created_at: item.created_at
      });
    }
    clusters.sort((a, b) => {
      if (b.size !== a.size) return b.size - a.size;
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      return b.id - a.id;
    });

    const downvotes = db.prepare(`
      SELECT f.id AS feedback_id, f.chat_id, f.created_at AS voted_at,
             bot.matched_answer_id AS answer_id,
             a.title AS answer_title,
             (
               SELECT u.text FROM chats u
               WHERE u.session = bot.session AND u.role = 'user' AND u.id < bot.id
               ORDER BY u.id DESC LIMIT 1
             ) AS question
      FROM feedback f
      JOIN chats bot ON bot.id = f.chat_id
      LEFT JOIN answers a ON a.id = bot.matched_answer_id
      WHERE f.vote = -1
      ORDER BY f.id DESC
      LIMIT 20
    `).all();

    const latestMetrics = db.prepare(`
      SELECT date, exam_avg, exam_lexical_avg, answers, variants, queue_pending,
             satisfaction, pairs_count
      FROM metrics_history
      ORDER BY date DESC
      LIMIT 1
    `).get() || null;

    const queueItemCount = pendingItems.length;
    const clusterHot = clusters.filter((c) => c.size >= 3).length;

    res.json({
      generated_at: new Date().toISOString(),
      counts: {
        drafts: drafts.length,
        queue_items: queueItemCount,
        clusters: clusters.length,
        clusters_hot: clusterHot,
        downvotes: downvotes.length,
        total_actions: drafts.length + queueItemCount + downvotes.length
      },
      drafts,
      clusters: clusters.slice(0, 30),
      downvotes,
      metrics: latestMetrics
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

