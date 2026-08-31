import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFilePromise = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * Extracts the last valid JSON block from a string.
 */
function extractLastJson(stdout) {
  if (!stdout) return null;
  const openIndices = [];
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === '{') openIndices.push(i);
  }
  
  for (let i = openIndices.length - 1; i >= 0; i--) {
    const start = openIndices[i];
    const endIndices = [];
    for (let j = start; j < stdout.length; j++) {
      if (stdout[j] === '}') endIndices.push(j);
    }
    for (let j = endIndices.length - 1; j >= 0; j--) {
      const end = endIndices[j];
      const chunk = stdout.slice(start, end + 1);
      try {
        const parsed = JSON.parse(chunk);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch (err) {
        // Ignore and try the next candidate pair
      }
    }
  }
  return null;
}

/**
 * External model helper, configured entirely from the environment.
 *
 *   SANAD_BRAIN_CMD   executable that receives the prompt as its first argument
 *                     and prints a JSON object on stdout.
 *   SANAD_BRAIN_ARGS  extra arguments appended after the prompt.
 *
 * Safe default: unset means every model call is a no-op that returns null.
 * The live reply path never calls the model, so the bot works fully without it.
 */
export const BRAIN_CMD = process.env.SANAD_BRAIN_CMD || '';
export const BRAIN_ARGS = (process.env.SANAD_BRAIN_ARGS || '--json')
  .split(' ')
  .filter(Boolean);

/**
 * Single wrapper to call the external model helper process.
 */
export async function callBrain(prompt, { timeoutMs = 90000 } = {}) {
  if (process.env.SANAD_NO_BRAIN === '1') {
    return null;
  }
  if (!BRAIN_CMD) {
    return null;
  }

  try {
    const { stdout } = await execFilePromise(
      BRAIN_CMD,
      [prompt, ...BRAIN_ARGS],
      { cwd: projectRoot, timeout: timeoutMs }
    );

    const parsed = extractLastJson(stdout);
    if (!parsed) {
      console.warn('callBrain: No valid JSON found in stdout');
      return null;
    }
    return parsed;
  } catch (error) {
    console.warn('callBrain failed:', error.message || error);
    return null;
  }
}

/**
 * Translates a given text to a target language.
 */
export async function translate(text, toLang) {
  const prompt = `Translate the following text to ${toLang}. Text: "${text}". Respond with JSON only in this format: {"translation": "..."}. Do not include any other text. أجب بـ JSON فقط بلا أي نص آخر.`;
  const res = await callBrain(prompt);
  return res && typeof res.translation === 'string' ? res.translation : null;
}

/**
 * Checks if the question has the same meaning as any of the candidates (up to 3).
 * Candidates are expected to be objects like: { title, variant }
 */
export async function sameMeaning(question, candidates) {
  const candidatesStr = candidates
    .map((c, i) => `Candidate ${i}: Title: "${c.title}", Best Variant: "${c.variant}"`)
    .join('\n');
  const prompt = `Determine if the following question has the same meaning as any of the candidates.
Question: "${question}"
Candidates:
${candidatesStr}
Respond with JSON only in this format: {"match_index": 0|1|2|-1} where 0, 1, 2 are the indices of the matching candidate, or -1 if none match. Do not include any other text. أجب بـ JSON فقط بلا أي نص آخر.`;
  
  const res = await callBrain(prompt);
  if (res && typeof res.match_index === 'number') {
    return res.match_index;
  }
  return null;
}

/**
 * Generates paraphrased versions of a question.
 */
export async function paraphrase(question, lang, n) {
  const dialectNote = lang === 'ar' ? ' (Make sure about half of them are in Saudi or Gulf dialect / عامية سعودية أو خليجية)' : '';
  const prompt = `Generate ${n} paraphrases of the following question in ${lang} with the exact same meaning${dialectNote}.
Question: "${question}"
Respond with JSON only in this format: {"paraphrases": ["...", ...]}. Do not include any other text. أجب بـ JSON فقط بلا أي نص آخر.`;
  
  const res = await callBrain(prompt);
  if (res && Array.isArray(res.paraphrases)) {
    return res.paraphrases;
  }
  return null;
}

/**
 * Generates draft training answers and variants from a source.
 */
export async function generateSourceTraining(source) {
  const prompt = `هذا توجيه من مدير النظام عن خدمة/فورم داخلية: العنوان: ${source.title}، الرابط: ${source.url}، التوجيه: ${source.guidance}. ولّد تدريباً لبوت دعم يرد على الموظفين: أعطني JSON فقط بالشكل {"title":"عنوان قصير","body_ar":"جواب عربي واضح ومهذب يشرح متى وكيف تستخدم هذه الخدمة ويتضمن الرابط بصيغة ماركداون [${source.title}](${source.url})","body_en":"الترجمة الإنجليزية للجواب نفسه","variants_ar":["12 صيغة سؤال متوقعة من موظفين عن هذه الخدمة بالعربي بينها عامية سعودية"],"variants_en":["6 صيغ إنجليزية"]}. الجواب يُبنى حصرياً من التوجيه المعطى — لا تخترع مزايا أو شروطاً لم تُذكر.`;
  
  const res = await callBrain(prompt);
  if (res && typeof res === 'object') {
    if (
      typeof res.title === 'string' &&
      typeof res.body_ar === 'string' &&
      typeof res.body_en === 'string' &&
      Array.isArray(res.variants_ar) &&
      Array.isArray(res.variants_en)
    ) {
      return res;
    }
  }
  return null;
}

export async function generateClusterDraft(leadQuestion) {
  const prompt = `هذا السؤال متكرر في طابور الأسئلة: "${leadQuestion}". اقترح جواباً مهنياً لموظف IT — سيراجعه المدير قبل الاعتماد. أجب بـ JSON فقط بالتنسيق التالي: {"title":"عنوان قصير","body_ar":"الجواب المقترح بالعربية","body_en":"الجواب المقترح بالإنجليزية","variants_ar":["6 صيغ أسئلة متوقعة بالعربية"],"variants_en":["3 صيغ بالإنجليزية"]}. لا تكتب أي نص آخر خارج الـ JSON.`;
  const res = await callBrain(prompt);
  if (res && typeof res === 'object') {
    if (
      typeof res.title === 'string' &&
      typeof res.body_ar === 'string' &&
      typeof res.body_en === 'string' &&
      Array.isArray(res.variants_ar) &&
      Array.isArray(res.variants_en)
    ) {
      return res;
    }
  }
  return null;
}

