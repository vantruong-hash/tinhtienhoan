/**
 * MailMaster - Application Logic
 * Frontend-only demo with localStorage persistence
 * Ready to connect to a Node.js/Express backend
 */

// ============================================
// DATA LAYER (localStorage persistence)
// ============================================

const DB = {
  get(key) {
    try { return JSON.parse(localStorage.getItem('mm_' + key) || 'null'); }
    catch { return null; }
  },
  set(key, val) {
    try { localStorage.setItem('mm_' + key, JSON.stringify(val)); }
    catch {}
  },
  getOrDefault(key, def) { return this.get(key) ?? def; }
};

// ============================================
// SEED DEFAULT DATA
// ============================================

function initDefaults() {
  if (!DB.get('users')) {
    DB.set('users', [
      { id: 'u1', username: 'admin', password: 'admin123', role: 'admin', email: 'admin@localhost' }
    ]);
  }
  if (!DB.get('domains')) {
    DB.set('domains', []);
  }
  if (!DB.get('emails')) {
    DB.set('emails', []);
  }
  if (!DB.get('messages')) {
    DB.set('messages', []);
  }
  if (!DB.get('settings')) {
    DB.set('settings', {
      smtpHost: '0.0.0.0',
      smtpPort: 25,
      retention: 365,
      maxMsgs: 500
    });
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Vừa xong';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} phút trước`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} giờ trước`;
  return d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateFull(ts) {
  return new Date(ts).toLocaleString('vi-VN');
}

function extractOTP(text) {
  const patterns = [
    /\b(\d{4,8})\b/g,
    /mã.*?[:：]\s*(\d{4,8})/gi,
    /code.*?[:：]\s*(\d{4,8})/gi,
    /OTP.*?[:：]\s*(\d{4,8})/gi,
  ];
  const found = new Set();
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const n = m[1];
      if (n.length >= 4 && n.length <= 8) found.add(n);
    }
  }
  return [...found];
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const el = document.createElement('textarea');
    el.value = text; document.body.appendChild(el);
    el.select(); document.execCommand('copy');
    el.remove();
  }
}

function randomName() {
  const adj = ['swift', 'bright', 'cool', 'happy', 'quick', 'smart', 'lucky', 'blue', 'green', 'sky'];
  const noun = ['fox', 'cat', 'bird', 'star', 'wave', 'rock', 'wolf', 'dove', 'hawk', 'fish'];
  return adj[Math.floor(Math.random() * adj.length)] +
         noun[Math.floor(Math.random() * noun.length)] +
         Math.floor(Math.random() * 9000 + 1000);
}

function generateBulkNames(type, prefix, count, customList) {
  const names = [];
  if (type === 'random') {
    while (names.length < count) {
      const n = randomName();
      if (!names.includes(n)) names.push(n);
    }
  } else if (type === 'prefix') {
    const p = prefix || 'user';
    for (let i = 1; i <= count; i++) names.push(`${p}${String(i).padStart(3, '0')}`);
  } else if (type === 'custom') {
    const lines = customList.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(count, lines.length); i++) names.push(lines[i]);
  }
  return names;
}

function escapeCsvField(val) {
  if (String(val).includes(',') || String(val).includes('"') || String(val).includes('\n')) {
    return '"' + String(val).replace(/"/g, '""') + '"';
  }
  return String(val);
}

function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(escapeCsvField).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================

function toast(msg, type = 'info', duration = 3000) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${msg}</span>`;
  document.getElementById('toastContainer').prepend(el);
  setTimeout(() => {
    el.style.animation = 'none';
    el.style.opacity = '0';
    el.style.transform = 'translateX(30px)';
    el.style.transition = 'all .3s';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ============================================
// MAIN APP
// ============================================

const app = (() => {
  let currentUser = null;
  let currentPage = 'dashboard';
  let selectedMessages = new Set();
  let bulkPreview = [];
  let emailPage = 1;
  const PAGE_SIZE = 15;

  // ------------- AUTH -------------

  function login(username, password) {
    const users = DB.get('users') || [];
    return users.find(u => u.username === username && u.password === password) || null;
  }

  function logout() {
    currentUser = null;
    DB.set('session', null);
    document.getElementById('app').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('loginUser').value = '';
    document.getElementById('loginPass').value = '';
  }

  function restoreSession() {
    const s = DB.get('session');
    if (s) {
      const users = DB.get('users') || [];
      const u = users.find(x => x.id === s.id);
      if (u) { currentUser = u; return true; }
    }
    return false;
  }

  // ------------- NAVIGATION -------------

  function navigate(page) {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const pageEl = document.getElementById('page-' + page);
    if (pageEl) pageEl.classList.add('active');
    const navEl = document.getElementById('nav-' + page);
    if (navEl) navEl.classList.add('active');
    const titles = {
      dashboard: 'Tổng quan',
      domains: 'Quản lý tên miền',
      emails: 'Địa chỉ email',
      inbox: 'Hộp thư đến',
      bulk: 'Tạo hàng loạt',
      settings: 'Cài đặt'
    };
    document.getElementById('topbarTitle').textContent = titles[page] || page;
    // close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');
    refreshPage(page);
  }

  function refreshPage(page) {
    switch(page) {
      case 'dashboard': renderDashboard(); break;
      case 'domains': renderDomains(); break;
      case 'emails': renderEmails(); break;
      case 'inbox': renderInbox(); break;
      case 'bulk': renderBulk(); break;
      case 'settings': renderSettings(); break;
    }
    updateBadges();
  }

  // ------------- DOMAINS -------------

  function getDomains() { return DB.getOrDefault('domains', []); }
  function saveDomains(d) { DB.set('domains', d); }

  function addDomain(name, desc) {
    const domains = getDomains();
    if (domains.find(d => d.name.toLowerCase() === name.toLowerCase())) return false;
    domains.push({ id: uid(), name: name.toLowerCase(), desc, status: 'active', createdAt: Date.now() });
    saveDomains(domains);
    return true;
  }

  function deleteDomain(id) {
    let domains = getDomains();
    const domain = domains.find(d => d.id === id);
    if (!domain) return;
    // Remove emails for this domain
    let emails = getEmails().filter(e => e.domain !== domain.name);
    DB.set('emails', emails);
    saveDomains(domains.filter(d => d.id !== id));
  }

  function renderDomains() {
    const domains = getDomains();
    const list = document.getElementById('domainsList');
    updateTopDomainBadge(domains);
    updateDomainSelects();

    if (!domains.length) {
      list.innerHTML = `<div class="empty-state big">
        <span>🌐</span>
        <h3>Chưa có tên miền nào</h3>
        <p>Thêm tên miền để bắt đầu tạo địa chỉ email</p>
        <button class="btn-primary" onclick="app.openAddDomain()">+ Thêm tên miền đầu tiên</button>
      </div>`;
      return;
    }

    const emails = getEmails();
    list.innerHTML = domains.map(d => {
      const count = emails.filter(e => e.domain === d.name).length;
      return `<div class="domain-card">
        <div class="domain-status-dot ${d.status}"></div>
        <div class="domain-info">
          <div class="domain-name">📧 @${d.name}</div>
          <div class="domain-meta">${d.desc || 'Không có mô tả'} • ${count} địa chỉ email • Thêm ${fmtDate(d.createdAt)}</div>
        </div>
        <div class="domain-actions">
          <button class="btn-sm" onclick="app.copyText('@${d.name}')">📋 Copy</button>
          <button class="btn-danger-sm" onclick="app.deleteDomainPrompt('${d.id}', '${d.name}')">🗑 Xóa</button>
        </div>
      </div>`;
    }).join('');
  }

  function updateTopDomainBadge(domains) {
    const label = document.getElementById('activeDomainLabel');
    const active = domains.filter(d => d.status === 'active');
    label.textContent = active.length ? `@${active[0].name}` + (active.length > 1 ? ` +${active.length - 1}` : '') : 'Chưa có tên miền';
  }

  function updateDomainSelects() {
    const domains = getDomains();
    const opts = '<option value="">-- Chọn tên miền --</option>' +
      domains.map(d => `<option value="${d.name}">@${d.name}</option>`).join('');
    ['emailDomainSelect', 'bulkDomainSelect', 'emailDomainFilter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        const prev = el.value;
        el.innerHTML = id === 'emailDomainFilter'
          ? '<option value="">Tất cả tên miền</option>' + domains.map(d => `<option value="${d.name}">@${d.name}</option>`).join('')
          : opts;
        if (prev) el.value = prev;
      }
    });
    const simTo = document.getElementById('simTo');
    if (simTo) {
      const emails = getEmails();
      simTo.innerHTML = '<option value="">-- Chọn email nhận --</option>' +
        emails.map(e => `<option value="${e.email}">${e.email}</option>`).join('');
    }
    const inboxFilter = document.getElementById('inboxEmailFilter');
    if (inboxFilter) {
      const emails = getEmails();
      inboxFilter.innerHTML = '<option value="">Tất cả email</option>' +
        emails.map(e => `<option value="${e.email}">${e.email}</option>`).join('');
    }
  }

  function openAddDomain() {
    document.getElementById('domainInput').value = '';
    document.getElementById('domainDesc').value = '';
    document.getElementById('addDomainError').classList.add('hidden');
    openModal('modalAddDomain');
    setTimeout(() => document.getElementById('domainInput').focus(), 100);
  }

  // ------------- EMAILS -------------

  function getEmails() { return DB.getOrDefault('emails', []); }
  function saveEmails(e) { DB.set('emails', e); }

  function addEmail(local, domain, note) {
    const emails = getEmails();
    const email = `${local}@${domain}`;
    if (emails.find(e => e.email === email)) return { ok: false, msg: 'Địa chỉ email này đã tồn tại!' };
    emails.push({ id: uid(), email, local, domain, note: note || '', status: 'active', createdAt: Date.now() });
    saveEmails(emails);
    return { ok: true };
  }

  function deleteEmail(id) {
    let emails = getEmails().filter(e => e.id !== id);
    saveEmails(emails);
    let msgs = getMessages().filter(m => m.to !== getEmails().find(e => e.id === id)?.email);
    // Just delete messages for this email
    const email = DB.getOrDefault('emails', []).find(e => e.id === id);
    if (email) {
      DB.set('messages', getMessages().filter(m => m.to !== email.email));
    }
  }

  let emailSearchQuery = '';
  let emailDomainFilter = '';

  function renderEmails() {
    const allEmails = getEmails();
    const q = emailSearchQuery.toLowerCase();
    const df = emailDomainFilter;
    let filtered = allEmails.filter(e =>
      (!q || e.email.toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q)) &&
      (!df || e.domain === df)
    );

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (emailPage > totalPages) emailPage = totalPages;
    const start = (emailPage - 1) * PAGE_SIZE;
    const paged = filtered.slice(start, start + PAGE_SIZE);

    const msgs = getMessages();
    const tbody = document.getElementById('emailsTableBody');

    if (!paged.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">
        <div class="empty-state"><span>📧</span><p>Không tìm thấy địa chỉ email nào. <a href="#" onclick="app.openAddEmail()">Tạo ngay!</a></p></div>
      </td></tr>`;
    } else {
      tbody.innerHTML = paged.map(e => {
        const count = msgs.filter(m => m.to === e.email).length;
        return `<tr>
          <td><input type="checkbox" class="email-row-check" data-id="${e.id}" /></td>
          <td>
            <div class="email-chip" title="${e.email}">
              ${e.email}
              <button onclick="app.copyText('${e.email}')" style="background:none;border:none;cursor:pointer;font-size:.75rem;padding:0;color:inherit;" title="Copy">📋</button>
            </div>
            ${e.note ? `<div style="font-size:.7rem;color:var(--text-muted);margin-top:.25rem">${e.note}</div>` : ''}
          </td>
          <td style="color:var(--text-secondary)">@${e.domain}</td>
          <td>
            <span style="font-weight:600;color:#a5b4fc">${count}</span>
            ${count > 0 ? `<button class="btn-sm" style="margin-left:.375rem" onclick="app.viewEmailInbox('${e.email}')">📥 Xem</button>` : ''}
          </td>
          <td style="color:var(--text-secondary)">${fmtDate(e.createdAt)}</td>
          <td><span class="status-badge ${e.status}">${e.status === 'active' ? 'Hoạt động' : 'Tắt'}</span></td>
          <td>
            <div class="action-btns">
              <button class="btn-sm" onclick="app.viewEmailInbox('${e.email}')">📥</button>
              <button class="btn-danger-sm" onclick="app.deleteEmailPrompt('${e.id}', '${e.email}')">🗑</button>
            </div>
          </td>
        </tr>`;
      }).join('');
    }

    // Pagination
    const pag = document.getElementById('emailPagination');
    pag.innerHTML = '';
    for (let i = 1; i <= totalPages; i++) {
      const btn = document.createElement('button');
      btn.className = 'page-btn' + (i === emailPage ? ' active' : '');
      btn.textContent = i;
      btn.onclick = () => { emailPage = i; renderEmails(); };
      pag.appendChild(btn);
    }

    document.getElementById('emailCountBadge').textContent = allEmails.length;
    updateDomainSelects();
  }

  function viewEmailInbox(email) {
    navigate('inbox');
    setTimeout(() => {
      const filter = document.getElementById('inboxEmailFilter');
      if (filter) { filter.value = email; filterMessages(); }
    }, 100);
  }

  function openAddEmail() {
    document.getElementById('emailLocalInput').value = '';
    document.getElementById('emailNote').value = '';
    document.getElementById('addEmailError').classList.add('hidden');
    updateDomainSelects();
    const domains = getDomains();
    if (domains.length === 0) {
      toast('Bạn cần thêm ít nhất một tên miền trước!', 'warning');
      navigate('domains');
      return;
    }
    openModal('modalAddEmail');
    setTimeout(() => document.getElementById('emailLocalInput').focus(), 100);
  }

  function deleteEmailPrompt(id, email) {
    if (confirm(`Xóa địa chỉ "${email}" và toàn bộ thư liên quan?`)) {
      const emails = getEmails();
      const target = emails.find(e => e.id === id);
      if (target) {
        saveEmails(emails.filter(e => e.id !== id));
        DB.set('messages', getMessages().filter(m => m.to !== target.email));
        toast(`Đã xóa ${email}`, 'success');
        renderEmails();
        updateBadges();
      }
    }
  }

  function deleteDomainPrompt(id, name) {
    const emailCount = getEmails().filter(e => e.domain === name).length;
    const warn = emailCount > 0 ? `\nSẽ xóa cả ${emailCount} địa chỉ email liên quan.` : '';
    if (confirm(`Xóa tên miền "@${name}"?${warn}`)) {
      deleteDomain(id);
      toast(`Đã xóa tên miền @${name}`, 'success');
      renderDomains();
      renderEmails();
      updateBadges();
    }
  }

  // ------------- MESSAGES -------------

  function getMessages() { return DB.getOrDefault('messages', []); }
  function saveMessages(m) { DB.set('messages', m); }

  let activeMessageId = null;
  let inboxSearchQuery = '';
  let inboxEmailFilterVal = '';

  function addMessage(from, to, subject, body) {
    const msgs = getMessages();
    const msg = {
      id: uid(),
      from, to, subject, body,
      read: false,
      createdAt: Date.now()
    };
    msgs.unshift(msg);
    // Limit per inbox
    const settings = DB.getOrDefault('settings', {});
    const max = settings.maxMsgs || 500;
    saveMessages(msgs.slice(0, max * 100)); // global cap
    updateBadges();
    // Show bell notification
    showBellNotif(subject, from);
    return msg;
  }

  function showBellNotif(subject, from) {
    toast(`📩 Thư mới: "${subject}" từ ${from}`, 'info', 4000);
    const badge = document.getElementById('bellBadge');
    badge.classList.remove('hidden');
    badge.textContent = parseInt(badge.textContent || '0') + 1;
  }

  function markRead(id) {
    const msgs = getMessages();
    const m = msgs.find(m => m.id === id);
    if (m) { m.read = true; saveMessages(msgs); }
  }

  function markAllRead() {
    const msgs = getMessages();
    msgs.forEach(m => m.read = true);
    saveMessages(msgs);
    renderInbox();
    updateBadges();
    toast('Đã đánh dấu tất cả thư là đã đọc', 'success');
  }

  function getFilteredMessages() {
    const q = inboxSearchQuery.toLowerCase();
    const ef = inboxEmailFilterVal;
    return getMessages().filter(m =>
      (!q || m.from.toLowerCase().includes(q) || m.subject.toLowerCase().includes(q) || m.body.toLowerCase().includes(q) || m.to.toLowerCase().includes(q)) &&
      (!ef || m.to === ef)
    );
  }

  function filterMessages() {
    inboxSearchQuery = document.getElementById('inboxSearch')?.value || '';
    inboxEmailFilterVal = document.getElementById('inboxEmailFilter')?.value || '';
    renderInbox();
  }

  function renderInbox() {
    updateDomainSelects();
    const msgs = getFilteredMessages();
    const list = document.getElementById('messageList');

    if (!msgs.length) {
      list.innerHTML = `<div class="empty-state">
        <span>📭</span>
        <p>${inboxSearchQuery || inboxEmailFilterVal ? 'Không tìm thấy thư phù hợp' : 'Hộp thư trống'}</p>
        ${!inboxSearchQuery && !inboxEmailFilterVal ? '<button class="btn-primary" onclick="app.simulateIncomingMail()">Mô phỏng thư đến</button>' : ''}
      </div>`;
      return;
    }

    list.innerHTML = msgs.map(m => {
      const otps = extractOTP(m.body);
      return `<div class="msg-item ${m.read ? '' : 'unread'} ${m.id === activeMessageId ? 'active' : ''}" onclick="app.openMessage('${m.id}')" id="msg-${m.id}">
        <div class="msg-item-header">
          <span class="msg-from">${escHtml(m.from)}</span>
          <span class="msg-time">${fmtDate(m.createdAt)}</span>
        </div>
        <div class="msg-subject">${escHtml(m.subject)}</div>
        <div class="msg-to">→ ${escHtml(m.to)}</div>
        ${otps.length ? `<div style="margin-top:.25rem"><span style="font-size:.7rem;background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.25);padding:.1rem .4rem;border-radius:4px;color:#a5b4fc">🔑 OTP: ${otps.join(', ')}</span></div>` : ''}
        ${!m.read ? '<div class="unread-dot"></div>' : ''}
      </div>`;
    }).join('');

    if (activeMessageId) {
      const msg = msgs.find(m => m.id === activeMessageId);
      if (msg) renderMessageDetail(msg);
    }
  }

  function openMessage(id) {
    const msgs = getMessages();
    const msg = msgs.find(m => m.id === id);
    if (!msg) return;
    activeMessageId = id;
    markRead(id);
    renderMessageDetail(msg);
    // Rerender list to update unread state
    renderInbox();
    updateBadges();
  }

  function renderMessageDetail(msg) {
    const panel = document.getElementById('messageDetail');
    const otps = extractOTP(msg.body);
    let otpHtml = '';
    if (otps.length) {
      otpHtml = `<div class="otp-highlight-block">
        <div>
          <div class="otp-label-inline">🔑 Mã OTP phát hiện được</div>
          <div style="display:flex;gap:.625rem;flex-wrap:wrap;margin-top:.375rem">
            ${otps.map(otp => `<div class="otp-code-display" onclick="app.copyOTP('${otp}')" title="Nhấn để copy" style="cursor:pointer">${otp}</div>`).join('')}
          </div>
        </div>
        <button class="otp-copy-btn" onclick="app.copyOTP('${otps[0]}')">📋 Copy OTP</button>
      </div>`;
    }

    panel.innerHTML = `<div class="msg-detail-header">
      <div class="msg-detail-subject">${escHtml(msg.subject)}</div>
      <div class="msg-detail-meta">
        <div class="msg-detail-meta-row"><span>Từ:</span><span>${escHtml(msg.from)}</span></div>
        <div class="msg-detail-meta-row"><span>Đến:</span><span>${escHtml(msg.to)}</span></div>
        <div class="msg-detail-meta-row"><span>Lúc:</span><span>${fmtDateFull(msg.createdAt)}</span></div>
      </div>
    </div>
    <div class="msg-body-content">
      ${otpHtml}
      <div class="msg-body-text">${escHtml(msg.body)}</div>
    </div>
    <div class="msg-detail-actions">
      <button class="btn-secondary" onclick="app.deleteMessage('${msg.id}')">🗑 Xóa thư</button>
      <button class="btn-secondary" onclick="app.copyText('${escHtml(msg.body).replace(/'/g, "\\'")}')">📋 Copy nội dung</button>
      ${otps.length ? `<button class="btn-primary" onclick="app.copyOTP('${otps[0]}')">📋 Copy OTP: ${otps[0]}</button>` : ''}
    </div>`;
  }

  function copyOTP(otp) {
    copyToClipboard(otp);
    toast(`Đã sao chép mã OTP: ${otp}`, 'success');
  }

  function deleteMessage(id) {
    if (!confirm('Xóa thư này?')) return;
    const msgs = getMessages().filter(m => m.id !== id);
    saveMessages(msgs);
    if (activeMessageId === id) {
      activeMessageId = null;
      document.getElementById('messageDetail').innerHTML = `<div class="message-detail-empty"><span>📨</span><p>Chọn một thư để xem nội dung</p></div>`;
    }
    renderInbox();
    updateBadges();
    toast('Đã xóa thư', 'success');
  }

  // ------------- SIMULATE MAIL -------------

  const simTemplates = {
    otp: {
      from: 'security@github.com',
      subject: 'Mã xác thực đăng nhập GitHub',
      body: `Xin chào,

Mã xác thực (OTP) của bạn là:

  748392

Mã này có hiệu lực trong 10 phút. Không chia sẻ mã này với bất kỳ ai.

Nếu bạn không yêu cầu mã này, hãy bỏ qua email này.

Trân trọng,
Đội ngũ bảo mật GitHub`
    },
    verify: {
      from: 'no-reply@google.com',
      subject: 'Xác thực địa chỉ email của bạn',
      body: `Chào mừng đến với Google!

Để hoàn tất đăng ký, vui lòng nhập mã xác thực sau:

  Mã xác thực: 291847

Mã này sẽ hết hạn sau 30 phút.

Nếu bạn không tạo tài khoản, hãy bỏ qua email này.

Đội ngũ Google`
    },
    promo: {
      from: 'deals@shop.com',
      subject: '🎉 Khuyến mãi đặc biệt dành riêng cho bạn!',
      body: `Chào bạn,

Chúng tôi có ưu đãi đặc biệt dành cho bạn!

🔥 Giảm 50% tất cả sản phẩm hôm nay
🎁 Miễn phí vận chuyển đơn từ 200.000đ
⏰ Ưu đãi kết thúc lúc 23:59 hôm nay

Dùng mã: SAVE50 để nhận ưu đãi

Mua ngay tại: shop.example.com

Trân trọng,
Shop Team`
    }
  };

  function applySimTemplate(name) {
    const t = simTemplates[name];
    if (!t) return;
    document.getElementById('simFrom').value = t.from;
    document.getElementById('simSubject').value = t.subject;
    document.getElementById('simBody').value = t.body;
  }

  function simulateIncomingMail() {
    updateDomainSelects();
    const emails = getEmails();
    if (!emails.length) {
      toast('Bạn cần tạo ít nhất một địa chỉ email trước!', 'warning');
      navigate('emails');
      return;
    }
    if (emails.length > 0) {
      document.getElementById('simTo').value = emails[0].email;
    }
    applySimTemplate('otp');
    openModal('modalSimulate');
  }

  function sendSimulatedMail() {
    const from = document.getElementById('simFrom').value.trim();
    const to = document.getElementById('simTo').value;
    const subject = document.getElementById('simSubject').value.trim();
    const body = document.getElementById('simBody').value.trim();

    if (!from || !to || !subject) {
      toast('Vui lòng điền đầy đủ thông tin!', 'error');
      return;
    }

    addMessage(from, to, subject, body);
    closeModal('modalSimulate');
    toast('📩 Đã nhận thư mới!', 'success');
    if (currentPage === 'inbox') renderInbox();
    if (currentPage === 'dashboard') renderDashboard();
  }

  // ------------- BULK CREATE -------------

  function renderBulk() {
    updateDomainSelects();
    document.getElementById('previewCount').textContent = '0 email';
    document.getElementById('bulkPreviewList').innerHTML = `<div class="empty-state"><span>⚡</span><p>Nhấn "Xem trước" để kiểm tra danh sách</p></div>`;
  }

  function previewBulk() {
    const domain = document.getElementById('bulkDomainSelect').value;
    const count = parseInt(document.getElementById('bulkCount').value) || 10;
    const type = document.getElementById('bulkNameType').value;
    const prefix = document.getElementById('bulkPrefix').value.trim();
    const custom = document.getElementById('bulkCustomList').value;

    if (!domain) { toast('Vui lòng chọn tên miền!', 'error'); return; }

    const names = generateBulkNames(type, prefix, count, custom);
    const existing = getEmails().map(e => e.email);
    bulkPreview = names.map(n => {
      const email = `${n}@${domain}`;
      return { email, conflict: existing.includes(email) };
    });

    const container = document.getElementById('bulkPreviewList');
    const conflicts = bulkPreview.filter(e => e.conflict).length;
    document.getElementById('previewCount').textContent = `${bulkPreview.length} email${conflicts ? ` (${conflicts} trùng)` : ''}`;

    container.innerHTML = bulkPreview.map(e =>
      `<div class="preview-email-item${e.conflict ? ' conflict' : ''}">
        <span>${e.email}</span>
        ${e.conflict ? '<span class="conflict-label">⚠ Trùng</span>' : ''}
      </div>`
    ).join('');
  }

  function createBulk() {
    if (!bulkPreview.length) { previewBulk(); return; }
    const toCreate = bulkPreview.filter(e => !e.conflict);
    if (!toCreate.length) {
      toast('Tất cả email đã bị trùng!', 'error');
      return;
    }

    const emails = getEmails();
    toCreate.forEach(item => {
      const [local, domain] = item.email.split('@');
      emails.push({ id: uid(), email: item.email, local, domain, note: 'Tạo hàng loạt', status: 'active', createdAt: Date.now() });
    });
    saveEmails(emails);
    toast(`✅ Đã tạo ${toCreate.length} địa chỉ email!`, 'success');
    bulkPreview = [];
    renderBulk();
    renderEmails();
    updateBadges();
  }

  // ------------- CSV IMPORT/EXPORT -------------

  function exportCsv() {
    const emails = getEmails();
    if (!emails.length) { toast('Chưa có email nào để xuất!', 'warning'); return; }
    const rows = [
      ['Email', 'Local', 'Domain', 'Note', 'Status', 'CreatedAt'],
      ...emails.map(e => [e.email, e.local, e.domain, e.note || '', e.status, new Date(e.createdAt).toISOString()])
    ];
    downloadCsv(`mailmaster_emails_${Date.now()}.csv`, rows);
    toast('Đã xuất CSV thành công!', 'success');
  }

  function importCsv(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      let count = 0;
      const emails = getEmails();
      const existing = emails.map(e => e.email);
      const domains = getDomains().map(d => d.name);

      // Skip header row
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
        const email = cols[0]?.toLowerCase();
        if (!email || !email.includes('@')) continue;
        if (existing.includes(email)) continue;
        const [local, domain] = email.split('@');
        if (!local || !domain) continue;
        // Auto-add domain if not exists
        if (!domains.includes(domain)) {
          getDomains().push({ id: uid(), name: domain, desc: 'Nhập từ CSV', status: 'active', createdAt: Date.now() });
          domains.push(domain);
          saveDomains(getDomains());
        }
        emails.push({ id: uid(), email, local, domain, note: cols[3] || 'Nhập CSV', status: 'active', createdAt: Date.now() });
        existing.push(email);
        count++;
      }
      saveEmails(emails);
      toast(`Đã nhập ${count} địa chỉ email mới từ CSV!`, 'success');
      renderEmails();
      renderDomains();
      updateBadges();
    };
    reader.readAsText(file);
  }

  function copyAllEmails() {
    const emails = getEmails().map(e => e.email).join('\n');
    if (!emails) { toast('Chưa có email nào!', 'warning'); return; }
    copyToClipboard(emails);
    toast(`Đã sao chép ${getEmails().length} địa chỉ email!`, 'success');
  }

  // ------------- SETTINGS -------------

  function renderSettings() {
    const user = currentUser;
    document.getElementById('settingUsername').value = user.username;
    document.getElementById('settingEmail').value = user.email || '';
    document.getElementById('settingPassword').value = '';
    document.getElementById('settingPasswordConfirm').value = '';

    const s = DB.getOrDefault('settings', {});
    document.getElementById('settingSmtpHost').value = s.smtpHost || '0.0.0.0';
    document.getElementById('settingSmtpPort').value = s.smtpPort || 25;
    document.getElementById('settingRetention').value = s.retention || 365;
    document.getElementById('settingMaxMsgs').value = s.maxMsgs || 500;

    const emails = getEmails();
    const msgs = getMessages();
    document.getElementById('sysStatEmails').textContent = emails.length;
    document.getElementById('sysStatMessages').textContent = msgs.length;
    document.getElementById('sysStatDomains').textContent = getDomains().length;

    const storageUsed = JSON.stringify(localStorage).length / 1024;
    document.getElementById('sysStatStorage').textContent = storageUsed.toFixed(1) + ' KB';
  }

  function saveSettings() {
    const pass = document.getElementById('settingPassword').value;
    const confirm = document.getElementById('settingPasswordConfirm').value;
    if (pass && pass !== confirm) {
      toast('Mật khẩu xác nhận không khớp!', 'error');
      return;
    }
    const users = DB.get('users') || [];
    const idx = users.findIndex(u => u.id === currentUser.id);
    if (idx !== -1) {
      users[idx].email = document.getElementById('settingEmail').value;
      if (pass) users[idx].password = pass;
      DB.set('users', users);
      currentUser = users[idx];
    }
    toast('Đã lưu thông tin tài khoản!', 'success');
  }

  function saveSmtpSettings() {
    DB.set('settings', {
      smtpHost: document.getElementById('settingSmtpHost').value,
      smtpPort: parseInt(document.getElementById('settingSmtpPort').value),
      retention: parseInt(document.getElementById('settingRetention').value),
      maxMsgs: parseInt(document.getElementById('settingMaxMsgs').value)
    });
    toast('Đã lưu cấu hình SMTP!', 'success');
  }

  function exportBackup() {
    const backup = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      domains: getDomains(),
      emails: getEmails(),
      messages: getMessages(),
      settings: DB.get('settings')
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mailmaster_backup_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Đã xuất file sao lưu!', 'success');
  }

  function clearAll() {
    if (!confirm('⚠️ Xóa TẤT CẢ dữ liệu? Thao tác này không thể hoàn tác!')) return;
    if (!confirm('Bạn thực sự muốn xóa toàn bộ domains, emails và messages?')) return;
    DB.set('domains', []);
    DB.set('emails', []);
    DB.set('messages', []);
    toast('Đã xóa toàn bộ dữ liệu!', 'warning');
    refreshPage(currentPage);
    updateBadges();
  }

  // ------------- DASHBOARD -------------

  function renderDashboard() {
    const domains = getDomains();
    const emails = getEmails();
    const msgs = getMessages();
    const unread = msgs.filter(m => !m.read).length;

    document.getElementById('statDomains').textContent = domains.length;
    document.getElementById('statEmails').textContent = emails.length;
    document.getElementById('statMessages').textContent = msgs.length;
    document.getElementById('statUnread').textContent = unread;

    // Recent messages
    const rm = document.getElementById('recentMessages');
    const recent = msgs.slice(0, 5);
    if (!recent.length) {
      rm.innerHTML = `<div class="empty-state"><span>📭</span><p>Chưa có thư nào</p></div>`;
    } else {
      rm.innerHTML = recent.map(m => {
        const otps = extractOTP(m.body);
        return `<div class="recent-item" onclick="app.navigate('inbox'); setTimeout(()=>app.openMessage('${m.id}'),100)">
          <div class="recent-item-dot ${m.read ? 'read' : 'unread'}"></div>
          <div class="recent-item-info">
            <div class="recent-item-title">${escHtml(m.subject)}</div>
            <div class="recent-item-sub">${escHtml(m.from)} → ${escHtml(m.to)}</div>
          </div>
          ${otps.length ? `<span style="font-size:.7rem;color:#a5b4fc;white-space:nowrap">🔑${otps[0]}</span>` : ''}
          <span class="recent-item-time">${fmtDate(m.createdAt)}</span>
        </div>`;
      }).join('');
    }

    // Recent emails
    const re = document.getElementById('recentEmails');
    const recEmails = emails.slice(-5).reverse();
    if (!recEmails.length) {
      re.innerHTML = `<div class="empty-state"><span>📭</span><p>Chưa có địa chỉ nào</p></div>`;
    } else {
      re.innerHTML = recEmails.map(e => `
        <div class="recent-item" onclick="app.navigate('emails')">
          <div class="recent-item-dot unread"></div>
          <div class="recent-item-info">
            <div class="recent-item-title">${e.email}</div>
            <div class="recent-item-sub">${e.note || 'Không có ghi chú'}</div>
          </div>
          <span class="recent-item-time">${fmtDate(e.createdAt)}</span>
        </div>
      `).join('');
    }
  }

  // ------------- BADGES -------------

  function updateBadges() {
    const msgs = getMessages();
    const unread = msgs.filter(m => !m.read).length;
    const inboxBadge = document.getElementById('inboxBadge');
    inboxBadge.textContent = unread;
    inboxBadge.style.display = unread > 0 ? '' : 'none';

    const emailCountBadge = document.getElementById('emailCountBadge');
    emailCountBadge.textContent = getEmails().length;
  }

  // ------------- MODAL SYSTEM -------------

  function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
  function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

  // ------------- COPY -------------

  function copyText(text) {
    copyToClipboard(text);
    toast(`Đã sao chép: ${text.slice(0, 40)}${text.length > 40 ? '...' : ''}`, 'success', 2000);
  }

  // ------------- HTML ESCAPE -------------

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ------------- INIT -------------

  function init() {
    initDefaults();

    // Check session
    if (restoreSession()) {
      showApp();
    } else {
      document.getElementById('loginScreen').classList.remove('hidden');
    }

    // Login form
    document.getElementById('loginForm').addEventListener('submit', e => {
      e.preventDefault();
      const username = document.getElementById('loginUser').value.trim();
      const password = document.getElementById('loginPass').value;
      const user = login(username, password);
      if (user) {
        currentUser = user;
        DB.set('session', { id: user.id });
        document.getElementById('loginError').classList.add('hidden');
        showApp();
      } else {
        document.getElementById('loginError').classList.remove('hidden');
      }
    });

    document.getElementById('logoutBtn').addEventListener('click', logout);

    // Navigation
    document.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        navigate(el.dataset.page);
      });
    });

    // Hamburger
    document.getElementById('hamburger').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
    });
    document.getElementById('sidebarClose').addEventListener('click', () => {
      document.getElementById('sidebar').classList.remove('open');
    });

    // Refresh
    document.getElementById('refreshBtn').addEventListener('click', () => {
      refreshPage(currentPage);
      toast('Đã làm mới!', 'info', 1500);
    });

    // Bell
    document.getElementById('notifBtn').addEventListener('click', () => {
      const badge = document.getElementById('bellBadge');
      badge.classList.add('hidden');
      badge.textContent = '0';
      navigate('inbox');
    });

    // Add domain button
    document.getElementById('addDomainBtn').addEventListener('click', openAddDomain);
    document.getElementById('saveDomainBtn').addEventListener('click', () => {
      const name = document.getElementById('domainInput').value.trim().toLowerCase();
      const desc = document.getElementById('domainDesc').value.trim();
      const errEl = document.getElementById('addDomainError');
      if (!name) { errEl.textContent = 'Vui lòng nhập tên miền!'; errEl.classList.remove('hidden'); return; }
      if (!/^[a-z0-9][a-z0-9\-\.]*\.[a-z]{2,}$/.test(name)) {
        errEl.textContent = 'Tên miền không hợp lệ! Ví dụ: example.com'; errEl.classList.remove('hidden'); return;
      }
      if (!addDomain(name, desc)) {
        errEl.textContent = 'Tên miền này đã tồn tại!'; errEl.classList.remove('hidden'); return;
      }
      closeModal('modalAddDomain');
      toast(`Đã thêm tên miền @${name}`, 'success');
      renderDomains();
      updateBadges();
    });

    // Add email button
    document.getElementById('addEmailBtn').addEventListener('click', openAddEmail);
    document.getElementById('saveEmailBtn').addEventListener('click', () => {
      const local = document.getElementById('emailLocalInput').value.trim().toLowerCase();
      const domain = document.getElementById('emailDomainSelect').value;
      const note = document.getElementById('emailNote').value.trim();
      const errEl = document.getElementById('addEmailError');
      if (!local) { errEl.textContent = 'Vui lòng nhập tên email!'; errEl.classList.remove('hidden'); return; }
      if (!domain) { errEl.textContent = 'Vui lòng chọn tên miền!'; errEl.classList.remove('hidden'); return; }
      if (!/^[a-z0-9][a-z0-9._+-]*$/.test(local)) {
        errEl.textContent = 'Tên email chỉ được chứa chữ, số, dấu chấm, gạch dưới!'; errEl.classList.remove('hidden'); return;
      }
      const result = addEmail(local, domain, note);
      if (!result.ok) { errEl.textContent = result.msg; errEl.classList.remove('hidden'); return; }
      closeModal('modalAddEmail');
      toast(`Đã tạo ${local}@${domain}`, 'success');
      renderEmails();
      updateDomainSelects();
      updateBadges();
    });

    // Email search & filter
    document.getElementById('emailSearchInput').addEventListener('input', e => {
      emailSearchQuery = e.target.value;
      emailPage = 1;
      renderEmails();
    });
    document.getElementById('emailDomainFilter').addEventListener('change', e => {
      emailDomainFilter = e.target.value;
      emailPage = 1;
      renderEmails();
    });

    // Select all emails checkbox
    document.getElementById('selectAllEmails').addEventListener('change', e => {
      const checks = document.querySelectorAll('.email-row-check');
      checks.forEach(c => { c.checked = e.target.checked; });
      document.getElementById('bulkActions').classList.toggle('hidden', !e.target.checked);
    });

    // Export CSV
    document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);

    // Import CSV
    document.getElementById('importCsvInput').addEventListener('change', e => {
      importCsv(e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('bulkCsvImport').addEventListener('change', e => {
      importCsv(e.target.files[0]);
      e.target.value = '';
    });

    // Inbox search
    document.getElementById('inboxSearch').addEventListener('input', filterMessages);
    document.getElementById('inboxEmailFilter').addEventListener('change', filterMessages);
    document.getElementById('markAllReadBtn').addEventListener('click', markAllRead);
    document.getElementById('simulateMailBtn').addEventListener('click', simulateIncomingMail);
    document.getElementById('sendSimBtn').addEventListener('click', sendSimulatedMail);

    // Bulk create
    document.getElementById('bulkNameType').addEventListener('change', e => {
      document.getElementById('prefixGroup').style.display = e.target.value === 'prefix' ? '' : 'none';
      document.getElementById('customListGroup').style.display = e.target.value === 'custom' ? '' : 'none';
    });
    document.getElementById('previewBulkBtn').addEventListener('click', previewBulk);
    document.getElementById('createBulkBtn').addEventListener('click', createBulk);

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) {
          overlay.classList.add('hidden');
        }
      });
    });

    // Keyboard: ESC closes modal
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
      }
    });

    // Auto-refresh (simulated SMTP polling every 30s)
    setInterval(() => {
      updateBadges();
      if (currentPage === 'inbox') renderInbox();
      if (currentPage === 'dashboard') renderDashboard();
    }, 30000);
  }

  function showApp() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('userNameDisplay').textContent = currentUser.username;
    document.getElementById('userAvatar').textContent = currentUser.username[0].toUpperCase();
    navigate('dashboard');
  }

  return {
    init,
    navigate,
    openAddDomain,
    openAddEmail,
    openMessage,
    simulateIncomingMail,
    applySimTemplate,
    closeModal,
    copyText,
    copyOTP,
    exportCsv,
    copyAllEmails,
    deleteMessage,
    deleteEmailPrompt,
    deleteDomainPrompt,
    viewEmailInbox,
    saveSettings,
    saveSmtpSettings,
    exportBackup,
    clearAll,
    previewBulk,
    createBulk
  };
})();

// Boot
document.addEventListener('DOMContentLoaded', () => app.init());
