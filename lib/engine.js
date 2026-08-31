import dbInstance from './db.js';
import { normalize, detectLang } from './normalize.js';
import { bestMatches, similarity, hybridSimilarity } from './matcher.js';
import { matchSkill } from './skills.js';
import { embed } from './embedder.js';

const db = dbInstance.db || dbInstance;

export const T_AUTO = 0.85;
export const T_BRAIN = 0.55;

/**
 * Core answer logic flow.
 * Returns: { reply, matched: {answer_id, title, score} | null, suggestions: string[] | null, queued: boolean, chat_id: number }
 */
export async function answer(sessionId, rawText) {
  // 1. Log the user's message in chats
  db.prepare(`
    INSERT INTO chats (session, role, text, matched_answer_id, score)
    VALUES (?, 'user', ?, NULL, NULL)
  `).run(sessionId, rawText);

  // 2. Detect language and normalize
  const lang = detectLang(rawText);
  const norm = normalize(rawText);

  // 3. Skills check first: if trigger similarity >= T_AUTO, return the skill reply
  if (typeof matchSkill === 'function') {
    const skillResult = matchSkill(norm, rawText);
    if (skillResult) {
      const reply = skillResult.reply;
      // Log the bot's skill reply in chats
      const botInfo = db.prepare(`
        INSERT INTO chats (session, role, text, matched_answer_id, score)
        VALUES (?, 'bot', ?, NULL, NULL)
      `).run(sessionId, reply);

      return {
        reply,
        matched: null,
        suggestions: null,
        queued: false,
        chat_id: botInfo.lastInsertRowid
      };
    }
  }

  // 4. Direct match
  let matches = await bestMatches(norm, lang, null, rawText);
  if (matches && matches.length > 0) {
    matches.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 1e-9) {
        return b.score - a.score;
      }
      return b.answer_id - a.answer_id;
    });
  }
  let bestMatch = matches && matches[0] ? matches[0] : null;

  // Helper function to resolve reply based on language and caching
  function resolveReply(ansId, ansRow) {
    if (lang === 'en') {
      if (ansRow.body_en && ansRow.body_en.trim()) {
        return ansRow.body_en;
      } else {
        const payloadStr = JSON.stringify({ answer_id: ansId });
        const exists = db.prepare(`
          SELECT 1 FROM brain_jobs
          WHERE kind = 'translate_body' AND payload = ? AND status = 'pending'
        `).get(payloadStr);

        if (!exists) {
          db.prepare(`
            INSERT INTO brain_jobs (kind, payload, status)
            VALUES ('translate_body', ?, 'pending')
          `).run(payloadStr);
        }
        return ansRow.body_ar; // Fallback
      }
    }
    return ansRow.body_ar;
  }

  // Helper function to learn the variant
  function learnVariant(ansId) {
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

  // Helper function for unknown question response (score < T_BRAIN)
  function handleUnknown() {
    // Check if consecutive unknown
    const lastBotChat = db.prepare(`
      SELECT text FROM chats
      WHERE session = ? AND role = 'bot'
      ORDER BY id DESC LIMIT 1
    `).get(sessionId);

    const isLastBotUnknown = lastBotChat && (
      lastBotChat.text.includes('ما عندي إجابة مؤكدة') ||
      lastBotChat.text.includes("I don't have a confirmed answer")
    );

    let priorityVal = 0;
    let suffix = '';
    if (isLastBotUnknown) {
      priorityVal = 1;
      suffix = lang === 'ar'
        ? '\n\nيبدو أن أسئلتك تحتاج مدرّبي شخصياً — لخّصتها له وسيصلك الجواب 📨'
        : "\n\nIt seems your questions need my trainer personally — I've summarized them for him and you'll get the answer soon 📨";
    }

    db.prepare(`
      INSERT INTO queue (question_raw, question_norm, lang, status, priority)
      VALUES (?, ?, ?, 'pending', ?)
      ON CONFLICT(question_norm) DO UPDATE SET 
        priority = max(priority, excluded.priority),
        status = CASE WHEN status = 'ignored' THEN 'pending' ELSE status END
    `).run(rawText, norm, lang, priorityVal);

    const unknownReply = (lang === 'ar'
      ? 'ما عندي إجابة مؤكدة على هذا السؤال بعد — سجّلته وسأتعلمه من مدرّبي قريباً 🙏'
      : "I don't have a confirmed answer for this yet — I've logged it and will learn it from my trainer soon 🙏") + suffix;

    const botInfo = db.prepare(`
      INSERT INTO chats (session, role, text, matched_answer_id, score)
      VALUES (?, 'bot', ?, NULL, NULL)
    `).run(sessionId, unknownReply);

    return {
      reply: unknownReply,
      matched: null,
      suggestions: null,
      queued: true,
      chat_id: botInfo.lastInsertRowid
    };
  }

  // 6. Decision logic
  if (bestMatch && bestMatch.score >= T_AUTO) {
    // Immediate answer
    const ansRow = db.prepare('SELECT * FROM answers WHERE id = ?').get(bestMatch.answer_id);
    if (!ansRow) {
      return handleUnknown();
    }
    const reply = resolveReply(bestMatch.answer_id, ansRow);
    learnVariant(bestMatch.answer_id);

    const botInfo = db.prepare(`
      INSERT INTO chats (session, role, text, matched_answer_id, score)
      VALUES (?, 'bot', ?, ?, ?)
    `).run(sessionId, reply, bestMatch.answer_id, bestMatch.score);

    return {
      reply,
      matched: {
        answer_id: bestMatch.answer_id,
        title: ansRow.title,
        score: bestMatch.score
      },
      suggestions: null,
      queued: false,
      chat_id: botInfo.lastInsertRowid
    };

  } else if (bestMatch && bestMatch.score >= T_BRAIN) {
    // Consult the Brain (asynchronously via cache/jobs)
    const cachedVerdict = db.prepare(`
      SELECT answer_id, verdict FROM brain_cache
      WHERE question_norm = ?
    `).get(norm);

    if (cachedVerdict) {
      if (cachedVerdict.verdict === 'same') {
        const ansRow = db.prepare('SELECT * FROM answers WHERE id = ?').get(cachedVerdict.answer_id);
        if (!ansRow) {
          return handleUnknown();
        }
        const reply = resolveReply(cachedVerdict.answer_id, ansRow);
        learnVariant(cachedVerdict.answer_id);

        const botInfo = db.prepare(`
          INSERT INTO chats (session, role, text, matched_answer_id, score)
          VALUES (?, 'bot', ?, ?, ?)
        `).run(sessionId, reply, cachedVerdict.answer_id, bestMatch.score);

        return {
          reply,
          matched: {
            answer_id: cachedVerdict.answer_id,
            title: ansRow.title,
            score: bestMatch.score
          },
          suggestions: null,
          queued: false,
          chat_id: botInfo.lastInsertRowid
        };
      } else {
        // verdict = 'different'
        return handleUnknown();
      }
    }

    const candidates = [];
    const qVectorForCandidates = await embed(rawText || norm);

    for (const m of matches.slice(0, 3)) {
      const ansRow = db.prepare('SELECT title FROM answers WHERE id = ?').get(m.answer_id);
      if (!ansRow) continue;

      // Find the best variant text for candidate matching
      const vars = db.prepare('SELECT id, text_raw, text_norm FROM variants WHERE answer_id = ?').all(m.answer_id);
      let bestVarText = '';
      let maxSim = -1;
      for (const v of vars) {
        const sim = await hybridSimilarity(norm, qVectorForCandidates, v);
        if (sim > maxSim) {
          maxSim = sim;
          bestVarText = v.text_raw;
        }
      }

      candidates.push({
        answer_id: m.answer_id,
        score: m.score,
        title: ansRow.title,
        variant: bestVarText || ansRow.title
      });
    }

    if (candidates.length === 0) {
      return handleUnknown();
    }

    // Insert judge job
    const payloadStr = JSON.stringify({
      question_raw: rawText,
      question_norm: norm,
      lang,
      candidates
    });

    const exists = db.prepare(`
      SELECT 1 FROM brain_jobs
      WHERE kind = 'judge' AND status = 'pending' AND JSON_EXTRACT(payload, '$.question_norm') = ?
    `).get(norm);

    if (!exists) {
      db.prepare(`
        INSERT INTO brain_jobs (kind, payload, status)
        VALUES ('judge', ?, 'pending')
      `).run(payloadStr);
    }

    // Suggestions response
    const reply = lang === 'ar' ? 'هل تقصد أحد الأسئلة التالية؟' : 'Did you mean one of the following?';
    const suggestions = candidates.map(c => c.title);

    const botInfo = db.prepare(`
      INSERT INTO chats (session, role, text, matched_answer_id, score)
      VALUES (?, 'bot', ?, NULL, ?)
    `).run(sessionId, reply, bestMatch.score);

    return {
      reply,
      matched: {
        answer_id: bestMatch.answer_id,
        title: bestMatch.title,
        score: bestMatch.score
      },
      suggestions,
      queued: false,
      chat_id: botInfo.lastInsertRowid
    };

  } else {
    // Less than T_BRAIN
    return handleUnknown();
  }
}
