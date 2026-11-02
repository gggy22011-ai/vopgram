require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'vopgram-dev-secret-change-me';
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '7533';
const ADMIN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'vopgram-admin-secret';

// ---------- Verification codes ----------
// Codes are derived from the phone + a 30-minute time window, so they keep
// working even after a server restart (important on free hosting).
const crypto = require('crypto');
const CODE_SECRET = process.env.CODE_SECRET || ('vopgram|' + BOT_TOKEN);
const CODE_WINDOW_MS = 30 * 60 * 1000;
const CODE_TTL_MS = CODE_WINDOW_MS * 2; // current + previous window

function normPhone(phone) { return String(phone || '').replace(/[^\d+]/g, ''); }

function derivedCode(phone, windowOffset = 0) {
  const win = Math.floor(Date.now() / CODE_WINDOW_MS) + windowOffset;
  const h = crypto.createHmac('sha256', CODE_SECRET).update(normPhone(phone) + ':' + win).digest();
  return String(h.readUInt32BE(0) % 10000000).padStart(7, '0');
}

function codeMatches(phone, code, windowOffset = 0) {
  const expected = derivedCode(phone, windowOffset);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(code || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isValidCode(phone, code) {
  return codeMatches(phone, code, 0) || codeMatches(phone, code, -1);
}

const app = express();
const server = http.createServer(app);
server.headersTimeout = 20000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
server.maxConnections = 1000;
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 64 * 1024,
  pingTimeout: 20000,
  pingInterval: 25000,
});

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(cors({ origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

/* ---------- security headers ---------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' https: wss:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "connect-src 'self' https: wss:",
    "font-src 'self' data: https:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
  ].join('; '));
  next();
});

/* ---------- anti-flood / rate limiting ---------- */
const clientIp = req => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
function hashIp(ip) {
  return crypto.createHash('sha256')
    .update(String(ip || '') + '|' + (process.env.IP_SECRET || ADMIN_SECRET))
    .digest('hex').slice(0, 16);
}

const limitBuckets = new Map();
const globalBans = new Map();  // ip -> until (flood)
const scopedBans = new Map();  // name|ip -> until (brute-force)

function cleanLimits() {
  const now = Date.now();
  for (const [k, v] of limitBuckets) if (v.reset <= now) limitBuckets.delete(k);
  for (const [k, v] of globalBans) if (v <= now) globalBans.delete(k);
  for (const [k, v] of scopedBans) if (v <= now) scopedBans.delete(k);
}
setInterval(cleanLimits, 60000).unref();

function banLeft(ip, name) {
  const now = Date.now();
  const g = globalBans.get(ip);
  if (g && g > now) return g - now;
  const s = scopedBans.get(name + '|' + ip);
  if (s && s > now) return s - now;
  return 0;
}

function rateLimit({ name = 'global', windowMs = 60000, max = 120, banMs = 0, globalBan = false, skip = null } = {}) {
  return (req, res, next) => {
    if (skip && skip(req)) return next();
    const ip = clientIp(req);
    const now = Date.now();
    const left = banLeft(ip, name);
    if (left > 0) {
      res.setHeader('Retry-After', String(Math.ceil(left / 1000)));
      return res.status(429).json({ error: 'too many requests, try later' });
    }
    const key = name + '|' + ip;
    let b = limitBuckets.get(key);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + windowMs };
      limitBuckets.set(key, b);
    }
    b.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
    if (b.count > max) {
      if (banMs) {
        if (globalBan) globalBans.set(ip, now + banMs);
        else scopedBans.set(key, now + banMs);
      }
      res.setHeader('Retry-After', String(Math.ceil((banMs || windowMs) / 1000)));
      return res.status(429).json({ error: 'too many requests, try later' });
    }
    next();
  };
}

/* ---------- concurrent request cap (DDoS backstop) ---------- */
let inflight = 0;
const MAX_INFLIGHT = 400;
app.use((req, res, next) => {
  if (inflight >= MAX_INFLIGHT) {
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ error: 'server busy, try again' });
  }
  inflight++;
  let done = false;
  const release = () => { if (!done) { done = true; inflight--; } };
  res.on('finish', release);
  res.on('close', release);
  next();
});

/* ---------- block scanner / probe paths ---------- */
const BAD_PATH = /(?:^\/\.(?:env|git|svn|aws|ssh)|\.(?:php|asp|aspx|jsp|cgi)$|\/(?:wp-admin|wp-login|wp-content|phpmyadmin|xmlrpc|vendor\/phpunit|actuator|cgi-bin)(?:\/|$))/i;
app.use((req, res, next) => {
  if (BAD_PATH.test(req.path)) return res.status(404).end();
  next();
});

// whole-app flood protection (health checks are exempt)
app.use(rateLimit({ name: 'all', windowMs: 60000, max: 900, banMs: 2 * 60000, globalBan: true, skip: req => req.path === '/health' }));
// strict limits for login / code endpoints (anti brute-force, scoped to these paths)
const strictPaths = ['/api/auth/verify', '/api/auth/confirm-device', '/api/auth/reject-device', '/check', '/request', '/api/admin/login', '/api/admin/issue-number', '/api/admin/send-code'];
app.use(strictPaths, rateLimit({ name: 'strict', windowMs: 60000, max: 20, banMs: 3 * 60000 }));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype || '')) {
      return cb(new Error('only images allowed'));
    }
    cb(null, true);
  },
});
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
    if (!user) return res.status(401).json({ error: 'user not found' });
    req.user = user;
    req.token = token;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function sanitizeUser(u) {
  return {
    id: u.id, phone: u.phone, username: u.username, name: u.name,
    bio: u.bio, avatar_url: u.avatar_url, balance: u.balance,
    verified: !!u.verified, major: !!u.major, created_at: u.created_at,
  };
}

// ---------- Auth ----------
app.post('/api/auth/verify', (req, res) => {
  const { phone, code, deviceInfo } = req.body || {};
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
  const normalizedPhone = normPhone(phone);
  const now = Math.floor(Date.now() / 1000);
  // Accept the stateless derived code ...
  let valid = isValidCode(normalizedPhone, code);
  // ... or a one-time code previously stored in the database
  if (!valid) {
    const allCodes = db.prepare('SELECT * FROM verification_codes').all();
    const vc = allCodes.filter(c => normPhone(c.phone) === normalizedPhone && c.code === String(code) && c.used === 0 && c.expires_at >= now).sort((a, b) => b.id - a.id)[0];
    if (vc) {
      db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(vc.id);
      valid = true;
    }
  }
  if (!valid) return res.status(400).json({ error: 'invalid code' });

  // find or create user (normalize phone)
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(normalizedPhone);
  // also check with spaces
  if (!user) {
    const allUsers = db.prepare('SELECT * FROM users').all();
    user = allUsers.find(u => u.phone.replace(/\s+/g, '') === normalizedPhone);
  }
  let isNew = false;
  if (!user) {
    const r = db.prepare('INSERT INTO users (phone, username, name, balance) VALUES (?,?,?,?)').run(normalizedPhone, null, 'Пользователь', 100);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    isNew = true;
  }
  const existing = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(user.id).c;
  const ip = hashIp(req.ip || '');
  const dev = deviceInfo || req.headers['user-agent'] || '';

  if (existing > 0) {
    const r = db.prepare('INSERT INTO device_confirmations (user_id, device_info, ip, status) VALUES (?,?,?,?)').run(user.id, dev, ip, 'pending');
    return res.json({ requiresConfirmation: true, confirmationId: r.lastInsertRowid, userId: user.id });
  }

  const token = signToken(user.id);
  db.prepare('INSERT INTO sessions (user_id, token, device_info, ip, confirmed) VALUES (?,?,?,?,1)').run(user.id, token, dev, ip);
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, user.id);
  return res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/auth/confirm-device', (req, res) => {
  const { confirmationId } = req.body || {};
  const conf = db.prepare('SELECT * FROM device_confirmations WHERE id = ?').get(confirmationId);
  if (!conf) return res.status(404).json({ error: 'not found' });
  if (conf.status !== 'pending') return res.status(400).json({ error: 'already handled' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(conf.user_id);
  const token = signToken(user.id);
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO sessions (user_id, token, device_info, ip, confirmed) VALUES (?,?,?,?,1)').run(user.id, token, conf.device_info, conf.ip);
  db.prepare('UPDATE device_confirmations SET status = ? WHERE id = ?').run('confirmed', conf.id);
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, user.id);
  return res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/auth/reject-device', (req, res) => {
  const { confirmationId } = req.body || {};
  db.prepare('UPDATE device_confirmations SET status = ? WHERE id = ?').run('rejected', confirmationId);
  return res.json({ ok: true });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  return res.json({ ok: true });
});

// ---------- Me ----------
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.put('/api/me', authMiddleware, upload.single('avatar'), (req, res) => {
  const { name, username, bio } = req.body || {};
  let avatar_url = req.user.avatar_url;
  if (req.file) avatar_url = '/uploads/' + req.file.filename;
  if (username && username !== req.user.username) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (exists) return res.status(400).json({ error: 'username taken' });
  }
  db.prepare('UPDATE users SET name = COALESCE(?, name), username = COALESCE(?, username), bio = COALESCE(?, bio), avatar_url = ? WHERE id = ?')
    .run(name || null, username || null, bio != null ? bio : null, avatar_url, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: sanitizeUser(user) });
});

// ---------- Users ----------
app.get('/api/users/search', authMiddleware, (req, res) => {
  const q = (req.query.q || '').trim();
  const rows = q
    ? db.prepare('SELECT id, phone, username, name, avatar_url, verified, major FROM users WHERE id != ? AND (username LIKE ? OR name LIKE ? OR phone LIKE ?) LIMIT 20').all(req.user.id, `%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT id, phone, username, name, avatar_url, verified, major FROM users WHERE id != ? LIMIT 20').all(req.user.id);
  res.json({ users: rows });
});

// ---------- Chats ----------
app.get('/api/chats', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.type, c.title, c.channel, c.subscribers, c.created_at,
      (SELECT text FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_text,
      (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_at
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY COALESCE(last_at, c.created_at) DESC
  `).all(req.user.id);

  const out = rows.map(r => {
    let title = r.title;
    let avatar = '';
    if (r.type === 'private' && !r.channel) {
      const other = db.prepare(`
        SELECT u.id, u.name, u.username, u.avatar_url FROM users u
        JOIN chat_members cm ON cm.user_id = u.id
        WHERE cm.chat_id = ? AND u.id != ? LIMIT 1
      `).get(r.id, req.user.id);
      if (other) { title = other.name; avatar = other.avatar_url; }
    }
    return { ...r, title, avatar };
  });
  res.json({ chats: out });
});

app.post('/api/chats', authMiddleware, (req, res) => {
  const { type, title, memberIds } = req.body || {};
  const t = type || 'group';
  const r = db.prepare('INSERT INTO chats (type, title) VALUES (?,?)').run(t, title || '');
  const chatId = r.lastInsertRowid;
  const ids = Array.isArray(memberIds) ? memberIds : [];
  const set = new Set([req.user.id, ...ids]);
  const ins = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?,?)');
  for (const uid of set) ins.run(chatId, uid);
  res.json({ chat: { id: chatId, type: t, title: title || '' } });
});

app.post('/api/channels', authMiddleware, (req, res) => {
  const { title, description } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const r = db.prepare('INSERT INTO chats (type, title, channel) VALUES (?,?,1)').run('channel', title);
  const chatId = r.lastInsertRowid;
  db.prepare('INSERT INTO chat_members (chat_id, user_id, role) VALUES (?,?,?)').run(chatId, req.user.id, 'owner');
  db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?,?,?)').run(chatId, req.user.id, (description || 'Канал создан'));
  res.json({ chat: { id: chatId, type: 'channel', title, channel: 1 } });
});

app.post('/api/channels/:id/subscribe', authMiddleware, (req, res) => {
  const chatId = req.params.id;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND channel = 1').get(chatId);
  if (!chat) return res.status(404).json({ error: 'channel not found' });
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!member) {
    db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?,?)').run(chatId, req.user.id);
    db.prepare('UPDATE chats SET subscribers = subscribers + 1 WHERE id = ?').run(chatId);
  }
  res.json({ ok: true });
});

app.post('/api/chats/start', authMiddleware, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const existing = db.prepare(`
    SELECT c.id FROM chats c WHERE c.type = 'private' AND c.channel = 0
    AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = ?)
    AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = ?)
  `).get(req.user.id, userId);
  if (existing) return res.json({ chatId: existing.id });
  const r = db.prepare('INSERT INTO chats (type, title) VALUES (?,?)').run('private', '');
  const chatId = r.lastInsertRowid;
  db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?,?)').run(chatId, req.user.id);
  db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?,?)').run(chatId, userId);
  res.json({ chatId });
});

app.get('/api/chats/:id/messages', authMiddleware, (req, res) => {
  const chatId = req.params.id;
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!member) return res.status(403).json({ error: 'not member' });
  const msgs = db.prepare(`
    SELECT m.id, m.chat_id, m.sender_id, m.text, m.type, m.gift_id, m.created_at,
           u.name as sender_name, u.avatar_url as sender_avatar, u.username as sender_username
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? ORDER BY m.id ASC LIMIT 200
  `).all(chatId);
  res.json({ messages: msgs });
});

app.post('/api/chats/:id/messages', authMiddleware, (req, res) => {
  const chatId = req.params.id;
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!member) return res.status(403).json({ error: 'not member' });
  const r = db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?,?,?)').run(chatId, req.user.id, text);
  const msg = db.prepare(`
    SELECT m.id, m.chat_id, m.sender_id, m.text, m.type, m.gift_id, m.created_at,
           u.name as sender_name, u.avatar_url as sender_avatar, u.username as sender_username
    FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?
  `).get(r.lastInsertRowid);
  io.to('chat:' + chatId).emit('message', msg);
  res.json({ message: msg });
});

app.post('/api/chats/:id/gift', authMiddleware, (req, res) => {
  const chatId = req.params.id;
  const { gift_id } = req.body || {};
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(gift_id);
  if (!gift) return res.status(404).json({ error: 'gift not found' });
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!member) return res.status(403).json({ error: 'not member' });
  if (req.user.balance < gift.price) return res.status(400).json({ error: 'insufficient balance' });
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(gift.price, req.user.id);
  db.prepare('INSERT INTO user_gifts (user_id, gift_id) VALUES (?,?)').run(req.user.id, gift.id);
  const r = db.prepare('INSERT INTO messages (chat_id, sender_id, text, type, gift_id) VALUES (?,?,?,?,?)').run(chatId, req.user.id, gift.icon + ' ' + gift.name, 'gift', gift.id);
  const msg = db.prepare(`
    SELECT m.id, m.chat_id, m.sender_id, m.text, m.type, m.gift_id, m.created_at,
           u.name as sender_name, u.avatar_url as sender_avatar, u.username as sender_username
    FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?
  `).get(r.lastInsertRowid);
  io.to('chat:' + chatId).emit('message', msg);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ message: msg, balance: user.balance });
});

// ---------- Gifts ----------
app.get('/api/gifts', (req, res) => {
  const gifts = db.prepare('SELECT * FROM gifts').all();
  res.json({ gifts });
});

app.post('/api/gifts/:id/buy', authMiddleware, (req, res) => {
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  if (!gift) return res.status(404).json({ error: 'gift not found' });
  if (req.user.balance < gift.price) return res.status(400).json({ error: 'insufficient balance' });
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(gift.price, req.user.id);
  db.prepare('INSERT INTO user_gifts (user_id, gift_id) VALUES (?,?)').run(req.user.id, gift.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, balance: user.balance });
});

app.get('/api/users/:id/gifts', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT g.*, ug.purchased_at FROM user_gifts ug JOIN gifts g ON g.id = ug.gift_id
    WHERE ug.user_id = ? ORDER BY ug.id DESC
  `).all(req.params.id);
  res.json({ gifts: rows });
});

// ---------- Admin ----------

function adminMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    const p = jwt.verify(token, ADMIN_SECRET);
    if (!p.admin) throw new Error('not admin');
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid admin token' });
  }
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const given = Buffer.from(String(password || ''));
  const expected = Buffer.from(String(ADMIN_PASSWORD));
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return res.status(401).json({ error: 'wrong password' });
  const t = jwt.sign({ admin: true }, ADMIN_SECRET, { expiresIn: '7d' });
  res.json({ token: t });
});

app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const chats = db.prepare('SELECT COUNT(*) as c FROM chats').get().c;
  const msgs = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const nums = db.prepare('SELECT COUNT(*) as c FROM anonymous_numbers').get().c;
  res.json({ users, chats, messages: msgs, issuedNumbers: nums });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id, phone, username, name, balance, verified, major, created_at FROM users ORDER BY id DESC').all();
  res.json({ users: rows });
});

app.post('/api/admin/issue-number', adminMiddleware, (req, res) => {
  const { prefix } = req.body || {};
  const p = prefix === '+888' ? '+888' : '+39';
  const num = p + ' ' + String(Math.floor(Math.random() * 9000000000 + 1000000000));
  const code = derivedCode(num);
  const expires = Math.floor(Date.now() / 1000) + 600;
  db.prepare('INSERT INTO anonymous_numbers (phone, telegram_user_id) VALUES (?,?)').run(num, 'admin');
  db.prepare('INSERT INTO verification_codes (phone, code, expires_at) VALUES (?,?,?)').run(num, code, expires);
  res.json({ phone: num, code, expires });
});

app.post('/api/admin/send-code', adminMiddleware, (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const code = derivedCode(phone);
  const expires = Math.floor(Date.now() / 1000) + 600;
  db.prepare('INSERT INTO verification_codes (phone, code, expires_at) VALUES (?,?,?)').run(phone, code, expires);
  res.json({ phone, code, expires });
});

app.post('/api/admin/verify-user', adminMiddleware, (req, res) => {
  const { userId } = req.body || {};
  db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(userId);
  res.json({ ok: true });
});

app.post('/api/admin/add-balance', adminMiddleware, (req, res) => {
  const { userId, amount } = req.body || {};
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount || 0, userId);
  const u = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  res.json({ ok: true, balance: u.balance });
});

app.get('/api/admin/codes', adminMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM verification_codes ORDER BY id DESC LIMIT 100').all();
  res.json({ codes: rows });
});

// ---------- Socket.io ----------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('no token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.userId;
    next();
  } catch (e) {
    next(new Error('invalid token'));
  }
});

io.on('connection', (socket) => {
  const chats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(socket.userId);
  for (const c of chats) socket.join('chat:' + c.chat_id);
  socket.on('join', (chatId) => socket.join('chat:' + chatId));
});

// ---------- Telegram Bot ----------
if (BOT_TOKEN && process.env.RENDER) {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });

    const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    function isAdminChat(id) { return ADMIN_CHAT_IDS.includes(String(id)); }

    function issueNumber(chatId) {
      const existing = db.prepare('SELECT phone FROM anonymous_numbers WHERE telegram_user_id = ?').get(String(chatId));
      let num;
      if (existing) {
        num = existing.phone;
      } else {
        num = '+39' + String(Math.floor(Math.random() * 9000000000 + 1000000000));
        db.prepare('INSERT INTO anonymous_numbers (phone, telegram_user_id) VALUES (?,?)').run(num, String(chatId));
      }
      const code = derivedCode(num);
      const expires = Math.floor(Date.now() / 1000) + 600;
      db.prepare('INSERT INTO verification_codes (phone, code, expires_at) VALUES (?,?,?)').run(num, code, expires);
      return { num, code };
    }

    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      const { num, code } = issueNumber(chatId);
      const opts = {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Получить номер', callback_data: 'get_number' }],
            [{ text: 'Открыть Vopgram', web_app: { url: process.env.APP_URL || 'http://localhost:3000' } }],
            [{ text: 'Админ-панель', callback_data: 'admin_panel' }],
          ]
        }
      };
      bot.sendMessage(chatId, '<b>Добро пожаловать в Vopgram!</b>\n\nНомер: <code>' + num + '</code>\nКод: <code>' + code + '</code>\n\nВведите в приложении. Код 10 минут.\n\nНикому не сообщайте код!', opts);
    });

    bot.on('callback_query', (q) => {
      const chatId = q.message.chat.id;
      const data = q.data;
      if (data === 'get_number') {
        const { num, code } = issueNumber(chatId);
        bot.answerCallbackQuery(q.id, { text: 'Номер выдан' });
        bot.sendMessage(chatId, 'Номер: <code>' + num + '</code>\nКод: <code>' + code + '</code>', { parse_mode: 'HTML' });
      } else if (data === 'admin_panel') {
        bot.answerCallbackQuery(q.id, { text: 'Введите /admin пароль' });
        bot.sendMessage(chatId, 'Введите: /admin ваш_пароль');
      } else if (data === 'adm_stats') {
        const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
        const chats = db.prepare('SELECT COUNT(*) as c FROM chats').get().c;
        const msgs = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
        const nums = db.prepare('SELECT COUNT(*) as c FROM anonymous_numbers').get().c;
        bot.answerCallbackQuery(q.id);
        bot.sendMessage(chatId, 'Статистика:\nПользователей: ' + users + '\nЧатов: ' + chats + '\nСообщений: ' + msgs + '\nВыдано номеров: ' + nums);
      } else if (data === 'adm_issue') {
        const num = '+39' + String(Math.floor(Math.random() * 9000000000 + 1000000000));
        const code = derivedCode(num);
        const expires = Math.floor(Date.now() / 1000) + 600;
        db.prepare('INSERT INTO anonymous_numbers (phone, telegram_user_id) VALUES (?,?)').run(num, 'admin');
        db.prepare('INSERT INTO verification_codes (phone, code, expires_at) VALUES (?,?,?)').run(num, code, expires);
        bot.answerCallbackQuery(q.id, { text: 'Номер выдан' });
        bot.sendMessage(chatId, 'Номер: <code>' + num + '</code>\nКод: <code>' + code + '</code>', { parse_mode: 'HTML' });
      } else if (data === 'adm_users') {
        const rows = db.prepare('SELECT id, name, phone, balance, verified FROM users ORDER BY id DESC LIMIT 20').all();
        const text = rows.map(u => u.id + '. ' + (u.name || 'Без имени') + ' | ' + u.phone + ' | ' + u.balance + ' stars ' + (u.verified ? 'V' : '')).join('\n');
        bot.answerCallbackQuery(q.id);
        bot.sendMessage(chatId, 'Пользователи:\n' + text);
      } else if (data === 'adm_balance') {
        bot.answerCallbackQuery(q.id);
        bot.sendMessage(chatId, 'Введите: /balance <номер> <сумма>');
      } else if (data === 'adm_gifts') {
        const gifts = db.prepare('SELECT id, name, price, market FROM gifts').all();
        const text = gifts.map(g => g.id + '. ' + g.name + ' - ' + g.price + ' stars ' + (g.market ? '[Market]' : '')).join('\\n');
        bot.answerCallbackQuery(q.id);
        bot.sendMessage(chatId, 'Подарки:\\n' + text + '\\n\\nДобавить: /addgift <имя> <иконка> <цена>\\nУдалить: /delgift <id>');
      } else if (data === 'adm_chats') {
        const chats = db.prepare('SELECT id, type, title, subscribers FROM chats ORDER BY id DESC LIMIT 20').all();
        const text = chats.map(c => c.id + '. [' + c.type + '] ' + c.title + (c.subscribers ? ' (' + c.subscribers + ' подп.)' : '')).join('\\n');
        bot.answerCallbackQuery(q.id);
        bot.sendMessage(chatId, 'Чаты:\\n' + text);
      } else if (data === 'adm_broadcast') {
        bot.answerCallbackQuery(q.id);
        bot.sendMessage(chatId, 'Введите: /broadcast <текст рассылки>');
      } else if (data === 'adm_help') {
        bot.answerCallbackQuery(q.id);
        bot.sendMessage(chatId, 'Команды:\\n/issue - выдать номер\\n/stats - статистика\\n/users - пользователи\\n/verify <номер> - верифицировать\\n/unverify <номер> - снять верификацию\\n/balance <номер> <сумма> - пополнить\\n/resetbal <номер> - сбросить баланс\\n/ban <номер> - забанить\\n/premium <номер> - выдать premium\\n/major <номер> - выдать major\\n/broadcast <текст> - рассылка\\n/gifts - список подарков\\n/addgift <имя> <иконка> <цена> - добавить подарок\\n/delgift <id> - удалить подарок\\n/chats - список чатов\\n/help - помощь');
      }
    });

    bot.onText(/\/admin (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (match[1].trim() !== ADMIN_PASSWORD) { bot.sendMessage(chatId, 'Неверный пароль'); return; }
      if (!ADMIN_CHAT_IDS.includes(String(chatId))) ADMIN_CHAT_IDS.push(String(chatId));
      const opts = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 Статистика', callback_data: 'adm_stats' }],
            [{ text: '📱 Выдать номер', callback_data: 'adm_issue' }],
            [{ text: '👥 Пользователи', callback_data: 'adm_users' }],
            [{ text: '💰 Пополнить баланс', callback_data: 'adm_balance' }],
            [{ text: '🎁 Список подарков', callback_data: 'adm_gifts' }],
            [{ text: '💬 Список чатов', callback_data: 'adm_chats' }],
            [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
            [{ text: '❓ Помощь', callback_data: 'adm_help' }],
          ]
        }
      };
      bot.sendMessage(chatId, 'Вы администратор. Выберите действие:', opts);
    });

    bot.onText(/\/verify (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const phone = match[1].trim();
      const u = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (!u) { bot.sendMessage(chatId, 'Пользователь не найден'); return; }
      db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(u.id);
      bot.sendMessage(chatId, 'Верифицирован: ' + phone);
    });

    bot.onText(/\/unverify (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const phone = match[1].trim();
      const u = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (!u) { bot.sendMessage(chatId, 'Пользователь не найден'); return; }
      db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run(u.id);
      bot.sendMessage(chatId, 'Верификация снята: ' + phone);
    });

    bot.onText(/\/balance (.+) (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const phone = match[1].trim();
      const amount = parseInt(match[2].trim(), 10);
      const u = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (!u) { bot.sendMessage(chatId, 'Пользователь не найден'); return; }
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, u.id);
      const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(u.id).balance;
      bot.sendMessage(chatId, 'Баланс ' + phone + ': ' + bal);
    });

    bot.onText(/\/resetbal (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const phone = match[1].trim();
      const u = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (!u) { bot.sendMessage(chatId, 'Пользователь не найден'); return; }
      db.prepare('UPDATE users SET balance = 0 WHERE id = ?').run(u.id);
      bot.sendMessage(chatId, 'Баланс сброшен: ' + phone);
    });

    bot.onText(/\/ban (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const phone = match[1].trim();
      const u = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (!u) { bot.sendMessage(chatId, 'Пользователь не найден'); return; }
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      bot.sendMessage(chatId, 'Пользователь забанен и удалён: ' + phone);
    });

    bot.onText(/\/premium (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const phone = match[1].trim();
      const u = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (!u) { bot.sendMessage(chatId, 'Пользователь не найден'); return; }
      db.prepare('UPDATE users SET major = 1 WHERE id = ?').run(u.id);
      bot.sendMessage(chatId, 'Premium выдан: ' + phone);
    });

    bot.onText(/\/major (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const phone = match[1].trim();
      const u = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (!u) { bot.sendMessage(chatId, 'Пользователь не найден'); return; }
      db.prepare('UPDATE users SET major = 1 WHERE id = ?').run(u.id);
      bot.sendMessage(chatId, 'Major статус выдан: ' + phone);
    });

    bot.onText(/\/broadcast (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const text = match[1].trim();
      const users = db.prepare('SELECT id FROM users').all();
      let sent = 0;
      for (const u of users) {
        const chats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(u.id);
        for (const c of chats) {
          db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?,?,?)').run(c.chat_id, u.id, '[Broadcast] ' + text);
          sent++;
        }
      }
      bot.sendMessage(chatId, 'Рассылка отправлена: ' + sent + ' чатов');
    });

    bot.onText(/\/gifts/, (msg) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const gifts = db.prepare('SELECT id, name, price, market FROM gifts').all();
      const text = gifts.map(g => g.id + '. ' + g.name + ' - ' + g.price + ' stars ' + (g.market ? '[Market]' : '')).join('\n');
      bot.sendMessage(chatId, 'Подарки:\\n' + text);
    });

    bot.onText(/\/addgift (.+) (.+) (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const name = match[1].trim();
      const icon = match[2].trim();
      const price = parseInt(match[3].trim(), 10);
      db.prepare('INSERT INTO gifts (name, icon, price, market) VALUES (?,?,?,0)').run(name, icon, price);
      bot.sendMessage(chatId, 'Подарок добавлен: ' + name + ' ' + icon + ' - ' + price + ' stars');
    });

    bot.onText(/\/delgift (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const id = parseInt(match[1].trim(), 10);
      db.prepare('DELETE FROM gifts WHERE id = ?').run(id);
      bot.sendMessage(chatId, 'Подарок удалён: ' + id);
    });

    bot.onText(/\/chats/, (msg) => {
      const chatId = msg.chat.id;
      if (!isAdminChat(chatId)) { bot.sendMessage(chatId, 'Нет доступа'); return; }
      const chats = db.prepare('SELECT id, type, title, subscribers FROM chats ORDER BY id DESC LIMIT 20').all();
      const text = chats.map(c => c.id + '. [' + c.type + '] ' + c.title + (c.subscribers ? ' (' + c.subscribers + ' подп.)' : '')).join('\n');
      bot.sendMessage(chatId, 'Чаты:\\n' + text);
    });

    bot.onText(/\/help/, (msg) => {
      const chatId = msg.chat.id;
      bot.sendMessage(chatId, 'Команды:\\n/start - получить номер\\n/admin <пароль> - админ-панель\\n\\nАдмин-команды:\\n/issue - выдать номер\\n/stats - статистика\\n/users - пользователи\\n/verify <номер> - верифицировать\\n/unverify <номер> - снять верификацию\\n/balance <номер> <сумма> - пополнить\\n/resetbal <номер> - сбросить баланс\\n/ban <номер> - забанить\\n/premium <номер> - выдать premium\\n/major <номер> - выдать major\\n/broadcast <текст> - рассылка\\n/gifts - список подарков\\n/addgift <имя> <иконка> <цена> - добавить подарок\\n/delgift <id> - удалить подарок\\n/chats - список чатов\\n/help - помощь');
    });

    console.log('Telegram bot started');
  } catch (e) {
    console.error('Bot error:', e.message);
  }
} else if (BOT_TOKEN) {
  console.log('Bot disabled locally (set RENDER=1 to enable). Bot runs on Render.');
} else {
  console.log('BOT_TOKEN not set; bot disabled. Set BOT_TOKEN in .env to enable.');
}

// demo number seeding disabled
db.prepare("DELETE FROM verification_codes WHERE code = '123456'").run();

// ---------- Admin ----------

function adminMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    const p = jwt.verify(token, ADMIN_SECRET);
    if (!p.admin) throw new Error('not admin');
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid admin token' });
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('no token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.userId;
    next();
  } catch (e) {
    next(new Error('invalid token'));
  }
});

io.on('connection', (socket) => {
  const chats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(socket.userId);
  for (const c of chats) socket.join('chat:' + c.chat_id);
  socket.on('join', (chatId) => socket.join('chat:' + chatId));
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Bot auth endpoints (support GET for compatibility and POST so the phone/code
// never appear in URLs, proxy logs or browser history)
async function handleRequest(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const phone = String((req.body && req.body.phone) || req.query.phone || '').trim();
  if (!phone) return res.json({ ok: false, error: 'phone required' });
  const normalizedPhone = normPhone(phone);
  const code = derivedCode(normalizedPhone);

  // Deliver the code to the Telegram chat that owns this number
  let sent = false;
  try {
    const nums = db.prepare('SELECT * FROM anonymous_numbers').all();
    const found = nums.find(n => normPhone(n.phone) === normalizedPhone);
    if (found && found.telegram_user_id && BOT_TOKEN) {
      const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({
          chat_id: found.telegram_user_id,
          text: 'Код входа в Vopgram: ' + code + '\nДействует 60 минут.',
        }),
      });
      const j = await r.json().catch(() => ({}));
      sent = !!(j && j.ok);
    }
  } catch (e) {
    console.error('send code error:', e.message);
  }

  return res.json({ ok: true, sent, hint: sent ? '' : 'Код приходит в боте @Vopgrambot — напишите /start' });
}

function handleCheck(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const phone = String((req.body && req.body.phone) || req.query.phone || '').trim();
  const code = String((req.body && req.body.code) || req.query.code || '').trim();
  if (!phone || !code) return res.json({ ok: false, error: 'phone and code required' });
  const normalizedPhone = normPhone(phone);
  const now = Math.floor(Date.now() / 1000);

  let valid = isValidCode(normalizedPhone, code);
  if (!valid) {
    const allCodes = db.prepare('SELECT * FROM verification_codes').all();
    const vc = allCodes
      .filter(c => normPhone(c.phone) === normalizedPhone && String(c.code) === code && c.used === 0 && c.expires_at >= now)
      .sort((a, b) => b.id - a.id)[0];
    if (vc) {
      db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(vc.id);
      valid = true;
    }
  }

  if (!valid) return res.json({ ok: false, error: 'invalid code' });
  return res.json({ ok: true });
}

app.get('/request', handleRequest);
app.post('/request', handleRequest);
app.get('/check', handleCheck);
app.post('/check', handleCheck);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Vopgram server running on port ' + PORT);
});
