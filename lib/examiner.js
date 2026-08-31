import db from './db.js';
import { bestMatches, similarity } from './matcher.js';
import { normalize, detectLang } from './normalize.js';
import { paraphrase } from './brain.js';

export async function runFullExam() {
  const answers = db.prepare('SELECT * FROM answers').all();
  const allVariants = db.prepare(`
    SELECT v.id, v.answer_id, v.text_raw, v.text_norm, v.lang, v.source, a.title
    FROM variants v
    JOIN answers a ON v.answer_id = a.id
  `).all();
  const now = new Date().toISOString();
  const examReport = [];

  for (const ans of answers) {
    const ansVars = allVariants.filter(v => v.answer_id === ans.id);
    
    let detResult = null;
    let lexResult = null;
    let smartResult = null;

    // 1. Deterministic Mode (Leave-One-Out) - requires >= 3 variants
    if (ansVars.length >= 3) {
      const tested = ansVars.length;
      let passed = 0;

      for (const v of ansVars) {
        const customVars = allVariants.filter(cv => cv.id !== v.id);
        const matches = await bestMatches(v.text_norm, v.lang, customVars);
        const topMatch = matches && matches[0] ? matches[0] : null;

        if (topMatch && topMatch.answer_id === ans.id && topMatch.score > 0) {
          passed++;
        }
      }

      const score = passed / tested;
      detResult = { score, tested, passed };

      db.prepare(`
        INSERT INTO exam_results (answer_id, mode, score, tested, passed, created_at)
        VALUES (?, 'deterministic', ?, ?, ?, ?)
      `).run(ans.id, score, tested, passed, now);
    }

    // 1.5 Lexical Mode (Leave-One-Out) - requires >= 3 variants
    if (ansVars.length >= 3) {
      const tested = ansVars.length;
      let passed = 0;

      for (const v of ansVars) {
        const maxScores = {};
        for (const cv of allVariants) {
          if (cv.id === v.id) continue;
          const score = similarity(v.text_norm, cv.text_norm);
          if (maxScores[cv.answer_id] === undefined || score > maxScores[cv.answer_id]) {
            maxScores[cv.answer_id] = score;
          }
        }

        let topAnswerId = null;
        let topScore = -1;
        for (const [aid, score] of Object.entries(maxScores)) {
          if (score > topScore) {
            topScore = score;
            topAnswerId = Number(aid);
          }
        }

        if (topAnswerId === ans.id && topScore > 0) {
          passed++;
        }
      }

      const score = passed / tested;
      lexResult = { score, tested, passed };

      db.prepare(`
        INSERT INTO exam_results (answer_id, mode, score, tested, passed, created_at)
        VALUES (?, 'lexical', ?, ?, ?, ?)
      `).run(ans.id, score, tested, passed, now);
    }

    // 2. Smart Mode - requires brain
    if (process.env.SANAD_NO_BRAIN !== '1') {
      const priority = { manual: 0, user: 1, paraphrase: 2 };
      const sortedVars = [...ansVars].sort((a, b) => {
        if (priority[a.source] !== priority[b.source]) {
          return priority[a.source] - priority[b.source];
        }
        return a.id - b.id;
      });

      const baseText = sortedVars[0] ? sortedVars[0].text_raw : ans.title;
      const baseLang = sortedVars[0] ? sortedVars[0].lang : (detectLang(baseText) || 'ar');

      const paras = await paraphrase(baseText, baseLang, 3);
      if (paras && Array.isArray(paras)) {
        let tested = 0;
        let passed = 0;

        for (const p of paras) {
          const normP = normalize(p);
          const matches = await bestMatches(normP, baseLang, allVariants);
          const topMatch = matches && matches[0] ? matches[0] : null;

          if (topMatch && topMatch.answer_id === ans.id && topMatch.score > 0) {
            passed++;
          }
          tested++;
        }

        if (tested > 0) {
          const score = passed / tested;
          smartResult = { score, tested, passed };

          db.prepare(`
            INSERT INTO exam_results (answer_id, mode, score, tested, passed, created_at)
            VALUES (?, 'smart', ?, ?, ?, ?)
          `).run(ans.id, score, tested, passed, now);
        }
      }
    }

    examReport.push({
      answer_id: ans.id,
      title: ans.title,
      deterministic: detResult,
      lexical: lexResult,
      smart: smartResult,
      score: detResult ? detResult.score : (smartResult ? smartResult.score : null)
    });
  }

  return examReport;
}
