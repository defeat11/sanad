import { pipeline, env } from '@huggingface/transformers';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export const EMBED_MODEL_ID = process.env.SANAD_EMBED_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBED_DTYPE = 'q8';
export const MODEL_TAG = `${EMBED_MODEL_ID}:${EMBED_DTYPE}`;

// خزّن كاش النموذج داخل data/models (لا داخل node_modules) كي ينجو من npm install لاحقة
env.cacheDir = path.join(projectRoot, 'data', 'models');

let pipelinePromise = null;
function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = pipeline('feature-extraction', EMBED_MODEL_ID, { dtype: EMBED_DTYPE })
      .catch((err) => {
        // Prevent unhandled promise rejection warnings in Node.js
        throw err;
      });
  }
  return pipelinePromise;
}

/** يرجع Float32Array(384) أو null (لا يرمي أبداً). */
export async function embed(text) {
  if (process.env.SANAD_NO_EMBED === '1') return null;
  if (!text || !text.trim()) return null;
  try {
    const extractor = await getPipeline();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Float32Array.from(output.data);
  } catch (err) {
    console.warn('embed() failed:', err.message || err);
    return null;
  }
}

export function vectorToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVector(buf) {
  const copy = Buffer.from(buf); // نسخ لضمان محاذاة مستقلة عن أي تجميع buffer داخلي
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** دالة تشابه جيب التمام؛ المتجهات مُطبَّعة L2 مسبقاً (normalize:true) فحاصل الضرب النقطي = cosine. */
export function cosineSim(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * يرجع متجه الصيغة variantId من الجدول إن وُجد ومطابقاً لوسم النموذج الحالي،
 * وإلا يحسبه من textNorm ويخزّنه (self-heal — يضمن عدم الحاجة لتعديل كل نقطة
 * INSERT INTO variants الاثنتي عشرة عبر المشروع). يرجع null إن تعذّر الحساب.
 */
export async function getOrEmbedVariant(db, variantId, textNorm) {
  if (process.env.SANAD_NO_EMBED === '1') return null;
  try {
    const row = db.prepare('SELECT vector, model FROM embeddings WHERE variant_id = ?').get(variantId);
    if (row && row.model === MODEL_TAG) {
      return blobToVector(row.vector);
    }
    const vec = await embed(textNorm);
    if (!vec) return null;
    db.prepare(`
      INSERT INTO embeddings (variant_id, vector, dims, model)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(variant_id) DO UPDATE SET vector = excluded.vector, model = excluded.model, created_at = datetime('now')
    `).run(variantId, vectorToBlob(vec), vec.length, MODEL_TAG);
    return vec;
  } catch (err) {
    console.warn('getOrEmbedVariant() failed:', err.message || err);
    return null;
  }
}

/**
 * مسح دفعي: يضمن أن كل صيغة موجودة في variants عندها embedding مطابق لوسم
 * النموذج الحالي. يُستدعى عند إقلاع الخادم (§9.1). يعيد {embedded, skipped, tookMs}.
 */
export async function migrateEmbeddings(db, { onProgress } = {}) {
  if (process.env.SANAD_NO_EMBED === '1') return { embedded: 0, skipped: 0, tookMs: 0 };
  const t0 = Date.now();
  const rows = db.prepare(`
    SELECT v.id, v.text_norm
    FROM variants v
    LEFT JOIN embeddings e ON e.variant_id = v.id AND e.model = ?
    WHERE e.variant_id IS NULL
  `).all(MODEL_TAG);

  let embedded = 0;
  for (const row of rows) {
    const vec = await getOrEmbedVariant(db, row.id, row.text_norm);
    if (vec) embedded++;
    if (onProgress) onProgress(embedded, rows.length);
  }
  return { embedded, skipped: rows.length - embedded, tookMs: Date.now() - t0 };
}
