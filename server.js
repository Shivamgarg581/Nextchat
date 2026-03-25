require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const xss = require('xss');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'nexchat.data.json');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

function defaultData() {
  return {
    users: [],
    chats: [{ id: 1, type: 'group', name: 'Global', createdBy: null, createdAt: new Date().toISOString() }],
    chatMembers: [],
    messages: [],
    bannedWords: [
      { id: 1, word: 'hate', replacement: '****' },
      { id: 2, word: 'abuse', replacement: '####' }
    ],
    reports: [],
    stories: [],
    storyViews: [],
    nowPlaying: []
  };
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = defaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...defaultData(), ...parsed };
  } catch {
    return defaultData();
  }
}

let store = loadData();

function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function nextId(list) {
  return (list.length ? Math.max(...list.map((x) => x.id || 0)) : 0) + 1;
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, isAdmin: Boolean(user.isAdmin) }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

function cleanupStories() {
  const now = Date.now();
  store.stories = store.stories.filter((s) => new Date(s.expiresAt).getTime() > now);
  persist();
}

function sanitizeMessage(content) {
  const clean = xss(String(content || '').trim());
  let masked = clean;
  let hitCount = 0;
  for (const row of store.bannedWords) {
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
      { role: 'system', content: 'Return strict JSON: {"score": number 0-1, "reason": string} for toxicity.' },
      { role: 'user', content }
    ],
    temperature: 0
  });
  const raw = completion.choices?.[0]?.message?.content || '{"score":0.1,"reason":"unknown"}';
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

  if (store.users.some((u) => u.email === email || u.username === username)) {
    return res.status(409).json({ error: 'Username or email already exists.' });
  }

  const user = {
    id: nextId(store.users),
    username: xss(username),
    email: xss(email),
    passwordHash: bcrypt.hashSync(password, 10),
    isAdmin: false,
    isBlocked: false,
    strikeCount: 0,
    createdAt: new Date().toISOString()
  };

  store.users.push(user);
  store.chatMembers.push({ chatId: 1, userId: user.id, role: 'member' });
  persist();

  const token = signToken(user);
  res.json({ user: { id: user.id, username: user.username, email: user.email, is_admin: false }, token });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = store.users.find((u) => u.email === email);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  if (user.isBlocked) return res.status(403).json({ error: 'Your account is blocked.' });

  const token = signToken(user);
  res.json({ user: { id: user.id, username: user.username, email: user.email, is_admin: user.isAdmin }, token });
});

app.get('/api/chats', authMiddleware, (req, res) => {
  cleanupStories();
  const memberOf = store.chatMembers.filter((m) => m.userId === req.user.id).map((m) => m.chatId);
  res.json(store.chats.filter((c) => memberOf.includes(c.id)));
});

app.get('/api/chats/:id/messages', authMiddleware, (req, res) => {
  const chatId = Number(req.params.id);
  const messages = store.messages
    .filter((m) => m.chatId === chatId)
    .slice(-100)
    .map((m) => ({
      ...m,
      sender: store.users.find((u) => u.id === m.senderId)?.username || 'Unknown',
      sender_id: m.senderId,
      message_type: m.messageType,
      created_at: m.createdAt
    }));
  res.json(messages);
});

app.post('/api/reports', authMiddleware, (req, res) => {
  const { reportedUserId, messageId, reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'reason required' });
  store.reports.push({
    id: nextId(store.reports),
    reporterId: req.user.id,
    reportedUserId: reportedUserId || null,
    messageId: messageId || null,
    reason: xss(reason),
    status: 'open',
    createdAt: new Date().toISOString()
  });
  persist();
  res.json({ ok: true });
});

app.get('/api/stories', authMiddleware, (req, res) => {
  cleanupStories();
  const stories = store.stories
    .map((s) => ({
      ...s,
      username: store.users.find((u) => u.id === s.userId)?.username || 'Unknown',
      views: store.storyViews.filter((v) => v.storyId === s.id).length
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(stories);
});

app.post('/api/stories', authMiddleware, (req, res) => {
  const { content, storyType = 'text' } = req.body;
  if (!content) return res.status(400).json({ error: 'Story content required' });
  const story = {
    id: nextId(store.stories),
    userId: req.user.id,
    content: xss(content),
    storyType,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString()
  };
  store.stories.push(story);
  persist();
  res.json({ ok: true, expiresAt: story.expiresAt });
});

app.post('/api/stories/:id/view', authMiddleware, (req, res) => {
  const storyId = Number(req.params.id);
  const exists = store.storyViews.some((v) => v.storyId === storyId && v.viewerId === req.user.id);
  if (!exists) {
    store.storyViews.push({ storyId, viewerId: req.user.id, viewedAt: new Date().toISOString() });
    persist();
  }
  res.json({ ok: true });
});

app.post('/api/music/now-playing', authMiddleware, (req, res) => {
  const { title, url } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title and url required' });

  const existing = store.nowPlaying.find((n) => n.userId === req.user.id);
  if (existing) {
    existing.title = xss(title);
    existing.url = xss(url);
    existing.updatedAt = new Date().toISOString();
  } else {
    store.nowPlaying.push({
      userId: req.user.id,
      title: xss(title),
      url: xss(url),
      updatedAt: new Date().toISOString()
    });
  }
  persist();

  io.emit('music:status', { userId: req.user.id, title, url });
  res.json({ ok: true });
});

app.get('/api/admin/moderation', authMiddleware, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  res.json({
    bannedWords: store.bannedWords,
    reports: store.reports.slice(-100).reverse(),
    blockedUsers: store.users.filter((u) => u.isBlocked).map((u) => ({ id: u.id, username: u.username, email: u.email, strike_count: u.strikeCount }))
  });
});

app.post('/api/admin/banned-words', authMiddleware, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { word, replacement = '****' } = req.body;
  if (!word) return res.status(400).json({ error: 'word required' });

  const safeWord = String(word).toLowerCase().trim();
  if (!store.bannedWords.some((b) => b.word === safeWord)) {
    store.bannedWords.push({ id: nextId(store.bannedWords), word: safeWord, replacement });
    persist();
  }
  res.json({ ok: true });
});

app.post('/api/ai/assist', authMiddleware, async (req, res) => {
  const { mode = 'reply', text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  if (!openai) return res.json({ output: `[Demo AI ${mode}] ${text.slice(0, 120)}` });

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

const onlineUsers = new Map();

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  io.emit('presence:update', { userId, online: true });

  store.chatMembers.filter((m) => m.userId === userId).forEach((m) => socket.join(`chat:${m.chatId}`));

  socket.on('typing:start', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('typing:update', { userId, username: socket.user.username, chatId, typing: true });
  });

  socket.on('typing:stop', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('typing:update', { userId, username: socket.user.username, chatId, typing: false });
  });

  socket.on('message:send', async ({ chatId, content, messageType = 'text' }, ack) => {
    const user = store.users.find((u) => u.id === userId);
    if (!user || user.isBlocked) return ack?.({ error: 'User blocked.' });

    const { clean, masked, hitCount } = sanitizeMessage(content);
    const toxic = await aiToxicityScore(clean);

    if (toxic.score > 0.8) {
      user.strikeCount += 1;
      if (user.strikeCount >= 3) {
        user.isBlocked = true;
        persist();
        return ack?.({ error: 'Blocked due to repeated abusive content.' });
      }
      persist();
      return ack?.({ warning: `Potentially harmful message blocked: ${toxic.reason}` });
    }

    const message = {
      id: nextId(store.messages),
      chatId,
      senderId: userId,
      sender: socket.user.username,
      content: masked,
      content_masked: masked,
      messageType,
      message_type: messageType,
      status: 'delivered',
      createdAt: new Date().toISOString(),
      created_at: new Date().toISOString(),
      sender_id: userId
    };

    store.messages.push(message);
    persist();

    io.to(`chat:${chatId}`).emit('message:new', message);
    ack?.(hitCount > 0 ? { warning: 'Message was filtered by moderation policy.', message } : { message });
  });

  socket.on('message:seen', ({ messageId }) => {
    const message = store.messages.find((m) => m.id === messageId);
    if (message) {
      message.status = 'seen';
      persist();
      io.emit('message:status', { messageId, status: 'seen' });
    }
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('presence:update', { userId, online: false });
  });
});

server.listen(PORT, () => {
  console.log(`NexChat server running at http://localhost:${PORT}`);
});
