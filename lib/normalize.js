/**
 * Normalizes text according to the specification:
 * 1. Remove all Arabic diacritics (tashkeel: \u064B-\u065F, superscript alef \u0670) and tatweel (\u0640).
 * 2. Unify characters: أ إ آ ٱ -> ا, ة -> ه, ى -> ي, ؤ -> و, ئ -> ي.
 * 3. Delete all Arabic and Latin punctuation characters (؟?!.,؛;:"'()[]{}«»…).
 * 4. Convert Arabic digits ٠-٩ to 0-9, and lowercase all Latin characters.
 * 5. Collapse consecutive spaces and trim.
 * 6. Replace synonyms (as whole-words) after basic normalization.
 */

let synonymsCache = null;

export function clearSynonymsCache() {
  synonymsCache = null;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalize(text) {
  if (text === null || text === undefined) return '';
  let res = String(text);

  // 1. Remove diacritics and tatweel
  res = res.replace(/[\u064B-\u065F\u0670\u0640]/g, '');

  // 2. Unify characters
  res = res.replace(/[أإآٱ]/g, 'ا')
           .replace(/ة/g, 'ه')
           .replace(/ى/g, 'ي')
           .replace(/ؤ/g, 'و')
           .replace(/ئ/g, 'ي');

  // 3. Delete punctuation
  res = res.replace(/[؟\?\!\.\,\؛\;\:\"\'\(\)\[\]\{\}\«\»\…]/g, '');

  // 4. Convert Arabic-Indic digits to English digits and lowercase
  res = res.replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 1632 + 48));
  res = res.toLowerCase();

  // 5. Collapse spaces and trim
  res = res.replace(/\s+/g, ' ').trim();

  // 6. Synonym replacements (as whole words)
  const db = globalThis.sanadDb;
  if (db) {
    if (!synonymsCache) {
      try {
        const rows = db.prepare('SELECT term, canonical FROM synonyms').all();
        synonymsCache = rows.map(r => ({
          term: r.term,
          canonical: r.canonical
        }));
        synonymsCache.sort((a, b) => b.term.length - a.term.length);
      } catch (e) {
        // Table might not exist yet during migration
        synonymsCache = [];
      }
    }

    if (synonymsCache && synonymsCache.length > 0) {
      for (const syn of synonymsCache) {
        const isArabic = /^[\u0600-\u06FF]/.test(syn.term);
        const pattern = isArabic ? `(?:ال)?${escapeRegExp(syn.term)}` : escapeRegExp(syn.term);
        const regex = new RegExp(`(?<=^|\\s)${pattern}(?=\\s|$)`, 'g');
        res = res.replace(regex, syn.canonical);
      }
      res = res.replace(/\s+/g, ' ').trim();
    }
  }

  return res;
}

/**
 * Detects the language of the text.
 * If the ratio of Arabic script characters to the total alphabetical (Arabic + English) characters is >= 30%, returns 'ar', else 'en'.
 */
export function detectLang(text) {
  if (!text) return 'ar';
  const arabicMatches = text.match(/[\u0600-\u06FF]/g) || [];
  const englishMatches = text.match(/[a-zA-Z]/g) || [];
  const totalLetters = arabicMatches.length + englishMatches.length;
  if (totalLetters === 0) return 'ar';
  return (arabicMatches.length / totalLetters >= 0.3) ? 'ar' : 'en';
}

/**
 * Splits normalized text by spaces, and filters out stop words with length <= 1.
 */
export function tokens(norm) {
  if (!norm) return [];
  // Strip "ال" prefix from words to allow definite/indefinite matching
  const cleanNorm = norm.split(/\s+/).map(w => w.replace(/^ال([\u0600-\u06FF]{2,})$/, '$1')).join(' ');
  return cleanNorm.split(/\s+/).filter(t => t.length > 1);
}

/**
 * Generates the set of 3-character n-grams (trigrams) of the normalized text after removing all spaces.
 */
export function trigrams(norm) {
  // Strip "ال" prefix from words to allow definite/indefinite matching
  const cleanNorm = norm.split(/\s+/).map(w => w.replace(/^ال([\u0600-\u06FF]{2,})$/, '$1')).join(' ');
  const clean = cleanNorm.replace(/\s+/g, '');
  const set = new Set();
  if (clean.length < 3) {
    if (clean.length > 0) {
      set.add(clean);
    }
    return set;
  }
  for (let i = 0; i <= clean.length - 3; i++) {
    set.add(clean.substring(i, i + 3));
  }
  return set;
}
