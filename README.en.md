# Sanad — a support bot that does not invent answers

[العربية](README.md)

**An employee asks a question in Arabic or English. Out comes a sourced answer, or a clear "I don't know."**

One Node.js server: 12,455 source lines (dependencies not counted), 6 npm packages, 40 E2E tests, 19 SQLite tables.

It normalizes the question. Then it matches it against a human-approved answer base, and replies. The language model never writes the user's reply. The code blocks this. It is not a rule in the docs.

It runs offline. The embedding model is fully local (130 MB inside `data/models`).

---

## The problem

Employees ask the help desk the same questions every day: password, printer, leave balance.

The obvious fix is a bot built on a language model. But the model does not know the internal systems, so it invents steps that look correct.

The employee then runs an invented step on a production system. That is a bigger problem than the first question.

Sanad works the other way. It matches first. And "I don't know" is an acceptable answer.

---

## How it works

**1. Arabic normalization.** Strips diacritics and tatweel. Folds `أ إ آ ٱ` to `ا`, `ة` to `ه`, and `ى` to `ي`. Converts Arabic-Indic digits to Western ones. Then it swaps in stored synonyms, such as `باسورد` for `كلمة المرور`.

**2. Hybrid matching.** It computes two separate scores. The higher one wins:

| Layer | Score | Catches |
|---|---|---|
| Lexical | `0.5 × Jaccard` over words + `0.5 × Dice` over character trigrams | almost the same wording |
| Semantic | cosine over 384-dimension vectors (multilingual MiniLM, ONNX q8) | same meaning, different words |

**3. Three thresholds.** The whole decision happens here:

| Score | Behavior |
|---|---|
| 0.85 and above | sends the approved answer, and **saves the new phrasing** automatically |
| 0.55 to 0.85 | shows "did you mean?" with three titles, and sends the case to a background judge |
| below 0.55 | says it does not know, and puts the question in the trainer queue |

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

The third case shows why the semantic layer exists. Both questions mean the same thing. But their lexical score is only 0.481.

---

## The key design decision

**The problem:** every support bot built on a language model invents answers. It never saw the internal systems.

**The decision:** the live reply path never calls the model. This is structure, not an operating rule. `lib/engine.js` and `routes/chat.js` contain 0 calls to `callBrain`. Neither one imports `lib/brain.js` at all. That file is imported in 4 places only. All of them sit off the reply path: a background worker, a trainer, an examiner, and the training dashboard.

**The cost:** the bot answers only what it was trained on. And the answer base starts at 0 answers.

**The return:** 0 invented answers, and 0 network requests on the reply path. The reply comes out of a local SQLite file.

The model works backstage only, and always asynchronously. It judges mid-range matches, and the server caches the verdict. It proposes other phrasings **for the trainer to approve**. It also translates content.

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
| `SANAD_NO_BRAIN=1` | turns off every model call. Test mode |
| `SANAD_NO_EMBED=1` | turns off vectors. The lexical matcher works alone |
| `SANAD_BRAIN_CMD` | the external model command. It takes the prompt as first argument and prints JSON. If empty, the server never calls a model |
| `SANAD_BRAIN_ARGS` | extra arguments added after the prompt. Defaults to `--json` |
| `SANAD_TG_TOKEN` | Telegram bot token. Optional, and redacted from every log |
| `SANAD_TG_ALLOWLIST` | the chats that are allowed. The server logs and refuses anything else |
| `SANAD_TG_ADMIN` | the trainer's chat id |

Every secret comes from the environment. Not one key inside the code.

The Telegram channel has a limit of 20 messages per minute per chat. The server makes a backup every 24 hours, and keeps the last 14.

---

## Why I built it

I work as an IT supervisor. The help desk answers the same questions every day.

I built the engine only. The answer base starts at 0 answers. Each organization fills it with its own content.

---

MIT — © 2026 Osaid Ahmad
