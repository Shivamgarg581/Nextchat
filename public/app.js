const state = {
  token: localStorage.getItem('token') || '',
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  socket: null,
  chatId: 1
};

const el = (id) => document.getElementById(id);
const api = async (path, method = 'GET', body) => {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: state.token ? `Bearer ${state.token}` : ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};

function setAuth(user, token) {
  state.user = user;
  state.token = token;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  el('authStatus').textContent = `Logged in as ${user.username}`;
  connectSocket();
  loadMessages();
  loadStories();
}

async function signupOrLogin(mode) {
  try {
    const payload = {
      username: el('username').value,
      email: el('email').value,
      password: el('password').value
    };
    const path = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const { user, token } = await api(path, 'POST', payload);
    setAuth(user, token);
  } catch (err) {
    el('authStatus').textContent = err.message;
  }
}

function addMessage(msg) {
  const node = document.createElement('div');
  node.className = `msg ${msg.sender_id === state.user?.id ? 'self' : ''}`;
  node.dataset.id = msg.id;
  node.innerHTML = `<b>${msg.sender}</b> <small>${msg.status}</small><br>${msg.content}`;
  el('messages').appendChild(node);
  el('messages').scrollTop = el('messages').scrollHeight;
}

async function loadMessages() {
  if (!state.token) return;
  const messages = await api(`/api/chats/${state.chatId}/messages`);
  el('messages').innerHTML = '';
  messages.forEach(addMessage);
}

async function loadStories() {
  const stories = await api('/api/stories');
  el('storyList').innerHTML = '';
  for (const s of stories) {
    const li = document.createElement('li');
    li.textContent = `${s.username}: ${s.content} (${s.views} views)`;
    li.onclick = async () => {
      await api(`/api/stories/${s.id}/view`, 'POST', {});
      await loadStories();
    };
    el('storyList').appendChild(li);
  }
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('message:new', (msg) => {
    addMessage(msg);
    if (msg.sender_id !== state.user?.id) {
      state.socket.emit('message:seen', { messageId: msg.id });
    }
  });

  state.socket.on('message:status', ({ messageId, status }) => {
    const node = document.querySelector(`.msg[data-id='${messageId}'] small`);
    if (node) node.textContent = status;
  });

  state.socket.on('typing:update', ({ username, typing }) => {
    el('typing').textContent = typing ? `${username} is typing...` : '';
  });

  state.socket.on('presence:update', ({ userId, online }) => {
    el('presence').textContent = `User ${userId} is ${online ? 'online' : 'offline'}`;
  });

  state.socket.on('music:status', ({ userId, title, url }) => {
    el('musicFeed').innerHTML = `User ${userId} now playing: <a href='${url}' target='_blank'>${title}</a>`;
  });
}

el('signupBtn').onclick = () => signupOrLogin('signup');
el('loginBtn').onclick = () => signupOrLogin('login');

el('sendBtn').onclick = () => {
  const content = el('messageInput').value.trim();
  if (!content || !state.socket) return;
  state.socket.emit('message:send', { chatId: state.chatId, content }, (resp) => {
    if (resp?.warning) alert(resp.warning);
    if (resp?.error) alert(resp.error);
  });
  el('messageInput').value = '';
  state.socket.emit('typing:stop', { chatId: state.chatId });
};

el('messageInput').addEventListener('input', () => {
  if (!state.socket) return;
  state.socket.emit('typing:start', { chatId: state.chatId });
  clearTimeout(window._typingTimer);
  window._typingTimer = setTimeout(() => state.socket.emit('typing:stop', { chatId: state.chatId }), 800);
});

el('postStoryBtn').onclick = async () => {
  await api('/api/stories', 'POST', { content: el('storyText').value, storyType: 'text' });
  el('storyText').value = '';
  await loadStories();
};

el('shareMusicBtn').onclick = async () => {
  await api('/api/music/now-playing', 'POST', { title: el('musicTitle').value, url: el('musicUrl').value });
};

for (const btn of document.querySelectorAll('.aiBtn')) {
  btn.onclick = async () => {
    const mode = btn.dataset.mode;
    const result = await api('/api/ai/assist', 'POST', { mode, text: el('aiInput').value });
    el('aiOutput').textContent = result.output;
  };
}

el('addBanBtn').onclick = async () => {
  try {
    await api('/api/admin/banned-words', 'POST', { word: el('banWord').value, replacement: '****' });
    el('adminOutput').textContent = 'Added successfully';
  } catch (e) {
    el('adminOutput').textContent = e.message;
  }
};

el('loadAdminBtn').onclick = async () => {
  try {
    const data = await api('/api/admin/moderation');
    el('adminOutput').textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    el('adminOutput').textContent = e.message;
  }
};

if (state.token && state.user) {
  el('authStatus').textContent = `Logged in as ${state.user.username}`;
  connectSocket();
  loadMessages();
  loadStories();
}
