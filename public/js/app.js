const API = '';
let token = localStorage.getItem('vopgram_token') || null;
let me = { id: 1, phone: '+888 830 75 15', username: 'username', name: 'Пользователь', bio: '', avatar_url: '', balance: 185, verified: true, major: true };
let currentChatId = null;

// Mock data for offline/demo mode
const MOCK_CHATS = [
  { id: 1, type: 'private', title: 'Vopgram', avatar: '', last_text: 'Добро пожаловать!', last_at: Math.floor(Date.now()/1000) - 300 },
  { id: 2, type: 'private', title: 'Кот в кепке', avatar: '', last_text: 'Привет!', last_at: Math.floor(Date.now()/1000) - 3600 },
  { id: 3, type: 'private', title: 'Аниме Девушка', avatar: '', last_text: 'Kawaii~', last_at: Math.floor(Date.now()/1000) - 7200 },
  { id: 4, type: 'private', title: 'Мем Лорд', avatar: '', last_text: 'Мемы — это жизнь', last_at: Math.floor(Date.now()/1000) - 86400 },
];
const MOCK_GIFTS = [
  { id: 1, name: 'Роза', icon: '🌹', price: 15, market: 0 },
  { id: 2, name: 'Торт', icon: '🎂', price: 50, market: 0 },
  { id: 3, name: 'Ракета', icon: '🚀', price: 100, market: 1 },
  { id: 4, name: 'Алмаз', icon: '💎', price: 150, market: 1 },
  { id: 5, name: 'Трофей', icon: '🏆', price: 200, market: 0 },
  { id: 6, name: 'Кольцо', icon: '💍', price: 430, market: 1 },
  { id: 7, name: 'Корона', icon: '👑', price: 500, market: 1 },
  { id: 8, name: 'Единорог', icon: '🦄', price: 350, market: 1 },
];
let socket = null;
let adminToken = localStorage.getItem('vopgram_admin_token') || null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function showScreen(name) { $$('.screen').forEach(s => s.classList.remove('active')); const el = $('#screen-' + name); if (el) el.classList.add('active'); }
function go(name) { showScreen(name); }

function api(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(API + path, opts).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'request failed');
    return data;
  });
}
function adminApi(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (adminToken) opts.headers['Authorization'] = 'Bearer ' + adminToken;
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(API + path, opts).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'request failed');
    return data;
  });
}

$$('[data-back]').forEach(b => b.addEventListener('click', () => go(b.dataset.back)));
$$('[data-nav]').forEach(b => b.addEventListener('click', () => {
  const n = b.dataset.nav;
  if (n === 'chats') { go('chats'); loadChats(); }
  else if (n === 'contacts') { go('contacts'); loadContacts(); }
  else if (n === 'gifts') { go('gifts'); loadGifts(); }
  else if (n === 'profile') { go('profile'); loadProfile(); }
}));

// Welcome
$('#btn-welcome-start').addEventListener('click', () => go('getnumber'));
$('#btn-welcome-login').addEventListener('click', () => go('phone'));

// Get number
$('#btn-open-bot').addEventListener('click', () => {
  window.open('https://t.me/Vopgrambot', '_blank');
  toast('Откройте бота и нажмите /start');
});
$('#btn-have-number').addEventListener('click', () => go('phone'));

// Phone keypad
const phoneInput = $('#phone-input');
$$('.keypad button').forEach(b => {
  b.addEventListener('click', () => {
    const k = b.dataset.k;
    if (k === 'del') phoneInput.value = phoneInput.value.slice(0, -1);
    else phoneInput.value += k;
  });
});
$('#btn-phone-next').addEventListener('click', () => {
  const phone = phoneInput.value.trim();
  if (!phone) { toast('Введите номер'); return; }
  sessionStorage.setItem('vopgram_phone', phone);
  $('#verify-subtitle').textContent = 'Код отправлен для ' + phone;
  go('verify');
  startTimer();
  const boxes = $$('.code-box');
  if (boxes.length) boxes[0].focus();
});

function startTimer() {
  let s = 59;
  const el = $('#timer');
  const iv = setInterval(() => {
    s--;
    if (s <= 0) { el.textContent = 'Отправить снова'; clearInterval(iv); return; }
    el.textContent = '00:' + String(s).padStart(2, '0');
  }, 1000);
}
const codeBoxes = $$('.code-box');
codeBoxes.forEach((box, i) => {
  box.addEventListener('input', (e) => {
    const v = e.target.value.replace(/\D/g, '');
    e.target.value = v.slice(0, 1);
    if (v && i < codeBoxes.length - 1) codeBoxes[i + 1].focus();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !e.target.value && i > 0) codeBoxes[i - 1].focus();
  });
});

$('#btn-verify').addEventListener('click', async () => {
  const phone = sessionStorage.getItem('vopgram_phone');
  const code = codeBoxes.map(b => b.value).join('');
  if (code.length < 6) { toast('Введите 6-значный код'); return; }
  const deviceInfo = navigator.userAgent.slice(0, 80);
  try {
    const data = await api('/api/auth/verify', { method: 'POST', body: { phone, code, deviceInfo } });
    if (data.requiresConfirmation) {
      sessionStorage.setItem('vopgram_conf', data.confirmationId);
      $('#dev-name').textContent = deviceInfo.slice(0, 40);
      $('#dev-ip').textContent = '—';
      $('#dev-time').textContent = new Date().toLocaleString('ru');
      go('device');
      return;
    }
    token = data.token;
    localStorage.setItem('vopgram_token', token);
    me = data.user;
    initSocket();
    go('chats');
    loadChats();
  } catch (e) { toast(e.message); }
});

$('#btn-device-yes').addEventListener('click', async () => {
  const confId = sessionStorage.getItem('vopgram_conf');
  try {
    const data = await api('/api/auth/confirm-device', { method: 'POST', body: { confirmationId: Number(confId) } });
    token = data.token;
    localStorage.setItem('vopgram_token', token);
    me = data.user;
    initSocket();
    go('chats');
    loadChats();
  } catch (e) { toast(e.message); }
});
$('#btn-device-no').addEventListener('click', async () => {
  const confId = sessionStorage.getItem('vopgram_conf');
  try {
    await api('/api/auth/reject-device', { method: 'POST', body: { confirmationId: Number(confId) } });
    toast('Вход отклонён');
    go('welcome');
  } catch (e) { toast(e.message); }
});

function initSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on('message', (msg) => {
    if (currentChatId && String(msg.chat_id) === String(currentChatId)) appendMessage(msg);
    loadChats();
  });
}

// Chats
async function loadChats(q = '') {
  let data;
  try { data = await api('/api/chats'); } catch (e) { data = { chats: MOCK_CHATS }; }
  try {
    const list = $('#chat-list');
    list.innerHTML = '';
    let chats = data.chats;
    if (q) chats = chats.filter(c => (c.title || '').toLowerCase().includes(q.toLowerCase()));
    if (!chats.length) { list.innerHTML = '<div class="empty">Нет чатов. Начните общение!</div>'; return; }
    const countEl = $('#chat-count');
    if (countEl) countEl.textContent = chats.length;
    chats.forEach(c => {
      const el = document.createElement('div');
      el.className = 'list-item';
      const isChannel = c.channel == 1;
      const avatar = c.avatar ? `<img src="${c.avatar}" alt="">` : (isChannel ? '📢' : (c.type === 'group' ? '👥' : avatarEmoji(c.title)));
      el.innerHTML = `
        <div class="avatar">${avatar}</div>
        <div class="info">
          <div class="title">${escapeHtml(c.title || 'Без названия')} ${isChannel ? '<span style="font-size:11px;color:var(--text-sec);font-weight:400;">' + (c.subscribers || 0) + ' подп.</span>' : ''}</div>
          <div class="sub">${escapeHtml(c.last_text || 'Нет сообщений')}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
          <div class="time">${c.last_at ? timeAgo(c.last_at) : ''}</div>
          <button class="btn small" style="background:#7B68EE;color:#fff;padding:4px 10px;font-size:11px;border-radius:12px;" data-open>Open</button>
        </div>
      `;
      el.addEventListener('click', () => openChat(c));
      el.querySelector('[data-open]').addEventListener('click', (e) => { e.stopPropagation(); openChat(c); });
      list.appendChild(el);
    });
  } catch (e) { toast(e.message); }
}
$('#chat-search').addEventListener('input', (e) => loadChats(e.target.value));

function openChat(c) {
  currentChatId = c.id;
  $('#cv-title').textContent = c.title || 'Чат';
  $('#cv-avatar').innerHTML = c.avatar ? `<img src="${c.avatar}" alt="">` : (c.type === 'group' ? '👥' : avatarEmoji(c.title));
  $('#cv-messages').innerHTML = '';
  go('chatview');
  socket && socket.emit('join', c.id);
  loadMessages(c.id);
}

async function loadMessages(chatId) {
  try {
    const data = await api('/api/chats/' + chatId + '/messages');
    const box = $('#cv-messages');
    box.innerHTML = '';
    data.messages.forEach(m => appendMessage(m));
    box.scrollTop = box.scrollHeight;
  } catch (e) { toast(e.message); }
}

function appendMessage(m) {
  const box = $('#cv-messages');
  const mine = me && m.sender_id === me.id;
  const el = document.createElement('div');
  el.className = 'msg-row ' + (mine ? 'mine' : '');
  let content = '';
  if (m.type === 'gift') {
    content = `<div class="msg gift mine"><div class="icon">${escapeHtml(m.text.split(' ')[0])}</div><div style="font-size:13px;margin-top:4px;">${escapeHtml(m.text)}</div><div class="meta">${escapeHtml(m.sender_name || '')} · ${timeAgo(m.created_at)}</div></div>`;
  } else {
    content = `<div class="msg ${mine ? 'mine' : 'theirs'}">${!mine ? `<div class="sender">${escapeHtml(m.sender_name || '')}</div>` : ''}${escapeHtml(m.text)}<div class="meta">${timeAgo(m.created_at)} ${mine ? '✓✓' : ''}</div></div>`;
  }
  el.innerHTML = content;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

$('#cv-send').addEventListener('click', sendMessage);
$('#cv-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
async function sendMessage() {
  const text = $('#cv-input').value.trim();
  if (!text || !currentChatId) return;
  $('#cv-input').value = '';
  try { await api('/api/chats/' + currentChatId + '/messages', { method: 'POST', body: { text } }); }
  catch (e) { toast(e.message); }
}

// Gift send in chat
$('#cv-call') && $('#cv-call').addEventListener('click', () => toast('📞 Звонок... (демо)'));
$('#cv-video') && $('#cv-video').addEventListener('click', () => toast('📹 Видеозвонок... (демо)'));
$('#cv-gift').addEventListener('click', () => {
  $('#modal-gift-send').classList.add('active');
  loadGiftSendList();
});
$('#gift-send-cancel').addEventListener('click', () => $('#modal-gift-send').classList.remove('active'));
async function loadGiftSendList() {
  try {
    const data = await api('/api/gifts');
    const list = $('#gift-send-list');
    list.innerHTML = '';
    data.gifts.forEach(g => {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = `<div class="avatar sm">${g.icon}</div><div class="info"><div class="title">${escapeHtml(g.name)}</div><div class="sub">⭐ ${g.price}</div></div>`;
      el.addEventListener('click', async () => {
        if (!confirm('Отправить ' + g.name + ' за ' + g.price + ' ⭐?')) return;
        try {
          const r = await api('/api/chats/' + currentChatId + '/gift', { method: 'POST', body: { gift_id: g.id } });
          $('#modal-gift-send').classList.remove('active');
          toast('Подарок отправлен! Баланс: ' + r.balance);
          if (me) me.balance = r.balance;
        } catch (e) { toast(e.message); }
      });
      list.appendChild(el);
    });
  } catch (e) { toast(e.message); }
}

// Contacts
async function loadContacts(q = '') {
  try {
    const data = await api('/api/users/search?q=' + encodeURIComponent(q));
    const list = $('#contact-list');
    list.innerHTML = '';
    if (!data.users.length) { list.innerHTML = '<div class="empty">Пользователи не найдены</div>'; return; }
    data.users.forEach(u => {
      const el = document.createElement('div');
      el.className = 'list-item';
      const badge = u.verified ? '<span class="verified">✓</span>' : '';
      el.innerHTML = `
        <div class="avatar">${u.avatar_url ? `<img src="${u.avatar_url}">` : avatarEmoji(u.name)}</div>
        <div class="info">
          <div class="title">${escapeHtml(u.name || u.username || 'Пользователь')} ${badge}</div>
          <div class="sub">${escapeHtml(u.username ? '@' + u.username : u.phone)}</div>
        </div>
      `;
      el.addEventListener('click', () => {
        $('#view-prof-avatar').innerHTML = u.avatar_url ? `<img src="${u.avatar_url}">` : avatarEmoji(u.name);
        $('#view-prof-name').textContent = u.name || '—';
        $('#view-prof-username').textContent = u.username ? '@' + u.username : '@username';
        $('#view-prof-phone').textContent = u.phone;
        $('#view-prof-bio').textContent = '';
        $('#modal-profile').classList.add('active');
        $('#view-prof-message').onclick = async () => {
          $('#modal-profile').classList.remove('active');
          try {
            const r = await api('/api/chats/start', { method: 'POST', body: { userId: u.id } });
            openChat({ id: r.chatId, type: 'private', title: u.name, avatar: u.avatar_url });
          } catch (e) { toast(e.message); }
        };
      });
      list.appendChild(el);
    });
  } catch (e) { toast(e.message); }
}
$('#contact-search').addEventListener('input', (e) => loadContacts(e.target.value));
$('#view-prof-close').addEventListener('click', () => $('#modal-profile').classList.remove('active'));

// New chat modal
$('#btn-new-chat').addEventListener('click', () => { $('#modal-newchat').classList.add('active'); loadNewChatList(); });
$('#btn-new-channel') && $('#btn-new-channel').addEventListener('click', () => $('#modal-createchannel').classList.add('active'));
$('#channel-cancel').addEventListener('click', () => $('#modal-createchannel').classList.remove('active'));
$('#channel-create').addEventListener('click', async () => {
  const title = $('#channel-name').value.trim();
  const desc = $('#channel-desc').value.trim();
  if (!title) { toast('Введите название'); return; }
  try {
    const r = await api('/api/channels', { method: 'POST', body: { title, description: desc } });
    $('#modal-createchannel').classList.remove('active');
    toast('Канал создан!');
    loadChats();
  } catch (e) { toast(e.message); }
});
$('#newchat-cancel').addEventListener('click', () => $('#modal-newchat').classList.remove('active'));
async function loadNewChatList(q = '') {
  const data = await api('/api/users/search?q=' + encodeURIComponent(q));
  const list = $('#newchat-list');
  list.innerHTML = '';
  data.users.forEach(u => {
    const el = document.createElement('div');
    el.className = 'list-item';
    el.innerHTML = `<div class="avatar sm">${u.avatar_url ? `<img src="${u.avatar_url}">` : avatarEmoji(u.name)}</div><div class="info"><div class="title">${escapeHtml(u.name || u.username)}</div></div>`;
    el.addEventListener('click', async () => {
      try {
        const r = await api('/api/chats/start', { method: 'POST', body: { userId: u.id } });
        $('#modal-newchat').classList.remove('active');
        openChat({ id: r.chatId, type: 'private', title: u.name, avatar: u.avatar_url });
      } catch (e) { toast(e.message); }
    });
    list.appendChild(el);
  });
}
$('#newchat-search') && $('#newchat-search').addEventListener('input', (e) => loadNewChatList(e.target.value));

// Add contact
$('#btn-add-contact').addEventListener('click', () => $('#modal-addcontact').classList.add('active'));
$('#btn-create-group') && $('#btn-create-group').addEventListener('click', () => {
  $('#modal-creategroup').classList.add('active');
  loadGroupMembers();
});
$('#group-cancel').addEventListener('click', () => $('#modal-creategroup').classList.remove('active'));
$('#group-create').addEventListener('click', async () => {
  const name = $('#group-name').value.trim();
  if (!name) { toast('Введите название'); return; }
  const selected = Array.from(document.querySelectorAll('#group-members-list input:checked')).map(i => Number(i.value));
  try {
    const r = await api('/api/chats', { method: 'POST', body: { type: 'group', title: name, memberIds: selected } });
    $('#modal-creategroup').classList.remove('active');
    toast('Группа создана!');
    loadChats();
    openChat({ id: r.chat.id, type: 'group', title: name, avatar: '' });
  } catch (e) { toast(e.message); }
});
async function loadGroupMembers() {
  const data = await api('/api/users/search?q=');
  const list = $('#group-members-list');
  list.innerHTML = '';
  data.users.forEach(u => {
    const el = document.createElement('label');
    el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.gap = '10px'; el.style.padding = '8px 0';
    el.innerHTML = `<input type="checkbox" value="${u.id}"> <span style="color:var(--text);">${escapeHtml(u.name || u.username)}</span>`;
    list.appendChild(el);
  });
}
$('#addcontact-cancel').addEventListener('click', () => $('#modal-addcontact').classList.remove('active'));
$('#addcontact-save').addEventListener('click', async () => {
  const q = $('#addcontact-input').value.trim();
  if (!q) return;
  const data = await api('/api/users/search?q=' + encodeURIComponent(q));
  if (data.users.length) { toast('Пользователь найден'); $('#modal-addcontact').classList.remove('active'); loadContacts(q); }
  else toast('Пользователь не найден');
});

// Profile
async function loadProfile() {
  let data;
  try { data = await api('/api/me'); } catch (e) { data = { user: me }; }
  try {
    me = data.user;
    $('#prof-name-text').textContent = me.name || '—';
    $('#prof-verified').classList.toggle('hidden', !me.verified);
    $('#prof-major').classList.toggle('hidden', !me.major);
    $('#prof-username').textContent = me.username ? '@' + me.username : '@username';
    $('#prof-phone').textContent = me.phone;
    $('#prof-bio').textContent = me.bio || '';
    $('#prof-avatar').innerHTML = me.avatar_url ? `<img src="${me.avatar_url}" alt="">` : avatarEmoji(me.name);
    $('#prof-balance').textContent = me.balance || 0;
    const g = await api('/api/users/' + me.id + '/gifts');
    const box = $('#prof-gifts');
    box.innerHTML = '';
    g.gifts.forEach(x => {
      const s = document.createElement('span');
      s.style.fontSize = '24px';
      s.textContent = x.icon;
      box.appendChild(s);
    });
    $('#prof-gift-count').textContent = g.gifts.length;
  } catch (e) { toast(e.message); }
}

function avatarEmoji(name) {
  const emojis = ['🐱','🐶','🦊','🐼','🐯','🐰','🐸','🐵','😎','🤖'];
  let h = 0; for (let i = 0; i < (name || '').length; i++) h += name.charCodeAt(i);
  return emojis[h % emojis.length];
}

$('#btn-edit-profile').addEventListener('click', () => {
  $('#edit-name').value = me?.name || '';
  $('#edit-username').value = me?.username || '';
  $('#edit-bio').value = me?.bio || '';
  $('#modal-edit').classList.add('active');
});
$('#btn-edit-photo').addEventListener('click', () => $('#edit-avatar-file').click());
$('#edit-cancel').addEventListener('click', () => $('#modal-edit').classList.remove('active'));
$('#edit-save').addEventListener('click', async () => {
  const fd = new FormData();
  fd.append('name', $('#edit-name').value);
  fd.append('username', $('#edit-username').value);
  fd.append('bio', $('#edit-bio').value);
  const f = $('#edit-avatar-file').files[0];
  if (f) fd.append('avatar', f);
  try {
    const res = await fetch(API + '/api/me', { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token }, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    me = data.user;
    $('#modal-edit').classList.remove('active');
    loadProfile();
    toast('Сохранено');
  } catch (e) { toast(e.message); }
});
$('#btn-open-settings').addEventListener('click', () => go('settings'));
$('#btn-settings').addEventListener('click', () => go('settings'));
$('#btn-open-gifts') && $('#btn-open-gifts').addEventListener('click', () => { go('gifts'); loadGifts(); });
$('#btn-send-gift') && $('#btn-send-gift').addEventListener('click', () => { go('gifts'); loadGifts(); });

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  token = null; me = null; localStorage.removeItem('vopgram_token');
  go('welcome');
});

// Gifts
async function loadGifts() {
  let data, meData;
  try { data = await api('/api/gifts'); } catch (e) { data = { gifts: MOCK_GIFTS }; }
  try { meData = await api('/api/me'); } catch (e) { meData = { user: me }; }
  try {
    me = meData.user;
    $('#gift-balance').textContent = '⭐ ' + (me.balance || 0);
    const grid = $('#gift-grid');
    grid.innerHTML = '';
    data.gifts.forEach(g => {
      const el = document.createElement('div');
      el.className = 'gift-card' + (g.market ? ' featured' : '');
      el.innerHTML = `
        ${g.market ? '<div class="gift-tag">Market</div>' : ''}
        <span class="icon">${g.icon}</span>
        <div class="name">${escapeHtml(g.name)}</div>
        <div class="price-tag">⭐ ${g.price}</div>
      `;
      el.addEventListener('click', async () => {
        if (!confirm('Купить ' + g.name + ' за ' + g.price + ' ⭐?')) return;
        try {
          const r = await api('/api/gifts/' + g.id + '/buy', { method: 'POST' });
          toast('Куплено! Баланс: ' + r.balance);
          if (me) me.balance = r.balance;
          loadGifts();
        } catch (e) { toast(e.message); }
      });
      grid.appendChild(el);
    });
  } catch (e) { toast(e.message); }
}

// Admin
$('#btn-admin-open').addEventListener('click', () => go('admin'));
// Settings items interactivity
document.querySelectorAll('.settings-item').forEach(item => {
  const label = item.querySelector('.label')?.textContent || '';
  if (label.includes('Premium')) item.addEventListener('click', () => toast('⭐ Vopgram Premium — скоро!'));
  if (label.includes('Stars') || label.includes('My Stars')) item.addEventListener('click', () => toast('⭐ У вас ' + (me?.balance || 0) + ' звёзд'));
  if (label.includes('GRAM')) item.addEventListener('click', () => toast('💎 Earned GRAM: 0'));
  if (label.includes('Send Gift')) item.addEventListener('click', () => { go('gifts'); loadGifts(); });
  if (label.includes('Уведомления')) item.addEventListener('click', () => toast('🔔 Уведомления: Вкл'));
  if (label.includes('Конфиденциальность')) item.addEventListener('click', () => toast('🔒 Конфиденциальность'));
  if (label.includes('Скрыть номер')) item.addEventListener('click', () => {
    const cur = localStorage.getItem('vopgram_hide_phone') === '1';
    const next = !cur;
    localStorage.setItem('vopgram_hide_phone', next ? '1' : '0');
    $('#hide-phone-value').textContent = next ? 'Вкл' : 'Выкл';
    toast('🔒 Скрыть номер: ' + (next ? 'Вкл' : 'Выкл'));
  });
  if (label.includes('Чаты и звонки')) item.addEventListener('click', () => toast('💬 Чаты и звонки'));
  if (label.includes('Тема')) item.addEventListener('click', () => {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('vopgram_theme', next);
    $('#theme-value').textContent = next === 'dark' ? 'Тёмная' : 'Светлая';
    toast('🎨 Тема: ' + (next === 'dark' ? 'Тёмная' : 'Светлая'));
  });
  if (label.includes('Язык')) item.addEventListener('click', () => toast('🌐 Язык: Русский'));
  if (label.includes('О Vopgram')) item.addEventListener('click', () => toast('ℹ️ Vopgram v1.0'));
});
$('#admin-login-btn').addEventListener('click', async () => {
  try {
    const data = await adminApi('/api/admin/login', { method: 'POST', body: { password: $('#admin-password').value } });
    adminToken = data.token;
    localStorage.setItem('vopgram_admin_token', adminToken);
    $('#admin-login-card').classList.add('hidden');
    $('#admin-panel').classList.remove('hidden');
    loadAdmin();
  } catch (e) { toast(e.message); }
});
$('#admin-logout').addEventListener('click', () => {
  adminToken = null; localStorage.removeItem('vopgram_admin_token');
  $('#admin-login-card').classList.remove('hidden');
  $('#admin-panel').classList.add('hidden');
});

async function loadAdmin() {
  try {
    const stats = await adminApi('/api/admin/stats');
    $('#admin-stats').innerHTML = `Пользователей: ${stats.users}<br>Чатов: ${stats.chats}<br>Сообщений: ${stats.messages}<br>Выдано номеров: ${stats.issuedNumbers}`;
    const users = await adminApi('/api/admin/users');
    const tbody = $('#admin-users-table tbody');
    tbody.innerHTML = '';
    users.users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${escapeHtml(u.name || '')}${u.verified ? ' ✓' : ''}${u.major ? ' ★' : ''}</td>
        <td>${escapeHtml(u.phone)}</td>
        <td>${u.balance}</td>
        <td>
          <button class="btn small" data-act="verify" data-id="${u.id}">Верифицировать</button>
          <button class="btn small secondary" data-act="major" data-id="${u.id}">Major ${u.major ? 'off' : 'on'}</button>
          <button class="btn small secondary" data-act="balance" data-id="${u.id}">+100⭐</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const act = btn.dataset.act;
        try {
          if (act === 'verify') await adminApi('/api/admin/verify-user', { method: 'POST', body: { userId: id } });
          if (act === 'major') {
            const u = users.users.find(x => x.id === id);
            await adminApi('/api/admin/set-major', { method: 'POST', body: { userId: id, major: !u.major } });
          }
          if (act === 'balance') await adminApi('/api/admin/add-balance', { method: 'POST', body: { userId: id, amount: 100 } });
          toast('Готово');
          loadAdmin();
        } catch (e) { toast(e.message); }
      });
    });
  } catch (e) { toast(e.message); }
}

$('#admin-issue-number').addEventListener('click', async () => {
  try {
    const data = await adminApi('/api/admin/issue-number', { method: 'POST', body: {} });
    $('#admin-issued').innerHTML = `Номер: <b>${data.phone}</b><br>Код: <b>${data.code}</b>`;
  } catch (e) { toast(e.message); }
});
$('#admin-send-code').addEventListener('click', async () => {
  try {
    const data = await adminApi('/api/admin/send-code', { method: 'POST', body: { phone: $('#admin-code-phone').value } });
    $('#admin-sent').innerHTML = `Код для ${data.phone}: <b>${data.code}</b>`;
  } catch (e) { toast(e.message); }
});

// Auto-login admin if token exists
if (adminToken) {
  $('#admin-login-card')?.classList.add('hidden');
  $('#admin-panel')?.classList.remove('hidden');
  // load later when screen opened
}

// Helpers
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function timeAgo(ts) {
  const now = Math.floor(Date.now()/1000);
  const d = now - ts;
  if (d < 60) return 'только что';
  if (d < 3600) return Math.floor(d/60) + ' мин';
  if (d < 86400) return Math.floor(d/3600) + ' ч';
  return new Date(ts*1000).toLocaleDateString('ru');
}

// Particles
function spawnParticles(containerId, count) {
  const c = document.getElementById(containerId);
  if (!c) return;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDelay = Math.random() * 15 + 's';
    p.style.animationDuration = (10 + Math.random() * 10) + 's';
    c.appendChild(p);
  }
}
spawnParticles('welcome-particles', 30);

// Init
// Load saved theme
const savedTheme = localStorage.getItem('vopgram_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
const tv = $('#theme-value');
if (tv) tv.textContent = savedTheme === 'dark' ? 'Тёмная' : 'Светлая';
const hpv = $('#hide-phone-value');
if (hpv) hpv.textContent = localStorage.getItem('vopgram_hide_phone') === '1' ? 'Вкл' : 'Выкл';

(async function init() {
  if (token) {
    try {
      const data = await api('/api/me');
      me = data.user;
      initSocket();
      go('chats');
      loadChats();
      return;
    } catch (e) {
      token = null; localStorage.removeItem('vopgram_token');
    }
  }
  go('chats');
  loadChats();
})();
