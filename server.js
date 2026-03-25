require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const xss = require('xss');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const DB_PATH = process.env.DB_PATH || './nexchat.db';
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      strike_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER,
      user_id INTEGER,
      role TEXT DEFAULT 'member',
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_masked TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      status TEXT DEFAULT 'sent',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS banned_words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT UNIQUE NOT NULL,
      replacement TEXT DEFAULT '****'
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL,
      reported_user_id INTEGER,
      message_id INTEGER,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'open'
    );

    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      story_type TEXT DEFAULT 'text',
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS story_views (
      story_id INTEGER,
      viewer_id INTEGER,
      viewed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (story_id, viewer_id)
    );

    CREATE TABLE IF NOT EXISTS now_playing (
      user_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.prepare('INSERT OR IGNORE INTO banned_words (word, replacement) VALUES (?, ?)').run('hate', '****');
  db.prepare('INSERT OR IGNORE INTO banned_words (word, replacement) VALUES (?, ?)').run('abuse', '####');

  const defaultChat = db.prepare('SELECT id FROM chats WHERE type = ? AND name = ?').get('group', 'Global');
  if (!defaultChat) {
    db.prepare('INSERT INTO chats (type, name) VALUES (?, ?)').run('group', 'Global');
  }
}

initDb();

const onlineUsers = new Map();

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, isAdmin: Boolean(user.is_admin) }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

function cleanupStories() {
  db.prepare('DELETE FROM stories WHERE datetime(expires_at) < datetime(?)').run(new Date().toISOString());
}

function sanitizeMessage(content) {
  const clean = xss(String(content || '').trim());
  const words = db.prepare('SELECT word, replacement FROM banned_words').all();
  let masked = clean;
  let hitCount = 0;
  for (const row of words) {
    const regex = new RegExp(`\\b${row.word.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'gi');
    const before = masked;
    masked = masked.replace(regex, row.replacement || '****');
    if (before !== masked) hitCount += 1;
  }
  return { clean, masked, hitCount };
}

async function aiToxicityScore(content) {
  if (!openai) return { score: 0.2, reason: 'No API key configured, local fallback used.' };
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a safety classifier. Return strict JSON: {"score": number 0-1, "reason": string}.' },
      { role: 'user', content }
    ],
    temperature: 0
  });
  const raw = completion.choices?.[0]?.message?.content || '{"score":0.1, "reason":"unknown"}';
  try {
    return JSON.parse(raw);
  } catch {
    return { score: 0.3, reason: 'Could not parse model output.' };
  }
}

app.post('/api/auth/signup', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Invalid input. Password min length: 8.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(username, email, hash);
    const user = db.prepare('SELECT id, username, email, is_admin FROM users WHERE id = ?').get(result.lastInsertRowid);
    const token = signToken(user);
    db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(1, user.id);
    return res.json({ user, token });
  } catch {
    return res.status(409).json({ error: 'Username or email already exists.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  if (user.is_blocked) return res.status(403).json({ error: 'Your account is blocked.' });

  const token = signToken(user);
  return res.json({ user: { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin }, token });
});

app.get('/api/chats', authMiddleware, (req, res) => {
  cleanupStories();
  const chats = db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at
    FROM chats c
    JOIN chat_members cm ON c.id = cm.chat_id
    WHERE cm.user_id = ?
    ORDER BY c.id ASC
  `).all(req.user.id);
  res.json(chats);
});

app.get('/api/chats/:id/messages', authMiddleware, (req, res) => {
  const messages = db.prepare(`
    SELECT m.id, m.chat_id, m.sender_id, u.username as sender, m.content_masked as content, m.message_type, m.status, m.created_at
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ?
    ORDER BY m.id DESC
    LIMIT 100
  `).all(req.params.id).reverse();
  res.json(messages);
});

app.post('/api/reports', authMiddleware, (req, res) => {
  const { reportedUserId, messageId, reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'reason required' });
  db.prepare('INSERT INTO reports (reporter_id, reported_user_id, message_id, reason) VALUES (?, ?, ?, ?)')
    .run(req.user.id, reportedUserId || null, messageId || null, reason);
  res.json({ ok: true });
});

app.get('/api/stories', authMiddleware, (req, res) => {
  cleanupStories();
  const stories = db.prepare(`
    SELECT s.id, s.user_id, u.username, s.content, s.story_type, s.expires_at, s.created_at,
      (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.id) as views
    FROM stories s JOIN users u ON u.id = s.user_id
    WHERE datetime(s.expires_at) > datetime(?)
    ORDER BY s.created_at DESC
  `).all(new Date().toISOString());
  res.json(stories);
});

app.post('/api/stories', authMiddleware, (req, res) => {
  const { content, storyType = 'text' } = req.body;
  if (!content) return res.status(400).json({ error: 'Story content required' });
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO stories (user_id, content, story_type, expires_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, xss(content), storyType, expires);
  res.json({ ok: true, expiresAt: expires });
});

app.post('/api/stories/:id/view', authMiddleware, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO story_views (story_id, viewer_id) VALUES (?, ?)').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/music/now-playing', authMiddleware, (req, res) => {
  const { title, url } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title and url required' });
  db.prepare(`
    INSERT INTO now_playing (user_id, title, url, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET title=excluded.title, url=excluded.url, updated_at=CURRENT_TIMESTAMP
  `).run(req.user.id, xss(title), xss(url));
  io.emit('music:status', { userId: req.user.id, title, url });
  res.json({ ok: true });
});

app.get('/api/admin/moderation', authMiddleware, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const bannedWords = db.prepare('SELECT * FROM banned_words ORDER BY word ASC').all();
  const reports = db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 100').all();
  const blockedUsers = db.prepare('SELECT id, username, email, strike_count FROM users WHERE is_blocked = 1').all();
  res.json({ bannedWords, reports, blockedUsers });
});

app.post('/api/admin/banned-words', authMiddleware, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { word, replacement = '****' } = req.body;
  if (!word) return res.status(400).json({ error: 'word required' });
  db.prepare('INSERT OR IGNORE INTO banned_words (word, replacement) VALUES (?, ?)').run(word.toLowerCase(), replacement);
  res.json({ ok: true });
});

app.post('/api/ai/assist', authMiddleware, async (req, res) => {
  const { mode = 'reply', text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  if (!openai) {
    return res.json({ output: `[Demo AI ${mode}] ${text.slice(0, 120)}` });
  }

  const prompts = {
    reply: 'Write a concise helpful reply to this message.',
    summarize: 'Summarize this chat text in bullets.',
    rephrase: 'Rephrase this text to be clear and polite.'
  };

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: prompts[mode] || prompts.reply },
      { role: 'user', content: text }
    ]
  });
  res.json({ output: completion.choices?.[0]?.message?.content || '' });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const user = jwt.verify(token, JWT_SECRET);
    socket.user = user;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  io.emit('presence:update', { userId, online: true });

  const memberships = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(userId);
  memberships.forEach((m) => socket.join(`chat:${m.chat_id}`));

  socket.on('typing:start', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('typing:update', { userId, username: socket.user.username, chatId, typing: true });
  });

  socket.on('typing:stop', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('typing:update', { userId, username: socket.user.username, chatId, typing: false });
  });

  socket.on('message:send', async ({ chatId, content, messageType = 'text' }, ack) => {
    const user = db.prepare('SELECT is_blocked, strike_count FROM users WHERE id = ?').get(userId);
    if (!user || user.is_blocked) return ack?.({ error: 'User blocked.' });

    const { clean, masked, hitCount } = sanitizeMessage(content);
    const toxic = await aiToxicityScore(clean);

    if (toxic.score > 0.8) {
      db.prepare('UPDATE users SET strike_count = strike_count + 1 WHERE id = ?').run(userId);
      const updated = db.prepare('SELECT strike_count FROM users WHERE id = ?').get(userId);
      if (updated.strike_count >= 3) {
        db.prepare('UPDATE users SET is_blocked = 1 WHERE id = ?').run(userId);
        return ack?.({ error: 'Blocked due to repeated abusive content.' });
      }
      return ack?.({ warning: `Potentially harmful message blocked: ${toxic.reason}` });
    }

    const result = db.prepare(`
      INSERT INTO messages (chat_id, sender_id, content, content_masked, message_type, status)
      VALUES (?, ?, ?, ?, ?, 'sent')
    `).run(chatId, userId, clean, masked, messageType);

    const msg = db.prepare(`
      SELECT m.id, m.chat_id, m.sender_id, u.username as sender, m.content_masked as content, m.message_type, m.status, m.created_at
      FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?
    `).get(result.lastInsertRowid);

    io.to(`chat:${chatId}`).emit('message:new', msg);
    db.prepare('UPDATE messages SET status = ? WHERE id = ?').run('delivered', msg.id);

    if (hitCount > 0) {
      ack?.({ warning: 'Message was filtered by moderation policy.', message: msg });
    } else {
      ack?.({ message: msg });
    }
  });

  socket.on('message:seen', ({ messageId }) => {
    db.prepare('UPDATE messages SET status = ? WHERE id = ?').run('seen', messageId);
    io.emit('message:status', { messageId, status: 'seen' });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('presence:update', { userId, online: false });
  });
});

server.listen(PORT, () => {
  console.log(`NexChat server running at http://localhost:${PORT}`);
});
