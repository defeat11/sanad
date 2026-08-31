import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from './lib/db.js';
import { migrateEmbeddings } from './lib/embedder.js';

import chatRouter from './routes/chat.js';
import trainRouter from './routes/train.js';
import { selfTrain } from './lib/trainer.js';
import { processBrainJobs } from './lib/brainworker.js';
import { startTelegram } from './lib/telegram.js';
import { runNightly } from './lib/nightly.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json({ limit: '2mb' }));

// Mount API routes
app.use('/api', chatRouter);
app.use('/api', trainRouter);

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

// Backup Helper Function
function runBackup() {
  try {
    const backupDir = path.join(__dirname, 'data/backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const answers = db.prepare('SELECT * FROM answers').all();
    const variants = db.prepare('SELECT * FROM variants').all();
    const skills = db.prepare('SELECT * FROM skills').all();
    const backupData = { answers, variants, skills };

    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const filename = `sanad-${YYYY}-${MM}-${DD}-${HH}${mm}.json`;

    fs.writeFileSync(
      path.join(backupDir, filename),
      JSON.stringify(backupData, null, 2),
      'utf-8'
    );
    console.log(`[Backup] Created backup: ${filename}`);

    // Keep only last 14 backups
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('sanad-') && f.endsWith('.json'))
      .sort();

    if (files.length > 14) {
      const toDelete = files.slice(0, files.length - 14);
      for (const f of toDelete) {
        fs.unlinkSync(path.join(backupDir, f));
        console.log(`[Backup] Deleted old backup: ${f}`);
      }
    }
  } catch (error) {
    console.error('[Backup] Backup failed:', error);
  }
}

// Run initialization backup
runBackup();

// Schedule backup every 24 hours
setInterval(runBackup, 24 * 60 * 60 * 1000);

// Schedule nightly batch check every 10 minutes
setInterval(async () => {
  try {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();

    if (hours === 3 && minutes >= 0 && minutes <= 20) {
      const offset = now.getTimezoneOffset();
      const localNow = new Date(now.getTime() - (offset * 60 * 1000));
      const todayStr = localNow.toISOString().split('T')[0];

      const setting = db.prepare("SELECT value FROM settings WHERE key = 'last_nightly'").get();
      if (!setting || setting.value !== todayStr) {
        console.log(`[Nightly] Starting scheduled nightly batch for ${todayStr}...`);
        await runNightly();
        
        db.prepare(`
          INSERT INTO settings (key, value)
          VALUES ('last_nightly', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(todayStr);
        console.log(`[Nightly] Scheduled nightly batch for ${todayStr} completed.`);
      }
    }
  } catch (error) {
    console.error('[Nightly] Error in scheduled nightly batch:', error);
  }
}, 10 * 60 * 1000);

// Start self-training loop scheduled every 6 hours (disabled if SANAD_NO_BRAIN=1)
if (process.env.SANAD_NO_BRAIN !== '1') {
  setInterval(() => {
    console.log('[Trainer] Starting scheduled self-training loop...');
    selfTrain()
      .then((result) => {
        console.log('[Trainer] Scheduled self-training complete:', result);
      })
      .catch((error) => {
        console.error('[Trainer] Scheduled self-training error:', error);
      });
  }, 6 * 60 * 60 * 1000);
}

if (process.env.SANAD_NO_EMBED !== '1') {
  console.log('[Embeddings] Checking for variants missing embeddings...');
  try {
    const result = await migrateEmbeddings(db, {
      onProgress: (done, total) => {
        if (total > 0 && done % 20 === 0) console.log(`[Embeddings] ${done}/${total}`);
      }
    });
    console.log(`[Embeddings] Migration done: ${result.embedded} embedded, ${result.tookMs}ms`);
  } catch (err) {
    console.error('[Embeddings] Migration failed (continuing with lexical-only fallback):', err);
  }
}

const PORT = process.env.PORT || 4600;
const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`Sanad server running on http://${HOST}:${PORT}`);
  
  // Start Telegram bot background loops (checks for process.env.SANAD_TG_TOKEN inside)
  startTelegram();

  // Background Brain Worker loops
  setInterval(() => {
    processBrainJobs(10).catch(err => {
      console.error('[BrainWorker] Error in scheduled run:', err);
    });
  }, 10 * 60 * 1000);

  setTimeout(() => {
    processBrainJobs(10).catch(err => {
      console.error('[BrainWorker] Error in startup run:', err);
    });
  }, 30 * 1000);
});
