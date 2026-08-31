import dbInstance from './db.js';
import { answer } from './engine.js';
import { normalize, detectLang } from './normalize.js';

const db = dbInstance.db || dbInstance;

// In-memory maps
const rateLimits = new Map();         // chat_id -> array of timestamps
const outgoingQueues = new Map();     // chat_id -> array of task functions
const outgoingTimers = new Map();     // chat_id -> NodeJS.Timeout
const suggestionsMap = new Map();     // "chat_id:message_id" -> array of suggestion strings

/**
 * Redacts the Telegram bot token from any logs/errors.
 */
function redact(str) {
  if (!str) return str;
  const token = process.env.SANAD_TG_TOKEN;
  if (!token) return str;
  // Escaping special regex characters in token
  const escapedToken = token.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(escapedToken, 'g');
  return str.replace(regex, '***');
}

/**
 * Loggers with automatic token redacting
 */
function logInfo(message) {
  console.log(redact(message));
}

function logError(message, error) {
  const errStr = error ? (error.stack || error.message || String(error)) : '';
  console.error(redact(message + ' ' + errStr));
}

/**
 * Exported functions as required by the prompt & verify scripts.
 */

export function isAllowed(chatId, allowlistStr) {
  if (allowlistStr === undefined || allowlistStr === null || allowlistStr.trim() === '') {
    return true;
  }
  const allowedIds = allowlistStr.split(',').map(id => id.trim());
  return allowedIds.includes(String(chatId).trim());
}

export function formatTelegramReply(result) {
  if (!result) return { text: '', reply_markup: null };
  const text = result.reply || '';
  let reply_markup = null;

  if (result.suggestions && result.suggestions.length > 0) {
    reply_markup = {
      inline_keyboard: result.suggestions.map((sug, index) => [
        { text: sug, callback_data: String(index) }
      ])
    };
  } else if (result.matched && result.chat_id) {
    reply_markup = {
      inline_keyboard: [
        [
          { text: '👍', callback_data: `fb:${result.chat_id}:1` },
          { text: '👎', callback_data: `fb:${result.chat_id}:-1` }
        ]
      ]
    };
  }

  return { text, reply_markup };
}

/**
 * Rate limit check: 20 messages / minute per chat_id
 */
function isRateLimited(chatId) {
  const now = Date.now();
  const limitWindow = 60 * 1000;
  if (!rateLimits.has(chatId)) {
    rateLimits.set(chatId, []);
  }
  let timestamps = rateLimits.get(chatId);
  timestamps = timestamps.filter(t => now - t < limitWindow);
  if (timestamps.length >= 20) {
    return true;
  }
  timestamps.push(now);
  rateLimits.set(chatId, timestamps);
  return false;
}

/**
 * Simple queue to space outgoing messages at most 1 message/second per chat_id
 */
function enqueueOutgoing(chatId, taskFn) {
  if (!outgoingQueues.has(chatId)) {
    outgoingQueues.set(chatId, []);
  }
  outgoingQueues.get(chatId).push(taskFn);
  processOutgoingQueue(chatId);
}

function processOutgoingQueue(chatId) {
  if (outgoingTimers.has(chatId)) {
    return;
  }
  const queue = outgoingQueues.get(chatId);
  if (!queue || queue.length === 0) return;

  const nextTask = queue.shift();
  nextTask().catch(err => {
    logError(`[Telegram] Error executing queued send task to chat ${chatId}:`, err);
  });

  const timer = setTimeout(() => {
    outgoingTimers.delete(chatId);
    processOutgoingQueue(chatId);
  }, 1000);
  outgoingTimers.set(chatId, timer);
}

export async function send(chatId, text, replyMarkup) {
  return sendTelegramMessage(chatId, text, replyMarkup);
}

/**
 * Sends a message via Telegram API
 */
export async function sendTelegramMessage(chatId, text, replyMarkup) {
  const token = process.env.SANAD_TG_TOKEN;
  if (!token) return null;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to send message: ${response.status} - ${errText}`);
  }

  const resData = await response.json();
  if (!resData.ok) {
    throw new Error(resData.description || 'Unknown error on sendMessage');
  }

  return resData.result; // The Message object
}

/**
 * Enqueues a message to be sent asynchronously respecting the outgoing rate limit.
 */
function enqueueMessage(chatId, text, replyMarkup, onSuccess) {
  return new Promise((resolve, reject) => {
    enqueueOutgoing(chatId, async () => {
      try {
        const sentMsg = await sendTelegramMessage(chatId, text, replyMarkup);
        if (onSuccess) {
          onSuccess(sentMsg);
        }
        resolve(sentMsg);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Answers a Telegram callback query to stop the loading state.
 */
async function answerCallbackQuery(callbackQueryId, text) {
  const token = process.env.SANAD_TG_TOKEN;
  if (!token) return;

  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  const body = {
    callback_query_id: callbackQueryId
  };
  if (text) {
    body.text = text;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errText = await response.text();
      logError(`[Telegram] Failed to answer callback query: ${response.status}`, new Error(errText));
    }
  } catch (err) {
    logError('[Telegram] Error in answerCallbackQuery fetch:', err);
  }
}

/**
 * Fetches the current system stats.
 */
function getStats() {
  const answers = db.prepare('SELECT COUNT(*) AS count FROM answers').get().count;
  const variants = db.prepare('SELECT COUNT(*) AS count FROM variants').get().count;
  const queue_pending = db.prepare("SELECT COUNT(*) AS count FROM queue WHERE status = 'pending'").get().count;
  const chats = db.prepare('SELECT COUNT(*) AS count FROM chats').get().count;
  const skills = db.prepare('SELECT COUNT(*) AS count FROM skills').get().count;

  const total_answered = db.prepare(`
    SELECT COUNT(*) AS count FROM chats
    WHERE role = 'bot' AND matched_answer_id IS NOT NULL
  `).get().count;

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

  const user_learned_variants = db.prepare(`
    SELECT COUNT(*) AS count FROM variants
    WHERE source = 'user'
  `).get().count;

  const fbStats = db.prepare(`
    SELECT 
      SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS ups,
      COUNT(*) AS total
    FROM feedback
  `).get();
  const ups = fbStats.ups || 0;
  const total = fbStats.total || 0;
  const overall_satisfaction = total > 0 ? Math.round((ups / total) * 100) : 100;

  let brain_jobs_pending = 0;
  try {
    brain_jobs_pending = db.prepare("SELECT COUNT(*) AS count FROM brain_jobs WHERE status = 'pending'").get().count;
  } catch (e) {}

  let brain_cache_count = 0;
  try {
    brain_cache_count = db.prepare("SELECT COUNT(*) AS count FROM brain_cache").get().count;
  } catch (e) {}

  return `📊 إحصائيات النظام:
- الإجابات: ${answers}
- الصياغات: ${variants}
- معلق في الطابور: ${queue_pending}
- المحادثات: ${chats}
- المهارات: ${skills}
- تم الرد عليها: ${total_answered}
- معدل الرد الفوري: ${instant_answer_rate}%
- صياغات المستخدمين: ${user_learned_variants}
- نسبة الرضا: ${overall_satisfaction}%
- وظائف العقل المعلقة: ${brain_jobs_pending}
- ذاكرة العقل: ${brain_cache_count}`;
}

/**
 * Gets the number of pending questions in the queue.
 */
function getQueueCount() {
  const queue_pending = db.prepare("SELECT COUNT(*) AS count FROM queue WHERE status = 'pending'").get().count;
  return `عدد الأسئلة المعلقة في الطابور: ${queue_pending} 📨`;
}

/**
 * Handles incoming text messages
 */
async function handleMessage(message) {
  const chatId = String(message.chat.id);
  const text = message.text;
  if (!text) return; // Only process text messages

  const username = message.from ? (message.from.username || '') : '';
  const allowed = isAllowed(chatId, process.env.SANAD_TG_ALLOWLIST) ? 1 : 0;

  // 1. Audit Log: Log every message
  try {
    db.prepare(`
      INSERT INTO tg_audit (chat_id, username, text, allowed)
      VALUES (?, ?, ?, ?)
    `).run(chatId, username, text, allowed);
  } catch (err) {
    logError('[Telegram] Error writing to tg_audit:', err);
  }

  // 2. Allowed check
  if (!allowed) {
    await enqueueMessage(chatId, 'هذه الخدمة داخلية 🙏');
    return;
  }

  // 3. Incoming rate limiting: 20 msg/min
  if (isRateLimited(chatId)) {
    await enqueueMessage(chatId, 'أعطني نفَساً 😅');
    return;
  }

  // 4. Admin commands check
  const isAdmin = process.env.SANAD_TG_ADMIN && String(chatId) === String(process.env.SANAD_TG_ADMIN);
  if (isAdmin && text === '/stats') {
    const statsText = getStats();
    await enqueueMessage(chatId, statsText);
    return;
  }
  if (isAdmin && text === '/queue') {
    const queueText = getQueueCount();
    await enqueueMessage(chatId, queueText);
    return;
  }

  // 5. Normal chat flow using engine.answer()
  try {
    const result = await answer('tg:' + chatId, text);
    const { text: replyText, reply_markup } = formatTelegramReply(result);

    await enqueueMessage(chatId, replyText, reply_markup, (sentMsg) => {
      if (result.suggestions && result.suggestions.length > 0 && sentMsg && sentMsg.message_id) {
        const key = `${chatId}:${sentMsg.message_id}`;
        suggestionsMap.set(key, result.suggestions);
      }
    });
  } catch (err) {
    logError('[Telegram] Error answering message from engine:', err);
  }
}

/**
 * Handles callback queries (inline button clicks)
 */
async function handleCallbackQuery(callbackQuery) {
  const queryId = callbackQuery.id;
  const chatId = String(callbackQuery.message?.chat?.id || callbackQuery.from?.id);
  const data = callbackQuery.data;
  const message = callbackQuery.message;

  if (!chatId || !data) {
    await answerCallbackQuery(queryId);
    return;
  }

  const allowed = isAllowed(chatId, process.env.SANAD_TG_ALLOWLIST);
  if (!allowed) {
    await answerCallbackQuery(queryId);
    return;
  }

  if (data.startsWith('fb:')) {
    // Feedback: fb:<chat_row_id>:<vote>
    try {
      const parts = data.split(':');
      const chatRowId = parseInt(parts[1], 10);
      const vote = parseInt(parts[2], 10);

      // Insert directly into feedback
      db.prepare(`
        INSERT INTO feedback (chat_id, vote)
        VALUES (?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET vote = excluded.vote
      `).run(chatRowId, vote);

      await answerCallbackQuery(queryId, 'شكراً 🙏');
    } catch (err) {
      logError('[Telegram] Error executing feedback callback:', err);
      await answerCallbackQuery(queryId);
    }
  } else {
    // Suggestion click
    try {
      const index = parseInt(data, 10);
      if (!isNaN(index) && message && message.message_id) {
        const key = `${chatId}:${message.message_id}`;
        const suggestions = suggestionsMap.get(key);
        if (suggestions && index >= 0 && index < suggestions.length) {
          const selectedText = suggestions[index];
          
          await answerCallbackQuery(queryId);

          // Log simulated incoming message to audit log
          try {
            db.prepare(`
              INSERT INTO tg_audit (chat_id, username, text, allowed)
              VALUES (?, ?, ?, 1)
            `).run(chatId, callbackQuery.from?.username || '', selectedText, 1);
          } catch (err) {
            logError('[Telegram] Error writing callback message to tg_audit:', err);
          }

          if (isRateLimited(chatId)) {
            await enqueueMessage(chatId, 'أعطني نفَساً 😅');
            return;
          }

          const result = await answer('tg:' + chatId, selectedText);
          const { text: replyText, reply_markup } = formatTelegramReply(result);

          await enqueueMessage(chatId, replyText, reply_markup, (sentMsg) => {
            if (result.suggestions && result.suggestions.length > 0 && sentMsg && sentMsg.message_id) {
              const newKey = `${chatId}:${sentMsg.message_id}`;
              suggestionsMap.set(newKey, result.suggestions);
            }
          });
        } else {
          await answerCallbackQuery(queryId);
        }
      } else {
        await answerCallbackQuery(queryId);
      }
    } catch (err) {
      logError('[Telegram] Error handling suggestion callback:', err);
      await answerCallbackQuery(queryId);
    }
  }
}

/**
 * Processes an update object
 */
async function handleUpdate(update) {
  if (update.message) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
  }
}

/**
 * Reads the last saved offset from the settings table
 */
function getOffset() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'tg_offset'").get();
    return row ? parseInt(row.value, 10) : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Saves the current offset to the settings table
 */
function setOffset(offset) {
  try {
    db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('tg_offset', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(offset));
  } catch (e) {
    logError('[Telegram] Failed to save offset to settings:', e);
  }
}

/**
 * Main polling loop for the Telegram bot
 */
export async function startTelegram() {
  const token = process.env.SANAD_TG_TOKEN;
  if (!token) {
    logInfo('Telegram: disabled (no token)');
    return;
  }

  // Ensure necessary database tables exist
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS tg_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT,
        username TEXT,
        text TEXT,
        allowed INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (err) {
    logError('[Telegram] Error initializing DB tables:', err);
  }

  logInfo('Telegram: starting polling loop...');

  let offset = getOffset();
  let active = true;
  let delay = 5000; // Starting retry delay on network failure

  while (active) {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=50`;
      const response = await fetch(url);

      if (response.status === 401) {
        console.warn('Telegram: Token rejected (401). Disabling Telegram bot.');
        active = false;
        break;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.description || 'Unknown error from Telegram API');
      }

      const updates = data.result || [];
      for (const update of updates) {
        try {
          await handleUpdate(update);
        } catch (e) {
          logError('[Telegram] Error handling update:', e);
        }
        offset = update.update_id + 1;
        setOffset(offset);
      }

      // Reset retry delay on a successful poll
      delay = 5000;
    } catch (err) {
      logError('[Telegram] Polling error:', err);
      logInfo(`[Telegram] Waiting ${delay / 1000}s before retrying...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 60000);
    }
  }
}
