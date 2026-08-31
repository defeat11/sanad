import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

test('E2E Sanad Bot Test Suite', async (t) => {
  let serverProcess;
  const dbPath = path.join(projectRoot, 'data', 'test.db');

  t.before(async () => {
    // 1. Delete test.db before starting
    if (fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
        console.log('Deleted existing test database:', dbPath);
      } catch (e) {
        console.warn('Could not delete test.db:', e.message);
      }
    }

    // Ensure data directory exists
    const dataDir = path.join(projectRoot, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 2. Set environment variables
    process.env.SANAD_NO_BRAIN = '1';
    process.env.PORT = '4601';
    process.env.SANAD_DB = 'data/test.db';
    process.env.SANAD_TG_TOKEN = '';
    process.env.SANAD_TG_ADMIN = '';

    console.log('Starting server in background on port 4601...');
    serverProcess = spawn('node', ['server.js'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env
    });

    // Wait for the server to be ready by polling /api/stats
    const start = Date.now();
    const timeoutMs = 60000;
    let ready = false;
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch('http://127.0.0.1:4601/api/stats');
        if (res.ok) {
          ready = true;
          break;
        }
      } catch (e) {
        // server connection not ready yet, wait and retry
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!ready) {
      throw new Error('Server did not start in time or stats endpoint failed');
    }
    console.log('Server is ready. Running E2E tests...');
  });

  t.after(() => {
    if (serverProcess) {
      console.log('Stopping server process...');
      serverProcess.kill('SIGTERM');
    }
    if (fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
        console.log('Cleaned up test database:', dbPath);
      } catch (e) {
        // Ignore errors during final cleanup
      }
    }
  });

  let answerId;

  await t.test('1. POST /api/answers should create an answer and variants', async () => {
    const res = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'إعادة تعيين كلمة المرور',
        body_ar: 'لتغيير كلمة المرور، اذهب إلى الإعدادات',
        body_en: 'To change your password, go to Settings',
        variants: ['إعادة تعيين كلمة المرور', 'Reset Password']
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    answerId = data.id;
  });

  await t.test('2. POST /api/chat with exact variant', async () => {
    const res = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'test-session-1',
        text: 'إعادة تعيين كلمة المرور'
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.reply, 'لتغيير كلمة المرور، اذهب إلى الإعدادات');
    assert.strictEqual(data.queued, false);
  });

  await t.test('3. POST /api/chat with close variant (learns variant)', async () => {
    const resListBefore = await fetch('http://127.0.0.1:4601/api/answers');
    const answersBefore = await resListBefore.json();
    const targetBefore = answersBefore.find((a) => a.id === answerId);
    const initialCount = targetBefore.variants_count;

    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'test-session-1',
        text: 'كيف إعادة تعيين كلمة المرور' // similar wording, triggers T_AUTO (>= 0.85) without exact name duplicate
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();
    assert.strictEqual(chatData.reply, 'لتغيير كلمة المرور، اذهب إلى الإعدادات');

    const resListAfter = await fetch('http://127.0.0.1:4601/api/answers');
    const answersAfter = await resListAfter.json();
    const targetAfter = answersAfter.find((a) => a.id === answerId);
    assert.ok(targetAfter.variants_count > initialCount, `Expected variants_count to increase from ${initialCount}`);
  });

  await t.test('4. POST /api/chat with foreign question should queue it', async () => {
    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'test-session-1',
        text: 'ما هي عاصمة اليابان'
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();
    assert.strictEqual(chatData.queued, true);

    const resQueue = await fetch('http://127.0.0.1:4601/api/queue');
    const queue = await resQueue.json();
    const item = queue.find((q) => q.question_raw === 'ما هي عاصمة اليابان');
    assert.ok(item);
    assert.strictEqual(item.status, 'pending');
  });

  await t.test('5. POST /api/queue/:id/answer should resolve queue item', async () => {
    const resQueueBefore = await fetch('http://127.0.0.1:4601/api/queue');
    const queueBefore = await resQueueBefore.json();
    const item = queueBefore.find((q) => q.question_raw === 'ما هي عاصمة اليابان');
    assert.ok(item);

    const resAnswer = await fetch(`http://127.0.0.1:4601/api/queue/${item.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'عاصمة اليابان',
        body_ar: 'عاصمة اليابان هي طوكيو'
      })
    });
    assert.strictEqual(resAnswer.status, 200);

    const resQueueAfter = await fetch('http://127.0.0.1:4601/api/queue');
    const queueAfter = await resQueueAfter.json();
    const itemAfter = queueAfter.find((q) => q.id === item.id);
    assert.ok(!itemAfter);
  });

  await t.test('6. Skills greeting test', async () => {
    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'test-session-1',
        text: 'السلام عليكم'
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();
    assert.ok(chatData.reply);
  });

  await t.test('7. Export and Import', async () => {
    const resExport = await fetch('http://127.0.0.1:4601/api/export');
    assert.strictEqual(resExport.status, 200);
    const payload = await resExport.json();

    const resImport = await fetch('http://127.0.0.1:4601/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.strictEqual(resImport.status, 200);

    const resList = await fetch('http://127.0.0.1:4601/api/answers');
    const answers = await resList.json();
    const target = answers.find((a) => a.id === answerId);
    assert.ok(target);
  });

  await t.test('8. Language: English question with English variant', async () => {
    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'test-session-1',
        text: 'Reset Password'
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();
    assert.strictEqual(chatData.reply, 'To change your password, go to Settings');
  });

  await t.test('9. Synonyms test', async () => {
    // Train an answer with variant "كيف اغير كلمه المرور"
    const resCreate = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'تغيير كلمة المرور',
        body_ar: 'لتغيير كلمة المرور، اذهب إلى الإعدادات ثم الأمان',
        variants: ['كيف اغير كلمه المرور']
      })
    });
    assert.strictEqual(resCreate.status, 200);
    
    // Query chat with "كيف اغير الباسورد"
    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'synonyms-session',
        text: 'كيف اغير الباسورد'
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();
    assert.strictEqual(chatData.reply, 'لتغيير كلمة المرور، اذهب إلى الإعدادات ثم الأمان');
  });

  await t.test('10. Feedback test', async () => {
    // 1. Post to chat to get a chat_id
    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'feedback-session',
        text: 'سؤال عشوائي جدا غير موجود'
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();
    assert.ok(chatData.chat_id);
    
    // 2. Post vote -1 (👎) to /api/feedback
    const resFeedback = await fetch('http://127.0.0.1:4601/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatData.chat_id,
        vote: -1
      })
    });
    assert.strictEqual(resFeedback.status, 200);
    
    // 3. Verify it appears in the queue
    const resQueue = await fetch('http://127.0.0.1:4601/api/queue');
    assert.strictEqual(resQueue.status, 200);
    const queue = await resQueue.json();
    const item = queue.find(q => q.question_raw === 'سؤال عشوائي جدا غير موجود');
    assert.ok(item);
    assert.strictEqual(item.status, 'pending');
  });

  await t.test('11. Deterministic exam test', async () => {
    // Create an answer with 4 similar variants
    const resCreate = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'امتحان حتمي',
        body_ar: 'الرد على امتحان حتمي',
        variants: [
          'كيف يمكنني استعادة كلمة السر',
          'كيف استعادة كلمة السر',
          'طريقة استعادة كلمة السر',
          'استعادة كلمة السر'
        ]
      })
    });
    assert.strictEqual(resCreate.status, 200);
    const createData = await resCreate.json();
    const examAnswerId = createData.id;

    // Trigger exam
    const resExam = await fetch('http://127.0.0.1:4601/api/exam', {
      method: 'POST'
    });
    assert.strictEqual(resExam.status, 200);
    const examData = await resExam.json();
    
    // Retrieve results (support either array or object containing results)
    const results = Array.isArray(examData) ? examData : (examData.results || []);
    const ourResult = results.find(r => r.answer_id === examAnswerId);
    
    assert.ok(ourResult, 'Exam result for the test answer should exist');
    assert.ok(ourResult.score > 0, 'Exam score should be greater than 0');
  });

  await t.test('12. Clustering test', async () => {
    // 1. Send two very similar unknown questions
    const q1 = 'كيف احصل على تحديث جديد للبرنامج';
    const q2 = 'كيف احصل على التحديث الجديد للبرنامج';

    await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 'cluster-session', text: q1 })
    });
    await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 'cluster-session', text: q2 })
    });

    // 2. Fetch the queue and look for clusters
    const resQueue = await fetch('http://127.0.0.1:4601/api/queue');
    assert.strictEqual(resQueue.status, 200);
    const queue = await resQueue.json();
    
    // Find the item corresponding to q1 or q2
    const president = queue.find(q => q.question_raw === q1 || q.question_raw === q2);
    assert.ok(president);
    
    const similarList = president.similar || president.similar_questions || president.duplicates || [];
    assert.ok(similarList.length > 0, 'Should find at least one similar question grouped');
    
    const similarId = similarList[0].id;
    
    // 3. Resolve the president with include_ids to close both
    const resResolve = await fetch(`http://127.0.0.1:4601/api/queue/${president.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'تحديث البرنامج',
        body_ar: 'تحديث البرنامج يتم عبر المتجر',
        include_ids: [similarId]
      })
    });
    assert.strictEqual(resResolve.status, 200);
    
    // 4. Verify both are gone from queue
    const resQueueAfter = await fetch('http://127.0.0.1:4601/api/queue');
    const queueAfter = await resQueueAfter.json();
    const found1 = queueAfter.some(q => q.id === president.id || q.id === similarId);
    assert.strictEqual(found1, false);
  });

  await t.test('13. CSV Import and Export test', async () => {
    // 3 lines (header + 2 rows for the same answer)
    const csvContent = 'question,answer\nكيف افعل الحساب الجديد,طريقة التفعيل تتم عبر الايميل\nطريقة تفعيل الحساب الجديد,طريقة التفعيل تتم عبر الايميل\n';
    
    let resImport;
    // Attempt 1: multipart/form-data with field name 'file'
    try {
      const formData = new FormData();
      formData.append('file', new Blob([csvContent], { type: 'text/csv' }), 'test.csv');
      resImport = await fetch('http://127.0.0.1:4601/api/import-csv', {
        method: 'POST',
        body: formData
      });
    } catch (e) {
      // ignore
    }
    
    // Attempt 2: If Attempt 1 is not successful, try sending raw text/csv
    if (!resImport || resImport.status !== 200) {
      try {
        resImport = await fetch('http://127.0.0.1:4601/api/import-csv', {
          method: 'POST',
          headers: { 'Content-Type': 'text/csv' },
          body: csvContent
        });
      } catch (e) {
        // ignore
      }
    }
    
    // Attempt 3: If still not successful, try sending JSON payload { csv: csvContent }
    if (!resImport || resImport.status !== 200) {
      try {
        resImport = await fetch('http://127.0.0.1:4601/api/import-csv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: csvContent })
        });
      } catch (e) {
        // ignore
      }
    }

    assert.strictEqual(resImport.status, 200);

    // Verify it created 1 answer with 2 variants
    const resAnswers = await fetch('http://127.0.0.1:4601/api/answers');
    assert.strictEqual(resAnswers.status, 200);
    const answers = await resAnswers.json();
    const createdAnswer = answers.find(a => a.body_ar === 'طريقة التفعيل تتم عبر الايميل');
    assert.ok(createdAnswer);
    assert.strictEqual(createdAnswer.variants_count, 2);

    // Test export-csv
    const resExportCsv = await fetch('http://127.0.0.1:4601/api/export-csv');
    assert.strictEqual(resExportCsv.status, 200);
    const exportText = await resExportCsv.text();
    assert.ok(exportText.includes('كيف افعل الحساب الجديد'));
    assert.ok(exportText.includes('طريقة التفعيل تتم عبر الايميل'));
  });

  await t.test('14. Escalation test', async () => {
    const session = 'escalation-session-test';
    
    // Send 1st unknown question
    const res1 = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, text: 'سؤال مجهول اول للتصعيد' })
    });
    assert.strictEqual(res1.status, 200);

    // Send 2nd unknown question in same session
    const res2 = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, text: 'سؤال مجهول ثاني للتصعيد' })
    });
    assert.strictEqual(res2.status, 200);
    const chatData2 = await res2.json();
    
    // Check reply includes escalation message
    assert.ok(chatData2.reply.includes('تحتاج مدرّبي شخصياً') || chatData2.reply.includes('لخّصتها له وسيصلك الجواب'));

    // Check last queue item has priority=1
    const resQueue = await fetch('http://127.0.0.1:4601/api/queue');
    const queue = await resQueue.json();
    const item = queue.find(q => q.question_raw === 'سؤال مجهول ثاني للتصعيد');
    assert.ok(item);
    assert.strictEqual(item.priority, 1);
  });

  await t.test('15. Token authentication test', async () => {
    console.log('Starting token-auth server in background on port 4602...');
    const tokenEnv = {
      ...process.env,
      SANAD_NO_BRAIN: '1',
      PORT: '4602',
      SANAD_DB: 'data/test_token.db',
      SANAD_TOKEN: 'secret-token-123',
      SANAD_TG_TOKEN: '',
      SANAD_TG_ADMIN: ''
    };
    
    const dbTokenPath = path.join(projectRoot, 'data', 'test_token.db');
    if (fs.existsSync(dbTokenPath)) {
      try {
        fs.unlinkSync(dbTokenPath);
      } catch (e) {}
    }
    
    const tokenServerProcess = spawn('node', ['server.js'], {
      cwd: projectRoot,
      stdio: 'ignore',
      env: tokenEnv
    });
    
    // Wait for the server to start (polling /api/answers and expecting 401 or 200)
    const start = Date.now();
    const timeoutMs = 15000;
    let tokenReady = false;
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch('http://127.0.0.1:4602/api/answers');
        if (res.status === 401 || res.status === 200) {
          tokenReady = true;
          break;
        }
      } catch (e) {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    
    if (!tokenReady) {
      tokenServerProcess.kill('SIGKILL');
      throw new Error('Token auth server did not start in time');
    }
    
    try {
      // 1. GET /api/answers without token -> 401
      const resNoToken = await fetch('http://127.0.0.1:4602/api/answers');
      assert.strictEqual(resNoToken.status, 401);
      
      // 2. GET /api/answers with token -> 200
      const resWithToken = await fetch('http://127.0.0.1:4602/api/answers', {
        headers: { 'Authorization': 'Bearer secret-token-123' }
      });
      assert.strictEqual(resWithToken.status, 200);
      
      // 3. POST /api/chat without token -> works (200)
      const resChat = await fetch('http://127.0.0.1:4602/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'token-chat-session',
          text: 'Hello'
        })
      });
      assert.strictEqual(resChat.status, 200);
    } finally {
      tokenServerProcess.kill('SIGTERM');
      await new Promise(resolve => {
        tokenServerProcess.on('exit', resolve);
        tokenServerProcess.on('error', resolve);
      });
      await new Promise(r => setTimeout(r, 500));
      if (fs.existsSync(dbTokenPath)) {
        try {
          fs.unlinkSync(dbTokenPath);
        } catch (e) {}
      }
    }
  });

  await t.test('17. Semantic match: true paraphrase with zero lexical overlap ("طابعة" vs "طباعة")', async () => {
    const createRes = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'مشكلة الطابعة',
        body_ar: 'أعد تشغيل الطابعة من الزر الخلفي ثم أعد المحاولة',
        variants: ['الطابعة لا تعمل ماذا افعل']
      })
    });
    assert.strictEqual(createRes.status, 200);
    const created = await createRes.json();

    // صياغة بجذر لغوي مختلف تماماً ("طباعة" لا "طابعة") — لفظياً تسجّل 0.0 مقاساً فعلياً
    const chatRes = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 'test-embed-1', text: 'جهاز الطباعة متعطل ابغى حل' })
    });
    assert.strictEqual(chatRes.status, 200);
    const data = await chatRes.json();
    assert.strictEqual(data.queued, false, 'should not be queued as unknown — semantic match must fire');
    assert.ok(data.matched, 'should have a matched answer');
    assert.strictEqual(data.matched.answer_id, created.id);
    assert.ok(data.matched.score >= 0.55, `score ${data.matched.score} should be >= T_BRAIN via semantic similarity`);
  });

  await t.test('18. Semantic match does not create false positives for unrelated questions', async () => {
    const chatRes = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 'test-embed-2', text: 'اين يقع برج ايفل' })
    });
    assert.strictEqual(chatRes.status, 200);
    const data = await chatRes.json();
    assert.strictEqual(data.queued, true, 'unrelated question must still be queued as unknown');
  });

  await t.test('19. Embeddings persisted: variant gets a row in embeddings table', async () => {
    // GET /api/stats أو نقطة وصول موجودة؛ إن لم توجد نقطة تكشف عدد embeddings مباشرة،
    // اختبر بشكل غير مباشر عبر تكرار سؤال §17 والتأكد أن الاستجابة سريعة ومطابقة (دلالة أن
    // الحساب لم يُعَد من الصفر بل استُرجع من الجدول). البديل الأدق: أضف عمود اختياري
    // إلى GET /api/stats: embeddings_count (COUNT(*) FROM embeddings)، واختبر أنه > 0.
    const statsRes = await fetch('http://127.0.0.1:4601/api/stats');
    const stats = await statsRes.json();
    assert.ok(stats.embeddings_count > 0, 'embeddings table should be populated after prior tests');
  });

  await t.test('20. SANAD_NO_EMBED=1 fallback still answers via lexical-only (spawned sub-check)', async () => {
    // اختبار عملية فرعية منفصلة بمنفذ مختلف للتأكد أن تعطيل الطبقة لا يكسر شيئاً
    const { spawn } = await import('node:child_process');
    const testPort = 4602;
    const env = {
      ...process.env,
      SANAD_NO_EMBED: '1',
      PORT: String(testPort),
      SANAD_DB: 'data/test-noembed.db',
      SANAD_TG_TOKEN: '',
      SANAD_TG_ADMIN: ''
    };
    const fs = await import('node:fs');
    const dbPath2 = path.join(projectRoot, 'data', 'test-noembed.db');
    if (fs.existsSync(dbPath2)) {
      try {
        fs.unlinkSync(dbPath2);
      } catch (e) {}
    }

    const proc = spawn('node', ['server.js'], { cwd: projectRoot, stdio: 'inherit', env });
    try {
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < 30000) {
        try {
          const r = await fetch(`http://127.0.0.1:${testPort}/api/stats`);
          if (r.ok) { ready = true; break; }
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(ready, 'server with SANAD_NO_EMBED=1 must still start');

      const chatRes = await fetch(`http://127.0.0.1:${testPort}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: 's', text: 'test' })
      });
      assert.strictEqual(chatRes.status, 200); // لا يكسر حتى بلا embeddings
    } finally {
      proc.kill('SIGTERM');
      await new Promise(resolve => {
        proc.on('exit', resolve);
        proc.on('error', resolve);
      });
      await new Promise(r => setTimeout(r, 500));
      if (fs.existsSync(dbPath2)) {
        try {
          fs.unlinkSync(dbPath2);
        } catch (e) {}
      }
      const dbWal = dbPath2 + '-wal';
      const dbShm = dbPath2 + '-shm';
      if (fs.existsSync(dbWal)) { try { fs.unlinkSync(dbWal); } catch (e) {} }
      if (fs.existsSync(dbShm)) { try { fs.unlinkSync(dbShm); } catch (e) {} }
    }
  });

  await t.test('21. Cross-lingual matching', async () => {
    // 1. Create an answer with only one Arabic variant
    const resCreate = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'مشكلة الطابعة العربية',
        body_ar: 'الرجاء إعادة تشغيل الطابعة من الزر الخلفي',
        variants: ['الطابعة لا تعمل ماذا افعل']
      })
    });
    assert.strictEqual(resCreate.status, 200);
    const createdAnswer = await resCreate.json();
    const ansId = createdAnswer.id;

    // 2. Ask in English: 'my printer is not working'
    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'cross-lingual-session',
        text: 'my printer is not working'
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();

    // Verify chat reply structure
    assert.strictEqual(chatData.queued, false);
    assert.ok(chatData.suggestions && chatData.suggestions.includes('مشكلة الطابعة العربية'));
    assert.ok(chatData.matched);
    assert.strictEqual(chatData.matched.answer_id, ansId);

    // 3. Verify one judge job was inserted in brain_jobs
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    try {
      const jobs = db.prepare("SELECT * FROM brain_jobs WHERE kind = 'judge' AND status = 'pending'").all();
      assert.ok(jobs.length >= 1, 'Expected at least one pending judge job');
      // Find the specific job for our query
      const myJob = jobs.find(job => {
        try {
          const payload = JSON.parse(job.payload);
          return payload.question_raw === 'my printer is not working';
        } catch (e) {
          return false;
        }
      });
      assert.ok(myJob, 'Expected to find a judge job for "my printer is not working"');
    } finally {
      db.close();
    }
  });

  await t.test('22. Brain cache verdict same works', async () => {
    // 1. Create an answer
    const resCreate = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'شاشة زرقاء',
        body_ar: 'أعد تشغيل الجهاز',
        variants: ['شاشة زرقاء تظهر عند التشغيل']
      })
    });
    assert.strictEqual(resCreate.status, 200);
    const createdAnswer = await resCreate.json();
    const ansId = createdAnswer.id;

    // Get variants count before
    const resListBefore = await fetch('http://127.0.0.1:4601/api/answers');
    const answersBefore = await resListBefore.json();
    const targetBefore = answersBefore.find((a) => a.id === ansId);
    const initialCount = targetBefore.variants_count;

    // 2. Insert into brain_cache manually (using better-sqlite3)
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    const questionText = 'عندي مشكلة الشاشة الزرقاء';
    
    // Set global db so normalize can fetch synonyms if needed
    globalThis.sanadDb = db;
    const { normalize } = await import('../lib/normalize.js');
    const questionNorm = normalize(questionText);

    try {
      db.prepare("INSERT INTO brain_cache (question_norm, answer_id, verdict) VALUES (?, ?, 'same')")
        .run(questionNorm, ansId);
    } finally {
      db.close();
    }

    // 3. Ask the question via /api/chat
    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'brain-cache-session',
        text: questionText
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();

    // Verify it answers directly using the cached answer
    assert.strictEqual(chatData.reply, 'أعد تشغيل الجهاز');
    assert.strictEqual(chatData.queued, false);
    assert.ok(chatData.matched);
    assert.strictEqual(chatData.matched.answer_id, ansId);
    assert.strictEqual(chatData.suggestions, null);

    // 4. Verify that a new variant was learned
    const resListAfter = await fetch('http://127.0.0.1:4601/api/answers');
    const answersAfter = await resListAfter.json();
    const targetAfter = answersAfter.find((a) => a.id === ansId);
    assert.ok(targetAfter.variants_count > initialCount, `Expected variants_count to increase from ${initialCount}`);
  });

  await t.test('23. No live translation', async () => {
    // 1. Create an answer with body_ar, no body_en, and an English variant
    const resCreate = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'دعم الطابعة',
        body_ar: 'الرجاء الاتصال بالدعم الفني',
        variants: ['contact support for printer']
      })
    });
    assert.strictEqual(resCreate.status, 200);
    const createdAnswer = await resCreate.json();
    const ansId = createdAnswer.id;

    // 2. Ask the English question in English
    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'live-trans-session',
        text: 'contact support for printer'
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();

    // Verify it responds immediately with body_ar
    assert.strictEqual(chatData.reply, 'الرجاء الاتصال بالدعم الفني');
    assert.strictEqual(chatData.queued, false);

    // 3. Verify that a translate_body job is pending in brain_jobs for this answer
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    try {
      const jobs = db.prepare("SELECT * FROM brain_jobs WHERE kind = 'translate_body' AND status = 'pending'").all();
      const job = jobs.find(j => {
        try {
          return JSON.parse(j.payload).answer_id === ansId;
        } catch(e) {
          return false;
        }
      });
      assert.ok(job, 'Expected a pending translate_body job for the answer');
    } finally {
      db.close();
    }
  });

  await t.test('24. Telegram disabled safely and formatTelegramReply works', async () => {
    const { formatTelegramReply } = await import('../lib/telegram.js');

    // Case 1: Result has suggestions
    const resultWithSuggestions = {
      reply: 'هل تقصد أحد الأسئلة التالية؟',
      matched: null,
      suggestions: ['اقتراح 1', 'اقتراح 2'],
      queued: false,
      chat_id: 123
    };
    const formatted1 = formatTelegramReply(resultWithSuggestions);
    assert.ok(formatted1.text);
    assert.ok(formatted1.reply_markup);
    assert.ok(formatted1.reply_markup.inline_keyboard);
    const suggestionButtons = formatted1.reply_markup.inline_keyboard.flat();
    assert.strictEqual(suggestionButtons.length, 2);

    // Case 2: Result has matched, but no suggestions
    const resultMatchedNoSuggestions = {
      reply: 'الرد الصحيح',
      matched: { answer_id: 456, score: 0.9 },
      suggestions: null,
      queued: false,
      chat_id: 789
    };
    const formatted2 = formatTelegramReply(resultMatchedNoSuggestions);
    assert.ok(formatted2.text);
    assert.ok(formatted2.reply_markup);
    assert.ok(formatted2.reply_markup.inline_keyboard);
    const buttons = formatted2.reply_markup.inline_keyboard.flat();
    assert.strictEqual(buttons.length, 2);
    assert.ok(buttons.some(b => b.callback_data === 'fb:789:1'));
    assert.ok(buttons.some(b => b.callback_data === 'fb:789:-1'));

    // Case 3: Result has neither matched nor suggestions
    const resultNone = {
      reply: 'لا يوجد رد',
      matched: null,
      suggestions: null,
      queued: true,
      chat_id: 999
    };
    const formatted3 = formatTelegramReply(resultNone);
    assert.ok(formatted3.text);
    assert.ok(!formatted3.reply_markup || !formatted3.reply_markup.inline_keyboard || formatted3.reply_markup.inline_keyboard.flat().length === 0);
  });

  await t.test('25. Pure allowlist check works', async () => {
    const { isAllowed } = await import('../lib/telegram.js');

    assert.strictEqual(isAllowed('123', '123,456'), true);
    assert.strictEqual(isAllowed('999', '123,456'), false);
    assert.strictEqual(isAllowed('999', ''), true);
    assert.strictEqual(isAllowed('999', undefined), true);

    // Also support numbers
    assert.strictEqual(isAllowed(123, '123,456'), true);
    assert.strictEqual(isAllowed(999, '123,456'), false);
  });

  await t.test('26. Self-Exam Lexical-only mode check', async () => {
    // 1. Create first answer with 4 close lexical variants
    const res1 = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'إعدادات الشبكة',
        body_ar: 'الرد على إعدادات الشبكة',
        variants: [
          'كيف اضبط اعدادات الشبكه',
          'اشرح لي اعدادات الشبكه',
          'كيف اضبط الشبكه',
          'اعدادات الشبكه كيف اضبطها'
        ]
      })
    });
    assert.strictEqual(res1.status, 200);
    const data1 = await res1.json();
    const ansId1 = data1.id;

    // 2. Create second answer with 3 semantically close but lexically distant variants
    const res2 = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'بطء الإنترنت',
        body_ar: 'الرد على بطء الإنترنت',
        variants: [
          'النت بطيء جدا',
          'الاتصال ضعيف عندي',
          'تصفح المواقع ياخذ وقت طويل'
        ]
      })
    });
    assert.strictEqual(res2.status, 200);
    const data2 = await res2.json();
    const ansId2 = data2.id;

    // 3. Trigger exam
    const resExam = await fetch('http://127.0.0.1:4601/api/exam', {
      method: 'POST'
    });
    assert.strictEqual(resExam.status, 200);
    const examData = await resExam.json();
    const results = examData.results || [];

    const exam1 = results.find(r => r.answer_id === ansId1);
    const exam2 = results.find(r => r.answer_id === ansId2);

    assert.ok(exam1, 'Exam result for answer 1 should exist');
    assert.ok(exam2, 'Exam result for answer 2 should exist');

    assert.ok(exam1.lexical, 'Lexical score for answer 1 should exist');
    assert.ok(exam2.lexical, 'Lexical score for answer 2 should exist');
    assert.ok(exam2.deterministic, 'Deterministic score for answer 2 should exist');

    console.log('Test 26 outputs - Answer 1 lexical:', exam1.lexical.score);
    console.log('Test 26 outputs - Answer 2 lexical:', exam2.lexical.score, 'deterministic:', exam2.deterministic.score);

    // 4. Verify: First lexical score > 0.5
    assert.ok(exam1.lexical.score > 0.5, `Answer 1 lexical score ${exam1.lexical.score} should be > 0.5`);

    // 5. Verify: Second lexical score is less than the first
    assert.ok(exam2.lexical.score < exam1.lexical.score, `Answer 2 lexical score ${exam2.lexical.score} should be less than Answer 1 lexical score ${exam1.lexical.score}`);

    // 6. Verify: Second deterministic score is higher than its lexical score
    assert.ok(exam2.deterministic.score > exam2.lexical.score, `Answer 2 deterministic score ${exam2.deterministic.score} should be higher than its lexical score ${exam2.lexical.score}`);
  });

  await t.test('27. CRUD of sources including validation', async () => {
    // 1. Invalid URL (without http/https) should be rejected with 400
    const resInvalid = await fetch('http://127.0.0.1:4601/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'ftp://example.com',
        title: 'Test Source',
        guidance: 'Guidance text'
      })
    });
    assert.strictEqual(resInvalid.status, 400);

    // 2. Create source with valid URL
    const resValid = await fetch('http://127.0.0.1:4601/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/form1',
        title: 'نموذج طلب إجازة',
        guidance: 'يستخدم هذا النموذج لطلب إجازة سنوية أو مرضية للموظفين'
      })
    });
    assert.strictEqual(resValid.status, 200);
    const source = await resValid.json();
    assert.ok(source.id);
    const sourceId = source.id;

    // 3. GET /api/sources shows the source
    const resList = await fetch('http://127.0.0.1:4601/api/sources');
    assert.strictEqual(resList.status, 200);
    const sources = await resList.json();
    const found = sources.find(s => s.id === sourceId);
    assert.ok(found);
    assert.strictEqual(found.url, 'https://example.com/form1');
    assert.strictEqual(found.title, 'نموذج طلب إجازة');
    assert.strictEqual(found.status, 'new');

    // 4. PUT /api/sources/:id updates guidance
    const resUpdate = await fetch(`http://127.0.0.1:4601/api/sources/${sourceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/form1',
        title: 'نموذج طلب إجازة',
        guidance: 'التوجيه الجديد والمعدل لطلب الإجازة'
      })
    });
    assert.strictEqual(resUpdate.status, 200);

    // Verify update
    const resList2 = await fetch('http://127.0.0.1:4601/api/sources');
    const sources2 = await resList2.json();
    const found2 = sources2.find(s => s.id === sourceId);
    assert.strictEqual(found2.guidance, 'التوجيه الجديد والمعدل لطلب الإجازة');
  });

  await t.test('28. Complete manual draft creation and approval workflow showing chat matching', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    let draftId;
    let sourceId2;

    try {
      // 1. Create a source
      const resSource = await fetch('http://127.0.0.1:4601/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/draft-test',
          title: 'رابط المسودة',
          guidance: 'توجيه للمسودة'
        })
      });
      const srcData = await resSource.json();
      sourceId2 = srcData.id;

      // 2. Insert draft directly
      const variants = [
        { text: 'كيف يمكنني الدخول لرابط المسودة', lang: 'ar' },
        { text: 'how to access draft link', lang: 'en' }
      ];
      const info = db.prepare(`
        INSERT INTO draft_answers (source_id, title, body_ar, body_en, variants_json, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(
        sourceId2,
        'رابط المسودة المعتمد',
        'لتصفح المسودة اضغط على الرابط التالي: [رابط المسودة](https://example.com/draft-test)',
        'To access draft, click: [رابط المسودة](https://example.com/draft-test)',
        JSON.stringify(variants)
      );
      draftId = info.lastInsertRowid;
    } finally {
      db.close();
    }

    // 3. Approve draft
    const resApprove = await fetch(`http://127.0.0.1:4601/api/drafts/${draftId}/approve`, {
      method: 'POST'
    });
    assert.strictEqual(resApprove.status, 200);

    // 4. Verify created answer
    const resAnswers = await fetch('http://127.0.0.1:4601/api/answers');
    const answers = await resAnswers.json();
    const approvedAnswer = answers.find(a => a.title === 'رابط المسودة المعتمد');
    assert.ok(approvedAnswer);
    assert.strictEqual(approvedAnswer.body_ar, 'لتصفح المسودة اضغط على الرابط التالي: [رابط المسودة](https://example.com/draft-test)');
    assert.strictEqual(approvedAnswer.body_en, 'To access draft, click: [رابط المسودة](https://example.com/draft-test)');

    // 5. Verify source status
    const resListSources = await fetch('http://127.0.0.1:4601/api/sources');
    const sourcesList = await resListSources.json();
    const updatedSource = sourcesList.find(s => s.id === sourceId2);
    assert.strictEqual(updatedSource.status, 'ingested');

    // 6. Verify chat matching works
    const resChat = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'draft-chat-session',
        text: 'كيف يمكنني الدخول لرابط المسودة'
      })
    });
    assert.strictEqual(resChat.status, 200);
    const chatData = await resChat.json();
    assert.strictEqual(chatData.reply, 'لتصفح المسودة اضغط على الرابط التالي: [رابط المسودة](https://example.com/draft-test)');
    assert.strictEqual(chatData.queued, false);
  });

  await t.test('29. Rejection flow resetting status to new', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    let sourceId3;
    let draftId2;

    try {
      // 1. Create a source
      const resSource = await fetch('http://127.0.0.1:4601/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/reject-test',
          title: 'رابط الرفض',
          guidance: 'توجيه للرفض'
        })
      });
      const srcData = await resSource.json();
      sourceId3 = srcData.id;

      // 2. Insert draft directly
      const variants = [
        { text: 'كيف ارفض المسودة', lang: 'ar' }
      ];
      const info = db.prepare(`
        INSERT INTO draft_answers (source_id, title, body_ar, body_en, variants_json, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(
        sourceId3,
        'مسودة مرفوضة',
        'سيتم رفض هذا الرد',
        'This will be rejected',
        JSON.stringify(variants)
      );
      draftId2 = info.lastInsertRowid;
    } finally {
      db.close();
    }

    // 3. Reject draft
    const resReject = await fetch(`http://127.0.0.1:4601/api/drafts/${draftId2}/reject`, {
      method: 'POST'
    });
    assert.strictEqual(resReject.status, 200);

    // 4. Verify no new answer is created
    const resAnswers = await fetch('http://127.0.0.1:4601/api/answers');
    const answers = await resAnswers.json();
    const rejectedAnswer = answers.find(a => a.title === 'مسودة مرفوضة');
    assert.ok(!rejectedAnswer);

    // 5. Verify source status goes back to new
    const resListSources = await fetch('http://127.0.0.1:4601/api/sources');
    const sourcesList = await resListSources.json();
    const updatedSource = sourcesList.find(s => s.id === sourceId3);
    assert.strictEqual(updatedSource.status, 'new');
  });

  await t.test('30. Generating with SANAD_NO_BRAIN=1', async () => {
    // 1. Create a source to test generation
    const resSource = await fetch('http://127.0.0.1:4601/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/generate-test',
        title: 'رابط التوليد',
        guidance: 'توجيه للتوليد'
      })
    });
    const srcData = await resSource.json();
    const sourceId4 = srcData.id;

    // 2. POST /api/sources/:id/generate should return 200
    const resGenerate = await fetch(`http://127.0.0.1:4601/api/sources/${sourceId4}/generate`, {
      method: 'POST'
    });
    assert.strictEqual(resGenerate.status, 200);

    // 3. Verify exactly one pending ingest_source job is in brain_jobs
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    try {
      const jobs = db.prepare("SELECT * FROM brain_jobs WHERE kind = 'ingest_source' AND status = 'pending'").all();
      const myJobs = jobs.filter(j => {
        try {
          return JSON.parse(j.payload).source_id === sourceId4;
        } catch (e) {
          return false;
        }
      });
      assert.strictEqual(myJobs.length, 1);
    } finally {
      db.close();
    }

    // 4. Calling generate again should not duplicate the job
    const resGenerate2 = await fetch(`http://127.0.0.1:4601/api/sources/${sourceId4}/generate`, {
      method: 'POST'
    });
    assert.strictEqual(resGenerate2.status, 200);

    const db2 = new Database(dbPath);
    try {
      const jobs = db2.prepare("SELECT * FROM brain_jobs WHERE kind = 'ingest_source' AND status = 'pending'").all();
      const myJobs = jobs.filter(j => {
        try {
          return JSON.parse(j.payload).source_id === sourceId4;
        } catch (e) {
          return false;
        }
      });
      assert.strictEqual(myJobs.length, 1);
    } finally {
      db2.close();
    }
  });

  await t.test('31. POST /api/nightly -> 200 and metrics history upsert', async () => {
    // 1. Trigger nightly manually
    const res = await fetch('http://127.0.0.1:4601/api/nightly', {
      method: 'POST'
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.metrics, 'Metrics should exist in response');

    // 2. Fetch stats to compare
    const resStats = await fetch('http://127.0.0.1:4601/api/stats');
    const stats = await resStats.json();

    // 3. Connect to DB to check metrics_history
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT * FROM metrics_history ORDER BY date DESC LIMIT 1').get();
      assert.ok(row, 'A row in metrics_history should exist');
      assert.strictEqual(row.answers, stats.answers);
      assert.strictEqual(row.variants, stats.variants);
      assert.strictEqual(row.queue_pending, stats.queue_pending);

      // Verify that calling nightly again upserts (does not create duplicate date rows)
      const countBefore = db.prepare('SELECT COUNT(*) AS count FROM metrics_history').get().count;
      const res2 = await fetch('http://127.0.0.1:4601/api/nightly', { method: 'POST' });
      assert.strictEqual(res2.status, 200);
      const countAfter = db.prepare('SELECT COUNT(*) AS count FROM metrics_history').get().count;
      assert.strictEqual(countAfter, countBefore, 'Should upsert and not create new rows for same date');
    } finally {
      db.close();
    }
  });

  await t.test('32. Training pairs generation', async () => {
    // 1. Create first answer with 3 variants
    const res1 = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'الجواب أ',
        body_ar: 'محتوى أ',
        variants: ['سؤال أ 1', 'سؤال أ 2', 'سؤال أ 3']
      })
    });
    assert.strictEqual(res1.status, 200);
    const data1 = await res1.json();
    const ansId1 = data1.id;

    // 2. Create second answer with 2 variants
    const res2 = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'الجواب ب',
        body_ar: 'محتوى ب',
        variants: ['سؤال ب 1', 'سؤال ب 2']
      })
    });
    assert.strictEqual(res2.status, 200);
    const data2 = await res2.json();
    const ansId2 = data2.id;

    // 3. Clear training_pairs first to test exact count
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    try {
      db.prepare('DELETE FROM training_pairs').run();
    } finally {
      db.close();
    }

    // 4. Trigger nightly
    const resNightly = await fetch('http://127.0.0.1:4601/api/nightly', {
      method: 'POST'
    });
    assert.strictEqual(resNightly.status, 200);

    // 5. Verify pairs in DB:
    // Positive pairs for answer 1: 3 variants -> 3 pairs (combination of 3: C(3,2)=3)
    // Positive pairs for answer 2: 2 variants -> 1 pair (combination of 2: C(2,2)=1)
    // Total positives = 4
    // Negative pairs: 3 pairs for answer 1, 2 pairs for answer 2
    // Total negatives should be at least some rows
    const db2 = new Database(dbPath);
    try {
      const positives = db2.prepare("SELECT * FROM training_pairs WHERE label = 1").all();
      assert.ok(positives.length >= 4, `Expected at least 4 positive pairs, got ${positives.length}`);
      
      const negatives = db2.prepare("SELECT * FROM training_pairs WHERE label = 0").all();
      assert.ok(negatives.length > 0, 'Expected negative pairs to be generated');

      // Check "لا زوج نص مع نفسه"
      const selfPairs = db2.prepare("SELECT * FROM training_pairs WHERE text_a = text_b").all();
      assert.strictEqual(selfPairs.length, 0, 'No training pair should have same text for a and b');

      // 6. Test GET /api/dataset/export
      const resExport = await fetch('http://127.0.0.1:4601/api/dataset/export');
      assert.strictEqual(resExport.status, 200);
      assert.strictEqual(resExport.headers.get('Content-Disposition'), 'attachment; filename=sanad-pairs.jsonl');
      const text = await resExport.text();
      const lines = text.trim().split('\n').filter(l => l.trim().length > 0);
      const totalPairsCount = db2.prepare('SELECT COUNT(*) AS count FROM training_pairs').get().count;
      assert.strictEqual(lines.length, totalPairsCount, 'JSONL line count should match database training_pairs count');
      
      if (lines.length > 0) {
        const parsed = JSON.parse(lines[0]);
        assert.ok(parsed.hasOwnProperty('a'));
        assert.ok(parsed.hasOwnProperty('b'));
        assert.ok(parsed.hasOwnProperty('label'));
        assert.ok(parsed.hasOwnProperty('src'));
      }
    } finally {
      db2.close();
    }
  });

  await t.test('33. Clustered queue draft_cluster jobs creation', async () => {
    // 1. Insert 3 similar pending queue items
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    try {
      db.prepare("DELETE FROM queue WHERE status = 'pending'").run();
      db.prepare("DELETE FROM brain_jobs WHERE kind = 'draft_cluster'").run();
      db.prepare("DELETE FROM draft_answers WHERE source_id IS NULL").run();

      db.prepare(`
        INSERT INTO queue (question_raw, question_norm, lang, status)
        VALUES ('كيف استعادة كلمة السر', 'كيف استعاده كلمه المرور', 'ar', 'pending'),
               ('كيف استعادة كلمة السر الخاصة بي', 'كيف استعاده كلمه المرور الخاصه بي', 'ar', 'pending'),
               ('كيف استعادة كلمة السر هنا', 'كيف استعاده كلمه المرور هنا', 'ar', 'pending')
      `).run();
    } finally {
      db.close();
    }

    // 2. Trigger nightly
    const resNightly = await fetch('http://127.0.0.1:4601/api/nightly', {
      method: 'POST'
    });
    assert.strictEqual(resNightly.status, 200);

    // 3. Verify exactly one draft_cluster job exists in brain_jobs
    const db2 = new Database(dbPath);
    try {
      const jobs = db2.prepare("SELECT * FROM brain_jobs WHERE kind = 'draft_cluster' AND status = 'pending'").all();
      assert.strictEqual(jobs.length, 1);
      const payload = JSON.parse(jobs[0].payload);
      assert.strictEqual(payload.lead_question, 'كيف استعادة كلمة السر');
      assert.strictEqual(payload.member_ids.length, 3);

      // 4. Trigger nightly again, should not duplicate
      const resNightly2 = await fetch('http://127.0.0.1:4601/api/nightly', { method: 'POST' });
      assert.strictEqual(resNightly2.status, 200);
      const jobs2 = db2.prepare("SELECT * FROM brain_jobs WHERE kind = 'draft_cluster' AND status = 'pending'").all();
      assert.strictEqual(jobs2.length, 1);
    } finally {
      db2.close();
    }
  });

  await t.test('34. buildMorningReport unit test', async () => {
    const { buildMorningReport } = await import('../lib/nightly.js');
    
    const today = {
      date: '2026-07-09',
      queue_pending: 5,
      drafts_pending: 2,
      exam_avg: 0.85,
      exam_lexical_avg: 0.60,
      pairs_count: 150
    };

    const yesterday = {
      date: '2026-07-08',
      queue_pending: 3,
      drafts_pending: 4,
      exam_avg: 0.80,
      exam_lexical_avg: 0.65,
      pairs_count: 150
    };

    const report = buildMorningReport(today, yesterday);
    assert.ok(report.includes('5 ↑'));
    assert.ok(report.includes('2 ↓'));
    assert.ok(report.includes('85% ↑'));
    assert.ok(report.includes('60% ↓'));
    assert.ok(report.includes('150'));
    assert.ok(!report.includes('150 ↑') && !report.includes('150 ↓'));
  });

  await t.test('36. GET /api/today aggregates drafts, clusters, downvotes', async () => {
    const { normalize: normFn } = await import('../lib/normalize.js');
    const Database = (await import('better-sqlite3')).default;
    const dbToday = new Database(path.join(projectRoot, 'data', 'test.db'));
    try {
      const src = dbToday.prepare(`
        INSERT INTO sources (url, title, guidance, status)
        VALUES ('https://example.com/today-check', 'مصدر طابور اليوم', 'اختبار', 'new')
      `).run();
      dbToday.prepare(`
        INSERT INTO draft_answers (source_id, title, body_ar, body_en, variants_json, status)
        VALUES (?, 'مسودة اليوم', 'نص جواب المسودة للاختبار', null, ?, 'pending')
      `).run(src.lastInsertRowid, JSON.stringify([{ text: 'كيف اسوي فحص اليوم', lang: 'ar' }]));

      const q1 = 'طابعة المكتب لا تطبع اليوم';
      const q2 = 'طابعة المكتب ما تطبع اليوم';
      dbToday.prepare(`
        INSERT OR IGNORE INTO queue (question_raw, question_norm, lang, status, priority)
        VALUES (?, ?, 'ar', 'pending', 1)
      `).run(q1, normFn(q1));
      dbToday.prepare(`
        INSERT OR IGNORE INTO queue (question_raw, question_norm, lang, status, priority)
        VALUES (?, ?, 'ar', 'pending', 0)
      `).run(q2, normFn(q2));
    } finally {
      dbToday.close();
    }

    const uniq = 'سؤال فريد لطابور اليوم فقط xyz123';
    const ansRes = await fetch('http://127.0.0.1:4601/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'جواب اليوم',
        body_ar: 'هذا جواب للاختبار',
        variants: [uniq]
      })
    });
    assert.strictEqual(ansRes.status, 200);
    const chatRes = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 'today-sess', text: uniq })
    });
    assert.strictEqual(chatRes.status, 200);
    const chatBody = await chatRes.json();
    assert.ok(chatBody.chat_id, 'chat_id required for feedback');
    const fb = await fetch('http://127.0.0.1:4601/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatBody.chat_id, vote: -1 })
    });
    assert.strictEqual(fb.status, 200);

    const res = await fetch('http://127.0.0.1:4601/api/today');
    assert.strictEqual(res.status, 200);
    const payload = await res.json();
    assert.ok(payload.counts, 'counts object');
    assert.ok(payload.counts.drafts >= 1, 'at least one draft');
    assert.ok(payload.counts.queue_items >= 1, 'at least one queue item');
    assert.ok(Array.isArray(payload.drafts) && payload.drafts.some(d => d.title === 'مسودة اليوم'));
    assert.ok(Array.isArray(payload.clusters));
    assert.ok(Array.isArray(payload.downvotes) && payload.downvotes.length >= 1);
    assert.ok(typeof payload.counts.total_actions === 'number');
  });

  async function uploadDocument(buffer, filename) {
    const fd = new FormData();
    fd.append('file', new Blob([buffer]), filename);
    const res = await fetch('http://127.0.0.1:4601/api/documents', { method: 'POST', body: fd });
    return res;
  }

  await t.test('37. Documents: real xlsx upload extracts sheets and cells', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['البند', 'القيمة'],
      ['سياسة الاجازات المرضية', 'خمسة ايام بتقرير طبي']
    ]), 'Policies');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Item', 'Value'],
      ['VPN portal address', 'vpn.example.local']
    ]), 'Network');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const res = await uploadDocument(buf, 'handbook.xlsx');
    assert.strictEqual(res.status, 200);
    const doc = await res.json();
    assert.strictEqual(doc.kind, 'xlsx');
    assert.notStrictEqual(doc.status, 'failed');
    assert.ok(doc.text.includes('### Sheet: Policies'), 'first sheet header present');
    assert.ok(doc.text.includes('### Sheet: Network'), 'second sheet header present');
    assert.ok(doc.text.includes('سياسة الاجازات المرضية'), 'arabic cell extracted');
    assert.ok(doc.text.includes('vpn.example.local'), 'english cell extracted');
  });

  await t.test('38. Documents: real pdf extracts text, scanned pdf fails honestly', async () => {
    const pdfBuf = fs.readFileSync(path.join(projectRoot, 'scripts', 'fixtures', 'tiny.pdf'));
    const okRes = await uploadDocument(pdfBuf, 'guide.pdf');
    assert.strictEqual(okRes.status, 200);
    const okDoc = await okRes.json();
    assert.notStrictEqual(okDoc.status, 'failed');
    assert.ok(okDoc.text.includes('SANAD PDF TEST'), 'pdf text extracted');

    // fixture generated by Edge: valid PDF that pdf-parse cannot read (same
    // user-facing outcome as a scanned PDF: no extractable text)
    const scannedBuf = fs.readFileSync(path.join(projectRoot, 'scripts', 'fixtures', 'scanned.pdf'));
    const emptyRes = await uploadDocument(scannedBuf, 'scanned.pdf');
    assert.strictEqual(emptyRes.status, 200);
    const emptyDoc = await emptyRes.json();
    assert.strictEqual(emptyDoc.status, 'failed');
    assert.ok(emptyDoc.error && emptyDoc.error.includes('ممسوح'), 'friendly arabic message present, not a raw parser error');
  });

  await t.test('39. Documents: generate chunks into ingest_document jobs without duplication', async () => {
    const line = 'هذا سطر معرفة تجريبي يشرح اجراء داخليا مفصلا للموظفين في القسم التقني.\n';
    const bigText = line.repeat(Math.ceil(6000 / line.length));
    const upRes = await uploadDocument(Buffer.from(bigText, 'utf8'), 'big-policy.txt');
    assert.strictEqual(upRes.status, 200);
    const doc = await upRes.json();
    assert.notStrictEqual(doc.status, 'failed');

    const genRes = await fetch(`http://127.0.0.1:4601/api/documents/${doc.id}/generate`, { method: 'POST' });
    assert.strictEqual(genRes.status, 200);

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(projectRoot, 'data', 'test.db'));
    const countJobs = () => db.prepare(
      "SELECT COUNT(*) AS c FROM brain_jobs WHERE kind = 'ingest_document' AND payload LIKE ?"
    ).get(`%"document_id":${doc.id}%`).c;

    const firstCount = countJobs();
    assert.ok(firstCount >= 2, `expected multiple chunks for 6000 chars, got ${firstCount}`);

    const docRow = db.prepare('SELECT status, chunks_total FROM documents WHERE id = ?').get(doc.id);
    assert.strictEqual(docRow.status, 'generating');
    assert.strictEqual(docRow.chunks_total, firstCount);

    const genAgain = await fetch(`http://127.0.0.1:4601/api/documents/${doc.id}/generate`, { method: 'POST' });
    assert.strictEqual(genAgain.status, 200);
    assert.strictEqual(countJobs(), firstCount, 'regenerate must not duplicate pending jobs');
    db.close();
  });

  await t.test('40. Documents: approving a document draft creates a live answer', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(projectRoot, 'data', 'test.db'));
    const docInfo = db.prepare(`
      INSERT INTO documents (filename, kind, bytes, text, status, chunks_total, chunks_done)
      VALUES ('manual-fixture.txt', 'txt', 100, 'نص تجريبي', 'drafted', 1, 1)
    `).run();
    const variants = [
      { text: 'كيف اركب نظام البصمه الجديد في الفرع', lang: 'ar' },
      { text: 'how do I install the new fingerprint system', lang: 'en' }
    ];
    const draftInfo = db.prepare(`
      INSERT INTO draft_answers (document_id, title, body_ar, body_en, variants_json, status)
      VALUES (?, 'تركيب نظام البصمة', 'حمل المثبت من مجلد الانظمة ثم شغله بصلاحية مدير', 'Download the installer from the systems folder and run it as admin', ?, 'pending')
    `).run(docInfo.lastInsertRowid, JSON.stringify(variants));
    db.close();

    const apRes = await fetch(`http://127.0.0.1:4601/api/drafts/${draftInfo.lastInsertRowid}/approve`, { method: 'POST' });
    assert.strictEqual(apRes.status, 200);

    const chatRes = await fetch('http://127.0.0.1:4601/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 'doc-draft-sess', text: 'كيف اركب نظام البصمه الجديد في الفرع' })
    });
    assert.strictEqual(chatRes.status, 200);
    const chatBody = await chatRes.json();
    assert.strictEqual(chatBody.queued, false, 'approved draft must answer, not queue');
    assert.strictEqual(chatBody.reply, 'حمل المثبت من مجلد الانظمة ثم شغله بصلاحية مدير');
  });

  await t.test('41. Documents: rejects bad extension and oversized file', async () => {
    const exeRes = await uploadDocument(Buffer.from('MZ fake binary'), 'malware.exe');
    assert.strictEqual(exeRes.status, 400);

    const bigRes = await uploadDocument(Buffer.alloc(11 * 1024 * 1024, 65), 'big.txt');
    assert.ok(bigRes.status === 400 || bigRes.status === 413, `oversized upload must be rejected, got ${bigRes.status}`);
  });

  await t.test('35. Alternative Model startup fallback', async () => {
    const testPort3 = 4603;
    const dbPath3 = path.join(projectRoot, 'data', 'test_model_fallback.db');
    const dbWal = dbPath3 + '-wal';
    const dbShm = dbPath3 + '-shm';

    if (fs.existsSync(dbPath3)) { try { fs.unlinkSync(dbPath3); } catch (e) {} }
    if (fs.existsSync(dbWal)) { try { fs.unlinkSync(dbWal); } catch (e) {} }
    if (fs.existsSync(dbShm)) { try { fs.unlinkSync(dbShm); } catch (e) {} }

    const proc = spawn('node', ['server.js'], {
      cwd: projectRoot,
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(testPort3),
        SANAD_DB: dbPath3,
        SANAD_TG_TOKEN: '',
        SANAD_TG_ADMIN: '',
        SANAD_NO_BRAIN: '1',
        SANAD_EMBED_MODEL: 'nonexistent-model-to-trigger-fallback'
      }
    });

    try {
      let ready = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        try {
          const res = await fetch(`http://127.0.0.1:${testPort3}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: 's', text: 'hello' })
          });
          if (res.status === 200) {
            ready = true;
            break;
          }
        } catch (e) {
        }
      }
      assert.ok(ready, 'server with nonexistent model must fallback and start');
    } finally {
      proc.kill('SIGTERM');
      await new Promise(resolve => {
        proc.on('exit', resolve);
        proc.on('error', resolve);
      });
      await new Promise(r => setTimeout(r, 500));
      if (fs.existsSync(dbPath3)) { try { fs.unlinkSync(dbPath3); } catch (e) {} }
      if (fs.existsSync(dbWal)) { try { fs.unlinkSync(dbWal); } catch (e) {} }
      if (fs.existsSync(dbShm)) { try { fs.unlinkSync(dbShm); } catch (e) {} }
    }
  });
});

