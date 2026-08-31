import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { normalize, detectLang, clearSynonymsCache } from './normalize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine database file path: environment variable SANAD_DB or default to data/sanad.db relative to project root
const dbPath = process.env.SANAD_DB || path.join(__dirname, '../data/sanad.db');

// Ensure parent directory exists
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(dbPath);
globalThis.sanadDb = db;

// Enable WAL journal mode and foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Register custom SQLite functions
try {
  db.function('normalize', (text) => normalize(text));
} catch (e) {
  // ignore if already registered
}

// Initialize schema
db.exec(`
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,            -- عنوان قصير للإجابة (يظهر بلوحة التدريب وفي "هل تقصد؟")
  body_ar TEXT NOT NULL,          -- نص الإجابة الثابت بالعربي
  body_en TEXT,                   -- ترجمة إنجليزية (تُملأ يدوياً أو تُترجم وتُخزَّن عند أول حاجة)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  text_raw TEXT NOT NULL,
  text_norm TEXT NOT NULL,        -- ناتج normalize() — عليه فهرس
  lang TEXT NOT NULL CHECK(lang IN ('ar','en')),
  source TEXT NOT NULL CHECK(source IN ('manual','user','paraphrase')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(answer_id, text_norm)
);

CREATE INDEX IF NOT EXISTS idx_variants_norm ON variants(text_norm);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_raw TEXT NOT NULL,
  question_norm TEXT NOT NULL,
  lang TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','ignored')),
  answer_id INTEGER,              -- يُملأ عندما يجيب المدرِّب
  created_at TEXT DEFAULT (datetime('now')),
  priority INTEGER DEFAULT 0,
  UNIQUE(question_norm)           -- لا تكرار بالطابور
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  triggers_json TEXT NOT NULL,    -- مصفوفة JSON من عبارات التفعيل (ar/en)
  template TEXT NOT NULL,         -- قالب الرد؛ قد يحوي {placeholders}
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','bot')),
  text TEXT NOT NULL,
  matched_answer_id INTEGER,
  score REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,            -- 'paraphrase_added' | 'variant_learned' | 'merge_suggested' | ...
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id),
  answer_id INTEGER,
  vote INTEGER NOT NULL CHECK(vote IN (1,-1)),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(chat_id)
);

CREATE TABLE IF NOT EXISTS exam_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  score REAL,
  tested INTEGER,
  passed INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS synonyms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT UNIQUE,
  canonical TEXT
);

CREATE TABLE IF NOT EXISTS embeddings (
  variant_id INTEGER PRIMARY KEY REFERENCES variants(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,        -- Float32Array(384) كبايتات خام، little-endian (1536 بايت)
  dims INTEGER NOT NULL DEFAULT 384,
  model TEXT NOT NULL,         -- وسم النموذج، مثال: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2:q8'
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);

CREATE TABLE IF NOT EXISTS brain_cache (
  question_norm TEXT PRIMARY KEY,
  answer_id INTEGER,
  verdict TEXT NOT NULL CHECK(verdict IN ('same','different')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS brain_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('judge','translate_body','ingest_source','draft_cluster','ingest_document')),
  payload TEXT NOT NULL,          -- JSON: judge={question_raw,question_norm,lang,candidates:[{answer_id,title,variant}]} · translate_body={answer_id}
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
  created_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_brain_jobs_status ON brain_jobs(status);

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

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('pdf','xlsx','csv','txt')),
  bytes INTEGER NOT NULL,
  text TEXT,                       -- النص المستخرج (سقف 500 ألف حرف)
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','generating','drafted','ingested','failed')),
  error TEXT,
  chunks_total INTEGER DEFAULT 0,
  chunks_done INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  guidance TEXT NOT NULL,          -- توجيه المدرب الحر: ايش الفورم، متى، مميزاته
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','generating','drafted','ingested','failed')),
  created_at TEXT DEFAULT (datetime('now')),
  ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS draft_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body_ar TEXT NOT NULL,
  body_en TEXT,
  variants_json TEXT NOT NULL,     -- JSON: [{text, lang}] — الصيغ المقترحة
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metrics_history (
  date TEXT PRIMARY KEY,               -- YYYY-MM-DD (upsert: صف واحد لكل يوم)
  exam_avg REAL, exam_lexical_avg REAL,
  answers INTEGER, variants INTEGER, queue_pending INTEGER,
  chats_total INTEGER, satisfaction REAL, pairs_count INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_a TEXT NOT NULL, text_b TEXT NOT NULL,
  label INTEGER NOT NULL CHECK(label IN (0,1)),   -- 1=نفس المعنى، 0=مختلف
  src TEXT NOT NULL,                              -- 'variants' | 'negative' | 'dialect'
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(text_a, text_b, label)
);
`);

// Ensure priority column exists on queue (migration path for existing databases)
try {
  const tableInfo = db.pragma("table_info(queue)");
  const hasPriority = tableInfo.some(col => col.name === 'priority');
  if (!hasPriority) {
    db.exec("ALTER TABLE queue ADD COLUMN priority INTEGER DEFAULT 0");
  }
} catch (e) {
  console.error("Failed to alter queue table:", e);
}

// Ensure brain_jobs CHECK constraint includes 'ingest_source', 'draft_cluster', and 'ingest_document' (migration path for existing databases)
try {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='brain_jobs'").get();
  if (row && row.sql && (!row.sql.includes('ingest_source') || !row.sql.includes('draft_cluster') || !row.sql.includes('ingest_document'))) {
    db.transaction(() => {
      db.exec("ALTER TABLE brain_jobs RENAME TO old_brain_jobs");
      db.exec(`
        CREATE TABLE brain_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK(kind IN ('judge','translate_body','ingest_source','draft_cluster','ingest_document')),
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
          created_at TEXT DEFAULT (datetime('now')),
          processed_at TEXT
        )
      `);
      db.exec(`
        INSERT INTO brain_jobs (id, kind, payload, status, created_at, processed_at)
        SELECT id, kind, payload, status, created_at, processed_at FROM old_brain_jobs
      `);
      db.exec("DROP TABLE old_brain_jobs");
      db.exec("CREATE INDEX IF NOT EXISTS idx_brain_jobs_status ON brain_jobs(status)");
    })();
    console.log("Successfully migrated brain_jobs table to include 'ingest_document' kind.");
  }
} catch (e) {
  console.error("Failed to migrate brain_jobs table:", e);
}

// Ensure documents table exists (migration path)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('pdf','xlsx','csv','txt')),
      bytes INTEGER NOT NULL,
      text TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','generating','drafted','ingested','failed')),
      error TEXT,
      chunks_total INTEGER DEFAULT 0,
      chunks_done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
} catch (e) {
  console.error("Failed to create documents table during migration:", e);
}

// Ensure document_id column exists on draft_answers (migration path for existing databases)
try {
  const tableInfo = db.pragma("table_info(draft_answers)");
  const hasDocId = tableInfo.some(col => col.name === 'document_id');
  if (!hasDocId) {
    db.exec("ALTER TABLE draft_answers ADD COLUMN document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE");
  }
} catch (e) {
  console.error("Failed to alter draft_answers table:", e);
}

// Seed synonyms if table is empty
try {
  const rowCount = db.prepare('SELECT COUNT(*) AS count FROM synonyms').get().count;
  if (rowCount === 0) {
    const seedSyns = [
      { term: 'باسورد', canonical: 'كلمه المرور' },
      { term: 'باس', canonical: 'كلمه المرور' },
      { term: 'ايميل', canonical: 'بريد' },
      { term: 'ميل', canonical: 'بريد' },
      { term: 'لابتوب', canonical: 'حاسوب' },
      { term: 'كمبيوتر', canonical: 'حاسوب' },
      { term: 'جهازي', canonical: 'حاسوب' },
      { term: 'نت', canonical: 'انترنت' },
      { term: 'وايفاي', canonical: 'انترنت' },
      { term: 'wifi', canonical: 'انترنت' },
      { term: 'برنتر', canonical: 'طابعه' },
      { term: 'printer', canonical: 'طابعه' },
      { term: 'pw', canonical: 'password' },
      { term: 'acc', canonical: 'account' },
      { term: 'طريقة', canonical: 'كيف' },
      { term: 'طريقه', canonical: 'كيف' },
      { term: 'يمكنني', canonical: 'كيف' }
    ];
    const insertStmt = db.prepare('INSERT INTO synonyms (term, canonical) VALUES (?, ?)');
    db.transaction(() => {
      for (const item of seedSyns) {
        insertStmt.run(item.term, item.canonical);
      }
    })();
  }
} catch (e) {
  console.error("Failed to seed synonyms:", e);
}

// Function to handle automatic queueing on negative feedback
function handleNegativeFeedback(chatId) {
  const botChat = db.prepare('SELECT session FROM chats WHERE id = ?').get(chatId);
  if (botChat) {
    const userChat = db.prepare(`
      SELECT text FROM chats
      WHERE session = ? AND id < ? AND role = 'user'
      ORDER BY id DESC LIMIT 1
    `).get(botChat.session, chatId);

    if (userChat) {
      const rawText = userChat.text;
      const norm = normalize(rawText);
      const lang = detectLang(rawText);

      db.prepare(`
        INSERT OR IGNORE INTO queue (question_raw, question_norm, lang, status)
        VALUES (?, ?, ?, 'pending')
      `).run(rawText, norm, lang);
    }
  }
}

// Function to recalculate all stored variant norms (and optionally queue item norms)
export function recalculateVariantNorms() {
  clearSynonymsCache();
  
  const runInTx = (fn) => {
    if (db.inTransaction) {
      return fn();
    } else {
      return db.transaction(fn)();
    }
  };

  runInTx(() => {
    // Recalculate variants
    const variants = db.prepare('SELECT id, text_raw, text_norm FROM variants').all();
    const updateStmt = db.prepare('UPDATE variants SET text_norm = ? WHERE id = ?');
    const deleteEmbeddingStmt = db.prepare('DELETE FROM embeddings WHERE variant_id = ?');
    for (const v of variants) {
      const newNorm = normalize(v.text_raw);
      if (newNorm !== v.text_norm) {
        deleteEmbeddingStmt.run(v.id);
      }
      try {
        updateStmt.run(newNorm, v.id);
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message.includes('UNIQUE')) {
          db.prepare('DELETE FROM variants WHERE id = ?').run(v.id);
        } else {
          throw err;
        }
      }
    }

    // Recalculate queue
    try {
      const queueItems = db.prepare('SELECT id, question_raw FROM queue').all();
      const updateQueueStmt = db.prepare('UPDATE queue SET question_norm = ? WHERE id = ?');
      for (const q of queueItems) {
        const newNorm = normalize(q.question_raw);
        updateQueueStmt.run(newNorm, q.id);
      }
    } catch (e) {
      // ignore if queue table has issues or doesn't exist
    }
  });
}

// Hook database writes to trigger hooks
const isSynonymWrite = (sql) => {
  if (typeof sql !== 'string') return false;
  const cleanSql = sql.toUpperCase();
  return (cleanSql.includes('SYNONYMS') && 
         (cleanSql.includes('INSERT') || 
          cleanSql.includes('UPDATE') || 
          cleanSql.includes('DELETE') || 
          cleanSql.includes('REPLACE') || 
          cleanSql.includes('DROP') || 
          cleanSql.includes('ALTER')));
};

const isFeedbackInsert = (sql) => {
  if (typeof sql !== 'string') return false;
  const cleanSql = sql.toUpperCase();
  return cleanSql.includes('FEEDBACK') && cleanSql.includes('INSERT');
};

const originalPrepare = db.prepare;
db.prepare = function (sql, ...args) {
  const stmt = originalPrepare.call(this, sql, ...args);
  
  const originalRun = stmt.run;
  stmt.run = function (...runArgs) {
    const isFeedback = isFeedbackInsert(sql);
    const isSynonym = isSynonymWrite(sql);

    // Call original run
    const res = originalRun.apply(this, runArgs);

    if (isSynonym) {
      try {
        recalculateVariantNorms();
      } catch (e) {
        console.error('Error during recalculateVariantNorms from prepare.run:', e);
      }
    }

    if (isFeedback) {
      try {
        let chatId = null;
        let vote = null;
        if (runArgs.length === 1 && typeof runArgs[0] === 'object' && runArgs[0] !== null) {
          const obj = runArgs[0];
          chatId = obj.chat_id || obj.$chat_id || obj.chatId;
          vote = obj.vote || obj.$vote;
        } else {
          chatId = runArgs[0];
          vote = runArgs[1];
        }

        if (vote === -1 && chatId !== null && chatId !== undefined) {
          handleNegativeFeedback(chatId);
        }
      } catch (e) {
        console.error('Error during feedback hook in prepare.run:', e);
      }
    }

    return res;
  };

  return stmt;
};

const originalExec = db.exec;
db.exec = function (sql) {
  const res = originalExec.call(this, sql);
  if (isSynonymWrite(sql)) {
    try {
      recalculateVariantNorms();
    } catch (e) {
      console.error('Error during recalculateVariantNorms from exec:', e);
    }
  }
  return res;
};

export default db;
