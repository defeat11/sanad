# Sanad — a support bot that does not invent answers

[العربية](README.md)

**An employee question goes in, in Arabic or English — a sourced answer comes out, or an explicit "I don't know."**

One Node.js server: 12,455 source lines (dependencies not counted), 6 npm packages, 40 E2E tests, 19 SQLite tables.

It normalizes the question, matches it against a human-approved answer base, then replies. The language model is never allowed to write the user's reply. That is a boundary in the code, not a line in the docs.

It runs offline. The embedding model is fully local (130 MB inside `data/models`).

---

## The problem

Employees ask the help desk the same questions every day: password, printer, leave balance.

The obvious fix is a bot built on a language model. But the model does not know the internal systems, so it invents steps that look correct.

An employee running an invented step against a production system is a bigger problem than the question they started with.

Sanad reverses the order: match first, and admitting ignorance is an acceptable outcome.

---

## How it works

**1. Arabic normalization.** Strips diacritics and tatweel. Folds `أ إ آ ٱ` to `ا`, `ة` to `ه`, and `ى` to `ي`. Converts Arabic-Indic digits to Western ones. Then substitutes stored synonyms, such as `باسورد` for `كلمة المرور`.

**2. Hybrid matching.** Two independent scores are computed, and the higher one wins:

| Layer | Score | Catches |
|---|---|---|
| Lexical | `0.5 × Jaccard` over words + `0.5 × Dice` over character trigrams | near-identical phrasing |
| Semantic | cosine over 384-dimension vectors (multilingual MiniLM, ONNX q8) | one meaning, different words |

**3. Three thresholds.** This is where the entire decision lives:

| Score | Behavior |
|---|---|
| 0.85 and above | replies with the approved answer, and **stores the new phrasing** automatically |
| 0.55 to 0.85 | shows "did you mean?" with three titles, and sends the case to a background judge |
| below 0.55 | admits it does not know, and puts the question in the trainer queue |

### Proof: the lexical layer alone, no database and no vectors

```
in  : "كيف أُغيِّرُ كَلِمَةَ المُرورِ؟"  |  "كيف اغير كلمة المرور"
norm: "كيف اغير كلمه المرور"        |  "كيف اغير كلمه المرور"
lang=ar  score=1.000   -> رد فوري

in  : "الطابعه ما تطبع"             |  "الطابعة لا تطبع"
norm: "الطابعه ما تطبع"             |  "الطابعه لا تطبع"
lang=ar  score=0.583   -> "هل تقصد؟"

in  : "كم رصيد إجازاتي؟"            |  "وش رصيد الاجازات"
norm: "كم رصيد اجازاتي"             |  "وش رصيد الاجازات"
lang=ar  score=0.481   -> "لا أعرف" + طابور
```

The third case is why the semantic layer exists: both questions mean the same thing, yet their lexical score is only 0.481.

---

## The key design decision

**The problem:** every support bot built on a language model invents answers about systems it has never seen.

**The decision:** the live reply path never calls the model. This is not an operating rule, it is structure: `lib/engine.js` and `routes/chat.js` contain 0 calls to `callBrain`, and neither one imports `lib/brain.js` at all. That file is imported in 4 places only, all of them off the reply path: a background worker, a trainer, an examiner, and the training dashboard.

**The cost:** the bot answers only what it was trained on. And the answer base starts at 0 answers.

**The return:** 0 invented answers, and 0 network requests on the reply path. The reply comes out of a local SQLite file.

The model works backstage only, and asynchronously: it judges mid-range matches and its verdict is cached, it proposes alternative phrasings **for the trainer to approve**, and it translates content.

---

## Running it

```bash
npm install     # downloads the embedding model once into data/models
npm start       # http://127.0.0.1:4600
npm run verify  # 40 E2E tests against a temporary database, then deletes it
```

The server listens on `127.0.0.1` only, not on every interface.

| Variable | What it does |
|---|---|
| `PORT` | the port. Defaults to 4600 |
| `SANAD_DB` | path to the SQLite database |
| `SANAD_NO_BRAIN=1` | disables every model call. Test mode |
| `SANAD_NO_EMBED=1` | disables vectors, leaves the lexical matcher on its own |
| `SANAD_BRAIN_CMD` | the external model command. Takes the prompt as its first argument and prints JSON. Empty means no model call is ever made |
| `SANAD_BRAIN_ARGS` | extra arguments appended after the prompt. Defaults to `--json` |
| `SANAD_TG_TOKEN` | Telegram bot token. Optional, and redacted from every log |
| `SANAD_TG_ALLOWLIST` | the chats that are allowed. Anything else is logged and refused |
| `SANAD_TG_ADMIN` | the trainer's chat id |

Every secret comes from the environment. Not one key inside the code.

The Telegram channel is capped at 20 messages per minute per chat. The server takes a backup every 24 hours and keeps the last 14.

---

## Why I built it

I work as an IT supervisor. The help desk answers the same questions every day.

I built the engine only: the answer base starts at 0 answers, and each organization fills it with its own content.

---

MIT — © 2026 Osaid Ahmad
