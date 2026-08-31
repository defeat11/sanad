// سَنَد - منطق واجهة الدردشة التفاعلية

document.addEventListener('DOMContentLoaded', () => {
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatMessages = document.getElementById('chat-messages');
  const chatWelcome = document.getElementById('chat-welcome');
  const typingIndicator = document.getElementById('typing-indicator');
  const suggestionsContainer = document.getElementById('chat-suggestions-container');
  const suggestionsList = document.getElementById('suggestions-list');

  // 1. توليد أو استرجاع الجلسة
  let session = localStorage.getItem('sanad_chat_session');
  if (!session) {
    session = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('sanad_chat_session', session);
  }

  // 2. إرسال الرسالة إلى البوت
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;

    chatInput.value = '';
    await handleUserMessage(text);
  });

  // معالجة إرسال رسالة المستخدم
  async function handleUserMessage(text) {
    // إخفاء الترحيب عند أول رسالة
    if (chatWelcome) {
      chatWelcome.style.display = 'none';
    }

    // إخفاء الاقتراحات السابقة
    hideSuggestions();

    // إضافة فقاعة المستخدم
    appendMessageBubble('user', text);
    scrollToBottom();

    // إظهار مؤشر الكتابة
    showTypingIndicator();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ session, text })
      });

      const data = await response.json();
      hideTypingIndicator();

      if (data.error) {
        appendMessageBubble('bot', `عذراً، حدث خطأ أثناء معالجة طلبك: ${data.error}`);
        scrollToBottom();
        return;
      }

      // إضافة رد البوت
      appendMessageBubble('bot', data.reply, data);
      
      // التعامل مع الاقتراحات "هل تقصد؟"
      if (data.suggestions && data.suggestions.length > 0) {
        showSuggestions(data.suggestions);
      }
      
      scrollToBottom();
    } catch (error) {
      hideTypingIndicator();
      appendMessageBubble('bot', 'عذراً، حدث خطأ في الاتصال بالخادم. يرجى المحاولة مرة أخرى.');
      scrollToBottom();
      console.error('Chat error:', error);
    }
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function parseMarkdown(text) {
    if (!text) return '';
    let escaped = escapeHTML(text);

    // Code blocks (triple backticks)
    const codeBlocks = [];
    escaped = escaped.replace(/```([\s\S]*?)```/g, (match, p1) => {
      const id = `__CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push(`<pre><code>${p1.trim()}</code></pre>`);
      return id;
    });

    // Inline code (single backticks)
    const inlineCodes = [];
    escaped = escaped.replace(/`([^`\n]+)`/g, (match, p1) => {
      const id = `__INLINE_CODE_${inlineCodes.length}__`;
      inlineCodes.push(`<code>${p1}</code>`);
      return id;
    });

    // Bold (**text**)
    escaped = escaped.replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>');

    // Links [text](url) - accepting http/https only
    escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, textContent, url) => {
      const trimmedUrl = url.trim();
      if (/^https?:\/\//i.test(trimmedUrl)) {
        return `<a href="${trimmedUrl}" target="_blank" rel="noopener">${textContent}</a>`;
      }
      return match;
    });

    // Lists (lines starting with - or *)
    const lines = escaped.split('\n');
    let inList = false;
    const processedLines = [];

    for (let line of lines) {
      const listMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
      if (listMatch) {
        if (!inList) {
          processedLines.push('<ul>');
          inList = true;
        }
        processedLines.push(`<li>${listMatch[2]}</li>`);
      } else {
        if (inList) {
          processedLines.push('</ul>');
          inList = false;
        }
        processedLines.push(line);
      }
    }
    if (inList) {
      processedLines.push('</ul>');
    }

    // Join lines. For normal text lines, add a <br>
    let result = processedLines.map(line => {
      if (line.startsWith('<ul') || line.startsWith('</ul') || line.startsWith('<li') || line.includes('__CODE_BLOCK_')) {
        return line;
      }
      return line + '<br>';
    }).join('\n');

    // Restore inline codes and code blocks
    inlineCodes.forEach((codeHtml, idx) => {
      result = result.replace(`__INLINE_CODE_${idx}__`, codeHtml);
    });
    codeBlocks.forEach((codeHtml, idx) => {
      result = result.replace(`__CODE_BLOCK_${idx}__`, codeHtml);
    });

    return result;
  }

  async function submitFeedback(chatId, vote, container) {
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chat_id: chatId, vote: vote })
      });
      
      const resData = await response.json();
      if (response.ok) {
        container.innerHTML = '<span class="feedback-thanks">شكرًا لتقييمك!</span>';
      } else {
        console.error('Feedback error:', resData.error);
        alert('حدث خطأ أثناء إرسال التقييم: ' + (resData.error || 'خطأ غير معروف'));
      }
    } catch (err) {
      console.error('Feedback fetch error:', err);
      alert('فشل الاتصال بالخادم لإرسال التقييم.');
    }
  }

  // إضافة فقاعة رسالة
  function appendMessageBubble(sender, text, data = null) {
    const wrapper = document.createElement('div');
    wrapper.className = `chat-bubble-wrapper ${sender}`;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    
    if (sender === 'bot') {
      bubble.innerHTML = parseMarkdown(text);
    } else {
      bubble.innerText = text;
    }
    wrapper.appendChild(bubble);

    // في حال رد البوت، نعرض البيانات الملحقة (نسبة المطابقة أو الطابور)
    if (sender === 'bot' && data) {
      const meta = document.createElement('div');
      meta.className = 'bubble-meta';

      let hasMeta = false;

      // نسبة المطابقة إن وجدت
      if (data.matched && typeof data.matched.score === 'number') {
        const scorePct = Math.round(data.matched.score * 100);
        const matchSpan = document.createElement('span');
        matchSpan.className = 'meta-match';
        matchSpan.innerText = `مطابقة: ${data.matched.title} (‎%${scorePct})`;
        meta.appendChild(matchSpan);
        hasMeta = true;
      }

      // شارة إرسال للتدريب
      if (data.queued) {
        const queueSpan = document.createElement('span');
        queueSpan.className = 'meta-queued';
        queueSpan.innerText = 'أُرسل للتدريب 📥';
        meta.appendChild(queueSpan);
        hasMeta = true;
      }

      // أزرار التقييم 👍/👎
      if (data.chat_id) {
        const feedbackContainer = document.createElement('div');
        feedbackContainer.className = 'meta-feedback';
        
        const upBtn = document.createElement('button');
        upBtn.className = 'feedback-btn up';
        upBtn.innerHTML = '👍';
        upBtn.title = 'إجابة مفيدة';
        upBtn.onclick = () => submitFeedback(data.chat_id, 1, feedbackContainer);
        
        const downBtn = document.createElement('button');
        downBtn.className = 'feedback-btn down';
        downBtn.innerHTML = '👎';
        downBtn.title = 'إجابة غير مفيدة';
        downBtn.onclick = () => submitFeedback(data.chat_id, -1, feedbackContainer);
        
        feedbackContainer.appendChild(upBtn);
        feedbackContainer.appendChild(downBtn);
        meta.appendChild(feedbackContainer);
        hasMeta = true;
      }

      if (hasMeta) {
        wrapper.appendChild(meta);
      }
    }

    chatMessages.appendChild(wrapper);
  }

  // إظهار الاقتراحات
  function showSuggestions(suggestions) {
    suggestionsList.innerHTML = '';
    suggestions.forEach(suggestion => {
      const btn = document.createElement('button');
      btn.className = 'suggestion-btn';
      btn.innerText = suggestion;
      btn.addEventListener('click', () => {
        handleUserMessage(suggestion);
      });
      suggestionsList.appendChild(btn);
    });
    suggestionsContainer.style.display = 'block';
  }

  // إخفاء الاقتراحات
  function hideSuggestions() {
    suggestionsContainer.style.display = 'none';
    suggestionsList.innerHTML = '';
  }

  // التحكم بمؤشر الكتابة
  function showTypingIndicator() {
    typingIndicator.style.display = 'flex';
    scrollToBottom();
  }

  function hideTypingIndicator() {
    typingIndicator.style.display = 'none';
  }

  // التمرير التلقائي لأسفل
  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
    // للتمرير على مستوى الحاوية الخارجية في الهواتف المحمولة
    const main = document.querySelector('.chat-main');
    if (main) {
      main.scrollTop = main.scrollHeight;
    }
  }
});
