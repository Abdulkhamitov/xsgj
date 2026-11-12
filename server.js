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

const DEFAULT_QUESTIONS = 20;
const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 50;
const TIME_LIMIT = 15000;
const REVEAL_MS = 2500;

const MMR_START = 1000;
const MMR_PLACE_POINTS = [25, 10, -15, -25];

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
  total_questions INTEGER NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS game_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  username TEXT NOT NULL,
  correct INTEGER NOT NULL,
  total_time_ms INTEGER NOT NULL,
  place INTEGER NOT NULL,
  mmr_delta INTEGER NOT NULL DEFAULT 0,
  mmr_after INTEGER
);
CREATE INDEX IF NOT EXISTS idx_results_user ON game_results(user_id);
`);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('users', 'mmr', 'INTEGER NOT NULL DEFAULT 1000');
ensureColumn('games', 'total_questions', 'INTEGER NOT NULL DEFAULT 20');
ensureColumn('game_results', 'mmr_delta', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('game_results', 'mmr_after', 'INTEGER');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getUserByToken(token) {
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.username, u.mmr
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
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
  const user = db.prepare('SELECT id, username, mmr FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ token, user });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT id, username, password_hash, mmr FROM users WHERE username = ?').get(username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  }
  const token = createSession(row.id);
  res.json({ token, user: { id: row.id, username: row.username, mmr: row.mmr } });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/history', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT g.id, g.mode, g.players_count, g.total_questions, g.created_at,
            r.correct, r.total_time_ms, r.place, r.mmr_delta, r.mmr_after
     FROM game_results r JOIN games g ON g.id = r.game_id
     WHERE r.user_id = ? ORDER BY g.id DESC LIMIT 50`
  ).all(req.user.id);

  const playersStmt = db.prepare(
    `SELECT username, correct, total_time_ms, place, mmr_delta
     FROM game_results WHERE game_id = ? ORDER BY place`
  );

  res.json(rows.map(r => ({
    ...r,
    total: r.total_questions,
    players: playersStmt.all(r.id),
  })));
});

const lobbies = new Map();
const quickQueue = [];

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

function clampQuestions(n) {
  const v = Number(n);
  if (!Number.isInteger(v)) return DEFAULT_QUESTIONS;
  return Math.max(MIN_QUESTIONS, Math.min(MAX_QUESTIONS, v));
}

function buildQuestions(n) {
  return shuffle(COUNTRIES).slice(0, n).map(country => {
    const others = shuffle(COUNTRIES.filter(c => c[0] !== country[0])).slice(0, 3);
    const options = shuffle([country, ...others]);
    return {
      code: country[0],
      options: options.map(o => o[1]),
      correctIndex: options.findIndex(o => o[0] === country[0]),
    };
  });
}

function publicLobby(l) {
  return {
    code: l.code,
    mode: l.mode,
    state: l.state,
    hostId: l.hostId,
    questionCount: l.questionCount,
    players: [...l.players.values()].map(p => ({
      id: p.id, username: p.username, mmr: p.mmr,
    })),
  };
}

function broadcastLobby(l) {
  io.to(l.code).emit('lobby:update', publicLobby(l));
}

function rank(l) {
  return [...l.players.values()].sort((a, b) => b.correct - a.correct || a.totalMs - b.totalMs);
}

function standings(l) {
  return rank(l).map(p => ({
    id: p.id, username: p.username, correct: p.correct, totalMs: p.totalMs, mmr: p.mmr,
  }));
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
  l.questions = buildQuestions(l.questionCount);
  l.current = -1;
  l.qOpen = false;
  l.answers = new Map();
  for (const p of l.players.values()) {
    p.correct = 0;
    p.totalMs = 0;
    p.connected = true;
    const row = db.prepare('SELECT mmr FROM users WHERE id = ?').get(p.id);
    p.mmr = row ? row.mmr : MMR_START;
    p.mmrStart = p.mmr;
  }
  io.to(l.code).emit('game:started', { total: l.questionCount });
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
    timeLimit: TIME_LIMIT,
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
  io.to(l.code).emit('game:reveal', {
    correctIndex: q.correctIndex, results, standings: standings(l),
  });
  l.timer = setTimeout(() => nextQuestion(l), REVEAL_MS);
}

function computeMmrDeltas(ranking) {
  const n = ranking.length;
  const deltas = new Array(n).fill(0);
  if (n === 0) return deltas;

  const base = ranking.map((_, i) => {
    if (i === 0) return MMR_PLACE_POINTS[0];
    if (i === 1) return MMR_PLACE_POINTS[1];
    if (i === 2) return MMR_PLACE_POINTS[2];
    return MMR_PLACE_POINTS[3];
  });

  for (let i = 0; i < n; i++) {
    const p = ranking[i];
    const others = ranking.filter((_, j) => j !== i);
    const avgOpp = others.length
      ? others.reduce((s, o) => s + (o.mmrStart ?? MMR_START), 0) / others.length
      : (p.mmrStart ?? MMR_START);
    const diff = avgOpp - (p.mmrStart ?? MMR_START);
    let delta = base[i] + Math.round(diff * 0.05);
    delta = Math.max(-40, Math.min(40, delta));
    deltas[i] = delta;
  }
  return deltas;
}

function finishGame(l) {
  l.state = 'finished';
  const ranking = rank(l);
  const mmrDeltas = computeMmrDeltas(ranking);

  const save = db.transaction(() => {
    const g = db.prepare(
      'INSERT INTO games (code, mode, players_count, total_questions) VALUES (?, ?, ?, ?)'
    ).run(l.code, l.mode, ranking.length, l.questionCount);

    const ins = db.prepare(
      `INSERT INTO game_results
       (game_id, user_id, username, correct, total_time_ms, place, mmr_delta, mmr_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const updMmr = db.prepare('UPDATE users SET mmr = mmr + ? WHERE id = ?');

    ranking.forEach((p, i) => {
      const delta = mmrDeltas[i];
      const newMmr = (p.mmrStart ?? MMR_START) + delta;
      ins.run(g.lastInsertRowid, p.id, p.username, p.correct, p.totalMs, i + 1, delta, newMmr);
      updMmr.run(delta, p.id);
      p.mmr = newMmr;
      p.mmrDelta = delta;
    });
  });

  try { save(); } catch (e) { console.error('Ошибка сохранения игры:', e); }

  io.to(l.code).emit('game:end', {
    ranking: ranking.map((p, i) => ({
      place: i + 1,
      id: p.id,
      username: p.username,
      correct: p.correct,
      totalMs: p.totalMs,
      mmrDelta: p.mmrDelta ?? 0,
      mmr: p.mmr ?? MMR_START,
    })),
    total: l.questionCount,
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

function leaveQuickQueue(socketId) {
  const idx = quickQueue.findIndex(q => q.socketId === socketId);
  if (idx !== -1) quickQueue.splice(idx, 1);
}

function tryMatch(socket) {
  const idx = quickQueue.findIndex(q => q.userId !== socket.user.id);
  if (idx === -1) return false;

  const partner = quickQueue.splice(idx, 1)[0];
  const partnerSocket = io.sockets.sockets.get(partner.socketId);
  if (!partnerSocket) return false;

  leaveLobby(socket);
  leaveLobby(partnerSocket);

  const code = genCode();
  const l = {
    code,
    mode: 'friends',
    state: 'waiting',
    hostId: partner.userId,
    questionCount: DEFAULT_QUESTIONS,
    players: new Map(),
    questions: [],
    current: -1,
    qOpen: false,
    answers: new Map(),
    timer: null,
    isQuick: true,
  };

  const addPlayer = (s) => {
    l.players.set(s.user.id, {
      id: s.user.id, username: s.user.username, socketId: s.id,
      connected: true, correct: 0, totalMs: 0, mmr: s.user.mmr ?? MMR_START,
    });
    s.lobbyCode = code;
    s.join(code);
  };

  addPlayer(partnerSocket);
  addPlayer(socket);

  lobbies.set(code, l);

  io.to(code).emit('quick:matched', { code });
  broadcastLobby(l);

  setTimeout(() => {
    if (lobbies.has(code) && l.state === 'waiting') startGame(l);
  }, 3000);

  return true;
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
    leaveQuickQueue(socket.id);

    const mode = data && data.mode === 'solo' ? 'solo' : 'friends';
    const questionCount = clampQuestions(data && data.questionCount);
    const code = genCode();

    const l = {
      code, mode, state: 'waiting', hostId: socket.user.id,
      questionCount,
      players: new Map(),
      questions: [], current: -1, qOpen: false, answers: new Map(), timer: null,
    };

    l.players.set(socket.user.id, {
      id: socket.user.id, username: socket.user.username, socketId: socket.id,
      connected: true, correct: 0, totalMs: 0, mmr: socket.user.mmr ?? MMR_START,
    });

    lobbies.set(code, l);
    socket.lobbyCode = code;
    socket.join(code);
    ack({ ok: true, code, questionCount });

    if (mode === 'solo') startGame(l);
    else broadcastLobby(l);
  });

  socket.on('lobby:join', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const code = String((data && data.code) || '').trim().toUpperCase();
    const l = lobbies.get(code);
    if (!l || l.mode !== 'friends') return ack({ ok: false, error: 'Лобби с таким кодом не найдено' });
    if (l.state !== 'waiting') return ack({ ok: false, error: 'Игра в этом лобби уже началась' });

    leaveQuickQueue(socket.id);
    if (socket.lobbyCode !== code) leaveLobby(socket);

    l.players.set(socket.user.id, {
      id: socket.user.id, username: socket.user.username, socketId: socket.id,
      connected: true, correct: 0, totalMs: 0, mmr: socket.user.mmr ?? MMR_START,
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

  socket.on('lobby:leave', () => {
    leaveQuickQueue(socket.id);
    leaveLobby(socket);
  });

  socket.on('quick:play', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    if (socket.lobbyCode) leaveLobby(socket);
    leaveQuickQueue(socket.id);

    quickQueue.push({ userId: socket.user.id, username: socket.user.username, socketId: socket.id });
    const matched = tryMatch(socket);
    if (!matched) {
      ack({ ok: true, waiting: true });
      socket.emit('quick:waiting');
    } else {
      ack({ ok: true, waiting: false });
    }
  });

  socket.on('quick:cancel', () => {
    leaveQuickQueue(socket.id);
    socket.emit('quick:cancelled');
  });

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
      total: activePlayers(l).length,
    });
    if (allAnswered(l)) closeQuestion(l);
  });

  socket.on('disconnect', () => {
    leaveQuickQueue(socket.id);
    leaveLobby(socket);
  });
});

server.listen(PORT, () => console.log(`Сайт запущен: http://localhost:${PORT}`));
