const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const COUNTRIES = require('./countries');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const TOTAL_QUESTIONS = 20;
const TIME_LIMIT = 15000;   // время на один вопрос, мс
const REVEAL_MS = 2500;     // пауза после вопроса, мс
const MAX_PLAYERS = 8;

// ---------- База данных ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  mode TEXT NOT NULL,
  players_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS game_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  username TEXT NOT NULL,
  correct INTEGER NOT NULL,
  total_time_ms INTEGER NOT NULL,
  place INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_user ON game_results(user_id);
`);

// ---------- Express ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getUserByToken(token) {
  if (!token) return null;
  return db.prepare(
    'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).get(token) || null;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Требуется вход' });
  req.user = user;
  req.token = token;
  next();
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[\p{L}\p{N}_.-]{3,20}$/u.test(username)) {
    return res.status(400).json({ error: 'Имя: 3–20 символов (буквы, цифры, _ . -)' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 4 символов' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Такое имя уже занято' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  const token = createSession(info.lastInsertRowid);
  res.json({ token, user: { id: Number(info.lastInsertRowid), username } });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  }
  const token = createSession(row.id);
  res.json({ token, user: { id: row.id, username: row.username } });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/history', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT g.id, g.mode, g.players_count, g.created_at, r.correct, r.total_time_ms, r.place
    FROM game_results r JOIN games g ON g.id = r.game_id
    WHERE r.user_id = ? ORDER BY g.id DESC LIMIT 50
  `).all(req.user.id);
  const playersStmt = db.prepare(
    'SELECT username, correct, total_time_ms, place FROM game_results WHERE game_id = ? ORDER BY place'
  );
  res.json(rows.map(r => ({ ...r, total: TOTAL_QUESTIONS, players: playersStmt.all(r.id) })));
});

// ---------- Игровая логика ----------
const lobbies = new Map();

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (lobbies.has(code));
  return code;
}

function buildQuestions(n) {
  return shuffle(COUNTRIES).slice(0, n).map(country => {
    const others = shuffle(COUNTRIES.filter(c => c[0] !== country[0])).slice(0, 3);
    const options = shuffle([country, ...others]);
    return {
      code: country[0],
      options: options.map(o => o[1]),
      correctIndex: options.findIndex(o => o[0] === country[0])
    };
  });
}

function publicLobby(l) {
  return {
    code: l.code,
    mode: l.mode,
    state: l.state,
    hostId: l.hostId,
    players: [...l.players.values()].map(p => ({ id: p.id, username: p.username }))
  };
}

function broadcastLobby(l) {
  io.to(l.code).emit('lobby:update', publicLobby(l));
}

function rank(l) {
  return [...l.players.values()].sort((a, b) => b.correct - a.correct || a.totalMs - b.totalMs);
}

function standings(l) {
  return rank(l).map(p => ({ id: p.id, username: p.username, correct: p.correct, totalMs: p.totalMs }));
}

function detachAll(l) {
  for (const p of l.players.values()) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) { s.lobbyCode = null; s.leave(l.code); }
  }
}

function destroyLobby(l) {
  clearTimeout(l.timer);
  detachAll(l);
  lobbies.delete(l.code);
}

function startGame(l) {
  l.state = 'playing';
  l.questions = buildQuestions(TOTAL_QUESTIONS);
  l.current = -1;
  l.qOpen = false;
  l.answers = new Map();
  for (const p of l.players.values()) { p.correct = 0; p.totalMs = 0; p.connected = true; }
  io.to(l.code).emit('game:started', { total: TOTAL_QUESTIONS });
  l.timer = setTimeout(() => nextQuestion(l), 1500);
}

function activePlayers(l) {
  return [...l.players.values()].filter(p => p.connected);
}

function allAnswered(l) {
  return [...l.players.values()].every(p => !p.connected || l.answers.has(p.id));
}

function nextQuestion(l) {
  if (!lobbies.has(l.code)) return;
  l.current++;
  if (l.current >= l.questions.length) return finishGame(l);
  const q = l.questions[l.current];
  l.answers = new Map();
  l.qOpen = true;
  l.qStart = Date.now();
  io.to(l.code).emit('game:question', {
    index: l.current,
    total: l.questions.length,
    flag: `https://flagcdn.com/w320/${q.code}.png`,
    options: q.options,
    timeLimit: TIME_LIMIT
  });
  l.timer = setTimeout(() => closeQuestion(l), TIME_LIMIT + 400);
}

function closeQuestion(l) {
  if (!l.qOpen) return;
  l.qOpen = false;
  clearTimeout(l.timer);
  const q = l.questions[l.current];
  const results = [];
  for (const p of l.players.values()) {
    const a = l.answers.get(p.id);
    if (a) {
      results.push({ id: p.id, choice: a.option, correct: a.option === q.correctIndex });
    } else {
      p.totalMs += TIME_LIMIT;
      results.push({ id: p.id, choice: null, correct: false });
    }
  }
  io.to(l.code).emit('game:reveal', { correctIndex: q.correctIndex, results, standings: standings(l) });
  l.timer = setTimeout(() => nextQuestion(l), REVEAL_MS);
}

function finishGame(l) {
  l.state = 'finished';
  const ranking = rank(l);
  const save = db.transaction(() => {
    const g = db.prepare('INSERT INTO games (code, mode, players_count) VALUES (?, ?, ?)')
      .run(l.code, l.mode, ranking.length);
    const ins = db.prepare(
      'INSERT INTO game_results (game_id, user_id, username, correct, total_time_ms, place) VALUES (?, ?, ?, ?, ?, ?)'
    );
    ranking.forEach((p, i) => ins.run(g.lastInsertRowid, p.id, p.username, p.correct, p.totalMs, i + 1));
  });
  try { save(); } catch (e) { console.error('Ошибка сохранения игры:', e); }
  io.to(l.code).emit('game:end', {
    ranking: ranking.map((p, i) => ({
      place: i + 1, id: p.id, username: p.username, correct: p.correct, totalMs: p.totalMs
    })),
    total: TOTAL_QUESTIONS
  });
  destroyLobby(l);
}

function leaveLobby(socket) {
  const code = socket.lobbyCode;
  if (!code) return;
  socket.lobbyCode = null;
  socket.leave(code);
  const l = lobbies.get(code);
  if (!l) return;
  const p = l.players.get(socket.user.id);
  if (!p || p.socketId !== socket.id) return;

  if (l.state === 'waiting') {
    if (l.hostId === socket.user.id) {
      io.to(code).emit('lobby:closed');
      destroyLobby(l);
    } else {
      l.players.delete(socket.user.id);
      broadcastLobby(l);
    }
  } else if (l.state === 'playing') {
    p.connected = false;
    if (activePlayers(l).length === 0) {
      destroyLobby(l);
    } else if (l.qOpen && allAnswered(l)) {
      closeQuestion(l);
    }
  }
}

io.use((socket, next) => {
  const user = getUserByToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', socket => {
  socket.lobbyCode = null;

  socket.on('lobby:create', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    leaveLobby(socket);
    const mode = data && data.mode === 'solo' ? 'solo' : 'friends';
    const code = genCode();
    const l = {
      code, mode, state: 'waiting', hostId: socket.user.id,
      players: new Map(), questions: [], current: -1, qOpen: false, answers: new Map(), timer: null
    };
    l.players.set(socket.user.id, {
      id: socket.user.id, username: socket.user.username, socketId: socket.id,
      connected: true, correct: 0, totalMs: 0
    });
    lobbies.set(code, l);
    socket.lobbyCode = code;
    socket.join(code);
    ack({ ok: true, code });
    if (mode === 'solo') startGame(l);
    else broadcastLobby(l);
  });

  socket.on('lobby:join', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const code = String((data && data.code) || '').trim().toUpperCase();
    const l = lobbies.get(code);
    if (!l || l.mode !== 'friends') return ack({ ok: false, error: 'Лобби с таким кодом не найдено' });
    if (l.state !== 'waiting') return ack({ ok: false, error: 'Игра в этом лобби уже началась' });
    if (socket.lobbyCode !== code) leaveLobby(socket);
    if (!l.players.has(socket.user.id) && l.players.size >= MAX_PLAYERS) {
      return ack({ ok: false, error: 'Лобби заполнено' });
    }
    l.players.set(socket.user.id, {
      id: socket.user.id, username: socket.user.username, socketId: socket.id,
      connected: true, correct: 0, totalMs: 0
    });
    socket.lobbyCode = code;
    socket.join(code);
    ack({ ok: true, code });
    broadcastLobby(l);
  });

  socket.on('lobby:start', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const l = lobbies.get(socket.lobbyCode);
    if (!l) return ack({ ok: false, error: 'Лобби не найдено' });
    if (l.hostId !== socket.user.id) return ack({ ok: false, error: 'Начать игру может только создатель лобби' });
    if (l.state !== 'waiting') return ack({ ok: false, error: 'Игра уже идёт' });
    ack({ ok: true });
    startGame(l);
  });

  socket.on('lobby:leave', () => leaveLobby(socket));

  socket.on('game:answer', data => {
    const l = lobbies.get(socket.lobbyCode);
    if (!l || l.state !== 'playing' || !l.qOpen) return;
    const p = l.players.get(socket.user.id);
    if (!p || l.answers.has(p.id)) return;
    const option = Number(data && data.option);
    if (!Number.isInteger(option) || option < 0 || option > 3) return;
    const time = Math.min(Date.now() - l.qStart, TIME_LIMIT);
    l.answers.set(p.id, { option, time });
    p.totalMs += time;
    if (option === l.questions[l.current].correctIndex) p.correct++;
    io.to(l.code).emit('game:progress', {
      answered: l.answers.size,
      total: activePlayers(l).length
    });
    if (allAnswered(l)) closeQuestion(l);
  });

  socket.on('disconnect', () => leaveLobby(socket));
});

server.listen(PORT, () => console.log(`Сайт запущен: http://localhost:${PORT}`));