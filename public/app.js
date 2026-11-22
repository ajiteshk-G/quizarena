(() => {
  const SHAPES = ['▲', '◆', '●', '■'];
  const AVATARS = ['🚀', '⚡', '🤖', '🧠', '🔥', '🎯', '🌟', '🦊', '🐼', '🐯', '🦁', '🦄'];

  const state = {
    ws: null,
    role: null, // 'host' | 'player'
    authToken: localStorage.getItem('quizarena_token') || null,
    adminToken: sessionStorage.getItem('kahoot_admin_token') || null,
    launchingHostRoom: false,
    hostQuizId: null,
    roomTitle: '',
    lastReportId: null,
    activeQuestionIsPoll: false,
    allQuestions: [],
    selectedDeck: 'BOTH',
    checkedQuestionIds: new Set(),
    roomCode: null,
    hostSecret: null,
    playerId: null,
    playerName: '',
    playerAvatar: '🚀',
    timerInterval: null,
    readyInterval: null,
    confettiRunning: false
  };

  const $ = (id) => document.getElementById(id);

  function showView(viewId) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const target = $(viewId);
    if (target) target.classList.add('active');
  }

  function showToast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.display = 'none'; }, 3000);
  }

  function formatPin(code) {
    const clean = String(code || '').replace(/\s+/g, '');
    return clean.length === 6 ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean;
  }

  function isPollMsg(msg) {
    return Boolean(msg && (msg.isPoll === true || msg.pointsMultiplier === 0));
  }

  function isBossMsg(msg) {
    if (isPollMsg(msg)) return false;
    return Boolean(msg && (msg.doublePoints === true || msg.pointsMultiplier === 2));
  }

  function setEqualizer(playing) {
    const eq = $('eqBars');
    if (!eq) return;
    eq.classList.toggle('playing', Boolean(playing) && !window.quizAudio.muted);
  }

  function setUrgencyVignette(active) {
    const v = $('urgencyVignette');
    if (v) v.classList.toggle('active', Boolean(active));
  }

  function animateNumber(el, from, to, durationMs = 700, prefix = '', suffix = '') {
    if (!el) return;
    const start = performance.now();
    function step(now) {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = Math.round(from + (to - from) * eased);
      el.textContent = `${prefix}${val.toLocaleString()}${suffix}`;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function spawnFloatingReaction(emoji, name) {
    const layer = $('reactionsLayer');
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'floating-reaction';
    const leftPct = 10 + Math.random() * 80;
    el.style.left = `${leftPct}%`;
    el.innerHTML = `<span>${emoji}</span><span class="r-name">${escapeHtml(name)}</span>`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 3300);
  }

  function enterFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      enterFullscreen();
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function updateFullscreenBtn() {
    const btn = $('fullscreenBtn');
    if (!btn) return;
    btn.style.display = state.role === 'host' ? 'inline-flex' : 'none';
    btn.textContent = document.fullscreenElement ? '🗗 Exit Fullscreen' : '⛶ Fullscreen';
  }

  function updateTopbarButtons() {
    const isHostContext = state.role === 'host' || state.launchingHostRoom;
    if ($('topRoomBadge')) {
      $('topRoomBadge').style.display = state.roomCode ? 'inline-block' : 'none';
    }
    if ($('topStudioBtn')) {
      $('topStudioBtn').style.display = isHostContext ? 'inline-flex' : 'none';
    }
    if ($('topCreateQuizBtn')) {
      $('topCreateQuizBtn').style.display = (!isHostContext && state.role !== 'player') ? 'inline-flex' : 'none';
    }
    if ($('adminLogoutBtn')) {
      $('adminLogoutBtn').style.display = state.adminToken ? 'inline-flex' : 'none';
    }
    updateFullscreenBtn();
  }

  function clearClientTimers() {
    if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
    if (state.readyInterval) { clearInterval(state.readyInterval); state.readyInterval = null; }
    setUrgencyVignette(false);
  }

  // ==================== WEBSOCKET ====================
  function connectWs(onOpenCallback) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      if (onOpenCallback) onOpenCallback();
      return;
    }
    if (state.ws && state.ws.readyState === WebSocket.CONNECTING) {
      if (onOpenCallback) state.ws.addEventListener('open', onOpenCallback, { once: true });
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;

    ws.addEventListener('open', () => {
      if (onOpenCallback) onOpenCallback();
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServerMessage(msg);
    });

    ws.addEventListener('close', () => {
      if (state.ws === ws) state.ws = null;
      if (state.role === 'player' && state.roomCode && state.playerId) {
        setTimeout(() => {
          connectWs(() => {
            wsSend({
              type: 'player_join',
              code: state.roomCode,
              name: state.playerName,
              avatar: state.playerAvatar,
              playerId: state.playerId
            });
          });
        }, 1500);
      } else if (state.role === 'host' && state.roomCode && state.hostSecret) {
        setTimeout(() => {
          connectWs(() => {
            wsSend({
              type: 'host_rejoin',
              code: state.roomCode,
              hostSecret: state.hostSecret
            });
          });
        }, 1500);
      }
    });
  }

  function wsSend(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
    } else {
      connectWs(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify(payload));
        }
      });
    }
  }

  // ==================== CONFETTI ENGINE ====================
  function launchConfetti(durationMs = 7000) {
    const canvas = $('confettiCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ['#f9ab00', '#1a73e8', '#f43f5e', '#22c55e', '#ffffff', '#fb923c'];
    const particles = Array.from({ length: 190 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * 280,
      w: 8 + Math.random() * 8,
      h: 5 + Math.random() * 6,
      vx: (Math.random() - 0.5) * 5,
      vy: 3 + Math.random() * 4.8,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.22,
      color: colors[Math.floor(Math.random() * colors.length)]
    }));

    const endAt = Date.now() + durationMs;
    state.confettiRunning = true;

    function frame() {
      if (!state.confettiRunning) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        if (p.y < canvas.height + 30) alive = true;
        if (Date.now() < endAt && p.y > canvas.height + 20) {
          p.y = -20;
          p.x = Math.random() * canvas.width;
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive || Date.now() < endAt) {
        requestAnimationFrame(frame);
      } else {
        state.confettiRunning = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    requestAnimationFrame(frame);
  }

  // ==================== INIT LANDING & SETUP ====================
  function initAvatarPicker() {
    const wrap = $('avatarPicker');
    if (!wrap) return;
    wrap.innerHTML = '';
    AVATARS.forEach((emoji, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `avatar-btn${idx === 0 ? ' selected' : ''}`;
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        state.playerAvatar = emoji;
        wrap.querySelectorAll('.avatar-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        window.quizAudio.playAnswerClick();
      });
      wrap.appendChild(btn);
    });
  }

  let catalogLoaded = false;
  async function loadQuestionCatalog() {
    if (catalogLoaded) return;
    try {
      const res = await fetch('/api/questions');
      const data = await res.json();
      state.allQuestions = data.questions || [];
      catalogLoaded = true;
      applyDeckFilter('BOTH');
    } catch {
      showToast('Failed to load question bank.');
    }
  }

  function getFilteredPool(deck) {
    if (deck === 'UC1') return state.allQuestions.filter((q) => q.deck === 'UC1');
    if (deck === 'UC2') return state.allQuestions.filter((q) => q.deck === 'UC2');
    const uc1 = state.allQuestions.filter((q) => q.deck === 'UC1');
    const uc2 = state.allQuestions.filter((q) => q.deck === 'UC2');
    const out = [];
    const maxLen = Math.max(uc1.length, uc2.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < uc1.length) out.push(uc1[i]);
      if (i < uc2.length) out.push(uc2[i]);
    }
    return out;
  }

  function applyDeckFilter(deck) {
    state.selectedDeck = deck;
    const pool = getFilteredPool(deck);
    state.checkedQuestionIds = new Set(pool.map((q) => q.id));
    renderQuestionPreview(pool);
  }

  function renderQuestionPreview(pool) {
    const list = $('qPreviewList');
    if (!list) return;
    list.innerHTML = '';
    pool.forEach((q, idx) => {
      const item = document.createElement('label');
      item.className = 'q-preview-item';
      item.style.cursor = 'pointer';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.checkedQuestionIds.has(q.id);
      cb.style.marginTop = '4px';
      cb.style.width = '18px';
      cb.style.height = '18px';
      cb.addEventListener('change', () => {
        if (cb.checked) state.checkedQuestionIds.add(q.id);
        else state.checkedQuestionIds.delete(q.id);
        $('selectedQCount').textContent = state.checkedQuestionIds.size;
      });

      const body = document.createElement('div');
      body.innerHTML = `
        <div>
          <span class="q-badge ${q.deck === 'UC2' ? 'uc2' : ''}">${escapeHtml(q.category)}</span>
          ${q.doublePoints ? '<span class="q-badge boss">2&times; BOSS</span>' : ''}
        </div>
        <div style="font-size:13px;font-weight:700;color:#0b1324;line-height:1.35;">${idx + 1}. ${escapeHtml(q.question)}</div>
      `;

      item.appendChild(cb);
      item.appendChild(body);
      list.appendChild(item);
    });
    if ($('selectedQCount')) $('selectedQCount').textContent = state.checkedQuestionIds.size;
  }

  // ==================== SERVER MESSAGE ROUTER ====================
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'toast':
        showToast(msg.message);
        break;
      case 'error':
        showToast(msg.message);
        if (state.launchingHostRoom) {
          state.launchingHostRoom = false;
          if ($('launchingTitle')) $('launchingTitle').textContent = 'Could Not Launch Quiz';
          if ($('launchingError')) {
            $('launchingError').textContent = msg.message || 'Unable to load quiz.';
            $('launchingError').style.display = 'block';
          }
        }
        break;
      case 'auth_error':
        if (state.launchingHostRoom || state.hostQuizId) {
          state.launchingHostRoom = false;
          state.authToken = null;
          localStorage.removeItem('quizarena_token');
          localStorage.removeItem('quizarena_user');
          window.location.replace('/studio');
          return;
        }
        state.adminToken = null;
        sessionStorage.removeItem('kahoot_admin_token');
        updateTopbarButtons();
        $('adminLoginError').textContent = msg.message;
        $('adminLoginError').style.display = 'block';
        showView('viewAdminLogin');
        break;
      case 'join_error':
        $('joinError').textContent = msg.message;
        $('joinError').style.display = 'block';
        break;
      case 'room_created':
        onRoomCreated(msg);
        break;
      case 'lobby_update':
        onLobbyUpdate(msg);
        break;
      case 'live_reaction':
        spawnFloatingReaction(msg.emoji, msg.name);
        break;
      case 'joined_room':
        onJoinedRoom(msg);
        break;
      case 'phase_get_ready':
        onPhaseGetReady(msg);
        break;
      case 'phase_question':
        onPhaseQuestion(msg);
        break;
      case 'answer_count_update':
        $('hqAnsweredCount').textContent = msg.answeredCount;
        $('hqTotalPlayers').textContent = msg.totalPlayers;
        break;
      case 'answer_locked':
        onPlayerAnswerLocked();
        break;
      case 'phase_reveal':
        if (state.role === 'host') onHostReveal(msg);
        else onPlayerReveal(msg);
        break;
      case 'phase_leaderboard':
        if (state.role === 'host') onHostLeaderboard(msg);
        else onPlayerLeaderboard(msg);
        break;
      case 'phase_podium':
        if (state.role === 'host') onHostPodium(msg);
        else onPlayerPodium(msg);
        break;
      case 'back_to_lobby':
        if (state.role === 'player') {
          $('pScore').textContent = '0';
          setPlayerSubstate('pStateWaiting');
          showView('viewPlayer');
        }
        break;
      case 'kicked':
        showToast(msg.message);
        state.role = null;
        state.roomCode = null;
        state.playerId = null;
        updateTopbarButtons();
        showView('viewLanding');
        break;
    }
  }

  // ==================== HOST HANDLERS ====================
  function onRoomCreated(msg) {
    state.launchingHostRoom = false;
    state.role = 'host';
    state.roomCode = msg.code;
    state.hostSecret = msg.hostSecret;
    state.roomTitle = msg.title || 'QuizArena Live Session';

    $('topRoomPin').textContent = formatPin(msg.code);
    $('lobbyRoomTitle').textContent = state.roomTitle;
    $('lobbyPinDisplay').textContent = formatPin(msg.code);
    $('lobbyMaxPlayers').textContent = msg.maxPlayers;
    $('lobbyQCountBadge').textContent = `· ${msg.questionCount} Qs`;
    updateTopbarButtons();

    const joinUrl = `${location.origin}/?pin=${msg.code}`;
    $('lobbyJoinUrlText').textContent = joinUrl;
    $('copyJoinUrlBtn').onclick = () => {
      navigator.clipboard?.writeText(joinUrl).then(() => showToast('Direct join link copied!'));
    };

    fetch(`/api/qr?url=${encodeURIComponent(joinUrl)}`)
      .then((r) => r.text())
      .then((svg) => { $('lobbyQrBox').innerHTML = svg; })
      .catch(() => {});

    if (!msg.phase || msg.phase === 'LOBBY') {
      showView('viewHostLobby');
      window.quizAudio.startLobbyMusic();
      setEqualizer(true);
    }
  }

  let lastLobbyPlayerCount = 0;
  function onLobbyUpdate(msg) {
    if (msg.playerCount > lastLobbyPlayerCount) {
      window.quizAudio.playJoin();
    }
    lastLobbyPlayerCount = msg.playerCount;

    $('lobbyPlayerCount').textContent = msg.playerCount;
    $('lobbyMaxPlayers').textContent = msg.maxPlayers;
    $('lockRoomBtn').textContent = msg.locked ? '🔒 Room Locked' : '🔓 Room Open';

    const grid = $('lobbyPlayerGrid');
    if (msg.players.length === 0) {
      grid.innerHTML = `
        <div style="margin:auto;text-align:center;color:#94a3b8;font-weight:700;">
          Waiting for players to scan the QR code or enter the PIN&hellip;<br/>
          <span style="font-size:13px;font-weight:600;">Tip: Click <strong>+10 Bots</strong> or <strong>+50 Bots</strong> to preview a packed room instantly!</span>
        </div>`;
      return;
    }

    grid.innerHTML = '';
    msg.players.forEach((p) => {
      const chip = document.createElement('div');
      chip.className = `player-chip${p.isBot ? ' bot' : ''}`;
      chip.innerHTML = `<span>${escapeHtml(p.avatar)}</span><span>${escapeHtml(p.name)}</span>`;
      const kick = document.createElement('button');
      kick.className = 'kick-x';
      kick.title = `Remove ${p.name}`;
      kick.textContent = '×';
      kick.addEventListener('click', () => {
        wsSend({ type: 'host_kick_player', playerId: p.id });
      });
      chip.appendChild(kick);
      grid.appendChild(chip);
    });
  }

  function onPhaseGetReady(msg) {
    clearClientTimers();
    state.confettiRunning = false;
    window.quizAudio.stopMusic();
    setEqualizer(false);

    const isPoll = isPollMsg(msg);
    const isBoss = isBossMsg(msg);
    state.activeQuestionIsPoll = isPoll;

    $('readyCategory').textContent = msg.category || 'QuizArena';
    $('readyQNumber').textContent = `Question ${msg.questionIndex + 1} of ${msg.totalQuestions}`;
    if (msg.slideRef) {
      $('readySlideRef').textContent = msg.slideRef;
      $('readySlideRef').style.display = 'block';
    } else {
      $('readySlideRef').textContent = '';
      $('readySlideRef').style.display = 'none';
    }
    $('readyBossTag').style.display = isBoss ? 'block' : 'none';
    if ($('readyPollTag')) $('readyPollTag').style.display = isPoll ? 'block' : 'none';

    let count = msg.countdownSec || 3;
    $('readyCountdown').textContent = count;
    showView('viewGetReady');
    if (state.role === 'host') window.quizAudio.playCountdownTick(false);

    state.readyInterval = setInterval(() => {
      count--;
      if (count > 0) {
        $('readyCountdown').textContent = count;
        if (state.role === 'host') window.quizAudio.playCountdownTick(false);
      } else {
        $('readyCountdown').textContent = 'GO!';
        if (state.role === 'host') window.quizAudio.playCountdownTick(true);
        clearInterval(state.readyInterval);
        state.readyInterval = null;
      }
    }, 950);
  }

  function onPhaseQuestion(msg) {
    clearClientTimers();

    const isPoll = isPollMsg(msg);
    const isBoss = isBossMsg(msg);
    state.activeQuestionIsPoll = isPoll;
    const options = Array.isArray(msg.options) ? msg.options : [];
    const isTwoOption = options.length === 2;

    if (state.role === 'host') {
      $('hqProgress').textContent = `Q ${msg.questionIndex + 1} / ${msg.totalQuestions}`;
      $('hqCategory').textContent = msg.category || (isTwoOption ? 'True / False' : 'General');
      $('hqBossBadge').style.display = isBoss ? 'inline-flex' : 'none';
      if ($('hqPollBadge')) $('hqPollBadge').style.display = isPoll ? 'inline-flex' : 'none';
      $('hqText').textContent = msg.question;
      $('hqSlideRef').textContent = msg.slideRef || msg.category || (isTwoOption ? 'True / False' : 'Live Round');
      if ($('hqAnswersLabel')) $('hqAnswersLabel').textContent = isPoll ? 'Votes In' : 'Answers In';
      $('hqAnsweredCount').textContent = '0';
      $('hqTotalPlayers').textContent = msg.totalPlayers;

      const grid = $('hqOptionsGrid');
      grid.classList.toggle('two-col', isTwoOption);
      grid.innerHTML = '';
      options.forEach((opt, idx) => {
        const tile = document.createElement('div');
        tile.className = `opt-tile opt-${idx}`;
        tile.style.cursor = 'default';
        tile.innerHTML = `<div class="opt-shape">${SHAPES[idx] || ''}</div><div>${escapeHtml(opt)}</div>`;
        grid.appendChild(tile);
      });

      showView('viewHostQuestion');
      window.quizAudio.startQuestionMusic();
      setEqualizer(true);

      const totalMs = msg.timeLimit * 1000;
      const startAt = Date.now();
      const circle = $('hqTimerCircle');
      const ribbon = $('hqTimerRibbon');
      const wrap = $('hqTimerWrap');
      wrap.classList.remove('urgent');
      ribbon.className = 'timer-ribbon-fill';

      const updateTimer = () => {
        const elapsed = Date.now() - startAt;
        const leftMs = Math.max(0, totalMs - elapsed);
        const leftSec = Math.ceil(leftMs / 1000);
        $('hqTimerNum').textContent = leftSec;
        const ratio = leftMs / totalMs;
        circle.style.strokeDashoffset = String(264 * (1 - ratio));
        ribbon.style.width = `${Math.max(0, ratio * 100)}%`;

        if (leftSec <= 5) {
          circle.style.stroke = '#ea4335';
          ribbon.className = 'timer-ribbon-fill urgent';
          wrap.classList.add('urgent');
          setUrgencyVignette(true);
          window.quizAudio.setUrgent(true);
        } else if (leftSec <= 9) {
          circle.style.stroke = '#f9ab00';
          ribbon.className = 'timer-ribbon-fill warn';
        } else {
          circle.style.stroke = '#1a73e8';
        }

        if (leftMs <= 0) {
          clearInterval(state.timerInterval);
          state.timerInterval = null;
        }
      };
      updateTimer();
      state.timerInterval = setInterval(updateTimer, 100);
    } else {
      if ($('pLockedTitle')) {
        $('pLockedTitle').textContent = isPoll ? 'Vote Locked In!' : 'Answer Locked In!';
      }
      if (msg.alreadyAnswered) {
        setPlayerSubstate('pStateLocked');
        showView('viewPlayer');
        return;
      }
      $('pqProgress').textContent = `Q ${msg.questionIndex + 1} / ${msg.totalQuestions}`;
      if ($('pqBossBadge')) $('pqBossBadge').style.display = isBoss ? 'inline-flex' : 'none';
      if ($('pqPollBadge')) $('pqPollBadge').style.display = isPoll ? 'inline-flex' : 'none';
      $('pqText').textContent = msg.question;

      const grid = $('pqOptionsGrid');
      grid.classList.toggle('two-col', isTwoOption);
      grid.innerHTML = '';
      options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `opt-tile opt-${idx}`;
        btn.innerHTML = `<div class="opt-shape">${SHAPES[idx] || ''}</div><div>${escapeHtml(opt)}</div>`;
        btn.addEventListener('click', () => {
          window.quizAudio.playAnswerClick();
          wsSend({ type: 'player_answer', optionIndex: idx });
        });
        grid.appendChild(btn);
      });

      setPlayerSubstate('pStateQuestion');
      showView('viewPlayer');

      const endAt = Date.now() + msg.timeLimit * 1000;
      const tick = () => {
        const s = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        $('pqTimer').textContent = `${s}s`;
        if (s <= 0) { clearInterval(state.timerInterval); state.timerInterval = null; }
      };
      tick();
      state.timerInterval = setInterval(tick, 200);
    }
  }

  function onHostReveal(msg) {
    clearClientTimers();
    window.quizAudio.stopMusic();
    setEqualizer(false);
    window.quizAudio.playRevealCorrect();

    const isPoll = isPollMsg(msg) || state.activeQuestionIsPoll;
    const options = Array.isArray(msg.options) ? msg.options : [];
    const isTwoOption = options.length === 2;

    if (isPoll) {
      $('hrAccuracyPill').textContent = `Poll Results (${msg.totalAnswered} votes)`;
      if ($('hrPollBadge')) $('hrPollBadge').style.display = 'inline-flex';
    } else {
      $('hrAccuracyPill').textContent = `Accuracy: ${msg.accuracyPct}% (${msg.correctPlayers}/${msg.totalAnswered})`;
      if ($('hrPollBadge')) $('hrPollBadge').style.display = 'none';
    }

    const refText = msg.slideRef || msg.category || '';
    $('hrSlideRef').textContent = refText;
    $('hrSlideRef').style.display = refText ? 'inline-block' : 'none';
    $('hrQuestionText').textContent = msg.question;

    const debriefBox = $('hrDebriefBox');
    if (msg.explanation && String(msg.explanation).trim()) {
      if (debriefBox) debriefBox.style.display = 'flex';
      if ($('hrDebriefLabel')) $('hrDebriefLabel').textContent = isPoll ? 'Facilitator Note' : 'Facilitator Debrief Note';
      $('hrExplanation').textContent = msg.explanation;
    } else if (debriefBox) {
      debriefBox.style.display = 'none';
    }

    $('showLeaderboardBtn').textContent = msg.isLastQuestion ? '🎉 Reveal Final Podium →' : '🏆 Next: Leaderboard →';

    const dist = options.map((_, idx) => Number((msg.distribution && msg.distribution[idx]) || 0));
    const maxCount = Math.max(1, ...dist);
    const chart = $('hrChartWrap');
    chart.classList.toggle('two-col', isTwoOption);
    chart.innerHTML = '';

    dist.forEach((cnt, idx) => {
      const col = document.createElement('div');
      col.className = 'chart-col';
      const pct = Math.max(16, Math.round((cnt / maxCount) * 148));
      const isRight = !isPoll && idx === msg.correctIndex;
      const barOpacity = isPoll ? 1 : (isRight ? 1 : 0.52);
      col.innerHTML = `
        <div class="chart-count">${cnt}${isRight ? ' ✅' : ''}</div>
        <div class="chart-bar opt-${idx}" style="height:12px;opacity:${barOpacity};">${SHAPES[idx] || ''}</div>
      `;
      chart.appendChild(col);
      requestAnimationFrame(() => {
        const bar = col.querySelector('.chart-bar');
        if (bar) bar.style.height = `${pct}px`;
      });
    });

    const grid = $('hrOptionsGrid');
    grid.classList.toggle('two-col', isTwoOption);
    grid.innerHTML = '';
    options.forEach((opt, idx) => {
      const tile = document.createElement('div');
      tile.style.cursor = 'default';
      tile.style.minHeight = '72px';

      if (isPoll) {
        const totalVotes = Math.max(1, Number(msg.totalAnswered) || 0);
        const votePct = msg.totalAnswered > 0 ? Math.round((dist[idx] / totalVotes) * 100) : 0;
        tile.className = `opt-tile opt-${idx}`;
        tile.innerHTML = `
          <div class="opt-shape">${SHAPES[idx] || ''}</div>
          <div style="flex:1;">${escapeHtml(opt)}</div>
          <div class="mono" style="font-size:15px;opacity:0.95;">${dist[idx]} (${votePct}%)</div>
        `;
      } else {
        const isRight = idx === msg.correctIndex;
        tile.className = `opt-tile opt-${idx} ${isRight ? 'correct-highlight' : 'dimmed'}`;
        tile.innerHTML = `
          <div class="opt-shape">${isRight ? '✓' : (SHAPES[idx] || '')}</div>
          <div>${escapeHtml(opt)}</div>
        `;
      }
      grid.appendChild(tile);
    });

    showView('viewHostReveal');
  }

  function onHostLeaderboard(msg) {
    window.quizAudio.playLeaderboard();
    $('lbSubtitle').textContent = `Showing Top ${msg.leaderboard.length} of ${msg.totalPlayers} players · After Question ${msg.questionIndex + 1}/${msg.totalQuestions}`;
    $('lbNextBtn').textContent = msg.isLastQuestion ? '🏆 Reveal Final Podium →' : 'Next Question →';

    const list = $('hostLbList');
    list.innerHTML = '';
    msg.leaderboard.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = `lb-row ${p.rank <= 3 ? `rank-${p.rank}` : ''}`;
      row.style.animationDelay = `${idx * 45}ms`;
      const deltaBadge = p.rankDelta > 0 ? `<span class="lb-delta">▲ +${p.rankDelta}</span>` : '';
      const streakBadge = p.streak >= 2
        ? `<span class="lb-streak"><img src="/assets/streak-fire.gif" alt="" style="width:16px;height:16px;" /> ${p.streak}</span>`
        : '';
      const lastPts = p.lastPoints > 0 ? `<span style="font-size:12px;color:#16a34a;font-weight:800;margin-right:8px;">+${p.lastPoints}</span>` : '';
      row.innerHTML = `
        <div class="lb-left">
          <div class="lb-rank">${p.rank}</div>
          <span style="font-size:24px;">${escapeHtml(p.avatar)}</span>
          <div class="lb-name">${escapeHtml(p.name)}</div>
          ${streakBadge}
          ${deltaBadge}
        </div>
        <div>
          ${lastPts}
          <span class="lb-score">${p.score.toLocaleString()}</span>
        </div>
      `;
      list.appendChild(row);
    });

    showView('viewHostLeaderboard');
  }

  function onHostPodium(msg) {
    window.quizAudio.playPodiumFanfare();
    setEqualizer(false);
    launchConfetti(8000);

    state.lastReportId = msg.reportId || null;
    const titlePrefix = state.roomTitle ? `${state.roomTitle} · ` : '';
    $('podiumStatsLine').textContent = `${titlePrefix}${msg.totalPlayers} participants · ${msg.totalQuestions} questions · Room Avg Accuracy: ${msg.avgAccuracy}%`;

    const stage = $('podiumStage');
    stage.innerHTML = '';
    const order = [1, 0, 2];
    const medals = ['🥇', '🥈', '🥉'];
    order.forEach((idx) => {
      const p = msg.podium[idx];
      if (!p) return;
      const slot = document.createElement('div');
      slot.className = 'podium-slot';
      slot.innerHTML = `
        <div class="podium-avatar">${escapeHtml(p.avatar)}</div>
        <div class="podium-name">${escapeHtml(p.name)}</div>
        <div class="podium-pts">${p.score.toLocaleString()} pts &middot; ${p.correctCount}/${msg.totalQuestions}</div>
        <div class="podium-pillar pillar-${idx + 1}">${medals[idx]}</div>
      `;
      stage.appendChild(slot);
    });

    if (msg.hardestQuestion) {
      $('hardestQuestionCard').style.display = 'flex';
      $('hardestQuestionText').textContent = `[${msg.hardestQuestion.accuracyPct}% accuracy] ${msg.hardestQuestion.question}`;
    } else {
      $('hardestQuestionCard').style.display = 'none';
    }

    const rest = $('podiumRestList');
    rest.innerHTML = '';
    msg.leaderboard.slice(3, 15).forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'lb-row';
      row.style.animationDelay = `${idx * 35}ms`;
      row.innerHTML = `
        <div class="lb-left">
          <div class="lb-rank">${p.rank}</div>
          <span style="font-size:22px;">${escapeHtml(p.avatar)}</span>
          <div class="lb-name">${escapeHtml(p.name)}</div>
          <span style="font-size:12px;color:#64748b;font-weight:700;">${p.correctCount}/${msg.totalQuestions} right</span>
        </div>
        <div class="lb-score">${p.score.toLocaleString()}</div>
      `;
      rest.appendChild(row);
    });

    showView('viewHostPodium');
  }

  // ==================== PLAYER HANDLERS ====================
  function setPlayerSubstate(activeId) {
    ['pStateWaiting', 'pStateQuestion', 'pStateLocked', 'pStateReveal', 'pStateLeaderboard', 'pStatePodium'].forEach((id) => {
      const el = $(id);
      if (el) el.style.display = id === activeId ? (id === 'pStateQuestion' ? 'flex' : 'block') : 'none';
    });
  }

  function onJoinedRoom(msg) {
    state.role = 'player';
    state.roomCode = msg.code;
    state.playerId = msg.playerId;
    state.playerName = msg.name;
    state.playerAvatar = msg.avatar;

    $('joinError').style.display = 'none';
    $('topRoomPin').textContent = formatPin(msg.code);
    $('pAvatar').textContent = msg.avatar;
    $('pName').textContent = msg.name;
    $('pScore').textContent = msg.score.toLocaleString();
    updateTopbarButtons();

    if (msg.phase === 'LOBBY') {
      setPlayerSubstate('pStateWaiting');
    }
    showView('viewPlayer');
    window.quizAudio.playJoin();
  }

  function onPlayerAnswerLocked() {
    setPlayerSubstate('pStateLocked');
  }

  function onPlayerReveal(msg) {
    clearClientTimers();
    const prevScore = Number(($('pScore').textContent || '0').replace(/,/g, '')) || 0;
    animateNumber($('pScore'), prevScore, msg.totalScore, 650);

    const isPoll = isPollMsg(msg) || state.activeQuestionIsPoll;
    const card = $('pStateReveal');
    const gif = $('prGif');

    if (isPoll) {
      card.className = 'player-status-card poll';
      gif.src = '/assets/correct-party.gif';
      $('prTitle').textContent = msg.answered !== false ? 'Vote Recorded! 📊' : 'Poll Complete 📊';
      $('prPoints').textContent = 'Live Poll · No Points';
      $('prRankLine').textContent = msg.rank
        ? `Rank #${msg.rank} of ${msg.totalPlayers} · Total: ${msg.totalScore.toLocaleString()} pts`
        : `Total: ${msg.totalScore.toLocaleString()} pts`;
      $('prAheadLine').style.display = 'none';

      if (msg.explanation && String(msg.explanation).trim()) {
        $('prExplain').innerHTML = `<span>${escapeHtml(msg.explanation)}</span>`;
        $('prExplain').style.display = 'block';
      } else {
        $('prExplain').style.display = 'none';
      }

      window.quizAudio.playRevealCorrect();
      setPlayerSubstate('pStateReveal');
      showView('viewPlayer');
      return;
    }

    card.className = `player-status-card ${msg.isCorrect ? 'correct' : 'wrong'}`;

    if (msg.isCorrect) {
      gif.src = msg.streak >= 2 ? '/assets/streak-fire.gif' : '/assets/correct-party.gif';
      $('prTitle').textContent = msg.streak >= 2 ? `On Fire! ${msg.streak} Streak` : 'Correct!';
      animateNumber($('prPoints'), 0, msg.pointsEarned, 650, '+', ' pts');
    } else {
      gif.src = '/assets/oops-bounce.gif';
      $('prTitle').textContent = msg.answered ? 'Not Quite!' : "Time's Up!";
      $('prPoints').textContent = '+0 pts';
    }

    $('prRankLine').textContent = `Rank #${msg.rank} of ${msg.totalPlayers} · Total: ${msg.totalScore.toLocaleString()} pts`;

    if (msg.aheadPlayer && msg.aheadPlayer.diff > 0) {
      $('prAheadLine').textContent = `⚡ Only ${msg.aheadPlayer.diff.toLocaleString()} pts behind ${msg.aheadPlayer.name}!`;
      $('prAheadLine').style.display = 'inline-block';
    } else if (msg.rank === 1) {
      $('prAheadLine').textContent = '👑 You are #1 in the room!';
      $('prAheadLine').style.display = 'inline-block';
    } else {
      $('prAheadLine').style.display = 'none';
    }

    const expExtra = msg.explanation ? `<br/><span style="opacity:0.9;">${escapeHtml(msg.explanation)}</span>` : '';
    $('prExplain').innerHTML = `<strong>Answer:</strong> ${escapeHtml(msg.correctOptionText || '')}${expExtra}`;
    $('prExplain').style.display = 'block';

    if (msg.isCorrect) window.quizAudio.playRevealCorrect();
    else window.quizAudio.playRevealWrong();

    setPlayerSubstate('pStateReveal');
    showView('viewPlayer');
  }

  function onPlayerLeaderboard(msg) {
    $('pScore').textContent = msg.myScore.toLocaleString();
    const deltaStr = msg.rankDelta > 0 ? ` (▲ +${msg.rankDelta})` : '';
    const aheadStr = msg.aheadPlayer && msg.aheadPlayer.diff > 0
      ? ` · ${msg.aheadPlayer.diff.toLocaleString()} pts behind ${msg.aheadPlayer.name}`
      : (msg.myRank === 1 ? ' · 👑 #1 Leader!' : '');
    $('plMyBanner').textContent = `You are #${msg.myRank} of ${msg.totalPlayers}${deltaStr}${aheadStr}`;

    const list = $('plTop5List');
    if (list) {
      list.innerHTML = '';
      (msg.top5 || []).forEach((p, idx) => {
        const row = document.createElement('div');
        row.className = `lb-row ${p.rank <= 3 ? `rank-${p.rank}` : ''}`;
        row.style.padding = '10px 14px';
        row.style.animationDelay = `${idx * 45}ms`;
        row.innerHTML = `
          <div class="lb-left">
            <div class="lb-rank" style="width:28px;height:28px;font-size:13px;">${p.rank}</div>
            <span style="font-size:20px;">${escapeHtml(p.avatar)}</span>
            <div class="lb-name" style="font-size:15px;">${escapeHtml(p.name)}</div>
          </div>
          <div class="lb-score" style="font-size:16px;">${p.score.toLocaleString()}</div>
        `;
        list.appendChild(row);
      });
    }
    setPlayerSubstate('pStateLeaderboard');
    showView('viewPlayer');
  }

  function onPlayerPodium(msg) {
    $('pScore').textContent = msg.myScore.toLocaleString();
    $('ppRankTitle').textContent = msg.myRank <= 3 ? `🏆 You Made the Podium (#${msg.myRank})!` : `You Finished #${msg.myRank} of ${msg.totalPlayers}`;
    $('ppStats').textContent = `${msg.myScore.toLocaleString()} pts · ${msg.correctCount}/${msg.totalQuestions} correct · Best Streak: ${msg.maxStreak}`;
    setPlayerSubstate('pStatePodium');
    showView('viewPlayer');
    if (msg.myRank <= 3) {
      window.quizAudio.playPodiumFanfare();
      launchConfetti(5000);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==================== WIRE UP UI EVENTS ====================
  function bindEvents() {
    $('brandHomeBtn').addEventListener('click', () => {
      if (state.roomCode && !confirm('Leave the current session and return home?')) return;
      window.quizAudio.stopMusic();
      setEqualizer(false);
      clearClientTimers();
      state.role = null;
      state.roomCode = null;
      state.hostSecret = null;
      state.playerId = null;
      state.launchingHostRoom = false;
      if (location.search.includes('hostQuiz=') || location.pathname !== '/') {
        window.location.href = '/';
        return;
      }
      updateTopbarButtons();
      showView('viewLanding');
    });

    $('muteBtn').addEventListener('click', () => {
      const next = !window.quizAudio.muted;
      window.quizAudio.setMuted(next);
      $('muteBtn').textContent = next ? '🔇' : '🔊';
      setEqualizer(Boolean(window.quizAudio.currentTrack) && !next);
    });

    $('volumeSlider').addEventListener('input', (e) => {
      window.quizAudio.setVolume(e.target.value);
      if (window.quizAudio.muted && Number(e.target.value) > 0) {
        window.quizAudio.setMuted(false);
        $('muteBtn').textContent = '🔊';
        setEqualizer(Boolean(window.quizAudio.currentTrack));
      }
    });

    $('adminLoginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      window.quizAudio.ensureContext();
      $('adminLoginError').style.display = 'none';
      const username = $('adminUsername').value.trim();
      const password = $('adminPassword').value;
      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          $('adminLoginError').textContent = data.message || 'Invalid credentials.';
          $('adminLoginError').style.display = 'block';
          return;
        }
        state.adminToken = data.token;
        sessionStorage.setItem('kahoot_admin_token', data.token);
        $('adminPassword').value = '';
        updateTopbarButtons();
        loadQuestionCatalog();
        showView('viewHostSetup');
      } catch {
        $('adminLoginError').textContent = 'Login request failed. Please try again.';
        $('adminLoginError').style.display = 'block';
      }
    });

    $('adminLogoutBtn').addEventListener('click', async () => {
      if (state.adminToken) {
        fetch('/api/admin/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: state.adminToken })
        }).catch(() => {});
      }
      state.adminToken = null;
      state.role = null;
      state.roomCode = null;
      sessionStorage.removeItem('kahoot_admin_token');
      window.quizAudio.stopMusic();
      setEqualizer(false);
      updateTopbarButtons();
      showView('viewAdminLogin');
    });

    $('backToLandingBtn').addEventListener('click', () => {
      window.location.href = '/';
    });

    $('deckSelector').querySelectorAll('.deck-option').forEach((card) => {
      card.addEventListener('click', () => {
        $('deckSelector').querySelectorAll('.deck-option').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        applyDeckFilter(card.dataset.deck);
      });
    });

    $('selectAllQBtn').addEventListener('click', () => {
      const pool = getFilteredPool(state.selectedDeck);
      state.checkedQuestionIds = new Set(pool.map((q) => q.id));
      renderQuestionPreview(pool);
    });

    $('selectTop10Btn').addEventListener('click', () => {
      const pool = getFilteredPool(state.selectedDeck);
      state.checkedQuestionIds = new Set(pool.slice(0, 10).map((q) => q.id));
      renderQuestionPreview(pool);
    });

    $('createRoomBtn').addEventListener('click', () => {
      window.quizAudio.ensureContext();
      const pool = getFilteredPool(state.selectedDeck);
      const selected = pool.filter((q) => state.checkedQuestionIds.has(q.id));
      if (selected.length === 0) {
        showToast('Select at least 1 question!');
        return;
      }
      wsSend({
        type: 'host_create_room',
        adminToken: state.adminToken,
        authToken: state.authToken || localStorage.getItem('quizarena_token') || null,
        roomTitle: $('roomTitleInput').value.trim() || 'QuizArena Live Session',
        deck: state.selectedDeck,
        customQuestions: selected,
        questionCount: selected.length,
        overrideTimeLimit: Number($('timeLimitSelect').value) || 20,
        defaultTimeLimit: Number($('timeLimitSelect').value) || 20,
        maxPlayers: Number($('maxPlayersSelect').value) || 100
      });
    });

    $('joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      window.quizAudio.ensureContext();
      $('joinError').style.display = 'none';
      const code = $('joinPin').value.replace(/\s+/g, '');
      const name = $('joinName').value.trim();
      wsSend({
        type: 'player_join',
        code,
        name,
        avatar: state.playerAvatar
      });
    });

    // Live player reactions in Lobby & Podium
    document.querySelectorAll('.reaction-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.quizAudio.playAnswerClick();
        wsSend({ type: 'player_reaction', emoji: btn.dataset.emoji });
      });
    });

    $('lockRoomBtn').addEventListener('click', () => wsSend({ type: 'host_toggle_lock' }));
    $('add10BotsBtn').addEventListener('click', () => wsSend({ type: 'host_add_bots', count: 10 }));
    $('add50BotsBtn').addEventListener('click', () => wsSend({ type: 'host_add_bots', count: 50 }));
    $('clearBotsBtn').addEventListener('click', () => wsSend({ type: 'host_clear_bots' }));
    $('startGameBtn').addEventListener('click', () => {
      window.quizAudio.ensureContext();
      enterFullscreen();
      wsSend({ type: 'host_start_game' });
    });
    $('fullscreenBtn').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', updateFullscreenBtn);
    $('skipTimerBtn').addEventListener('click', () => wsSend({ type: 'host_skip_timer' }));
    $('endGameEarlyBtn').addEventListener('click', () => {
      if (confirm('End the quiz now and jump to the Final Podium?')) {
        wsSend({ type: 'host_end_game' });
      }
    });
    $('showLeaderboardBtn').addEventListener('click', () => wsSend({ type: 'host_show_leaderboard' }));
    $('lbNextBtn').addEventListener('click', () => wsSend({ type: 'host_next_question' }));
    $('playAgainBtn').addEventListener('click', () => {
      state.confettiRunning = false;
      wsSend({ type: 'host_reset_room' });
      showView('viewHostLobby');
      window.quizAudio.startLobbyMusic();
      setEqualizer(true);
    });

    const downloadCsv = () => {
      const token = localStorage.getItem('quizarena_token') || state.authToken || state.adminToken;
      if (!state.roomCode || !token) {
        showToast('Sign in via Studio to export CSV results.');
        return;
      }
      window.open(`/api/room/${state.roomCode}/export.csv?token=${encodeURIComponent(token)}`, '_blank');
    };
    $('lbExportCsvBtn').addEventListener('click', downloadCsv);
    $('podiumExportCsvBtn').addEventListener('click', downloadCsv);
  }

  // ==================== BOOT ====================
  initAvatarPicker();
  bindEvents();

  const params = new URLSearchParams(location.search);
  const hostQuizId = params.get('hostQuiz');
  const isAdminPath = location.pathname === '/admin' || location.pathname === '/admin/';

  if (hostQuizId) {
    const authToken = localStorage.getItem('quizarena_token');
    if (!authToken) {
      window.location.replace('/studio');
      return;
    }
    state.authToken = authToken;
    state.hostQuizId = hostQuizId;
    state.launchingHostRoom = true;
    updateTopbarButtons();
    showView('viewLaunching');

    wsSend({
      type: 'host_create_room',
      authToken,
      quizId: hostQuizId,
      maxPlayers: Number(params.get('maxPlayers')) || 100,
      overrideTimeLimit: Number(params.get('overrideTime')) || 0,
      shuffleOptions: params.get('shuffle') !== 'false'
    });
  } else if (isAdminPath) {
    loadQuestionCatalog();
    if (state.adminToken) {
      fetch('/api/admin/verify', { headers: { 'x-admin-token': state.adminToken } })
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) {
            updateTopbarButtons();
            showView('viewHostSetup');
          } else {
            state.adminToken = null;
            sessionStorage.removeItem('kahoot_admin_token');
            updateTopbarButtons();
            showView('viewAdminLogin');
          }
        })
        .catch(() => showView('viewAdminLogin'));
    } else {
      updateTopbarButtons();
      showView('viewAdminLogin');
    }
  } else {
    updateTopbarButtons();
    const urlPin = params.get('pin');
    if (urlPin) {
      $('joinPin').value = formatPin(urlPin);
      $('joinName').focus();
    }
  }
})();
