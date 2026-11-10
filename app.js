(() => {
  const $ = s => document.querySelector(s);
  let token = localStorage.getItem('fq_token');
  let me = null;
  let socket = null;
  let lobby = null;
  let authMode = 'login';
  let answered = false;

  function show(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    window.scrollTo(0, 0);
  }
  const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
  const fmtTime = ms => (ms / 1000).toFixed(1) + ' с';
  const medal = p => (p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : p + '.');
  const modeName = m => (m === 'solo' ? 'Одиночная' : 'С друзьями');

  async function api(url, method = 'GET', body) {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Ошибка');
    return data;
  }

  // ---------- Авторизация ----------
  function setAuthMode(mode) {
    authMode = mode;
    $('#tab-login').classList.toggle('active', mode === 'login');
    $('#tab-register').classList.toggle('active', mode === 'register');
    $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
    $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#auth-error').textContent = '';
  }
  $('#tab-login').onclick = () => setAuthMode('login');
  $('#tab-register').onclick = () => setAuthMode('register');

  async function submitAuth() {
    $('#auth-error').textContent = '';
    try {
      const data = await api(authMode === 'login' ? '/api/login' : '/api/register', 'POST', {
        username: $('#auth-username').value,
        password: $('#auth-password').value
      });
      token = data.token;
      localStorage.setItem('fq_token', token);
      me = data.user;
      $('#auth-password').value = '';
      enterMenu();
    } catch (e) {
      $('#auth-error').textContent = e.message;
    }
  }
  $('#auth-submit').onclick = submitAuth;
  $('#auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });
  $('#auth-username').addEventListener('keydown', e => { if (e.key === 'Enter') $('#auth-password').focus(); });

  function enterMenu() {
    $('#hello').textContent = me.username;
    connectSocket();
    show('menu');
  }

  async function logout() {
    try { await api('/api/logout', 'POST'); } catch (e) {}
    token = null; me = null; lobby = null;
    localStorage.removeItem('fq_token');
    if (socket) { socket.disconnect(); socket = null; }
    show('title');
  }
  $('#btn-logout').onclick = logout;

  // ---------- Сокет ----------
  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });

    socket.on('connect_error', err => {
      if (err.message === 'unauthorized') logout();
    });

    socket.on('lobby:update', l => {
      lobby = l;
      if (l.mode === 'friends' && l.state === 'waiting') {
        renderLobby();
        show('lobby');
      }
    });

    socket.on('lobby:closed', () => {
      lobby = null;
      alert('Создатель закрыл лобби');
      show('menu');
    });

    socket.on('game:started', () => {
      $('#flag').removeAttribute('src');
      $('#options').innerHTML = '';
      $('#qnum').textContent = 'Игра начинается…';
      $('#status').textContent = '';
      $('#scoreboard').innerHTML = '';
      show('game');
    });

    socket.on('game:question', q => {
      show('game');
      answered = false;
      $('#qnum').textContent = `Вопрос ${q.index + 1} из ${q.total}`;
      $('#flag').src = q.flag;
      $('#status').textContent = '';
      const box = $('#options');
      box.innerHTML = '';
      q.options.forEach((name, i) => {
        const b = document.createElement('button');
        b.className = 'opt';
        b.textContent = name;
        b.onclick = () => {
          if (answered) return;
          answered = true;
          b.classList.add('selected');
          box.querySelectorAll('button').forEach(x => (x.disabled = true));
          socket.emit('game:answer', { option: i });
          $('#status').textContent = 'Ответ принят…';
        };
        box.appendChild(b);
      });
      const bar = $('#timerbar');
      bar.style.transition = 'none';
      bar.style.width = '100%';
      void bar.offsetWidth;
      bar.style.transition = `width ${q.timeLimit}ms linear`;
      bar.style.width = '0%';
    });

    socket.on('game:progress', p => {
      if (answered && p.total > 1) {
        $('#status').textContent = `Ответили: ${p.answered} из ${p.total}`;
      }
    });

    socket.on('game:reveal', r => {
      const bar = $('#timerbar');
      bar.style.transition = 'none';
      const buttons = $('#options').children;
      [...buttons].forEach(b => (b.disabled = true));
      if (buttons[r.correctIndex]) buttons[r.correctIndex].classList.add('correct');
      const mine = r.results.find(x => x.id === me.id);
      if (mine && mine.choice !== null && !mine.correct && buttons[mine.choice]) {
        buttons[mine.choice].classList.add('wrong');
      }
      $('#status').textContent = mine && mine.correct ? '✅ Верно!' : (mine && mine.choice === null ? '⏰ Время вышло' : '❌ Неверно');
      const sb = $('#scoreboard');
      sb.innerHTML = '';
      if (r.standings.length > 1) {
        r.standings.forEach((p, i) => {
          const li = document.createElement('li');
          li.textContent = `${i + 1}. ${p.username} — ${p.correct}`;
          sb.appendChild(li);
        });
      }
    });

    socket.on('game:end', e => renderResults(e));
  }

  // ---------- Меню ----------
  $('#btn-solo').onclick = () => {
    socket.emit('lobby:create', { mode: 'solo' }, res => {
      if (!res.ok) alert(res.error || 'Не удалось начать игру');
    });
  };
  $('#btn-friends').onclick = () => { $('#friends-error').textContent = ''; $('#join-code').value = ''; show('friends'); };
  $('#btn-friends-back').onclick = () => show('menu');

  $('#btn-create-lobby').onclick = () => {
    socket.emit('lobby:create', { mode: 'friends' }, res => {
      if (!res.ok) $('#friends-error').textContent = res.error || 'Ошибка';
    });
  };

  function joinLobby() {
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length < 5) { $('#friends-error').textContent = 'Введи 5-символьный код'; return; }
    socket.emit('lobby:join', { code }, res => {
      if (!res.ok) $('#friends-error').textContent = res.error;
    });
  }
  $('#btn-join-lobby').onclick = joinLobby;
  $('#join-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinLobby(); });

  // ---------- Лобби ----------
  function renderLobby() {
    $('#lobby-code').textContent = lobby.code;
    $('#lobby-count').textContent = lobby.players.length;
    $('#lobby-players').innerHTML = lobby.players
      .map(p => `<li>${esc(p.username)}${p.id === lobby.hostId ? '<span class="crown">👑</span>' : ''}</li>`)
      .join('');
    const isHost = lobby.hostId === me.id;
    $('#btn-start').classList.toggle('hidden', !isHost);
    $('#lobby-wait').classList.toggle('hidden', isHost);
  }
  $('#btn-start').onclick = () => {
    socket.emit('lobby:start', {}, res => { if (!res.ok) alert(res.error); });
  };
  $('#btn-lobby-leave').onclick = () => {
    socket.emit('lobby:leave');
    lobby = null;
    show('menu');
  };

  // ---------- Результаты ----------
  function renderResults(e) {
    const r = e.ranking;
    const byPlace = n => r.find(x => x.place === n);
    const order = [2, 1, 3];
    $('#podium').innerHTML = order
      .map(n => byPlace(n))
      .filter(Boolean)
      .map(p => `<div class="pl p${p.place}">
          <div class="medal">${medal(p.place)}</div>
          <div class="nm">${esc(p.username)}</div>
          <div class="sc">${p.correct}/${e.total} • ${fmtTime(p.totalMs)}</div>
        </div>`)
      .join('');
    const mine = r.find(x => x.id === me.id);
    $('#my-place').textContent = mine ? `Твоё место: ${mine.place} из ${r.length} • ${mine.correct}/${e.total} верно` : '';
    $('#results-table tbody').innerHTML = r
      .map(p => `<tr class="${p.id === me.id ? 'me' : ''}">
          <td>${medal(p.place)}</td><td>${esc(p.username)}</td><td>${p.correct}/${e.total}</td><td>${fmtTime(p.totalMs)}</td>
        </tr>`)
      .join('');
    lobby = null;
    show('results');
  }
  $('#btn-results-menu').onclick = () => show('menu');

  // ---------- История ----------
  $('#btn-history').onclick = async () => {
    show('history');
    const box = $('#history-list');
    box.innerHTML = '<p class="muted">Загрузка…</p>';
    try {
      const list = await api('/api/history');
      if (!list.length) { box.innerHTML = '<p class="muted">Ты ещё не сыграл ни одной игры.</p>'; return; }
      box.innerHTML = list.map(g => {
        const date = new Date(g.created_at.replace(' ', 'T') + 'Z').toLocaleString('ru-RU');
        const players = g.players.map(p => `${medal(p.place)} ${esc(p.username)} (${p.correct})`).join(' · ');
        return `<div class="hitem">
          <div class="row"><span class="place">${medal(g.place)} место из ${g.players_count}</span><span>${g.correct}/${g.total} верно</span></div>
          <div class="small">${date} • ${modeName(g.mode)} • время ${fmtTime(g.total_time_ms)}</div>
          <div class="small">${players}</div>
        </div>`;
      }).join('');
    } catch (e) {
      box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  };
  $('#btn-history-back').onclick = () => show('menu');

  // ---------- Старт ----------
  setAuthMode('login');
  if (token) {
    api('/api/me').then(u => { me = u; enterMenu(); }).catch(() => {
      token = null;
      localStorage.removeItem('fq_token');
      show('title');
    });
  }
})();