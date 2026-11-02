const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'vopgram.json');

let data = {
  users: [],
  sessions: [],
  chats: [],
  chat_members: [],
  messages: [],
  gifts: [],
  user_gifts: [],
  verification_codes: [],
  anonymous_numbers: [],
  device_confirmations: [],
  _counters: { users: 0, sessions: 0, chats: 0, messages: 0, gifts: 0, user_gifts: 0, verification_codes: 0, anonymous_numbers: 0, device_confirmations: 0 }
};

// Load existing data
try {
  if (fs.existsSync(DB_PATH)) {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    data = JSON.parse(raw);
  }
} catch (e) {
  console.error('DB load error:', e.message);
}

function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('DB save error:', e.message);
  }
}

function nextId(table) {
  data._counters[table] = (data._counters[table] || 0) + 1;
  return data._counters[table];
}

// Helper: create a db-like interface
const db = {
  prepare(sql) {
    return {
      get(...params) { return executeGet(sql, params); },
      all(...params) { return executeAll(sql, params); },
      run(...params) { return executeRun(sql, params); },
    };
  },
  exec(sql) { /* no-op for schema */ },
  pragma() { /* no-op */ },
};

function parseWhere(sql, params) {
  // Simple WHERE clause parser for common patterns
  return { sql, params };
}

function executeGet(sql, params) {
  sql = sql.trim();
  // Handle SELECT COUNT(*) as c FROM table
  const countMatch = sql.match(/SELECT COUNT\(\*\) as c FROM (\w+)/i);
  if (countMatch) {
    const table = countMatch[1];
    let rows = data[table] || [];
    // Handle WHERE
    if (sql.includes('WHERE')) {
      rows = filterRows(table, sql, params);
    }
    return { c: rows.length };
  }

  // Handle SELECT * FROM table WHERE col = ?
  const selectMatch = sql.match(/SELECT \* FROM (\w+) WHERE (\w+) = \?/i);
  if (selectMatch) {
    const table = selectMatch[1];
    const col = selectMatch[2];
    const val = params[0];
    const rows = (data[table] || []).filter(r => r[col] == val);
    return rows.length > 0 ? rows[rows.length - 1] : undefined;
  }

  // Handle SELECT col FROM table WHERE col = ?
  const selectColMatch = sql.match(/SELECT (\w+) FROM (\w+) WHERE (\w+) = \?/i);
  if (selectColMatch) {
    const col = selectColMatch[1];
    const table = selectColMatch[2];
    const whereCol = selectColMatch[3];
    const val = params[0];
    const rows = (data[table] || []).filter(r => r[whereCol] == val);
    if (rows.length > 0) {
      const r = rows[rows.length - 1];
      return { [col]: r[col] };
    }
    return undefined;
  }

  // Handle specific queries
  // SELECT * FROM users WHERE phone = ?
  if (sql.includes('FROM users WHERE phone')) {
    const u = (data.users || []).find(u => u.phone === params[0]);
    return u;
  }
  // SELECT * FROM users WHERE id = ?
  if (sql.includes('FROM users WHERE id')) {
    const u = (data.users || []).find(u => u.id === params[0]);
    return u;
  }
  // SELECT * FROM users WHERE username = ?
  if (sql.includes('FROM users WHERE username')) {
    const u = (data.users || []).find(u => u.username === params[0]);
    return u;
  }
  // SELECT * FROM chats WHERE id = ? AND channel = 1
  if (sql.includes('FROM chats WHERE id') && sql.includes('channel = 1')) {
    const c = (data.chats || []).find(c => c.id === params[0] && c.channel === 1);
    return c;
  }
  // SELECT * FROM chats WHERE id = ?
  if (sql.includes('FROM chats WHERE id')) {
    const c = (data.chats || []).find(c => c.id === params[0]);
    return c;
  }
  // SELECT * FROM gifts WHERE id = ?
  if (sql.includes('FROM gifts WHERE id')) {
    const g = (data.gifts || []).find(g => g.id === params[0]);
    return g;
  }
  // SELECT * FROM anonymous_numbers WHERE telegram_user_id = ?
  if (sql.includes('FROM anonymous_numbers WHERE telegram_user_id')) {
    const n = (data.anonymous_numbers || []).find(n => n.telegram_user_id === params[0]);
    return n;
  }
  // SELECT * FROM verification_codes WHERE phone = ? AND code = ? AND used = 0
  if (sql.includes('FROM verification_codes WHERE phone') && sql.includes('code')) {
    const codes = (data.verification_codes || []).filter(c => c.phone === params[0] && c.code === params[1] && c.used === 0);
    return codes.length > 0 ? codes[codes.length - 1] : undefined;
  }
  // SELECT * FROM device_confirmations WHERE id = ?
  if (sql.includes('FROM device_confirmations WHERE id')) {
    const c = (data.device_confirmations || []).find(c => c.id === params[0]);
    return c;
  }
  // SELECT * FROM sessions WHERE token = ?
  if (sql.includes('FROM sessions WHERE token')) {
    const s = (data.sessions || []).find(s => s.token === params[0]);
    return s;
  }
  // SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?
  if (sql.includes('FROM chat_members WHERE chat_id') && sql.includes('user_id')) {
    const m = (data.chat_members || []).find(m => m.chat_id === params[0] && m.user_id === params[1]);
    return m ? 1 : undefined;
  }
  // SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?
  if (sql.includes('role FROM chat_members')) {
    const m = (data.chat_members || []).find(m => m.chat_id === params[0] && m.user_id === params[1]);
    return m;
  }
  // SELECT id FROM users WHERE username = ?
  if (sql.includes('id FROM users WHERE username')) {
    const u = (data.users || []).find(u => u.username === params[0]);
    return u ? { id: u.id } : undefined;
  }
  // SELECT id FROM users WHERE phone = ?
  if (sql.includes('id FROM users WHERE phone')) {
    const u = (data.users || []).find(u => u.phone === params[0]);
    return u ? { id: u.id } : undefined;
  }
  // SELECT chat_id FROM chat_members WHERE user_id = ?
  if (sql.includes('chat_id FROM chat_members WHERE user_id')) {
    const memberships = (data.chat_members || []).filter(m => m.user_id === params[0]);
    return memberships.length > 0 ? memberships[0] : undefined;
  }
  // SELECT balance FROM users WHERE id = ?
  if (sql.includes('balance FROM users WHERE id')) {
    const u = (data.users || []).find(u => u.id === params[0]);
    return u ? { balance: u.balance } : undefined;
  }
  // SELECT COUNT(*) as c FROM sessions WHERE user_id = ?
  if (sql.includes('FROM sessions WHERE user_id')) {
    const sessions = (data.sessions || []).filter(s => s.user_id === params[0]);
    return { c: sessions.length };
  }

  // Complex queries with JOINs - handle specific ones
  // Chats list query
  if (sql.includes('FROM chats c') && sql.includes('JOIN chat_members cm')) {
    const memberships = (data.chat_members || []).filter(m => m.user_id === params[0]);
    const chatIds = memberships.map(m => m.chat_id);
    const chats = (data.chats || []).filter(c => chatIds.includes(c.id));
    // Sort by last message
    const result = chats.map(c => {
      const msgs = (data.messages || []).filter(m => m.chat_id === c.id).sort((a, b) => b.id - a.id);
      const lastMsg = msgs[0];
      return {
        id: c.id, type: c.type, title: c.title, channel: c.channel || 0, subscribers: c.subscribers || 0, created_at: c.created_at,
        last_text: lastMsg ? lastMsg.text : null,
        last_at: lastMsg ? lastMsg.created_at : null,
        last_sender: lastMsg ? lastMsg.sender_id : null,
      };
    });
    result.sort((a, b) => (b.last_at || b.created_at) - (a.last_at || a.created_at));
    return result[0] || undefined; // This is for .get() - but we need .all()
  }

  return undefined;
}

function executeAll(sql, params) {
  sql = sql.trim();
  // Handle SELECT COUNT(*) 
  if (sql.includes('COUNT(*)')) {
    // Return array with one count object
    let rows = [];
    if (sql.includes('FROM users')) rows = data.users || [];
    else if (sql.includes('FROM chats')) rows = data.chats || [];
    else if (sql.includes('FROM messages')) rows = data.messages || [];
    else if (sql.includes('FROM anonymous_numbers')) rows = data.anonymous_numbers || [];
    else if (sql.includes('FROM verification_codes')) rows = data.verification_codes || [];
    else if (sql.includes('FROM chat_members')) rows = data.chat_members || [];
    let filtered = rows;
    if (sql.includes('WHERE')) {
      filtered = filterRowsGeneric(rows, sql, params);
    }
    return [{ c: filtered.length }];
  }

  // Handle chats list
  if (sql.includes('FROM chats c') && sql.includes('JOIN chat_members cm')) {
    const memberships = (data.chat_members || []).filter(m => m.user_id === params[0]);
    const chatIds = memberships.map(m => m.chat_id);
    const chats = (data.chats || []).filter(c => chatIds.includes(c.id));
    const result = chats.map(c => {
      const msgs = (data.messages || []).filter(m => m.chat_id === c.id).sort((a, b) => b.id - a.id);
      const lastMsg = msgs[0];
      return {
        id: c.id, type: c.type, title: c.title, channel: c.channel || 0, subscribers: c.subscribers || 0, created_at: c.created_at,
        last_text: lastMsg ? lastMsg.text : null,
        last_at: lastMsg ? lastMsg.created_at : null,
        last_sender: lastMsg ? lastMsg.sender_id : null,
      };
    });
    result.sort((a, b) => (b.last_at || b.created_at) - (a.last_at || a.created_at));
    return result;
  }

  // Handle messages list
  if (sql.includes('FROM messages m JOIN users u')) {
    const chatId = params[0];
    const msgs = (data.messages || []).filter(m => m.chat_id == chatId).sort((a, b) => a.id - b.id);
    return msgs.map(m => {
      const u = (data.users || []).find(u => u.id === m.sender_id) || {};
      return { ...m, sender_name: u.name, sender_avatar: u.avatar_url, sender_username: u.username };
    });
  }

  // Handle users search
  if (sql.includes('FROM users WHERE id != ?') || sql.includes('FROM users WHERE id !=?')) {
    const q = params.length > 1 ? params[1] : '';
    const currentId = params[0];
    let users = (data.users || []).filter(u => u.id !== currentId);
    if (q && !q.includes('%')) {
      // no filter param, return all
    }
    // Handle LIKE
    if (params.length > 1 && typeof params[1] === 'string') {
      const search = params[1].replace(/%/g, '');
      if (search) {
        users = users.filter(u => 
          (u.username && u.username.includes(search)) ||
          (u.name && u.name.includes(search)) ||
          (u.phone && u.phone.includes(search))
        );
      }
    }
    users = users.slice(0, 20);
    return users.map(u => ({ id: u.id, phone: u.phone, username: u.username, name: u.name, avatar_url: u.avatar_url, verified: u.verified, major: u.major }));
  }

  // Handle users list (admin)
  if (sql.includes('FROM users ORDER BY id DESC') || sql.includes('FROM users ORDER BY id DESC')) {
    const users = [...(data.users || [])].sort((a, b) => b.id - a.id).slice(0, 20);
    return users.map(u => ({ id: u.id, phone: u.phone, username: u.username, name: u.name, balance: u.balance, verified: u.verified, major: u.major, created_at: u.created_at }));
  }

  // Handle gifts list
  if (sql.includes('FROM gifts')) {
    return [...(data.gifts || [])];
  }

  // Handle user_gifts
  if (sql.includes('FROM user_gifts ug JOIN gifts g')) {
    const userId = params[0];
    const ugs = (data.user_gifts || []).filter(ug => ug.user_id === userId);
    return ugs.map(ug => {
      const g = (data.gifts || []).find(g => g.id === ug.gift_id) || {};
      return { ...g, purchased_at: ug.purchased_at };
    }).reverse();
  }

  // Handle anonymous_numbers
  if (sql.includes('FROM anonymous_numbers')) {
    const rows = [...(data.anonymous_numbers || [])].sort((a, b) => b.id - a.id).slice(0, 100);
    return rows;
  }

  // Handle verification_codes
  if (sql.includes('FROM verification_codes')) {
    const rows = [...(data.verification_codes || [])].sort((a, b) => b.id - a.id).slice(0, 100);
    return rows;
  }

  // Handle channels list
  if (sql.includes('FROM chats WHERE channel = 1')) {
    return (data.chats || []).filter(c => c.channel === 1).sort((a, b) => (b.subscribers || 0) - (a.subscribers || 0));
  }

  // Handle chat_members for a chat
  if (sql.includes('FROM chat_members WHERE chat_id')) {
    return (data.chat_members || []).filter(m => m.chat_id === params[0]);
  }

  // Handle chat_members for a user
  if (sql.includes('FROM chat_members WHERE user_id')) {
    return (data.chat_members || []).filter(m => m.user_id === params[0]);
  }

  return [];
}

function executeRun(sql, params) {
  sql = sql.trim();
  const now = Math.floor(Date.now() / 1000);

  // INSERT INTO users
  if (sql.match(/INSERT INTO users/i)) {
    const phone = params[0];
    const username = params[1];
    const name = params[2];
    const bio = params[3] || '';
    const balance = params[4] || 100;
    // Check if phone already exists
    const existing = (data.users || []).find(u => u.phone === phone);
    if (existing) return { lastInsertRowid: existing.id, changes: 0 };
    const id = nextId('users');
    const user = { id, phone, username, name, bio, avatar_url: '', password_hash: null, balance, verified: 0, major: 0, created_at: now, last_seen: now };
    data.users.push(user);
    save();
    return { lastInsertRowid: id, changes: 1 };
  }

  // INSERT INTO sessions
  if (sql.match(/INSERT INTO sessions/i)) {
    const id = nextId('sessions');
    const session = { id, user_id: params[0], token: params[1], device_info: params[2] || '', ip: params[3] || '', confirmed: params[4] || 1, created_at: now };
    data.sessions.push(session);
    save();
    return { lastInsertRowid: id, changes: 1 };
  }

  // INSERT INTO chats
  if (sql.match(/INSERT INTO chats/i)) {
    const id = nextId('chats');
    const type = params[0] || 'private';
    const title = params[1] || '';
    const channel = params[2] || 0;
    const chat = { id, type, title, channel, subscribers: 0, created_at: now };
    data.chats.push(chat);
    save();
    return { lastInsertRowid: id, changes: 1 };
  }

  // INSERT INTO chat_members
  if (sql.match(/INSERT INTO chat_members/i)) {
    const chat_id = params[0];
    const user_id = params[1];
    const role = params[2] || 'member';
    const existing = (data.chat_members || []).find(m => m.chat_id === chat_id && m.user_id === user_id);
    if (existing) return { lastInsertRowid: 0, changes: 0 };
    const member = { chat_id, user_id, role, joined_at: now };
    data.chat_members.push(member);
    save();
    return { lastInsertRowid: data.chat_members.length, changes: 1 };
  }

  // INSERT INTO messages
  if (sql.match(/INSERT INTO messages/i)) {
    const id = nextId('messages');
    // Parse: INSERT INTO messages (chat_id, sender_id, text) or (chat_id, sender_id, text, type, gift_id)
    let chat_id, sender_id, text, type = 'text', gift_id = null;
    if (sql.includes('gift_id')) {
      chat_id = params[0]; sender_id = params[1]; text = params[2]; type = params[3] || 'gift'; gift_id = params[4];
    } else {
      chat_id = params[0]; sender_id = params[1]; text = params[2];
      if (params[3]) type = params[3];
    }
    const msg = { id, chat_id, sender_id, text, type, gift_id, created_at: now };
    data.messages.push(msg);
    save();
    return { lastInsertRowid: id, changes: 1 };
  }

  // INSERT INTO gifts
  if (sql.match(/INSERT INTO gifts/i)) {
    const id = nextId('gifts');
    const gift = { id, name: params[0], icon: params[1], price: params[2], market: params[3] || 0 };
    data.gifts.push(gift);
    save();
    return { lastInsertRowid: id, changes: 1 };
  }

  // INSERT INTO user_gifts
  if (sql.match(/INSERT INTO user_gifts/i)) {
    const id = nextId('user_gifts');
    const ug = { id, user_id: params[0], gift_id: params[1], purchased_at: now };
    data.user_gifts.push(ug);
    save();
    return { lastInsertRowid: id, changes: 1 };
  }

  // INSERT INTO verification_codes
  if (sql.match(/INSERT INTO verification_codes/i)) {
    const id = nextId('verification_codes');
    const vc = { id, phone: params[0], code: params[1], expires_at: params[2], used: 0 };
    data.verification_codes.push(vc);
    save();
    return { lastInsertRowid: id, changes: 1 };
  }

  // INSERT INTO anonymous_numbers
  if (sql.match(/INSERT INTO anonymous_numbers/i)) {
    const id = nextId('anonymous_numbers');
    const an = { id, phone: params[0], telegram_user_id: params[1], issued_at: now, used: 0 };
    data.anonymous_numbers.push(an);
    save();
    return { lastInsertRowid: id, changes: 1 };
  }

  // INSERT INTO device_confirmations
  if (sql.match(/INSERT INTO device_confirmations/i)) {
    const id = nextId('device_confirmations');
    const dc = { id, user_id: params[0], session_id: params[1] || null, device_info: params[2] || '', ip: params[3] || '', status: params[4] || 'pending', created_at: now };
    data.device_confirmations.push(dc);
    save();
    return { lastInsertRowid: id, changes: 1 };
  }

  // UPDATE users
  if (sql.match(/UPDATE users SET/i)) {
    // Handle various UPDATE patterns
    if (sql.includes('balance = balance -')) {
      const amount = params[0];
      const userId = params[1];
      const u = (data.users || []).find(u => u.id === userId);
      if (u) { u.balance -= amount; save(); }
      return { lastInsertRowid: 0, changes: u ? 1 : 0 };
    }
    if (sql.includes('balance = balance +')) {
      const amount = params[0];
      const userId = params[1];
      const u = (data.users || []).find(u => u.id === userId);
      if (u) { u.balance += amount; save(); }
      return { lastInsertRowid: 0, changes: u ? 1 : 0 };
    }
    if (sql.includes('balance = 0')) {
      const userId = params[0];
      const u = (data.users || []).find(u => u.id === userId);
      if (u) { u.balance = 0; save(); }
      return { lastInsertRowid: 0, changes: u ? 1 : 0 };
    }
    if (sql.includes('verified = 1')) {
      const userId = params[0];
      const u = (data.users || []).find(u => u.id === userId);
      if (u) { u.verified = 1; save(); }
      return { lastInsertRowid: 0, changes: u ? 1 : 0 };
    }
    if (sql.includes('verified = 0')) {
      const userId = params[0];
      const u = (data.users || []).find(u => u.id === userId);
      if (u) { u.verified = 0; save(); }
      return { lastInsertRowid: 0, changes: u ? 1 : 0 };
    }
    if (sql.includes('major = ?')) {
      const major = params[0];
      const userId = params[1];
      const u = (data.users || []).find(u => u.id === userId);
      if (u) { u.major = major ? 1 : 0; save(); }
      return { lastInsertRowid: 0, changes: u ? 1 : 0 };
    }
    if (sql.includes('last_seen')) {
      const now = params[0];
      const userId = params[1];
      const u = (data.users || []).find(u => u.id === userId);
      if (u) { u.last_seen = now; save(); }
      return { lastInsertRowid: 0, changes: u ? 1 : 0 };
    }
    if (sql.includes('name = COALESCE')) {
      // UPDATE users SET name = COALESCE(?, name), username = COALESCE(?, username), bio = COALESCE(?, bio), avatar_url = ? WHERE id = ?
      const name = params[0];
      const username = params[1];
      const bio = params[2];
      const avatar_url = params[3];
      const userId = params[4];
      const u = (data.users || []).find(u => u.id === userId);
      if (u) {
        if (name) u.name = name;
        if (username) u.username = username;
        if (bio !== null) u.bio = bio;
        u.avatar_url = avatar_url;
        save();
      }
      return { lastInsertRowid: 0, changes: u ? 1 : 0 };
    }
    return { lastInsertRowid: 0, changes: 0 };
  }

  // UPDATE chats SET subscribers
  if (sql.match(/UPDATE chats SET subscribers/i)) {
    if (sql.includes('subscribers + 1')) {
      const chatId = params[0];
      const c = (data.chats || []).find(c => c.id === chatId);
      if (c) { c.subscribers = (c.subscribers || 0) + 1; save(); }
      return { lastInsertRowid: 0, changes: c ? 1 : 0 };
    }
    if (sql.includes('subscribers - 1')) {
      const chatId = params[0];
      const c = (data.chats || []).find(c => c.id === chatId);
      if (c) { c.subscribers = Math.max(0, (c.subscribers || 0) - 1); save(); }
      return { lastInsertRowid: 0, changes: c ? 1 : 0 };
    }
    return { lastInsertRowid: 0, changes: 0 };
  }

  // UPDATE verification_codes SET used = 1
  if (sql.match(/UPDATE verification_codes SET used/i)) {
    const id = params[0];
    const vc = (data.verification_codes || []).find(v => v.id === id);
    if (vc) { vc.used = 1; save(); }
    return { lastInsertRowid: 0, changes: vc ? 1 : 0 };
  }

  // UPDATE device_confirmations SET status
  if (sql.match(/UPDATE device_confirmations SET status/i)) {
    const status = params[0];
    const id = params[1];
    const dc = (data.device_confirmations || []).find(d => d.id === id);
    if (dc) { dc.status = status; save(); }
    return { lastInsertRowid: 0, changes: dc ? 1 : 0 };
  }

  // DELETE
  if (sql.match(/DELETE FROM/i)) {
    if (sql.includes('FROM sessions WHERE token')) {
      const token = params[0];
      const before = data.sessions.length;
      data.sessions = (data.sessions || []).filter(s => s.token !== token);
      save();
      return { lastInsertRowid: 0, changes: before - data.sessions.length };
    }
    if (sql.includes('FROM users WHERE id')) {
      const userId = params[0];
      data.users = (data.users || []).filter(u => u.id !== userId);
      data.chat_members = (data.chat_members || []).filter(m => m.user_id !== userId);
      save();
      return { lastInsertRowid: 0, changes: 1 };
    }
    if (sql.includes('FROM gifts WHERE id')) {
      const id = params[0];
      data.gifts = (data.gifts || []).filter(g => g.id !== id);
      save();
      return { lastInsertRowid: 0, changes: 1 };
    }
    if (sql.includes('FROM chat_members WHERE chat_id') && sql.includes('user_id')) {
      const chatId = params[0];
      const userId = params[1];
      const before = data.chat_members.length;
      data.chat_members = (data.chat_members || []).filter(m => !(m.chat_id === chatId && m.user_id === userId));
      save();
      return { lastInsertRowid: 0, changes: before - data.chat_members.length };
    }
    if (sql.includes('FROM verification_codes WHERE code')) {
      const code = params[0];
      data.verification_codes = (data.verification_codes || []).filter(v => v.code !== code);
      save();
      return { lastInsertRowid: 0, changes: 1 };
    }
    if (sql.includes('DELETE FROM user_gifts')) {
      data.user_gifts = [];
      save();
      return { lastInsertRowid: 0, changes: 1 };
    }
    if (sql.includes('DELETE FROM gifts')) {
      data.gifts = [];
      save();
      return { lastInsertRowid: 0, changes: 1 };
    }
    return { lastInsertRowid: 0, changes: 0 };
  }

  return { lastInsertRowid: 0, changes: 0 };
}

// Seed data if empty
if ((data.users || []).length === 0) {
  const now = Math.floor(Date.now() / 1000);
  const insert = (phone, username, name, bio, balance) => {
    const id = nextId('users');
    data.users.push({ id, phone, username, name, bio: bio || '', avatar_url: '', password_hash: null, balance: balance || 100, verified: username === 'vopgram' ? 1 : 0, major: username === 'vopgram' ? 1 : 0, created_at: now, last_seen: now });
    return id;
  };
  const svcId = insert('+42777 00 00 00', 'vopgram', 'Vopgram', 'Служебные уведомления', 0);
  insert('+888 100 00 01', 'cat_cap', 'Кот в кепке', 'Главный кот Vopgram', 500);
  insert('+888 100 00 02', 'anime_girl', 'Аниме Девушка', 'Kawaii~', 300);
  insert('+888 100 00 03', 'meme_lord', 'Мем Лорд', 'Мемы — это жизнь', 150);

  // Create a group chat
  const chatId = nextId('chats');
  data.chats.push({ id: chatId, type: 'group', title: 'Vopgram News', channel: 0, subscribers: 0, created_at: now });
  data.chat_members.push({ chat_id: chatId, user_id: 1, role: 'member', joined_at: now });
  data.chat_members.push({ chat_id: chatId, user_id: 2, role: 'member', joined_at: now });
  data.chat_members.push({ chat_id: chatId, user_id: 3, role: 'member', joined_at: now });
  data.chat_members.push({ chat_id: chatId, user_id: svcId, role: 'member', joined_at: now });
  const m1 = nextId('messages');
  data.messages.push({ id: m1, chat_id: chatId, sender_id: 1, text: 'Добро пожаловать в Vopgram! 🎉', type: 'text', gift_id: null, created_at: now });
  const m2 = nextId('messages');
  data.messages.push({ id: m2, chat_id: chatId, sender_id: 2, text: 'Привет всем! 👋', type: 'text', gift_id: null, created_at: now });

  // Seed gifts
  const gifts = [
    ['Роза', '🌹', 15, 0], ['Торт', '🎂', 50, 0], ['Конфета', '🍬', 25, 0],
    ['Сердце', '❤️', 35, 0], ['Звезда', '⭐', 40, 0], ['Ракета', '🚀', 100, 1],
    ['Алмаз', '💎', 150, 1], ['Трофей', '🏆', 200, 0], ['Кольцо', '💍', 430, 1],
    ['Корона', '👑', 500, 1], ['Единорог', '🦄', 350, 1], ['Дракон', '🐉', 700, 1],
    ['Пламя', '🔥', 60, 0], ['Подарок', '🎁', 80, 0], ['Шампанское', '🍾', 120, 1],
  ];
  for (const g of gifts) {
    const gid = nextId('gifts');
    data.gifts.push({ id: gid, name: g[0], icon: g[1], price: g[2], market: g[3] });
  }

  save();
  console.log('Database seeded with initial data');
}

// Remove demo codes
data.verification_codes = (data.verification_codes || []).filter(v => v.code !== '123456');
save();

module.exports = db;
