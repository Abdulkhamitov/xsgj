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

  function readQuestionCount(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return 20;
    const v = parseInt(el.value, 10);
    if (!Number.isInteger(v) || v < 3 || v > 50) return 20;
    return v;
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

  function updateMmrBadge() {
    const el = $('#my-mmr');
    if (el) el.textContent = (me && me.mmr != null) ? `${me.mmr} MMR` : '';
  }

  function enterMenu() {
    $('#hello').textContent = me.username;
    updateMmrBadge();
    $('#quick-status').classList.add('hidden');
    $('#btn-quick-cancel').classList.add('hidden');
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

    // --- быстрая игра ---
    socket.on('quick:waiting', () => {
      $('#quick-status').textContent = 'Ищем соперника…';
      $('#quick-status').classList.remove('hidden');
      $('#btn-quick-cancel').classList.remove('hidden');
    });

    socket.on('quick:matched', () => {
      $('#quick-status').textContent = 'Соперник найден! Заходим в лобби…';
      $('#btn-quick-cancel').classList.add('hidden');
    });

    socket.on('quick:cancelled', () => {
      $('#quick-status').classList.add('hidden');
      $('#btn-quick-cancel').classList.add('hidden');
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
    const questionCount = readQuestionCount('solo-qcount');
    socket.emit('lobby:create', { mode: 'solo', questionCount }, res => {
      if (!res.ok) alert(res.error || 'Не удалось начать игру');
    });
  };
  $('#btn-friends').onclick = () => { $('#friends-error').textContent = ''; $('#join-code').value = ''; show('friends'); };
  $('#btn-friends-back').onclick = () => show('menu');

  $('#btn-quick').onclick = () => {
    if (!socket) return;
    $('#quick-status').textContent = 'Ищем соперника…';
    $('#quick-status').classList.remove('hidden');
    $('#btn-quick-cancel').classList.remove('hidden');
    socket.emit('quick:play', {}, res => {
      if (!res.ok) {
        $('#quick-status').textContent = res.error || 'Ошибка';
        $('#btn-quick-cancel').classList.add('hidden');
      }
    });
  };
  $('#btn-quick-cancel').onclick = () => {
    if (!socket) return;
    socket.emit('quick:cancel');
    $('#quick-status').classList.add('hidden');
    $('#btn-quick-cancel').classList.add('hidden');
  };

  $('#btn-create-lobby').onclick = () => {
    const questionCount = readQuestionCount('friends-qcount');
    socket.emit('lobby:create', { mode: 'friends', questionCount }, res => {
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
    const qc = $('#lobby-qcount');
    if (qc) qc.textContent = lobby.questionCount || 20;
    $('#lobby-players').innerHTML = lobby.players
      .map(p => {
        const mmr = (p.mmr != null) ? ` <span class="mmr">${p.mmr} MMR</span>` : '';
        return `<li>${esc(p.username)}${mmr}${p.id === lobby.hostId ? '<span class="crown">👑</span>' : ''}</li>`;
      })
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
  // ---------- Выход из игры ----------
  $('#btn-quit-game').onclick = () => {
    if (!confirm('Ты уверен, что хочешь выйти? Игра будет завершена.')) return;
    if (socket) socket.emit('game:quit');
    lobby = null;
    show('menu');
  };
  
  function renderResults(e) {
  // Адаптируем данные: если пришли из истории, структура немного другая
    const r = e.ranking || e.players; 
    const totalQuestions = e.total || e.total_questions;
    
    const byPlace = n => r.find(x => x.place === n);
    const order = [2, 1, 3];
    
  // Отрисовка пьедестала
    $('#podium').innerHTML = order
      .map(n => byPlace(n))
      .filter(Boolean)
      .map(p => `<div class="pl p${p.place}">
          <div class="medal">${medal(p.place)}</div>
          <div class="nm">${esc(p.username)}</div>
          <div class="sc">${p.correct}/${totalQuestions} • ${fmtTime(p.totalMs || p.total_time_ms)}</div>
        </div>`)
      .join('');
      
    const mine = r.find(x => x.id === me.id || x.username === me.username);
    
  // Текст с личным результатом
    let myText = mine ? `Твоё место: ${mine.place} из ${r.length} • ${mine.correct}/${totalQuestions} верно` : '';
    
  // Если это из истории, показываем MMR из сохраненной игры, иначе из текущей сессии
    const delta = mine.mmrDelta ?? mine.mmr_delta;
    const newMmr = mine.mmr ?? mine.mmr_after;
    
    if (mine && typeof delta === 'number') {
      const sign = delta >= 0 ? '+' : '';
      myText += ` • MMR ${sign}${delta} → ${newMmr}`;
    }
    $('#my-place').textContent = myText;

  // Таблица
    $('#results-table tbody').innerHTML = r
      .map(p => {
        const d = p.mmrDelta ?? p.mmr_delta ?? 0;
        const m = p.mmr ?? p.mmr_after ?? '—';
        const sign = d >= 0 ? '+' : '';
        const mmrCell = `<td>${sign}${d} (${m})</td>`;
        const isMe = p.id === me.id || p.username === me.username;
        
        return `<tr class="${isMe ? 'me' : ''}">
          <td>${medal(p.place)}</td>
          <td>${esc(p.username)}</td>
          <td>${p.correct}/${totalQuestions}</td>
          <td>${fmtTime(p.totalMs || p.total_time_ms)}</td>
          ${mmrCell}
        </tr>`;
      })
      .join('');
      
    // Обновляем бейдж MMR в меню (только если играли сейчас, а не смотрим историю)
    if (e.ranking && mine && typeof mine.mmr === 'number') {
      me.mmr = mine.mmr;
      updateMmrBadge();
    }
    
    lobby = null;
    show('results');
  }

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
        const players = g.players.map(p => {
          const sign = (p.mmr_delta ?? 0) >= 0 ? '+' : '';
          return `${medal(p.place)} ${esc(p.username)} (${p.correct}, ${sign}${p.mmr_delta ?? 0} MMR)`;
        }).join(' · ');
        const sign = (g.mmr_delta ?? 0) >= 0 ? '+' : '';
        
        // Добавили data-id="${g.id}", чтобы знать, какую игру открывать
        return `<div class="hitem" data-id="${g.id}" style="cursor: pointer; transition: 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background=''">
          <div class="row"><span class="place">${medal(g.place)} место из ${g.players_count}</span><span>${g.correct}/${g.total} верно</span></div>
          <div class="small">${date} • ${modeName(g.mode)} • время ${fmtTime(g.total_time_ms)} • MMR ${sign}${g.mmr_delta ?? 0} (${g.mmr_after ?? '—'})</div>
          <div class="small">${players}</div>
        </div>`;
      }).join('');

      // Добавляем обработчик клика на каждую карточку
      document.querySelectorAll('.hitem').forEach(el => {
        el.onclick = () => {
          const id = Number(el.dataset.id);
          const game = list.find(g => g.id === id);
          if (game) {
            renderResults({ ... }); // внутри передаются данные
          }
        };
      });
            // Передаем данные из истории в тот же рендер, что и итоги игры
            renderResults({
              players: game.players,
              total_questions: game.total,
              // MMR в историческом логе относится к тебе, поэтому подставляем
              // твои данные, чтобы блок "Твоё место" отрисовался корректно
              ranking: game.players.map(p => ({
                 ...p,
                 totalMs: p.total_time_ms,
                 mmrDelta: p.mmr_delta,
                 mmr: p.mmr_after,
                 // В истории нет ID, поэтому привязываем "me" по нику
                 id: p.username === me.username ? me.id : null 
              }))
            });
          }
        };
      });

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
