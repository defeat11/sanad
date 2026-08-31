import express from 'express';
import { answer } from '../lib/engine.js';
import db from '../lib/db.js';
import { normalize, detectLang } from '../lib/normalize.js';

const router = express.Router();

// Rate limiting map: session -> array of timestamps
const rateLimits = new Map();

function rateLimitMiddleware(req, res, next) {
  const { session } = req.body;
  if (!session) {
    return next();
  }

  const now = Date.now();
  const limitWindow = 60 * 1000; // 1 minute

  if (!rateLimits.has(session)) {
    rateLimits.set(session, []);
  }

  let timestamps = rateLimits.get(session);
  timestamps = timestamps.filter(t => now - t < limitWindow);

  if (timestamps.length >= 20) {
    return res.status(429).json({
      reply: 'أعطني نفَساً 😅 أعد المحاولة بعد قليل'
    });
  }

  timestamps.push(now);
  rateLimits.set(session, timestamps);
  next();
}

router.post('/chat', rateLimitMiddleware, async (req, res) => {
  try {
    const { session, text } = req.body;
    if (!session || !text) {
      return res.status(400).json({ error: 'Missing session or text' });
    }
    const result = await answer(session, text);
    
    // Normalize response in case engine.js returned the skillReply object instead of a string
    if (result && result.reply && typeof result.reply === 'object' && 'reply' in result.reply) {
      result.reply = result.reply.reply;
    }
    
    res.json(result);
  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// POST /api/feedback - receive feedback votes (+1 or -1)
router.post('/feedback', (req, res) => {
  try {
    const { chat_id, vote } = req.body;
    if (chat_id === undefined || vote === undefined) {
      return res.status(400).json({ error: 'chat_id and vote are required' });
    }

    if (vote !== 1 && vote !== -1) {
      return res.status(400).json({ error: 'vote must be 1 or -1' });
    }

    // Insert or update feedback
    db.prepare(`
      INSERT INTO feedback (chat_id, vote)
      VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET vote = excluded.vote
    `).run(chat_id, vote);

    // If negative vote, push the original user question to the training queue
    if (vote === -1) {
      const botChat = db.prepare('SELECT session, matched_answer_id FROM chats WHERE id = ?').get(chat_id);
      if (botChat) {
        const userChat = db.prepare(`
          SELECT text FROM chats
          WHERE session = ? AND role = 'user' AND id < ?
          ORDER BY id DESC LIMIT 1
        `).get(botChat.session, chat_id);

        if (userChat) {
          const rawText = userChat.text;
          const norm = normalize(rawText);
          const lang = detectLang(rawText);

          const exists = db.prepare('SELECT id, status FROM queue WHERE question_norm = ?').get(norm);
          if (!exists) {
            db.prepare(`
              INSERT INTO queue (question_raw, question_norm, lang, status)
              VALUES (?, ?, ?, 'pending')
            `).run(rawText, norm, lang);
          } else if (exists.status !== 'pending') {
            db.prepare(`
              UPDATE queue SET status = 'pending' WHERE id = ?
            `).run(exists.id);
          }
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Feedback endpoint error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

export default router;

