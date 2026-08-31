// سَنَد - منطق لوحة التحكم والتدريب - تم التحقق والتحديث

// تخزين محلي للبيانات المجلوبة لتسهيل البحث والربط
let allAnswers = [];
let pendingQueue = [];
let allSkills = [];
let allSynonyms = [];
let allSources = [];
let allDocuments = [];
let pendingDrafts = [];
let todayPayload = null;
let todayStartTotal = null;
let activeTab = 'today';

// غلاف fetch لإدارة التوكن (Authorization) وإعادة المحاولة عند الحاجة
async function adminFetch(url, options = {}) {
  let token = localStorage.getItem('sanad_admin_token');
  if (!options.headers) {
    options.headers = {};
  }
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body && !(options.body instanceof FormData) && !options.headers['Content-Type']) {
    options.headers['Content-Type'] = 'application/json';
  }
  
  let res = await fetch(url, options);
  if (res.status === 401) {
    if (!window.isPromptingToken) {
      window.isPromptingToken = true;
      const newToken = prompt('الرجاء إدخال رمز التحقق (SANAD_TOKEN) لإدارة النظام:');
      window.isPromptingToken = false;
      if (newToken !== null) {
        localStorage.setItem('sanad_admin_token', newToken);
        options.headers['Authorization'] = `Bearer ${newToken}`;
        res = await fetch(url, options);
      }
    }
  }
  return res;
}

document.addEventListener('DOMContentLoaded', () => {
  // تهيئة التنقل بين التبويبات
  initTabs();
  
  // التبويب الافتراضي: طابور اليوم (5 دقائق صباحاً)
  loadTabContent('today');
  
  // تحديث الشارات بانتظام
  updateQueueBadgeCount();
  updateTodayBadgeCount();
  setInterval(updateQueueBadgeCount, 30000);
  setInterval(updateTodayBadgeCount, 30000);
  
  // تحديث عدد المصادر بانتظام
  updateSourcesBadgeCount();
  setInterval(updateSourcesBadgeCount, 30000);

  // تحديث دوري للمصادر والمسودات إذا كان تبويب المصادر مفتوحاً
  setInterval(() => {
    if (activeTab === 'sources') {
      fetchDocumentsOnly();
      fetchSourcesOnly();
      fetchDraftsOnly();
    }
    if (activeTab === 'today') {
      fetchTodayQueue(true);
    }
  }, 10000);
});

/* ==========================================================================
   إدارة التبويبات والتحميل
   ========================================================================== */

function initTabs() {
  const tabButtons = document.getElementById('tab-buttons');
  tabButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    
    // إزالة الصف النشط من الأزرار والتبويبات السابقة
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    // تفعيل التبويب المختار
    btn.classList.add('active');
    const tabName = btn.getAttribute('data-tab');
    const contentSection = document.getElementById(`tab-content-${tabName}`);
    if (contentSection) {
      contentSection.classList.add('active');
    }
    
    // تحميل بيانات التبويب المختار
    loadTabContent(tabName);
  });
}

async function loadTabContent(tabName) {
  activeTab = tabName;
  switch (tabName) {
    case 'today':
      await fetchDocuments(true);
      await fetchTodayQueue();
      break;
    case 'queue':
      await fetchQueue();
      await fetchAnswersListOnly(); // لملء قوائم خيارات الربط
      break;
    case 'answers':
      await fetchAnswers();
      break;
    case 'sources':
      await fetchDocuments();
      await fetchSources();
      await fetchDrafts();
      break;
    case 'skills':
      await fetchSkills();
      break;
    case 'synonyms':
      await fetchSynonyms();
      break;
    case 'exams':
      await fetchExams();
      break;
    case 'stats':
      await fetchStats();
      break;
    case 'backup':
      await fetchBackups();
      break;
    case 'evolution':
      await fetchEvolution();
      break;
  }
}

/* ==========================================================================
   طابور اليوم — اعتماد سريع (G30-2)
   ========================================================================== */

async function updateTodayBadgeCount() {
  try {
    const res = await adminFetch('/api/today');
    if (!res.ok) return;
    const data = await res.json();
    const badge = document.getElementById('today-badge');
    if (!badge) return;
    const n = data.counts?.total_actions || 0;
    if (n > 0) {
      badge.innerText = n > 99 ? '99+' : String(n);
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  } catch (err) {
    console.error('today badge:', err);
  }
}

async function fetchTodayQueue(silent = false) {
  const draftsEl = document.getElementById('today-drafts-list');
  if (!silent && draftsEl) {
    draftsEl.innerHTML = '<div class="loading-spinner">جاري تحميل طابور اليوم...</div>';
  }
  try {
    await fetchDocuments(true).catch(() => {});
    const res = await adminFetch('/api/today');
    if (!res.ok) throw new Error('فشل جلب طابور اليوم');
    todayPayload = await res.json();
    if (todayStartTotal === null) {
      todayStartTotal = todayPayload.counts?.total_actions || 0;
    }
    renderTodayQueue();
    updateTodayBadgeCount();
  } catch (err) {
    if (draftsEl) {
      draftsEl.innerHTML = `<div class="card text-center text-danger">خطأ: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderTodayQueue() {
  if (!todayPayload) return;
  const c = todayPayload.counts || {};
  const setNum = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v ?? 0;
  };
  setNum('today-stat-drafts', c.drafts);
  setNum('today-stat-queue', c.queue_items);
  setNum('today-stat-clusters', c.clusters_hot);
  setNum('today-stat-downs', c.downvotes);

  const start = todayStartTotal || 0;
  const left = c.total_actions || 0;
  const done = Math.max(0, start - left);
  const pct = start > 0 ? Math.min(100, Math.round((done / start) * 100)) : (left === 0 ? 100 : 0);
  const fill = document.getElementById('today-progress-fill');
  if (fill) fill.style.width = pct + '%';
  const pl = document.getElementById('today-progress-label');
  if (pl) {
    pl.textContent = left === 0
      ? '✨ لا بنود معلّقة — يوم نظيف'
      : `متبقي ${left} بنداً · أُنجز ${done} من ${start || left} (${pct}%)`;
  }

  const m = todayPayload.metrics;
  const mh = document.getElementById('today-metrics-hint');
  if (mh) {
    if (m) {
      const exam = m.exam_avg != null ? Math.round(m.exam_avg * 100) + '%' : '—';
      const lex = m.exam_lexical_avg != null ? Math.round(m.exam_lexical_avg * 100) + '%' : '—';
      mh.style.display = 'block';
      mh.textContent = `آخر لقطة (${m.date}): امتحان ${exam} · lexical ${lex} · أزواج ${m.pairs_count ?? 0}`;
    } else {
      mh.style.display = 'none';
    }
  }

  // مسودات
  const draftsList = document.getElementById('today-drafts-list');
  const drafts = todayPayload.drafts || [];
  const dc = document.getElementById('today-drafts-count');
  if (dc) {
    if (drafts.length) { dc.style.display = 'inline-block'; dc.textContent = drafts.length; }
    else dc.style.display = 'none';
  }
  if (draftsList) {
    if (!drafts.length) {
      draftsList.innerHTML = '<div class="today-empty">لا مسودات معلّقة 🎉</div>';
    } else {
      draftsList.innerHTML = drafts.map((d) => {
        let label = d.source_label || '';
        if (d.document_id) {
          if (d.document_filename) {
            label = `مستند: ${d.document_filename}`;
          } else {
            const doc = allDocuments.find(docItem => docItem.id === d.document_id);
            label = doc ? `مستند: ${doc.filename}` : `مستند #${d.document_id}`;
          }
        }
        return `
        <div class="today-card" id="today-draft-${d.id}">
          <div class="today-card-head">
            <strong>${escapeHtml(d.title || 'بدون عنوان')}</strong>
            <span class="badge badge-drafted">${escapeHtml(label)}</span>
          </div>
          <div class="today-meta">${d.variant_count || 0} صيغة · #${d.id}</div>
          <div class="today-preview">${escapeHtml(d.body_preview || d.body_ar || '')}</div>
          <div class="today-actions">
            <button class="btn-accent btn-sm" onclick="todayApproveDraft(${d.id})">اعتماد كما هو ✅</button>
            <button class="btn-danger btn-sm" onclick="todayRejectDraft(${d.id})">رفض ❌</button>
            <button class="btn-secondary btn-sm" onclick="switchToTab('sources')">تحرير كامل</button>
          </div>
        </div>
        `;
      }).join('');
    }
  }

  // عناقيد
  const clustersList = document.getElementById('today-clusters-list');
  const clusters = todayPayload.clusters || [];
  const cc = document.getElementById('today-clusters-count');
  if (cc) {
    if (clusters.length) { cc.style.display = 'inline-block'; cc.textContent = clusters.length; }
    else cc.style.display = 'none';
  }
  if (clustersList) {
    if (!clusters.length) {
      clustersList.innerHTML = '<div class="today-empty">الطابور فارغ 🎉</div>';
    } else {
      clustersList.innerHTML = clusters.map((cl) => {
        const hot = cl.size >= 3 ? '🔥 ' : '';
        const sims = (cl.similar || []).slice(0, 3).map((s) => escapeHtml(s.question_raw)).join(' · ');
        return `
          <div class="today-card" id="today-cluster-${cl.id}">
            <div class="today-card-head">
              <strong>${hot}${escapeHtml(cl.question_raw)}</strong>
              <span class="badge ${cl.size >= 3 ? 'badge-error' : ''}">${cl.size} سؤال</span>
            </div>
            ${sims ? `<div class="today-meta">مشابه: ${sims}</div>` : ''}
            <div class="today-actions">
              <button class="btn-primary btn-sm" onclick="switchToTab('queue')">حل في الطابور</button>
              <button class="btn-secondary btn-sm" onclick="todayIgnoreCluster(${cl.id}, ${JSON.stringify(cl.member_ids || [cl.id])})">تجاهل الكل</button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // أصوات سلبية
  const downsList = document.getElementById('today-downs-list');
  const downs = todayPayload.downvotes || [];
  const dnc = document.getElementById('today-downs-count');
  if (dnc) {
    if (downs.length) { dnc.style.display = 'inline-block'; dnc.textContent = downs.length; }
    else dnc.style.display = 'none';
  }
  if (downsList) {
    if (!downs.length) {
      downsList.innerHTML = '<div class="today-empty">لا أصوات سلبية حديثة</div>';
    } else {
      downsList.innerHTML = downs.map((d) => `
        <div class="today-card">
          <div class="today-card-head">
            <strong>${escapeHtml(d.question || '(سؤال غير معروف)')}</strong>
            <span class="badge badge-failed">👎</span>
          </div>
          <div class="today-meta">الجواب المرتبط: ${escapeHtml(d.answer_title || '—')} ${d.answer_id ? '#' + d.answer_id : ''}</div>
          <div class="today-actions">
            ${d.answer_id
              ? `<button class="btn-secondary btn-sm" onclick="switchToTab('answers')">راجع الإجابات</button>`
              : `<button class="btn-secondary btn-sm" onclick="switchToTab('queue')">افتح الطابور</button>`}
          </div>
        </div>
      `).join('');
    }
  }
}

function switchToTab(tabName) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

async function todayApproveDraft(id) {
  try {
    const res = await adminFetch(`/api/drafts/${id}/approve`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل الاعتماد');
    showToast('تم اعتماد المسودة ✅', 'success');
    await fetchDocuments(true);
    await fetchTodayQueue(true);
    updateSourcesBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function todayRejectDraft(id) {
  if (!confirm('رفض هذه المسودة؟')) return;
  try {
    const res = await adminFetch(`/api/drafts/${id}/reject`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل الرفض');
    showToast('تم رفض المسودة', 'success');
    await fetchDocuments(true);
    await fetchTodayQueue(true);
    updateSourcesBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function todayIgnoreCluster(leadId, memberIds) {
  const ids = Array.isArray(memberIds) ? memberIds : [leadId];
  if (!confirm(`تجاهل ${ids.length} سؤالاً في هذا العنقود؟`)) return;
  try {
    for (const qid of ids) {
      const res = await adminFetch(`/api/queue/${qid}/ignore`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `فشل تجاهل #${qid}`);
      }
    }
    showToast(`تم تجاهل ${ids.length} سؤالاً`, 'success');
    await fetchTodayQueue(true);
    updateQueueBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// تحديث شارة عدد الأسئلة المعلقة في الطابور على التبويب
async function updateQueueBadgeCount() {
  try {
    const token = localStorage.getItem('sanad_admin_token');
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch('/api/queue', { headers });
    if (res.ok) {
      const data = await res.json();
      const badge = document.getElementById('queue-badge');
      if (data && data.length > 0) {
        // لو مجمعة، قد يكون الطابور مصفوفة عناقيد، نحسب إجمالي الأسئلة
        let count = 0;
        data.forEach(item => {
          count++; // الرئيس
          if (item.similar && Array.isArray(item.similar)) {
            count += item.similar.length;
          }
        });
        badge.innerText = count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('Error fetching queue count:', err);
  }
}

/* ==========================================================================
   تبويب 1: طابور التدريب المعلق (Queue)
   ========================================================================== */

async function fetchQueue() {
  const container = document.getElementById('queue-list-container');
  container.innerHTML = '<div class="loading-spinner">جاري تحميل الأسئلة المعلقة...</div>';
  
  try {
    const res = await adminFetch('/api/queue');
    if (!res.ok) throw new Error('فشل جلب بيانات الطابور');
    pendingQueue = await res.json();
    
    if (pendingQueue.length === 0) {
      container.innerHTML = `
        <div class="card text-center text-secondary" style="padding: 3rem 1rem;">
          <span style="font-size: 2.5rem; display: block; margin-bottom: 1rem;">🎉</span>
          لا توجد أسئلة معلقة في الطابور حالياً! سند يجيب على كل شيء بثقة.
        </div>
      `;
      return;
    }
    
    // ترتيب المستعجل (priority=1) أولاً
    pendingQueue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    
    renderQueueList(container);
  } catch (err) {
    container.innerHTML = `<div class="card text-center text-danger">حدث خطأ أثناء تحميل الطابور: ${err.message}</div>`;
  }
}

// جلب قائمة الإجابات المخزنة مسبقاً لاستخدامها في الربط
async function fetchAnswersListOnly() {
  try {
    const res = await adminFetch('/api/answers');
    if (res.ok) {
      allAnswers = await res.json();
    }
  } catch (err) {
    console.error('Error fetching answers for lookup:', err);
  }
}

function renderQueueList(container) {
  container.innerHTML = '';
  
  pendingQueue.forEach(item => {
    const card = document.createElement('div');
    card.className = 'queue-card';
    if (item.priority === 1) {
      card.style.borderRight = '4px solid var(--color-danger)';
    }
    
    // ترويسة الكارت (السؤال واللغة والأولوية)
    const header = document.createElement('div');
    header.className = 'queue-card-header';
    
    const titleSpan = document.createElement('span');
    titleSpan.className = 'queue-question';
    titleSpan.innerText = item.question_raw;
    
    const badgeGroup = document.createElement('div');
    badgeGroup.style.display = 'flex';
    badgeGroup.style.gap = '0.5rem';
    badgeGroup.style.alignItems = 'center';
    
    if (item.priority === 1) {
      const urgentBadge = document.createElement('span');
      urgentBadge.className = 'priority-urgent-badge';
      urgentBadge.innerText = '🔴 مستعجل';
      badgeGroup.appendChild(urgentBadge);
    }
    
    const langBadge = document.createElement('span');
    langBadge.className = 'queue-lang-badge';
    langBadge.innerText = item.lang === 'ar' ? 'العربية' : 'الإنجليزية';
    badgeGroup.appendChild(langBadge);
    
    header.appendChild(titleSpan);
    header.appendChild(badgeGroup);
    card.appendChild(header);
    
    // عرض الأسئلة المشابهة إن وجدت
    const similarCount = item.similar ? item.similar.length : 0;
    let similarSectionHtml = '';
    if (similarCount > 0) {
      similarSectionHtml = `
        <div class="similar-questions-section">
          <div class="similar-questions-title">أسئلة مشابهة في نفس المجموعة (${similarCount}):</div>
          <ul class="similar-questions-list">
            ${item.similar.map(s => `<li>${escapeHtml(s.question_raw)}</li>`).join('')}
          </ul>
          <div class="similar-checkbox-container">
            <input type="checkbox" id="link-similar-${item.id}" checked>
            <label for="link-similar-${item.id}">+${similarCount} سؤالاً مشابهاً — اربطها وأغلقها كلها معاً؟</label>
          </div>
        </div>
      `;
    }
    
    // محتوى الخيارات (الربط أو الإنشاء)
    const actions = document.createElement('div');
    actions.className = 'queue-card-actions';
    
    const row = document.createElement('div');
    row.className = 'queue-action-row';
    
    // خيار الربط بإجابة موجودة
    const linkBox = document.createElement('div');
    linkBox.className = 'queue-action-box';
    linkBox.innerHTML = `
      <h4>🔗 ربط بإجابة موجودة في النظام</h4>
      <div class="form-group" style="margin-bottom: 0.5rem;">
        <input type="text" placeholder="ابحث في الإجابات المتاحة..." oninput="filterAnswersDropdown(this, ${item.id})">
      </div>
      <div class="select-search-container">
        <select id="select-answer-${item.id}">
          <option value="">-- اختر إجابة لربطها --</option>
          ${allAnswers.map(ans => `<option value="${ans.id}">${ans.title}</option>`).join('')}
        </select>
        <button class="btn-accent" onclick="linkQueueItem(${item.id})">ربط</button>
      </div>
      ${similarSectionHtml}
    `;
    
    // خيار إنشاء إجابة جديدة
    const createBox = document.createElement('div');
    createBox.className = 'queue-action-box';
    createBox.innerHTML = `
      <h4>➕ إنشاء إجابة جديدة كلياً لهذا السؤال</h4>
      <div class="queue-create-form">
        <input type="text" id="new-title-${item.id}" placeholder="عنوان الإجابة (مثال: طريقة تغيير الإيميل)">
        <textarea id="new-body-${item.id}" rows="2" placeholder="نص الرد الدقيق بالعربية..."></textarea>
        <button class="btn-primary" onclick="createAnswerForQueueItem(${item.id})">إنشاء وربط</button>
      </div>
    `;
    
    row.appendChild(linkBox);
    row.appendChild(createBox);
    actions.appendChild(row);
    
    // قسم التجاهل
    const ignoreSection = document.createElement('div');
    ignoreSection.className = 'queue-ignore-section';
    ignoreSection.innerHTML = `
      <button class="btn-danger" onclick="ignoreQueueItem(${item.id})">تجاهل السؤال من الطابور 🗑️</button>
    `;
    actions.appendChild(ignoreSection);
    
    card.appendChild(actions);
    container.appendChild(card);
  });
}

// تصفية خيارات القائمة المنسدلة للربط محلياً
function filterAnswersDropdown(input, itemId) {
  const query = input.value.toLowerCase().trim();
  const select = document.getElementById(`select-answer-${itemId}`);
  if (!select) return;
  
  select.innerHTML = '<option value="">-- اختر إجابة لربطها --</option>';
  
  const filtered = allAnswers.filter(ans => 
    ans.title.toLowerCase().includes(query) || 
    ans.body_ar.toLowerCase().includes(query)
  );
  
  filtered.forEach(ans => {
    const opt = document.createElement('option');
    opt.value = ans.id;
    opt.innerText = ans.title;
    select.appendChild(opt);
  });
}

// ربط السؤال بإجابة حالية
async function linkQueueItem(queueId) {
  const select = document.getElementById(`select-answer-${queueId}`);
  const answerId = select.value;
  if (!answerId) {
    showToast('الرجاء اختيار إجابة من القائمة للربط', 'error');
    return;
  }
  
  const item = pendingQueue.find(q => q.id === queueId);
  const includeIds = [];
  if (item && item.similar && item.similar.length > 0) {
    const cb = document.getElementById(`link-similar-${queueId}`);
    if (cb && cb.checked) {
      includeIds.push(...item.similar.map(s => s.id));
    }
  }
  
  try {
    const res = await adminFetch(`/api/queue/${queueId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ 
        answer_id: parseInt(answerId),
        include_ids: includeIds
      })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل عملية الربط');
    }
    
    showToast('تم ربط الأسئلة وتحديث الطابور بنجاح!', 'success');
    await fetchQueue();
    updateQueueBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// إنشاء إجابة جديدة وربط السؤال بها
async function createAnswerForQueueItem(queueId) {
  const titleInput = document.getElementById(`new-title-${queueId}`);
  const bodyTextarea = document.getElementById(`new-body-${queueId}`);
  
  const title = titleInput.value.trim();
  const body_ar = bodyTextarea.value.trim();
  
  if (!title || !body_ar) {
    showToast('يجب ملء العنوان والرد بالعربية لإنشاء إجابة جديدة', 'error');
    return;
  }
  
  const item = pendingQueue.find(q => q.id === queueId);
  const includeIds = [];
  if (item && item.similar && item.similar.length > 0) {
    const cb = document.getElementById(`link-similar-${queueId}`);
    if (cb && cb.checked) {
      includeIds.push(...item.similar.map(s => s.id));
    }
  }
  
  try {
    const res = await adminFetch(`/api/queue/${queueId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ 
        title, 
        body_ar,
        include_ids: includeIds
      })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل إنشاء الإجابة والربط');
    }
    
    showToast('تم إنشاء الإجابة وربط الأسئلة بنجاح!', 'success');
    await fetchQueue();
    updateQueueBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// تجاهل السؤال وحذفه من الطابور
async function ignoreQueueItem(queueId) {
  if (!confirm('هل أنت متأكد من تجاهل وحذف هذا السؤال من طابور التدريب؟')) return;
  
  try {
    const res = await adminFetch(`/api/queue/${queueId}/ignore`, {
      method: 'POST'
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل تجاهل السؤال');
    }
    
    showToast('تم تجاهل السؤال وحذفه من الطابور.', 'info');
    await fetchQueue();
    updateQueueBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ==========================================================================
   تبويب 2: إدارة الإجابات والـ CRUD
   ========================================================================== */

let deletedVariantIds = [];

async function fetchAnswers() {
  const tbody = document.getElementById('answers-table-body');
  tbody.innerHTML = '<tr><td colspan="5" class="text-center">جاري تحميل الإجابات...</td></tr>';
  
  try {
    const res = await adminFetch('/api/answers');
    if (!res.ok) throw new Error('فشل جلب الإجابات');
    allAnswers = await res.json();
    
    renderAnswersTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">خطأ: ${err.message}</td></tr>`;
  }
}

function renderAnswersTable() {
  const tbody = document.getElementById('answers-table-body');
  tbody.innerHTML = '';
  
  if (allAnswers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-secondary">لا توجد إجابات مخزنة حتى الآن. اضغط على الزر بالأعلى لإضافة واحدة!</td></tr>';
    return;
  }
  
  allAnswers.forEach(ans => {
    const tr = document.createElement('tr');
    
    // حساب عدد الصيغ
    const variantsCount = ans.variants ? ans.variants.length : 0;
    
    // حساب الرضا
    const votes = ans.votes_count ?? ans.feedback_count ?? ans.total_votes ?? 0;
    const pct = ans.satisfaction_pct ?? ans.satisfaction_rate ?? ans.satisfaction ?? null;
    
    let satisfactionHtml = '<span class="satisfaction-badge neutral">—</span>';
    let isLow = false;
    
    if (votes > 0 && pct !== null) {
      const displayPct = pct <= 1 ? Math.round(pct * 100) : Math.round(pct);
      if (displayPct < 60 && votes >= 3) {
        isLow = true;
        satisfactionHtml = `<span class="satisfaction-badge low">${displayPct}% (${votes} أصوات)</span>`;
      } else {
        satisfactionHtml = `<span class="satisfaction-badge good">${displayPct}% (${votes} أصوات)</span>`;
      }
    }
    
    if (isLow) {
      tr.className = 'low-satisfaction-row';
    }
    
    // تنسيق التاريخ بشكل مبسط
    const dateStr = ans.updated_at ? ans.updated_at.split(' ')[0] : 'غير معروف';
    
    tr.innerHTML = `
      <td><strong>${escapeHtml(ans.title)}</strong></td>
      <td><span class="badge badge-info">${variantsCount} صيغة</span></td>
      <td>${satisfactionHtml}</td>
      <td><span class="text-muted">${dateStr}</span></td>
      <td>
        <button class="btn-secondary btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="showEditAnswerModal(${ans.id})">تعديل 📝</button>
        <button class="btn-danger btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="deleteAnswer(${ans.id})">حذف 🗑️</button>
      </td>
    `;
    
    tbody.appendChild(tr);
  });
}

// تصفية جدول الإجابات
function filterAnswersTable() {
  const query = document.getElementById('answer-search-input').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#answers-table-body tr');
  
  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    if (text.includes(query)) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
}

// عرض نافذة إضافة إجابة
function showAddAnswerModal() {
  document.getElementById('answer-modal-title').innerText = 'إضافة إجابة جديدة';
  document.getElementById('answer-id-field').value = '';
  document.getElementById('answer-title-field').value = '';
  document.getElementById('answer-body-ar-field').value = '';
  document.getElementById('answer-body-en-field').value = '';
  
  // إخفاء قسم إدارة الصيغ الموجودة عند الإضافة
  document.getElementById('existing-variants-group').style.display = 'none';
  document.getElementById('existing-variants-list').innerHTML = '';
  document.getElementById('answer-new-variants-field').value = '';
  
  deletedVariantIds = [];
  
  document.getElementById('answer-modal').style.display = 'flex';
}

// عرض نافذة تعديل إجابة
function showEditAnswerModal(id) {
  const ans = allAnswers.find(a => a.id === id);
  if (!ans) return;
  
  document.getElementById('answer-modal-title').innerText = 'تعديل إجابة قائمة';
  document.getElementById('answer-id-field').value = ans.id;
  document.getElementById('answer-title-field').value = ans.title;
  document.getElementById('answer-body-ar-field').value = ans.body_ar;
  document.getElementById('answer-body-en-field').value = ans.body_en || '';
  
  // إظهار وإعداد قسم إدارة الصيغ
  document.getElementById('existing-variants-group').style.display = 'flex';
  const listContainer = document.getElementById('existing-variants-list');
  listContainer.innerHTML = '';
  
  deletedVariantIds = [];
  
  if (ans.variants && ans.variants.length > 0) {
    ans.variants.forEach(variant => {
      const item = document.createElement('div');
      item.className = 'variant-edit-item';
      item.id = `variant-item-${variant.id}`;
      
      const textSpan = document.createElement('span');
      textSpan.className = 'variant-text';
      textSpan.innerText = `${variant.text_raw} (${variant.lang === 'ar' ? 'عربي' : 'إنجليزي'} - ${variant.source})`;
      
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-delete-variant';
      delBtn.innerHTML = '×';
      delBtn.title = 'حذف هذه الصيغة';
      delBtn.onclick = () => markVariantForDeletion(variant.id);
      
      item.appendChild(textSpan);
      item.appendChild(delBtn);
      listContainer.appendChild(item);
    });
  } else {
    listContainer.innerHTML = '<div class="text-muted text-center" style="font-size:0.8rem; padding: 0.5rem;">لا توجد صيغ مربوطة حالياً.</div>';
  }
  
  document.getElementById('answer-new-variants-field').value = '';
  
  document.getElementById('answer-modal').style.display = 'flex';
}

// وسم صيغة للحذف من الواجهة
function markVariantForDeletion(variantId) {
  if (!deletedVariantIds.includes(variantId)) {
    deletedVariantIds.push(variantId);
  }
  const element = document.getElementById(`variant-item-${variantId}`);
  if (element) {
    element.style.opacity = '0.3';
    element.style.textDecoration = 'line-through';
    // تغيير زر الحذف ليكون تراجع
    const delBtn = element.querySelector('.btn-delete-variant');
    if (delBtn) {
      delBtn.innerHTML = '↩️';
      delBtn.onclick = () => unmarkVariantForDeletion(variantId);
    }
  }
}

// التراجع عن وسم صيغة للحذف
function unmarkVariantForDeletion(variantId) {
  deletedVariantIds = deletedVariantIds.filter(id => id !== variantId);
  const element = document.getElementById(`variant-item-${variantId}`);
  if (element) {
    element.style.opacity = '1';
    element.style.textDecoration = 'none';
    const delBtn = element.querySelector('.btn-delete-variant');
    if (delBtn) {
      delBtn.innerHTML = '×';
      delBtn.onclick = () => markVariantForDeletion(variantId);
    }
  }
}

function closeAnswerModal() {
  document.getElementById('answer-modal').style.display = 'none';
}

// حفظ أو تحديث الإجابة
async function saveAnswer(e) {
  e.preventDefault();
  
  const id = document.getElementById('answer-id-field').value;
  const title = document.getElementById('answer-title-field').value.trim();
  const body_ar = document.getElementById('answer-body-ar-field').value.trim();
  const body_en = document.getElementById('answer-body-en-field').value.trim() || null;
  
  // معالجة الصيغ الجديدة
  const newVariantsText = document.getElementById('answer-new-variants-field').value;
  const newVariants = newVariantsText.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  const isEdit = !!id;
  
  try {
    let res;
    if (isEdit) {
      // تعديل إجابة قائمة
      res = await adminFetch(`/api/answers/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title,
          body_ar,
          body_en,
          add_variants: newVariants,
          del_variant_ids: deletedVariantIds
        })
      });
    } else {
      // إضافة إجابة جديدة
      res = await adminFetch('/api/answers', {
        method: 'POST',
        body: JSON.stringify({
          title,
          body_ar,
          body_en,
          variants: newVariants
        })
      });
    }
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل حفظ الإجابة');
    }
    
    showToast(isEdit ? 'تم تحديث الإجابة بنجاح!' : 'تم إضافة الإجابة بنجاح!', 'success');
    closeAnswerModal();
    await fetchAnswers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// حذف الإجابة وصيغها
async function deleteAnswer(id) {
  if (!confirm('هل أنت متأكد من رغبتك في حذف هذه الإجابة وجميع الصيغ المرتبطة بها نهائياً؟')) return;
  
  try {
    const res = await adminFetch(`/api/answers/${id}`, {
      method: 'DELETE'
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل حذف الإجابة');
    }
    
    showToast('تم حذف الإجابة وكل صيغها بنجاح.', 'success');
    await fetchAnswers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ==========================================================================
   تبويب 3: إدارة المهارات (Skills)
   ========================================================================== */

async function fetchSkills() {
  const container = document.getElementById('skills-grid-container');
  container.innerHTML = '<div class="loading-spinner">جاري تحميل المهارات...</div>';
  
  try {
    const res = await adminFetch('/api/skills');
    if (!res.ok) throw new Error('فشل جلب المهارات');
    allSkills = await res.json();
    
    renderSkillsGrid(container);
  } catch (err) {
    container.innerHTML = `<div class="card text-center text-danger">حدث خطأ أثناء تحميل المهارات: ${err.message}</div>`;
  }
}

function renderSkillsGrid(container) {
  container.innerHTML = '';
  
  if (allSkills.length === 0) {
    container.innerHTML = `
      <div class="card text-center text-secondary" style="grid-column: 1 / -1; padding: 3rem 1rem;">
        <span style="font-size: 2.5rem; display: block; margin-bottom: 1rem;">🛠️</span>
        لا توجد مهارات مسجلة حالياً. أضف مهارة ترحيب أو وقت لتجربتها!
      </div>
    `;
    return;
  }
  
  allSkills.forEach(skill => {
    const card = document.createElement('div');
    card.className = 'card skill-card';
    
    // تحليل مصفوفة المحفزات
    let triggers = [];
    try {
      triggers = typeof skill.triggers_json === 'string' ? JSON.parse(skill.triggers_json) : skill.triggers_json;
    } catch (e) {
      triggers = [skill.triggers_json];
    }
    
    const isEnabled = skill.enabled === 1 || skill.enabled === true;
    
    card.innerHTML = `
      <div>
        <div class="skill-header">
          <div class="skill-title">
            <h3>${escapeHtml(skill.name)}</h3>
          </div>
          <span class="badge ${isEnabled ? 'badge-success' : 'badge-error'}">
            ${isEnabled ? 'نشطة' : 'معطلة'}
          </span>
        </div>
        
        <div class="skill-body">
          <p class="skill-desc">${escapeHtml(skill.description || 'بدون وصف')}</p>
          
          <div class="skill-meta-label">عبارات التفعيل (Triggers):</div>
          <div class="skill-triggers-preview">
            ${triggers.map(t => `<span class="trigger-tag">${escapeHtml(t)}</span>`).join('')}
          </div>
          
          <div class="skill-meta-label" style="margin-top:0.75rem;">قالب الرد:</div>
          <pre class="skill-template-preview">${escapeHtml(skill.template)}</pre>
        </div>
      </div>
      
      <div class="skill-actions">
        <button class="btn-secondary btn-full btn-sm" onclick="showEditSkillModal(${skill.id})">تعديل 📝</button>
        <button class="btn-danger btn-full btn-sm" onclick="deleteSkill(${skill.id})">حذف 🗑️</button>
      </div>
    `;
    
    container.appendChild(card);
  });
}

function showAddSkillModal() {
  document.getElementById('skill-modal-title').innerText = 'إضافة مهارة جديدة';
  document.getElementById('skill-id-field').value = '';
  document.getElementById('skill-name-field').value = '';
  document.getElementById('skill-desc-field').value = '';
  document.getElementById('skill-triggers-field').value = '';
  document.getElementById('skill-template-field').value = '';
  document.getElementById('skill-enabled-field').checked = true;
  
  document.getElementById('skill-modal').style.display = 'flex';
}

function showEditSkillModal(id) {
  const skill = allSkills.find(s => s.id === id);
  if (!skill) return;
  
  document.getElementById('skill-modal-title').innerText = 'تعديل مهارة قائمة';
  document.getElementById('skill-id-field').value = skill.id;
  document.getElementById('skill-name-field').value = skill.name;
  document.getElementById('skill-desc-field').value = skill.description || '';
  
  let triggers = [];
  try {
    triggers = typeof skill.triggers_json === 'string' ? JSON.parse(skill.triggers_json) : skill.triggers_json;
  } catch (e) {
    triggers = [skill.triggers_json];
  }
  
  document.getElementById('skill-triggers-field').value = triggers.join('\n');
  document.getElementById('skill-template-field').value = skill.template;
  document.getElementById('skill-enabled-field').checked = skill.enabled === 1 || skill.enabled === true;
  
  document.getElementById('skill-modal').style.display = 'flex';
}

function closeSkillModal() {
  document.getElementById('skill-modal').style.display = 'none';
}

// حفظ أو تحديث المهارة
async function saveSkill(e) {
  e.preventDefault();
  
  const id = document.getElementById('skill-id-field').value;
  const name = document.getElementById('skill-name-field').value.trim();
  const description = document.getElementById('skill-desc-field').value.trim() || null;
  const template = document.getElementById('skill-template-field').value;
  const enabled = document.getElementById('skill-enabled-field').checked ? 1 : 0;
  
  // معالجة المحفزات
  const triggersText = document.getElementById('skill-triggers-field').value;
  const triggers = triggersText.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  if (triggers.length === 0) {
    showToast('يجب كتابة محفز تفعيل واحد على الأقل للمهارة', 'error');
    return;
  }
  
  const isEdit = !!id;
  
  try {
    let res;
    if (isEdit) {
      res = await adminFetch(`/api/skills/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name,
          description,
          triggers,
          template,
          enabled
        })
      });
    } else {
      res = await adminFetch('/api/skills', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          triggers,
          template,
          enabled
        })
      });
    }
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل حفظ المهارة');
    }
    
    showToast(isEdit ? 'تم تحديث المهارة بنجاح!' : 'تم إضافة المهارة بنجاح!', 'success');
    closeSkillModal();
    await fetchSkills();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// حذف المهارة
async function deleteSkill(id) {
  if (!confirm('هل أنت متأكد من رغبتك في حذف هذه المهارة نهائياً؟')) return;
  
  try {
    const res = await adminFetch(`/api/skills/${id}`, {
      method: 'DELETE'
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل حذف المهارة');
    }
    
    showToast('تم حذف المهارة بنجاح.', 'success');
    await fetchSkills();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ==========================================================================
   تبويب 4: السجل والإحصاءات وتدريب ذاتي
   ========================================================================== */

async function fetchStats() {
  const cardsContainer = document.getElementById('stats-cards-container');
  const logsContainer = document.getElementById('logs-terminal-container');
  
  cardsContainer.innerHTML = '<div class="loading-spinner" style="grid-column: 1 / -1;">جاري جلب الإحصاءات...</div>';
  logsContainer.innerHTML = 'جاري جلب سجل الأحداث...';
  
  try {
    const res = await adminFetch('/api/stats');
    if (!res.ok) throw new Error('فشل جلب الإحصاءات والسجل');
    const data = await res.json();
    
    // رسم كروت الإحصاءات الخمسة الفاخرة (Pride Counter)
    const answered = data.answered_count ?? data.total_answered ?? data.answered ?? 0;
    const immediate = data.immediate_ratio ?? data.immediate_pct ?? data.immediate ?? 0;
    const userVariants = data.user_variants ?? data.user_variants_count ?? data.user_vars ?? 0;
    const examScore = data.avg_exam_score ?? data.last_exam_score ?? data.exam_score ?? 0;
    const satisfaction = data.satisfaction_rate ?? data.satisfaction_pct ?? data.satisfaction ?? 0;

    const displayImmediate = immediate <= 1 ? Math.round(immediate * 100) : Math.round(immediate);
    const displayExam = examScore <= 1 ? Math.round(examScore * 100) : Math.round(examScore);
    const displaySat = satisfaction <= 1 ? Math.round(satisfaction * 100) : Math.round(satisfaction);

    cardsContainer.innerHTML = `
      <div class="stats-pride-cards" style="grid-column: 1 / -1; width: 100%;">
        <!-- Card 1: Answered Questions -->
        <div class="pride-card">
          <div class="pride-card-icon">💬</div>
          <div class="pride-card-info">
            <h4>الأسئلة المجابة</h4>
            <p>${answered}</p>
          </div>
        </div>
        <!-- Card 2: Immediate Answers -->
        <div class="pride-card">
          <div class="pride-card-icon">⚡</div>
          <div class="pride-card-info">
            <h4>الإجابة الفورية (7 أيام)</h4>
            <p>${displayImmediate}%</p>
          </div>
        </div>
        <!-- Card 3: User Variants Learned -->
        <div class="pride-card">
          <div class="pride-card-icon">🌱</div>
          <div class="pride-card-info">
            <h4>صيغ مستخدمة متعلّمة</h4>
            <p>${userVariants}</p>
          </div>
        </div>
        <!-- Card 4: Last Exam Score -->
        <div class="pride-card">
          <div class="pride-card-icon">🎓</div>
          <div class="pride-card-info">
            <h4>متوسط آخر امتحان</h4>
            <p>${displayExam}%</p>
          </div>
        </div>
        <!-- Card 5: General Satisfaction -->
        <div class="pride-card">
          <div class="pride-card-icon">💖</div>
          <div class="pride-card-info">
            <h4>نسبة الرضا العامة</h4>
            <p>${displaySat}%</p>
          </div>
        </div>
      </div>
    `;
    
    // رسم السجل
    const logs = data.training_log ?? data.logs ?? [];
    if (logs.length === 0) {
      logsContainer.innerHTML = '<div class="text-secondary">لا توجد سجلات تدريب حالياً.</div>';
    } else {
      logsContainer.innerHTML = '';
      logs.forEach(log => {
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        
        // تبسيط شكل التاريخ
        const time = log.created_at ? log.created_at.split(' ')[1] || log.created_at : '';
        
        entry.innerHTML = `
          <span class="log-time">[${time}]</span>
          <span class="log-event">${escapeHtml(log.event)}:</span>
          <span class="log-detail">${escapeHtml(log.detail || '')}</span>
        `;
        logsContainer.appendChild(entry);
      });
    }
  } catch (err) {
    cardsContainer.innerHTML = `<div class="card text-center text-danger" style="grid-column: 1 / -1;">خطأ: ${err.message}</div>`;
    logsContainer.innerHTML = `<span class="text-danger">فشل في جلب السجلات: ${err.message}</span>`;
  }
}

// تشغيل حلقة التدريب الذاتي
async function runSelfTrain() {
  const btn = document.getElementById('btn-run-selftrain');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>جاري التدريب والتوسيع... 🔁</span>';
  
  try {
    const res = await adminFetch('/api/selftrain', {
      method: 'POST'
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل استدعاء التدريب الذاتي');
    }
    
    const data = await res.json();
    
    // إشعار بالنتيجة
    const addedCount = data.added ?? 0;
    const suggestionsCount = data.suggestions ? data.suggestions.length : 0;
    const tookMs = data.tookMs ?? 0;
    
    showToast(`اكتمل التدريب الذاتي بنجاح! تم إضافة ${addedCount} صيغة جديدة، واقتراح دمج لـ ${suggestionsCount} زوج من الإجابات. (الوقت: ${tookMs}ms)`, 'success');
    
    // تحديث البيانات
    await fetchStats();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

/* ==========================================================================
   تبويب 5: النسخ الاحتياطي والـ CSV
   ========================================================================== */

// تصدير المعرفة كـ JSON
async function exportData() {
  try {
    const res = await adminFetch('/api/export');
    if (!res.ok) throw new Error('فشل عملية تصدير البيانات');
    
    const data = await res.json();
    const dataStr = JSON.stringify(data, null, 2);
    
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `sanad_knowledge_backup_${date}.json`;
    document.body.appendChild(a);
    a.click();
    
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('تم تصدير المعرفة بنجاح وبدء تحميل الملف!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// استيراد المعرفة كـ JSON ودمجها
async function importData(e) {
  e.preventDefault();
  
  const fileInput = document.getElementById('import-file-input');
  const file = fileInput.files[0];
  if (!file) {
    showToast('الرجاء اختيار ملف JSON للاستيراد أولاً', 'error');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const payload = JSON.parse(event.target.result);
      
      const res = await adminFetch('/api/import', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'فشل عملية الدمج والاستيراد');
      }
      
      showToast('تم استيراد ودمج البيانات بنجاح في قاعدة البيانات!', 'success');
      fileInput.value = ''; // مسح خانة الملف
    } catch (err) {
      showToast(`فشل الاستيراد: ${err.message}`, 'error');
    }
  };
  
  reader.onerror = () => {
    showToast('حدث خطأ أثناء قراءة ملف النسخة الاحتياطية', 'error');
  };
  
  reader.readAsText(file);
}

/* ==========================================================================
   تبويب 7: قاموس المرادفات (Synonyms)
   ========================================================================== */

async function fetchSynonyms() {
  const tbody = document.getElementById('synonyms-table-body');
  tbody.innerHTML = '<tr><td colspan="3" class="text-center">جاري تحميل المرادفات...</td></tr>';
  
  try {
    const res = await adminFetch('/api/synonyms');
    if (!res.ok) throw new Error('فشل جلب المرادفات');
    allSynonyms = await res.json();
    renderSynonymsTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-danger">خطأ: ${err.message}</td></tr>`;
  }
}

function renderSynonymsTable() {
  const tbody = document.getElementById('synonyms-table-body');
  tbody.innerHTML = '';
  
  if (allSynonyms.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center text-secondary">لا توجد مرادفات مخزنة حالياً. أضف مرادفاً جديداً!</td></tr>';
    return;
  }
  
  allSynonyms.forEach(syn => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(syn.term)}</strong></td>
      <td><span class="badge badge-info">${escapeHtml(syn.canonical)}</span></td>
      <td>
        <button class="btn-secondary btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="showEditSynonymModal(${syn.id})">تعديل 📝</button>
        <button class="btn-danger btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="deleteSynonym(${syn.id})">حذف 🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function filterSynonymsTable() {
  const query = document.getElementById('synonym-search-input').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#synonyms-table-body tr');
  
  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    if (text.includes(query)) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
}

function showAddSynonymModal() {
  document.getElementById('synonym-modal-title').innerText = 'إضافة مرادف جديد';
  document.getElementById('synonym-id-field').value = '';
  document.getElementById('synonym-term-field').value = '';
  document.getElementById('synonym-canonical-field').value = '';
  document.getElementById('synonym-modal').style.display = 'flex';
}

function showEditSynonymModal(id) {
  const syn = allSynonyms.find(s => s.id === id);
  if (!syn) return;
  
  document.getElementById('synonym-modal-title').innerText = 'تعديل مرادف قائم';
  document.getElementById('synonym-id-field').value = syn.id;
  document.getElementById('synonym-term-field').value = syn.term;
  document.getElementById('synonym-canonical-field').value = syn.canonical;
  document.getElementById('synonym-modal').style.display = 'flex';
}

function closeSynonymModal() {
  document.getElementById('synonym-modal').style.display = 'none';
}

async function saveSynonym(e) {
  e.preventDefault();
  
  const id = document.getElementById('synonym-id-field').value;
  const term = document.getElementById('synonym-term-field').value.trim();
  const canonical = document.getElementById('synonym-canonical-field').value.trim();
  
  if (!term || !canonical) {
    showToast('يجب ملء حقول المرادف والكلمة المعتمدة', 'error');
    return;
  }
  
  const isEdit = !!id;
  
  try {
    let res;
    if (isEdit) {
      res = await adminFetch(`/api/synonyms/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ term, canonical })
      });
    } else {
      res = await adminFetch('/api/synonyms', {
        method: 'POST',
        body: JSON.stringify({ term, canonical })
      });
    }
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل حفظ المرادف');
    }
    
    showToast(isEdit ? 'تم تحديث المرادف بنجاح!' : 'تم إضافة المرادف بنجاح!', 'success');
    closeSynonymModal();
    await fetchSynonyms();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteSynonym(id) {
  if (!confirm('هل أنت متأكد من رغبتك في حذف هذا المرادف نهائياً؟')) return;
  
  try {
    const res = await adminFetch(`/api/synonyms/${id}`, {
      method: 'DELETE'
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل حذف المرادف');
    }
    
    showToast('تم حذف المرادف بنجاح.', 'success');
    await fetchSynonyms();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ==========================================================================
   تبويب 8: امتحان الذات (Self-Exams)
   ========================================================================== */

async function fetchExams() {
  const tbody = document.getElementById('exams-table-body');
  tbody.innerHTML = '<tr><td colspan="7" class="text-center">جاري تحميل أحدث نتائج الامتحان...</td></tr>';
  
  try {
    const res = await adminFetch('/api/exam');
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-secondary">لا توجد نتائج سابقة. اضغط على زر "تشغيل امتحان قياس الأداء" للبدء.</td></tr>';
      return;
    }
    const data = await res.json();
    renderExamsTable(data);
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-secondary">لا توجد نتائج سابقة. اضغط على زر "تشغيل امتحان قياس الأداء" للبدء.</td></tr>';
  }
}

function renderExamsTable(data) {
  const tbody = document.getElementById('exams-table-body');
  tbody.innerHTML = '';
  
  const results = data.results || data;
  if (!Array.isArray(results) || results.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-secondary">لا توجد نتائج سابقة. اضغط على زر "تشغيل امتحان قياس الأداء" للبدء.</td></tr>';
    return;
  }
  
  results.forEach(res => {
    const tr = document.createElement('tr');
    
    const scorePct = Math.round((res.score || 0) * 100);
    
    let scoreBadge = '';
    if (scorePct >= 80) {
      scoreBadge = `<span class="satisfaction-badge good">${scorePct}%</span>`;
    } else if (scorePct >= 50) {
      scoreBadge = `<span class="satisfaction-badge" style="background-color: rgba(245, 158, 11, 0.15); color: var(--color-warning); border: 1px solid rgba(245, 158, 11, 0.3); font-weight: bold; padding: 0.2rem 0.5rem; border-radius: 4px;">${scorePct}%</span>`;
    } else {
      scoreBadge = `<span class="satisfaction-badge low">${scorePct}%</span>`;
    }

    let lexicalBadge = '—';
    if (res.lexical && res.lexical.score !== null && res.lexical.score !== undefined) {
      const lexPct = Math.round(res.lexical.score * 100);
      if (lexPct >= 80) {
        lexicalBadge = `<span class="satisfaction-badge good">${lexPct}%</span>`;
      } else if (lexPct >= 50) {
        lexicalBadge = `<span class="satisfaction-badge" style="background-color: rgba(245, 158, 11, 0.15); color: var(--color-warning); border: 1px solid rgba(245, 158, 11, 0.3); font-weight: bold; padding: 0.2rem 0.5rem; border-radius: 4px;">${lexPct}%</span>`;
      } else {
        lexicalBadge = `<span class="satisfaction-badge low">${lexPct}%</span>`;
      }
    }
    
    let actionBtnHtml = '—';
    if (scorePct < 80) {
      actionBtnHtml = `<button class="btn-primary btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="runStrengthen(${res.answer_id})">قوِّني 💪</button>`;
    }
    
    const title = res.title || `إجابة رقم ${res.answer_id}`;
    
    tr.innerHTML = `
      <td><strong>${escapeHtml(title)}</strong></td>
      <td><span class="badge badge-info">${escapeHtml(res.mode || 'حتمي')}</span></td>
      <td title="جاهزية هذه الإجابة لو أُطفئ كل الذكاء الاصطناعي — مطابقة لفظية بحتة">${lexicalBadge}</td>
      <td>${res.tested || 0}</td>
      <td>${res.passed || 0}</td>
      <td>${scoreBadge}</td>
      <td>${actionBtnHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function runSelfExam() {
  const btn = document.getElementById('btn-run-exam');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>جاري تشغيل الامتحان وقياس الأداء... ⌛</span>';
  
  const tbody = document.getElementById('exams-table-body');
  tbody.innerHTML = '<tr><td colspan="7" class="text-center">جاري تشغيل الامتحان (قد يستغرق هذا دقيقة في الوضع الذكي)... ⌛</td></tr>';
  
  try {
    const res = await adminFetch('/api/exam', {
      method: 'POST'
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل تشغيل الامتحان');
    }
    
    const data = await res.json();
    showToast('اكتمل امتحان قياس الأداء بنجاح!', 'success');
    renderExamsTable(data);
  } catch (err) {
    showToast(err.message, 'error');
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">فشل الامتحان: ${err.message}</td></tr>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

async function runStrengthen(answerId) {
  try {
    showToast('جاري استدعاء التدريب الذاتي لتوسيع صيغ هذه الإجابة... 🔁', 'info');
    const res = await adminFetch('/api/selftrain', {
      method: 'POST',
      body: JSON.stringify({ answer_id: parseInt(answerId) })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل توسيع الصيغ');
    }
    
    const data = await res.json();
    const addedCount = data.added ?? 0;
    showToast(`اكتمل تدعيم الإجابة بنجاح! تم إضافة ${addedCount} صيغة مرادفة جديدة لهذه الإجابة.`, 'success');
    
    await runSelfExam();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ==========================================================================
   تبويب 9: إدارة CSV والنسخ الاحتياطية التلقائية
   ========================================================================== */

async function exportCSV() {
  try {
    const res = await adminFetch('/api/export-csv');
    if (!res.ok) throw new Error('فشل تصدير ملف CSV');
    
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sanad_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('تم تصدير ملف CSV بنجاح وبدء تحميله!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function importCSV(e) {
  e.preventDefault();
  
  const fileInput = document.getElementById('import-csv-file-input');
  const file = fileInput.files[0];
  if (!file) {
    showToast('الرجاء اختيار ملف CSV للاستيراد أولاً', 'error');
    return;
  }
  
  const formData = new FormData();
  formData.append('file', file);
  
  try {
    const res = await adminFetch('/api/import-csv', {
      method: 'POST',
      body: formData
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل استيراد CSV');
    }
    
    showToast('تم استيراد ودمج صياغات الأسئلة من ملف CSV بنجاح!', 'success');
    fileInput.value = '';
    await fetchAnswers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function fetchBackups() {
  const tbody = document.getElementById('auto-backups-table-body');
  tbody.innerHTML = '<tr><td colspan="3" class="text-center">جاري تحميل النسخ الاحتياطية من السيرفر...</td></tr>';
  
  try {
    const res = await adminFetch('/api/backups');
    if (!res.ok) throw new Error('فشل جلب قائمة النسخ الاحتياطية');
    
    const backups = await res.json();
    tbody.innerHTML = '';
    
    if (!Array.isArray(backups) || backups.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-center text-secondary">لا توجد نسخ احتياطية تلقائية محفوظة في السيرفر حالياً.</td></tr>';
      return;
    }
    
    backups.forEach(backup => {
      const filename = typeof backup === 'string' ? backup : backup.file;
      
      let dateDisplay = 'غير معروف';
      const match = filename.match(/sanad-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})/);
      if (match) {
        dateDisplay = `${match[1]} الساعة ${match[2]}:${match[3]}`;
      }
      
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code style="font-family: monospace;">${escapeHtml(filename)}</code></td>
        <td>${dateDisplay}</td>
        <td>
          <button class="btn-accent btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="restoreBackup('${filename}')">استرجاع 🔄</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-danger">خطأ: ${err.message}</td></tr>`;
  }
}

async function restoreBackup(filename) {
  if (!confirm(`هل أنت متأكد من رغبتك في استرجاع ملف النسخة الاحتياطية "${filename}"؟\nسيتم دمج البيانات دون حذف البيانات القائمة.`)) return;
  
  try {
    const res = await adminFetch('/api/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ file: filename })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'فشل استرجاع النسخة الاحتياطية');
    }
    
    showToast('تم استرجاع ودمج النسخة الاحتياطية بنجاح!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ==========================================================================
   دوال مساعدة عامة للواجهة
   ========================================================================== */

// عرض إشعار مؤقت (Toast Alert)
function showToast(message, type = 'success') {
  const container = document.getElementById('alert-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `alert-toast ${type}`;
  
  const textSpan = document.createElement('span');
  textSpan.innerText = message;
  toast.appendChild(textSpan);
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'alert-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.onclick = () => {
    toast.style.animation = 'none';
    toast.offsetHeight; // trigger reflow
    toast.style.animation = 'fadeOut 0.2s forwards';
    setTimeout(() => toast.remove(), 200);
  };
  toast.appendChild(closeBtn);
  
  container.appendChild(toast);
  
  // إزالة التنبيه تلقائياً بعد 5 ثواني
  setTimeout(() => {
    if (toast.parentNode) {
      toast.remove();
    }
  }, 5000);
}

// تنظيف مدخلات HTML للحماية من XSS
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return text.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ==========================================================================
   إدارة المستندات والتعلم منها (Documents)
   ========================================================================== */

async function fetchDocuments(silent = false) {
  const tbody = document.getElementById('documents-table-body');
  if (!silent && tbody) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">جاري تحميل المستندات...</td></tr>';
  }
  
  try {
    const res = await adminFetch('/api/documents');
    if (!res.ok) throw new Error('فشل جلب المستندات');
    allDocuments = await res.json();
    
    renderDocumentsTable();
  } catch (err) {
    if (!silent && tbody) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">خطأ: ${err.message}</td></tr>`;
    }
  }
}

function fetchDocumentsOnly() {
  const tbody = document.getElementById('documents-table-body');
  if (tbody && tbody.querySelector(':focus')) {
    return;
  }
  fetchDocuments(true);
}

function renderDocumentsTable() {
  const tbody = document.getElementById('documents-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  if (allDocuments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-secondary">لا توجد مستندات مرفوعة حالياً. ارفع مستنداً جديداً لبدء التدريب!</td></tr>';
    return;
  }
  
  allDocuments.forEach(doc => {
    const tr = document.createElement('tr');
    
    let statusBadge = '';
    switch (doc.status) {
      case 'new':
        statusBadge = '<span class="badge badge-new">جديد</span>';
        break;
      case 'generating':
        statusBadge = '<span class="badge badge-pulse-generating">جاري التوليد...</span>';
        break;
      case 'drafted':
        statusBadge = '<span class="badge badge-drafted" title="بانتظار اعتمادك">مسودة جاهزة ⚠️</span>';
        break;
      case 'ingested':
        statusBadge = '<span class="badge badge-ingested">تم التدريب ✅</span>';
        break;
      case 'failed':
        statusBadge = `<span class="badge badge-failed" title="${escapeHtml(doc.error || '')}">فشل ❌</span>`;
        break;
      default:
        statusBadge = `<span class="badge badge-new">${escapeHtml(doc.status)}</span>`;
    }
    
    const total = doc.chunks_total || 0;
    const done = doc.chunks_done || 0;
    const percentage = total > 0 ? Math.round((done / total) * 100) : 0;
    
    const progressBarHtml = `
      <div class="doc-progress-container" title="${done}/${total} مقطع مكتمل">
        <div class="doc-progress-bar">
          <div class="doc-progress-fill" style="width: ${percentage}%"></div>
        </div>
        <span class="doc-progress-text">${done}/${total}</span>
      </div>
    `;
    
    const sizeStr = formatBytes(doc.bytes || 0);
    
    tr.innerHTML = `
      <td><strong style="word-break: break-all;">${escapeHtml(doc.filename)}</strong></td>
      <td><span class="badge badge-new" style="text-transform: uppercase;">${escapeHtml(doc.kind)}</span></td>
      <td><span class="text-muted">${sizeStr}</span></td>
      <td>${statusBadge}</td>
      <td>${progressBarHtml}</td>
      <td>
        <button class="btn-primary btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="generateDocument(${doc.id})">علّمه 🧠</button>
        <button class="btn-danger btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="deleteDocument(${doc.id})">حذف 🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function generateDocument(id) {
  try {
    showToast('جاري بدء توليد مسودات التدريب... 🧠', 'info');
    const res = await adminFetch(`/api/documents/${id}/generate`, {
      method: 'POST'
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل تشغيل التوليد');
    }
    
    showToast(data.message || 'تم بدء عملية التوليد بنجاح!', 'success');
    
    await fetchDocuments(true);
    await fetchDrafts(true);
    updateSourcesBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteDocument(id) {
  if (!confirm('هل أنت متأكد من رغبتك في حذف هذا المستند نهائياً؟\nسيتم حذف جميع المسودات المرتبطة به.')) return;
  
  try {
    const res = await adminFetch(`/api/documents/${id}`, {
      method: 'DELETE'
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل حذف المستند');
    }
    
    showToast('تم حذف المستند بنجاح.', 'success');
    await fetchDocuments();
    await fetchDrafts();
    updateSourcesBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleDocumentUpload(input) {
  const file = input.files[0];
  if (!file) return;
  
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size > maxSize) {
    showToast('حجم الملف يتجاوز الحد الأقصى المسموح به (10 ميجابايت)', 'error');
    input.value = '';
    return;
  }
  
  const allowedExtensions = ['pdf', 'xlsx', 'csv', 'txt'];
  const ext = file.name.split('.').pop().toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    showToast('صيغة الملف غير مدعومة. الصيغ المسموحة: PDF, Excel, CSV, TXT', 'error');
    input.value = '';
    return;
  }
  
  const formData = new FormData();
  formData.append('file', file);
  
  showToast('جاري رفع ومعالجة المستند... 📄', 'info');
  
  try {
    const res = await adminFetch('/api/documents', {
      method: 'POST',
      body: formData
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل رفع المستند');
    }
    
    if (data.status === 'failed') {
      showToast(`فشل استخراج النص من المستند: ${data.error || 'خطأ غير معروف'}`, 'error');
    } else {
      showToast('تم رفع المستند واستخراج النص منه بنجاح! 🎉', 'success');
    }
    
    input.value = '';
    await fetchDocuments(true);
  } catch (err) {
    showToast(err.message, 'error');
    input.value = '';
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/* ==========================================================================
   تبويب 10: إدارة المصادر وتوجيهات المدرب (Sources)
   ========================================================================== */

async function fetchSources(silent = false) {
  const tbody = document.getElementById('sources-table-body');
  if (!silent && tbody) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center">جاري تحميل المصادر...</td></tr>';
  }
  
  try {
    const res = await adminFetch('/api/sources');
    if (!res.ok) throw new Error('فشل جلب المصادر');
    allSources = await res.json();
    
    renderSourcesTable();
  } catch (err) {
    if (!silent && tbody) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">خطأ: ${err.message}</td></tr>`;
    }
  }
}

function renderSourcesTable() {
  const tbody = document.getElementById('sources-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  if (allSources.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-secondary">لا توجد مصادر مضافة حالياً. أضف مصدراً جديداً بالضغط على الزر بالأعلى!</td></tr>';
    return;
  }
  
  allSources.forEach(source => {
    const tr = document.createElement('tr');
    
    // شارات الحالات الملونة
    // new رمادي / generating أزرق نابض / drafted برتقالي «بانتظار اعتمادك» / ingested أخضر / failed أحمر
    let statusBadge = '';
    switch (source.status) {
      case 'new':
        statusBadge = '<span class="badge badge-new">جديد</span>';
        break;
      case 'generating':
        statusBadge = '<span class="badge badge-pulse-generating">جاري التوليد...</span>';
        break;
      case 'drafted':
        statusBadge = '<span class="badge badge-drafted" title="بانتظار اعتمادك">مسودة جاهزة ⚠️</span>';
        break;
      case 'ingested':
        statusBadge = '<span class="badge badge-ingested">تم التدريب ✅</span>';
        break;
      case 'failed':
        statusBadge = '<span class="badge badge-failed">فشل ❌</span>';
        break;
      default:
        statusBadge = `<span class="badge badge-new">${escapeHtml(source.status)}</span>`;
    }
    
    const dateStr = source.created_at ? source.created_at.split(' ')[0] : 'غير معروف';
    
    tr.innerHTML = `
      <td>
        <a href="${escapeHtml(source.url)}" target="_blank" class="source-link" style="color: var(--color-primary); font-weight: 600; text-decoration: underline;">
          ${escapeHtml(source.title)}
        </a>
      </td>
      <td>${statusBadge}</td>
      <td><span class="text-muted">${dateStr}</span></td>
      <td>
        <button class="btn-primary btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="generateSource(${source.id})">علّمه 🧠</button>
        <button class="btn-secondary btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="showEditSourceModal(${source.id})">تعديل 📝</button>
        <button class="btn-danger btn-sm" style="padding: 0.3rem 0.7rem; font-size:0.8rem;" onclick="deleteSource(${source.id})">حذف 🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function generateSource(id) {
  try {
    showToast('جاري بدء توليد مسودة التدريب... 🧠', 'info');
    const res = await adminFetch(`/api/sources/${id}/generate`, {
      method: 'POST'
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل تشغيل التوليد');
    }
    
    showToast(data.message || 'تم بدء عملية التوليد بنجاح!', 'success');
    
    // تحديث فوري للحالة
    await fetchSources(true);
    await fetchDrafts(true);
    updateSourcesBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function showAddSourceModal() {
  document.getElementById('source-modal-title').innerText = 'إضافة مصدر جديد';
  document.getElementById('source-id-field').value = '';
  document.getElementById('source-title-field').value = '';
  document.getElementById('source-url-field').value = '';
  document.getElementById('source-guidance-field').value = '';
  
  document.getElementById('source-modal').style.display = 'flex';
}

function showEditSourceModal(id) {
  const source = allSources.find(s => s.id === id);
  if (!source) return;
  
  document.getElementById('source-modal-title').innerText = 'تعديل المصدر';
  document.getElementById('source-id-field').value = source.id;
  document.getElementById('source-title-field').value = source.title;
  document.getElementById('source-url-field').value = source.url;
  document.getElementById('source-guidance-field').value = source.guidance;
  
  document.getElementById('source-modal').style.display = 'flex';
}

function closeSourceModal() {
  document.getElementById('source-modal').style.display = 'none';
}

async function saveSource(e) {
  e.preventDefault();
  
  const id = document.getElementById('source-id-field').value;
  const title = document.getElementById('source-title-field').value.trim();
  const url = document.getElementById('source-url-field').value.trim();
  const guidance = document.getElementById('source-guidance-field').value.trim();
  
  if (!title || !url || !guidance) {
    showToast('الرجاء ملء جميع الحقول المطلوبة', 'error');
    return;
  }
  
  // تحقق أن الرابط يبدأ بـ http أو https
  if (!/^https?:\/\//i.test(url)) {
    showToast('يجب أن يبدأ الرابط بـ http:// أو https://', 'error');
    return;
  }
  
  const isEdit = !!id;
  
  try {
    let res;
    if (isEdit) {
      res = await adminFetch(`/api/sources/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title, url, guidance })
      });
    } else {
      res = await adminFetch('/api/sources', {
        method: 'POST',
        body: JSON.stringify({ title, url, guidance })
      });
    }
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل حفظ المصدر');
    }
    
    showToast(isEdit ? 'تم تحديث المصدر بنجاح!' : 'تم إضافة المصدر بنجاح!', 'success');
    closeSourceModal();
    await fetchSources();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteSource(id) {
  if (!confirm('هل أنت متأكد من رغبتك في حذف هذا المصدر نهائياً؟\nسيتم حذف جميع المسودات المرتبطة به.')) return;
  
  try {
    const res = await adminFetch(`/api/sources/${id}`, {
      method: 'DELETE'
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل حذف المصدر');
    }
    
    showToast('تم حذف المصدر بنجاح.', 'success');
    await fetchSources();
    await fetchDrafts();
    updateSourcesBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function fetchDrafts(silent = false) {
  const container = document.getElementById('drafts-container');
  if (!silent && container) {
    container.innerHTML = '<div class="loading-spinner">جاري تحميل المسودات بانتظار الاعتماد...</div>';
  }
  
  try {
    const res = await adminFetch('/api/drafts');
    if (!res.ok) throw new Error('فشل جلب المسودات المعلقة');
    pendingDrafts = await res.json();
    
    renderDraftsList();
  } catch (err) {
    if (!silent && container) {
      container.innerHTML = `<div class="card text-center text-danger">حدث خطأ أثناء تحميل المسودات: ${err.message}</div>`;
    }
  }
}

function renderDraftsList() {
  const container = document.getElementById('drafts-container');
  if (!container) return;
  container.innerHTML = '';
  
  if (pendingDrafts.length === 0) {
    container.innerHTML = `
      <div class="card text-center text-secondary" style="padding: 2rem 1rem;">
        <span style="font-size: 2rem; display: block; margin-bottom: 0.5rem;">🎉</span>
        لا توجد مسودات معلقة حالياً بانتظار الاعتماد.
      </div>
    `;
    return;
  }
  
  pendingDrafts.forEach(draft => {
    const card = document.createElement('div');
    card.className = 'draft-card card';
    card.id = `draft-card-${draft.id}`;
    
    // تحليل الصيغ من variants_json
    let variants = [];
    try {
      variants = typeof draft.variants_json === 'string' ? JSON.parse(draft.variants_json) : draft.variants_json;
    } catch (e) {
      variants = [];
    }
    
    let sourceTitle = '';
    if (draft.document_id) {
      if (draft.document_filename) {
        sourceTitle = draft.document_filename;
      } else {
        const doc = allDocuments.find(d => d.id === draft.document_id);
        sourceTitle = doc ? doc.filename : `مستند #${draft.document_id}`;
      }
    } else if (draft.source_id === null || draft.source_id === undefined) {
      sourceTitle = 'من طابور الأسئلة';
    } else {
      sourceTitle = draft.source_title || (draft.source ? draft.source.title : `مصدر #${draft.source_id}`);
    }
    
    card.innerHTML = `
      <div class="draft-header">
        <h3>${draft.document_id ? 'مسودة المستند' : 'مسودة المصدر'}: ${escapeHtml(sourceTitle)}</h3>
        <div class="draft-actions-top">
          <button class="btn-secondary btn-sm" onclick="saveDraftEdits(${draft.id})">حفظ التعديلات مؤقتاً 💾</button>
        </div>
      </div>
      <div class="draft-body">
        <div class="form-group">
          <label for="draft-title-${draft.id}">العنوان التعريفي للإجابة <span class="required">*</span></label>
          <input type="text" id="draft-title-${draft.id}" value="${escapeHtml(draft.title)}" required placeholder="عنوان الإجابة...">
        </div>
        <div class="form-group">
          <label for="draft-body-ar-${draft.id}">الرد باللغة العربية (إجباري) <span class="required">*</span></label>
          <textarea id="draft-body-ar-${draft.id}" rows="3" required placeholder="نص الرد باللغة العربية...">${escapeHtml(draft.body_ar)}</textarea>
        </div>
        <div class="form-group">
          <label for="draft-body-en-${draft.id}">الرد باللغة الإنجليزية (اختياري)</label>
          <textarea id="draft-body-en-${draft.id}" rows="3" placeholder="الترجمة الإنجليزية...">${escapeHtml(draft.body_en || '')}</textarea>
        </div>
        <div class="form-group">
          <label>صيغ الأسئلة المقترحة (Variants)</label>
          <div class="draft-variants-list" id="draft-variants-list-${draft.id}">
            <!-- ستضاف الصفوف هنا ديناميكياً -->
          </div>
          <button class="btn-secondary btn-sm" style="margin-top: 0.5rem; align-self: flex-start;" onclick="addVariantToDraftUI(${draft.id})">➕ إضافة صيغة سؤال جديدة</button>
        </div>
      </div>
      <div class="draft-footer">
        <button class="btn-accent" onclick="approveDraft(${draft.id})">اعتماد ✅</button>
        <button class="btn-danger" onclick="rejectDraft(${draft.id})">رفض ❌</button>
      </div>
    `;
    
    container.appendChild(card);
    
    // إضافة صيغ الأسئلة الحالية للـ DOM
    const list = document.getElementById(`draft-variants-list-${draft.id}`);
    if (variants && variants.length > 0) {
      variants.forEach(v => {
        appendVariantRowToDraft(draft.id, v.text, v.lang || 'ar');
      });
    } else {
      list.innerHTML = '<div class="no-variants-placeholder text-muted text-center" style="font-size:0.8rem; padding:0.5rem;">لا توجد صيغ أسئلة مضافة.</div>';
    }
  });
}

function appendVariantRowToDraft(draftId, textVal = '', langVal = 'ar') {
  const list = document.getElementById(`draft-variants-list-${draftId}`);
  if (!list) return;
  
  // إزالة النائب إن وجد
  const placeholder = list.querySelector('.no-variants-placeholder');
  if (placeholder) {
    placeholder.remove();
  }
  
  const row = document.createElement('div');
  row.className = 'draft-variant-row';
  row.style.display = 'flex';
  row.style.gap = '0.5rem';
  row.style.marginBottom = '0.5rem';
  
  row.innerHTML = `
    <input type="text" class="draft-variant-text-${draftId}" value="${escapeHtml(textVal)}" placeholder="اكتب صيغة السؤال المرادفة..." style="flex:1;">
    <select class="draft-variant-lang-${draftId}" style="width: 80px;">
      <option value="ar" ${langVal === 'ar' ? 'selected' : ''}>عربي</option>
      <option value="en" ${langVal === 'en' ? 'selected' : ''}>إنجليزي</option>
    </select>
    <button type="button" class="btn-delete-variant" onclick="this.parentElement.remove()" style="font-size: 1.2rem; line-height: 1; padding: 0 0.5rem; background: transparent; border: none; color: var(--text-muted); cursor: pointer;">×</button>
  `;
  
  list.appendChild(row);
}

function addVariantToDraftUI(draftId) {
  appendVariantRowToDraft(draftId, '', 'ar');
}

function getDraftDataFromUI(draftId) {
  const title = document.getElementById(`draft-title-${draftId}`).value.trim();
  const body_ar = document.getElementById(`draft-body-ar-${draftId}`).value.trim();
  const body_en = document.getElementById(`draft-body-en-${draftId}`).value.trim() || null;
  
  // قراءة كل صيغ الأسئلة
  const textInputs = document.querySelectorAll(`.draft-variant-text-${draftId}`);
  const langSelects = document.querySelectorAll(`.draft-variant-lang-${draftId}`);
  
  const variants = [];
  for (let i = 0; i < textInputs.length; i++) {
    const text = textInputs[i].value.trim();
    const lang = langSelects[i].value;
    if (text) {
      variants.push({ text, lang });
    }
  }
  
  return {
    title,
    body_ar,
    body_en,
    variants_json: JSON.stringify(variants)
  };
}

async function approveDraft(id) {
  try {
    const payload = getDraftDataFromUI(id);
    
    // 1. احفظ التعديلات أولاً
    const putRes = await adminFetch(`/api/drafts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    
    if (!putRes.ok) {
      const data = await putRes.json();
      throw new Error(data.error || 'فشل حفظ التعديلات على المسودة قبل الاعتماد');
    }
    
    // 2. أرسل طلب الاعتماد
    const approveRes = await adminFetch(`/api/drafts/${id}/approve`, {
      method: 'POST'
    });
    
    const approveData = await approveRes.json();
    if (!approveRes.ok) {
      throw new Error(approveData.error || 'فشل اعتماد المسودة');
    }
    
    showToast('تم اعتماد المسودة بنجاح وتحويلها لإجابة تدريب حية! ✅', 'success');
    
    // تحديث البيانات
    await fetchDocuments(true);
    await fetchSources(true);
    await fetchDrafts();
    updateSourcesBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function rejectDraft(id) {
  if (!confirm('هل أنت متأكد من رفض هذه المسودة؟\nسيؤدي ذلك إلى رفض المسودة وإعادة حالة المصدر إلى "جديد".')) return;
  
  try {
    const res = await adminFetch(`/api/drafts/${id}/reject`, {
      method: 'POST'
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل رفض المسودة');
    }
    
    showToast('تم رفض المسودة وإرجاع المصدر إلى الحالة جديد.', 'info');
    
    // تحديث البيانات
    await fetchDocuments(true);
    await fetchSources(true);
    await fetchDrafts();
    updateSourcesBadgeCount();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveDraftEdits(id) {
  try {
    const payload = getDraftDataFromUI(id);
    
    const res = await adminFetch(`/api/drafts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل حفظ التعديلات');
    }
    
    showToast('تم حفظ التعديلات على المسودة مؤقتاً بنجاح.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function updateSourcesBadgeCount() {
  try {
    const token = localStorage.getItem('sanad_admin_token');
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch('/api/drafts', { headers });
    if (res.ok) {
      const drafts = await res.json();
      const badge = document.getElementById('sources-badge');
      if (drafts && drafts.length > 0) {
        badge.innerText = drafts.length;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('Error fetching drafts count:', err);
  }
}

function fetchSourcesOnly() {
  const tbody = document.getElementById('sources-table-body');
  if (tbody && tbody.querySelector(':focus')) {
    return;
  }
  fetchSources(true);
}

function fetchDraftsOnly() {
  const container = document.getElementById('drafts-container');
  if (container && container.querySelector(':focus')) {
    return;
  }
  fetchDrafts(true);
}

// Evolution Tab Drawing & Fetch Logic
async function fetchEvolution() {
  try {
    const token = localStorage.getItem('sanad_admin_token');
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch('/api/metrics-history?days=30', { headers });
    if (!res.ok) throw new Error('Failed to fetch evolution metrics');
    const data = await res.json();
    
    const placeholder = document.getElementById('evolution-placeholder');
    const chartsDiv = document.getElementById('evolution-charts');
    
    if (data.length < 2) {
      placeholder.style.display = 'block';
      chartsDiv.style.display = 'none';
    } else {
      placeholder.style.display = 'none';
      chartsDiv.style.display = 'grid';
      
      drawLineChart('chart-hybrid', data, 'exam_avg', 'الامتحان الهجين', true);
      drawLineChart('chart-lexical', data, 'exam_lexical_avg', 'الصفر المطلق (Lexical)', true);
      drawLineChart('chart-queue', data, 'queue_pending', 'حجم الطابور', false);
      drawLineChart('chart-dataset', data, 'pairs_count', 'حجم الـ Dataset', false);
    }
  } catch (err) {
    console.error('Error fetching evolution:', err);
  }
}

function drawLineChart(canvasId, data, valueKey, label, isPercentage) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const width = canvas.width;
  const height = canvas.height;
  
  const paddingLeft = 40;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 30;
  
  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;
  
  const values = data.map(d => d[valueKey] || 0);
  const labels = data.map(d => d.date);
  
  const minVal = 0;
  let maxVal = Math.max(...values, 1);
  if (isPercentage) {
    maxVal = 1;
  } else {
    maxVal = Math.ceil(maxVal * 1.2);
  }
  
  const valRange = maxVal - minVal;
  
  ctx.strokeStyle = '#3f3f46';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(paddingLeft, paddingTop);
  ctx.lineTo(paddingLeft, height - paddingBottom);
  ctx.lineTo(width - paddingRight, height - paddingBottom);
  ctx.stroke();
  
  const points = [];
  ctx.strokeStyle = '#0ea5e9';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  
  for (let i = 0; i < data.length; i++) {
    const val = values[i];
    const x = paddingLeft + (i / (data.length - 1)) * chartWidth;
    const y = height - paddingBottom - ((val - minVal) / valRange) * chartHeight;
    points.push({ x, y, val, label: labels[i] });
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  
  ctx.fillStyle = '#0ea5e9';
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    
    if (i === points.length - 1) {
      ctx.strokeStyle = 'rgba(14, 165, 233, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(paddingLeft, p.y);
      ctx.lineTo(width - paddingRight, p.y);
      ctx.stroke();
    }
  }
  
  ctx.fillStyle = '#a1a1aa';
  ctx.font = '10px Tahoma, Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  
  const yTicks = [minVal, minVal + valRange / 2, maxVal];
  yTicks.forEach(tick => {
    const y = height - paddingBottom - ((tick - minVal) / valRange) * chartHeight;
    const text = isPercentage ? `${Math.round(tick * 100)}%` : Math.round(tick);
    ctx.fillText(text, paddingLeft - 8, y);
  });
  
  if (data.length > 0) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(data[0].date.slice(5), paddingLeft, height - paddingBottom + 6);
    if (data.length > 1) {
      ctx.fillText(data[data.length - 1].date.slice(5), width - paddingRight, height - paddingBottom + 6);
    }
  }
  
  if (points.length > 0) {
    const lastP = points[points.length - 1];
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px Tahoma, Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const textVal = isPercentage ? `${Math.round(lastP.val * 100)}%` : Math.round(lastP.val);
    ctx.fillText(textVal, lastP.x - 30, lastP.y - 8);
  }
}

async function runNightlyBatch() {
  const btn = document.getElementById('btn-run-nightly');
  const reportDiv = document.getElementById('nightly-run-report');
  
  btn.disabled = true;
  btn.innerHTML = '<span>جاري التشغيل... 🌙</span>';
  reportDiv.style.display = 'none';
  reportDiv.innerText = '';
  
  try {
    const token = localStorage.getItem('sanad_admin_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const res = await fetch('/api/nightly', {
      method: 'POST',
      headers
    });
    
    if (!res.ok) throw new Error('Nightly run failed');
    const result = await res.json();
    
    reportDiv.style.display = 'block';
    reportDiv.innerText = result.report || 'اكتملت الحلقة الليلية بنجاح ولم يصدر تقرير.';
    
    await fetchEvolution();
  } catch (err) {
    console.error(err);
    reportDiv.style.display = 'block';
    reportDiv.innerText = 'فشل تشغيل الحلقة الليلية: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>شغّل الحلقة الليلية الآن 🌙</span>';
  }
}

async function exportDataset() {
  try {
    const res = await adminFetch('/api/dataset/export');
    if (!res.ok) throw new Error('فشل تصدير الـ Dataset');
    
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sanad-pairs.jsonl';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('تم تصدير الـ Dataset بنجاح وبدء تحميلها! 📦', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}
