import db from './db.js';
import { selfTrain } from './trainer.js';
import { processBrainJobs } from './brainworker.js';
import { runFullExam } from './examiner.js';
import { similarity } from './matcher.js';
import { sendTelegramMessage } from './telegram.js';

function makeRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

export function buildMorningReport(today, yesterday) {
  const getDiffArrow = (col) => {
    if (!yesterday) return '';
    const vToday = today[col];
    const vYesterday = yesterday[col];
    if (vToday === null || vToday === undefined || vYesterday === null || vYesterday === undefined) return '';
    if (vToday > vYesterday) return ' ↑';
    if (vToday < vYesterday) return ' ↓';
    return '';
  };

  const fmtScore = (v) => {
    if (v === null || v === undefined) return 'N/A';
    return `${Math.round(v * 100)}%`;
  };

  const report = [
    `🌅 تقرير الصباح لـ سَنَد (${today.date}):`,
    `- أسئلة جديدة بالطابور: ${today.queue_pending}${getDiffArrow('queue_pending')}`,
    `- مسودات بانتظار الاعتماد: ${today.drafts_pending || 0}${getDiffArrow('drafts_pending')}`,
    `- درجة الامتحان: ${fmtScore(today.exam_avg)}${getDiffArrow('exam_avg')}`,
    `- جاهزية الصفر المطلق: ${fmtScore(today.exam_lexical_avg)}${getDiffArrow('exam_lexical_avg')}`,
    `- حجم الـDataset: ${today.pairs_count || 0}${getDiffArrow('pairs_count')}`
  ].join('\n');

  return report;
}

export async function runNightly({ manual = false } = {}) {
  // 1. Run selfTrain and processBrainJobs
  try {
    await selfTrain();
  } catch (err) {
    console.error('Nightly: selfTrain failed:', err);
  }

  try {
    await processBrainJobs(100);
  } catch (err) {
    console.error('Nightly: processBrainJobs failed:', err);
  }

  // 2. Cluster queue draft_cluster jobs creation
  try {
    const pendingItems = db.prepare(`
      SELECT id, question_raw, question_norm, lang
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
        lead_question: item.question_raw,
        lead_norm: item.question_norm,
        lang: item.lang,
        member_ids: [item.id, ...similar.map(s => s.id)],
        size: 1 + similar.length
      });
    }

    const largeClusters = clusters.filter(c => c.size >= 3);

    for (const cluster of largeClusters) {
      // Check if there is a pending draft_cluster job for this lead question
      const pendingJobs = db.prepare(`
        SELECT payload FROM brain_jobs
        WHERE kind = 'draft_cluster' AND status = 'pending'
      `).all();

      const hasPendingJob = pendingJobs.some(job => {
        try {
          const p = JSON.parse(job.payload);
          return p.lead_question === cluster.lead_question;
        } catch {
          return false;
        }
      });

      // Check if there is a pending draft with the same lead question
      const pendingDrafts = db.prepare(`
        SELECT variants_json FROM draft_answers
        WHERE source_id IS NULL AND status = 'pending'
      `).all();

      const hasPendingDraft = pendingDrafts.some(d => {
        try {
          const vars = JSON.parse(d.variants_json);
          return vars.some(v => (typeof v === 'object' ? v.text : v) === cluster.lead_question);
        } catch {
          return false;
        }
      });

      if (!hasPendingJob && !hasPendingDraft) {
        const payload = JSON.stringify({
          lead_question: cluster.lead_question,
          member_ids: cluster.member_ids,
          lang: cluster.lang
        });
        db.prepare(`
          INSERT INTO brain_jobs (kind, payload, status)
          VALUES ('draft_cluster', ?, 'pending')
        `).run(payload);
      }
    }
  } catch (err) {
    console.error('Nightly: queue clustering failed:', err);
  }

  // 3. Run exam
  let examReport = [];
  try {
    examReport = await runFullExam();
  } catch (err) {
    console.error('Nightly: runFullExam failed:', err);
  }

  // 4. Rebuild training pairs
  try {
    const answers = db.prepare('SELECT id FROM answers').all();
    const totalVariantsCount = db.prepare('SELECT COUNT(*) AS count FROM variants').get().count;

    for (const ans of answers) {
      const vars = db.prepare('SELECT id, text_raw, source FROM variants WHERE answer_id = ? ORDER BY id DESC').all(ans.id);
      
      // Positive pairs
      const answerPairs = [];
      for (let i = 0; i < vars.length; i++) {
        for (let j = i + 1; j < vars.length; j++) {
          answerPairs.push({ v1: vars[i], v2: vars[j] });
        }
      }
      const latestPairs = answerPairs.slice(0, 30);

      for (const pair of latestPairs) {
        const [text_a, text_b] = [pair.v1.text_raw, pair.v2.text_raw].sort();
        if (text_a === text_b) continue;
        const isDialect = pair.v1.source === 'paraphrase' || pair.v2.source === 'paraphrase';
        const src = isDialect ? 'dialect' : 'variants';
        db.prepare(`
          INSERT OR IGNORE INTO training_pairs (text_a, text_b, label, src)
          VALUES (?, ?, 1, ?)
        `).run(text_a, text_b, src);
      }

      // Negative pairs
      const otherVars = db.prepare('SELECT text_raw FROM variants WHERE answer_id != ?').all(ans.id);
      if (vars.length > 0 && otherVars.length > 0) {
        const seed = vars.length * 7 + totalVariantsCount * 13 + ans.id * 17;
        const rng = makeRandom(seed);
        const numPairs = Math.min(3, vars.length * otherVars.length);
        const chosenPairs = new Set();
        let attempts = 0;

        while (chosenPairs.size < numPairs && attempts < 100) {
          attempts++;
          const myIndex = Math.floor(rng() * vars.length);
          const otherIndex = Math.floor(rng() * otherVars.length);
          const pairKey = `${myIndex}-${otherIndex}`;
          if (!chosenPairs.has(pairKey)) {
            chosenPairs.add(pairKey);
            const vMy = vars[myIndex];
            const vOther = otherVars[otherIndex];
            const [text_a, text_b] = [vMy.text_raw, vOther.text_raw].sort();
            if (text_a === text_b) continue;
            db.prepare(`
              INSERT OR IGNORE INTO training_pairs (text_a, text_b, label, src)
              VALUES (?, ?, 0, 'negative')
            `).run(text_a, text_b);
          }
        }
      }
    }
  } catch (err) {
    console.error('Nightly: rebuildTrainingPairs failed:', err);
  }

  // 5. Upsert metrics history
  let todayMetrics = null;
  try {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const localNow = new Date(now.getTime() - (offset * 60 * 1000));
    const todayStr = localNow.toISOString().split('T')[0];

    // Fetch stats
    const answersCount = db.prepare('SELECT COUNT(*) AS count FROM answers').get().count;
    const variantsCount = db.prepare('SELECT COUNT(*) AS count FROM variants').get().count;
    const queuePendingCount = db.prepare("SELECT COUNT(*) AS count FROM queue WHERE status = 'pending'").get().count;
    const chatsTotalCount = db.prepare('SELECT COUNT(*) AS count FROM chats').get().count;

    const latestExamTime = db.prepare('SELECT MAX(created_at) AS max_time FROM exam_results').get().max_time;
    let exam_avg = null;
    let exam_lexical_avg = null;
    if (latestExamTime) {
      const hybrid = db.prepare("SELECT AVG(score) AS avg_score FROM exam_results WHERE created_at = ? AND mode = 'deterministic'").get(latestExamTime).avg_score;
      if (hybrid !== null) exam_avg = hybrid;
      const lexical = db.prepare("SELECT AVG(score) AS avg_score FROM exam_results WHERE created_at = ? AND mode = 'lexical'").get(latestExamTime).avg_score;
      if (lexical !== null) exam_lexical_avg = lexical;
    }

    const fbStats = db.prepare(`
      SELECT 
        SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS ups,
        COUNT(*) AS total
      FROM feedback
    `).get();
    const satisfaction = fbStats.total > 0 ? (fbStats.ups / fbStats.total) : 1.0;
    const pairs_count = db.prepare('SELECT COUNT(*) AS count FROM training_pairs').get().count;

    db.prepare(`
      INSERT INTO metrics_history (date, exam_avg, exam_lexical_avg, answers, variants, queue_pending, chats_total, satisfaction, pairs_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        exam_avg = excluded.exam_avg,
        exam_lexical_avg = excluded.exam_lexical_avg,
        answers = excluded.answers,
        variants = excluded.variants,
        queue_pending = excluded.queue_pending,
        chats_total = excluded.chats_total,
        satisfaction = excluded.satisfaction,
        pairs_count = excluded.pairs_count,
        created_at = datetime('now')
    `).run(todayStr, exam_avg, exam_lexical_avg, answersCount, variantsCount, queuePendingCount, chatsTotalCount, satisfaction, pairs_count);

    const draftsPending = db.prepare("SELECT COUNT(*) AS count FROM draft_answers WHERE status = 'pending'").get().count;

    todayMetrics = {
      date: todayStr,
      exam_avg,
      exam_lexical_avg,
      answers: answersCount,
      variants: variantsCount,
      queue_pending: queuePendingCount,
      chats_total: chatsTotalCount,
      satisfaction,
      pairs_count,
      drafts_pending: draftsPending
    };
  } catch (err) {
    console.error('Nightly: metrics recording failed:', err);
  }

  // 6. Morning report and Telegram alert
  let reportText = '';
  try {
    if (todayMetrics) {
      // Find yesterday's metrics
      const yesterdayMetrics = db.prepare(`
        SELECT * FROM metrics_history
        WHERE date < ?
        ORDER BY date DESC
        LIMIT 1
      `).get(todayMetrics.date);

      reportText = buildMorningReport(todayMetrics, yesterdayMetrics);

      const token = process.env.SANAD_TG_TOKEN;
      const admin = process.env.SANAD_TG_ADMIN;
      if (token && admin) {
        await sendTelegramMessage(admin, reportText);
      }
    }
  } catch (err) {
    console.error('Nightly: morning report failed:', err);
  }

  return {
    report: reportText,
    metrics: todayMetrics
  };
}
