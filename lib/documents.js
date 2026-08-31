import pdf from 'pdf-parse';
import * as XLSX from 'xlsx';

/**
 * Extracts plain text from a document buffer.
 * Support PDF (using pdf-parse), Excel/CSV/TXT (using xlsx / plain decoding).
 * 
 * @param {string} kind - 'pdf', 'xlsx', 'csv', 'txt'
 * @param {Buffer} buffer - File buffer
 * @returns {Promise<string>} Extracted text
 */
export async function extractText(kind, buffer) {
  if (kind === 'pdf') {
    let data;
    try {
      data = await pdf(buffer);
    } catch (e) {
      throw new Error('تعذر قراءة هذا الـPDF — قد يكون ممسوحاً ضوئياً (صور) أو تالفاً؛ أحتاج نسخة نصية');
    }
    const text = data.text;
    if (!text || text.trim().length < 20) {
      throw new Error('يبدو أن الـPDF ممسوح ضوئياً (صور) — أحتاج نسخة نصية');
    }
    return text;
  } else if (kind === 'xlsx') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    let sheetsText = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      sheetsText.push(`### Sheet: ${sheetName}\n${csv}`);
    }
    return sheetsText.join('\n');
  } else if (kind === 'csv' || kind === 'txt') {
    let text = buffer.toString('utf8');
    if (text.startsWith('\uFEFF')) {
      text = text.substring(1);
    }
    return text;
  } else {
    throw new Error(`Unsupported document kind: ${kind}`);
  }
}

/**
 * Splits text into chunks of at most `size` characters, with `overlap` characters overlap.
 * Tries to split on line boundaries (newlines) where possible.
 * 
 * @param {string} text - The input text
 * @param {number} size - Max chunk size (default 2500)
 * @param {number} overlap - Overlap size (default 200)
 * @returns {string[]} List of chunks
 */
export function chunkText(text, size = 2500, overlap = 200) {
  if (!text) return [];
  if (text.length <= size) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + size;
    if (end >= text.length) {
      chunks.push(text.substring(start));
      break;
    }

    // Look for a newline backwards from end
    let splitPoint = text.lastIndexOf('\n', end);

    if (splitPoint !== -1 && splitPoint > start) {
      // Split at the newline (including the newline itself in the chunk)
      chunks.push(text.substring(start, splitPoint + 1));

      // Calculate next start with overlap
      let nextStart = (splitPoint + 1) - overlap;
      if (nextStart < start) {
        nextStart = start;
      }

      // Try to align nextStart with a newline to start the next chunk cleanly
      let nextNewline = text.indexOf('\n', nextStart);
      if (nextNewline !== -1 && nextNewline < splitPoint) {
        start = nextNewline + 1;
      } else {
        start = nextStart;
      }
    } else {
      // No newline found, force split
      chunks.push(text.substring(start, end));
      start = end - overlap;
    }
  }

  return chunks;
}
