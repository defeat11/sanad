import db from './db.js';
import { normalize } from './normalize.js';
import { similarity } from './matcher.js';

// Seed default skills if the skills table is empty
export function seedSkills() {
  try {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM skills').get();
    if (row && row.cnt === 0) {
      const insert = db.prepare(`
        INSERT INTO skills (name, description, triggers_json, template, enabled)
        VALUES (?, ?, ?, ?, ?)
      `);

      insert.run(
        'الترحيب',
        'مهارة الترحيب بالمستخدم',
        JSON.stringify(['السلام عليكم', 'هلا', 'مرحبا', 'hello', 'hi']),
        'وعليكم السلام! أنا سَنَد 🤝 اسألني وسأجيبك مما درّبني عليه مدرّبي',
        1
      );

      insert.run(
        'الوقت',
        'مهارة عرض الوقت الحالي بتوقيت الرياض',
        JSON.stringify(['كم الساعة', 'what time is it']),
        'الساعة الآن {time} بتوقيت الرياض',
        1
      );
    }
  } catch (err) {
    console.error('Failed to seed skills:', err);
  }
}

// Run seed immediately upon importing the module
seedSkills();

/**
 * Renders a skill template by replacing placeholders:
 * - {time} -> Riyadh time (HH:mm)
 * - {date} -> Gregorian date (YYYY-MM-DD)
 * - {question} -> The raw user question
 */
export function renderTemplate(template, questionRaw) {
  if (!template) return '';
  const now = new Date();

  // Riyadh time in HH:mm format
  const timeString = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Riyadh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now);

  // Gregorian date in YYYY-MM-DD format
  const dateString = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  return template
    .replace(/{time}/g, timeString)
    .replace(/{date}/g, dateString)
    .replace(/{question}/g, questionRaw || '');
}

/**
 * Matches a normalized query against all enabled skills.
 * If the highest similarity score is >= T_AUTO (0.85), returns the matched skill details and the rendered reply.
 */
export function matchSkill(q_norm, questionRaw) {
  const T_AUTO = 0.85;
  let enabledSkills = [];
  try {
    enabledSkills = db.prepare('SELECT * FROM skills WHERE enabled = 1').all();
  } catch (err) {
    console.error('Failed to fetch enabled skills:', err);
    return null;
  }

  let bestMatch = null;
  let highestScore = -1;

  for (const skill of enabledSkills) {
    let triggers = [];
    try {
      triggers = JSON.parse(skill.triggers_json);
    } catch (e) {
      continue;
    }
    if (!Array.isArray(triggers)) continue;

    for (const trigger of triggers) {
      const triggerNorm = normalize(trigger);
      const score = similarity(q_norm, triggerNorm);
      if (score > highestScore) {
        highestScore = score;
        bestMatch = {
          skill,
          score
        };
      }
    }
  }

  if (bestMatch && highestScore >= T_AUTO) {
    return {
      skill: bestMatch.skill,
      score: highestScore,
      reply: renderTemplate(bestMatch.skill.template, questionRaw)
    };
  }

  return null;
}
