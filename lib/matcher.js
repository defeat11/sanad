import db from './db.js';
import { tokens, trigrams } from './normalize.js';
import { embed, getOrEmbedVariant, cosineSim } from './embedder.js';

/**
 * Calculates the similarity score between two normalized strings.
 * score = 0.5 * jaccard(tokens(a), tokens(b)) + 0.5 * dice(trigrams(a), trigrams(b))
 */
export function similarity(a_norm, b_norm) {
  const tokensA = new Set(tokens(a_norm));
  const tokensB = new Set(tokens(b_norm));

  const trigramsA = trigrams(a_norm);
  const trigramsB = trigrams(b_norm);

  // 1. Jaccard similarity of tokens
  let jaccardScore = 0;
  const tokenIntersectionSize = [...tokensA].filter(x => tokensB.has(x)).length;
  const tokenUnionSize = tokensA.size + tokensB.size - tokenIntersectionSize;
  if (tokenUnionSize > 0) {
    jaccardScore = tokenIntersectionSize / tokenUnionSize;
  }

  // 2. Dice similarity of trigrams
  let diceScore = 0;
  const trigramIntersectionSize = [...trigramsA].filter(x => trigramsB.has(x)).length;
  const trigramTotalSize = trigramsA.size + trigramsB.size;
  if (trigramTotalSize > 0) {
    diceScore = (2 * trigramIntersectionSize) / trigramTotalSize;
  }

  return 0.5 * jaccardScore + 0.5 * diceScore;
}

/**
 * Calculates the hybrid similarity score as max(lexical, cosine).
 */
export async function hybridSimilarity(q_norm, q_vector, candidate) {
  const lexical = similarity(q_norm, candidate.text_norm);
  if (!q_vector) return lexical; // embeddings disabled/failed -> old behavior exactly
  if (!candidate.id) return lexical;
  const candVector = await getOrEmbedVariant(db, candidate.id, candidate.text_raw || candidate.text_norm);
  if (!candVector) return lexical;
  return Math.max(lexical, cosineSim(q_vector, candVector));
}

/**
 * Finds the top 3 best matches for a normalized query.
 * Fetches all variants of the target language (or all variants if none exist for that language),
 * computes the hybrid similarity score, groups by answer_id (keeping the highest score for each answer),
 * and returns the top 3 sorted by score descending.
 */
export async function bestMatches(q_norm, lang, customVariants = null, q_raw = null) {
  let candidates = customVariants;

  if (!candidates) {
    candidates = db.prepare(`
      SELECT v.id, v.answer_id, v.text_raw, v.text_norm, v.lang, a.title
      FROM variants v
      JOIN answers a ON v.answer_id = a.id
    `).all();
  }

  const q_vector = await embed(q_raw || q_norm); // once per call, not per candidate

  const matches = {};
  for (const cand of candidates) {
    const score = await hybridSimilarity(q_norm, q_vector, cand);
    const currentBest = matches[cand.answer_id];
    if (!currentBest || score > currentBest.score) {
      matches[cand.answer_id] = {
        answer_id: cand.answer_id,
        title: cand.title,
        text_raw: cand.text_raw,
        score: score
      };
    }
  }

  return Object.values(matches)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
