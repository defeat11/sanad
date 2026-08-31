// يُشغَّل تلقائياً بعد npm install لتنزيل/تجهيز نموذج الـembeddings محلياً
// مرة واحدة، بدل مفاجأة أول تشغيل للخادم أو أول npm run verify بتنزيل ~118MB.
import { embed } from '../lib/embedder.js';

if (process.env.SANAD_NO_EMBED === '1') {
  console.log('[warmup] SANAD_NO_EMBED=1 — skipping model download.');
  process.exit(0);
}

console.log('[warmup] Downloading/loading embeddings model (one-time)...');
const t0 = Date.now();
try {
  const vec = await embed('تجربة');
  if (vec) {
    console.log(`[warmup] Model ready in ${Date.now() - t0}ms, dims=${vec.length}`);
  } else {
    console.warn('[warmup] embed() returned null — model unavailable; will fall back to lexical-only at runtime.');
  }
} catch (err) {
  console.warn('[warmup] Failed to warm up embeddings model (non-fatal):', err.message || err);
}
process.exit(0);
