(() => {
  'use strict';

  const TOKEN_KEY = 'quizarena_token';
  const USER_KEY = 'quizarena_user';
  const SHAPES = ['▲', '◆', '●', '■'];
  const DEFAULT_EMOJIS = ['🚀', '⚡', '🧠', '🎯', '🌎', '🏆', '📚', '🎮', '💡', '🔥'];

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: readStoredUser(),
    activeTab: 'quizzes',
    myQuizzes: [],
    publicQuizzes: [],
    sessions: [],
    authorizedAccounts: [],
    activeReport: null,
    templateFilter: 'all',
    launchTargetQuiz: null,
    previewTargetQuiz: null,
    deleteTargetQuiz: null,
    aiAppendMode: false,
    importAppendMode: false,
    toastTimer: null,
    editor: {
      quizId: null,
      title: '',
      description: '',
      coverEmoji: '🚀',
      visibility: 'private',
      questions: [createBlankQuestion('mcq')],
      activeIndex: 0,
      dirty: false,
      dragSourceIndex: null
    }
  };

  function $(id) {
    return document.getElementById(id);
  }

  function readStoredUser() {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function persistAuth(token, user) {
    state.token = token || '';
    state.user = user || null;
    if (state.token && state.user) {
      localStorage.setItem(TOKEN_KEY, state.token);
      localStorage.setItem(USER_KEY, JSON.stringify(state.user));
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  }

  function escapeHtml(val) {
    return String(val == null ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message) {
    const toast = $('studioToast');
    if (!toast) return;
    toast.textContent = message;
    toast.style.display = 'block';
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.style.display = 'none';
    }, 3400);
  }

  function createBlankQuestion(type = 'mcq') {
    const isTf = type === 'tf';
    return {
      id: `q_${Math.random().toString(36).slice(2, 9)}`,
      type: isTf ? 'tf' : 'mcq',
      category: 'General',
      slideRef: '',
      question: '',
      options: isTf ? ['True', 'False'] : ['', '', '', ''],
      correctIndex: 0,
      timeLimit: isTf ? 15 : 20,
      pointsMultiplier: 1,
      doublePoints: false,
      explanation: ''
    };
  }

  function normalizeClientQuestion(raw, idx = 0) {
    const rawOpts = Array.isArray(raw && raw.options) ? raw.options.map((o) => String(o == null ? '' : o)) : [];
    const isTf = (raw && raw.type === 'tf') || rawOpts.length === 2;
    let options;
    if (isTf) {
      options = [
        rawOpts[0] !== undefined ? rawOpts[0] : 'True',
        rawOpts[1] !== undefined ? rawOpts[1] : 'False'
      ];
    } else {
      options = [
        rawOpts[0] || '',
        rawOpts[1] || '',
        rawOpts[2] || '',
        rawOpts[3] || ''
      ];
    }

    let mult = 1;
    if (raw && raw.pointsMultiplier !== undefined && [0, 1, 2].includes(Number(raw.pointsMultiplier))) {
      mult = Number(raw.pointsMultiplier);
    } else if (raw && raw.doublePoints) {
      mult = 2;
    }

    const rawCorrect = Number(raw && raw.correctIndex);
    const correctIndex = Number.isInteger(rawCorrect) && rawCorrect >= 0 && rawCorrect < options.length
      ? rawCorrect
      : 0;

    const rawTime = Number(raw && raw.timeLimit);
    const timeLimit = Number.isFinite(rawTime) && rawTime >= 5 && rawTime <= 120 ? Math.round(rawTime) : 20;

    return {
      id: (raw && raw.id) ? String(raw.id) : `q_${idx + 1}_${Math.random().toString(36).slice(2, 6)}`,
      type: isTf ? 'tf' : 'mcq',
      category: String((raw && raw.category) || 'General'),
      slideRef: String((raw && raw.slideRef) || ''),
      question: String((raw && raw.question) || ''),
      options,
      correctIndex,
      timeLimit,
      pointsMultiplier: mult,
      doublePoints: mult === 2,
      explanation: String((raw && raw.explanation) || '')
    };
  }

  async function apiFetch(url, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }

    const res = await fetch(url, {
      ...options,
      headers
    });

    let data = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    } else {
      const text = await res.text();
      data = { ok: res.ok, message: text };
    }

    if (res.status === 401 && !url.startsWith('/api/auth/login') && !url.startsWith('/api/auth/register')) {
      persistAuth('', null);
      showAuthScreen('Your session expired or was revoked. Please sign in with an authorized account.');
      throw new Error((data && data.message) || 'Authorized creator sign-in required.');
    }

    if (!res.ok || (data && data.ok === false)) {
      const msg = (data && (data.message || data.error)) || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    return data;
  }

  // ==================== VIEW & TAB SWITCHING ====================

  function showAuthScreen(errorMsg = '') {
    $('studioBootLoader').style.display = 'none';
    $('studioMainShell').style.display = 'none';
    $('studioNavTabs').style.display = 'none';
    $('userBadgeWrap').style.display = 'none';
    $('viewStudioAuth').style.display = 'flex';

    const errBox = $('authErrorBox');
    if (errorMsg) {
      errBox.textContent = errorMsg;
      errBox.style.display = 'block';
    } else {
      errBox.style.display = 'none';
    }

    loadPublicShowcasePreview();
  }

  function enterStudioWorkspace() {
    $('studioBootLoader').style.display = 'none';
    $('viewStudioAuth').style.display = 'none';
    $('studioMainShell').style.display = 'block';
    $('studioNavTabs').style.display = 'flex';
    $('userBadgeWrap').style.display = 'flex';

    updateUserBadge();

    const hashTab = parseTabFromHash();
    switchStudioTab(hashTab || 'quizzes', { updateHash: false });
  }

  function updateUserBadge() {
    if (!state.user) return;
    const name = state.user.name || 'Creator';
    const isSuper = state.user.role === 'superadmin';
    $('userNameLabel').textContent = name;
    $('userInitial').textContent = name.trim().charAt(0).toUpperCase() || 'A';
    const roleTag = $('userRoleTag');
    if (roleTag) roleTag.style.display = isSuper ? 'inline-block' : 'none';
    const accessTab = $('tabBtnAccess');
    if (accessTab) accessTab.style.display = isSuper ? 'inline-flex' : 'none';
  }

  function parseTabFromHash() {
    const allowed = ['quizzes', 'templates', 'reports', 'editor', 'access'];
    const raw = (window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
    if (allowed.includes(raw)) {
      if (raw === 'access' && (!state.user || state.user.role !== 'superadmin')) return 'quizzes';
      return raw;
    }
    const params = new URLSearchParams(window.location.search);
    const qTab = (params.get('tab') || '').toLowerCase();
    if (allowed.includes(qTab)) {
      if (qTab === 'access' && (!state.user || state.user.role !== 'superadmin')) return 'quizzes';
      return qTab;
    }
    return '';
  }

  function switchStudioTab(tabName, { updateHash = true } = {}) {
    const isSuper = Boolean(state.user && state.user.role === 'superadmin');
    const validTabs = isSuper
      ? ['quizzes', 'templates', 'reports', 'editor', 'access']
      : ['quizzes', 'templates', 'reports', 'editor'];
    const nextTab = validTabs.includes(tabName) ? tabName : 'quizzes';
    state.activeTab = nextTab;

    document.querySelectorAll('#studioNavTabs .studio-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === nextTab);
    });

    $('panelQuizzes').classList.toggle('active', nextTab === 'quizzes');
    $('panelTemplates').classList.toggle('active', nextTab === 'templates');
    $('panelReports').classList.toggle('active', nextTab === 'reports');
    $('panelEditor').classList.toggle('active', nextTab === 'editor');
    if ($('panelAccess')) {
      $('panelAccess').classList.toggle('active', nextTab === 'access');
    }

    if (updateHash) {
      const targetHash = `#${nextTab}`;
      if (window.location.hash !== targetHash) {
        history.replaceState(null, '', `/studio${targetHash}`);
      }
    }

    if (nextTab === 'reports') {
      loadReports();
    } else if (nextTab === 'editor') {
      renderEditorAll();
    } else if (nextTab === 'access' && isSuper) {
      loadAccessList();
    }
  }

  // ==================== AUTH HANDLERS ====================

  function setAuthMode(mode) {
    const isLogin = mode !== 'register';
    $('authTabLogin').classList.toggle('active', isLogin);
    $('authTabLogin').setAttribute('aria-selected', String(isLogin));
    $('authTabRegister').classList.toggle('active', !isLogin);
    $('authTabRegister').setAttribute('aria-selected', String(!isLogin));

    $('loginForm').style.display = isLogin ? 'block' : 'none';
    $('registerForm').style.display = isLogin ? 'none' : 'block';
    $('authErrorBox').style.display = 'none';
  }

  async function loadAccessList() {
    if (!state.user || state.user.role !== 'superadmin') return;
    try {
      const data = await apiFetch('/api/admin/access');
      state.authorizedAccounts = data.accounts || [];
      if ($('navAccessCount')) $('navAccessCount').textContent = String(state.authorizedAccounts.length);
      if ($('accessCountBadge')) $('accessCountBadge').textContent = String(state.authorizedAccounts.length);
      renderAccessTable();
    } catch (err) {
      showToast(err.message || 'Failed to load access list.');
    }
  }

  function renderAccessTable() {
    const tbody = $('accessAccountsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    for (const acc of state.authorizedAccounts) {
      const tr = document.createElement('tr');
      tr.style.borderTop = '1px solid var(--border-subtle)';
      const roleBadge = acc.role === 'superadmin'
        ? '<span style="background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;">SUPER ADMIN</span>'
        : '<span style="background:#f1f5f9;color:#334155;font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;">CREATOR</span>';
      const statusBadge = acc.activated
        ? '<span style="color:#15803d;font-size:12px;font-weight:800;">● Active</span>'
        : '<span style="color:#b45309;font-size:12px;font-weight:800;">○ Pending Activation</span>';
      const canRevoke = !acc.isPrimarySuperAdmin && (!state.user || acc.email !== state.user.email);
      const actionCell = canRevoke
        ? `<button type="button" class="btn btn-danger-ghost btn-sm" data-revoke-email="${escapeHtml(acc.email)}">Revoke</button>`
        : '<span style="font-size:12px;color:var(--text-muted);font-weight:700;">Protected</span>';

      tr.innerHTML = `
        <td style="padding:13px 20px;font-weight:800;font-size:14px;">${escapeHtml(acc.email)}</td>
        <td style="padding:13px 16px;font-size:14px;">${escapeHtml(acc.name)}</td>
        <td style="padding:13px 16px;">${roleBadge}</td>
        <td style="padding:13px 16px;">${statusBadge}</td>
        <td style="padding:13px 20px;text-align:right;">${actionCell}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function handleAuthorizeSubmit(e) {
    e.preventDefault();
    const errBox = $('accessFormError');
    if (errBox) errBox.style.display = 'none';
    const email = $('authAllowEmail').value.trim();
    const name = $('authAllowName').value.trim();
    const role = $('authAllowRole').value;
    const initialPassword = $('authAllowPassword').value;
    const btn = $('authorizeSubmitBtn');
    btn.disabled = true;
    try {
      const data = await apiFetch('/api/admin/access', {
        method: 'POST',
        body: JSON.stringify({ email, name, role, initialPassword })
      });
      state.authorizedAccounts = data.accounts || [];
      if ($('navAccessCount')) $('navAccessCount').textContent = String(state.authorizedAccounts.length);
      if ($('accessCountBadge')) $('accessCountBadge').textContent = String(state.authorizedAccounts.length);
      renderAccessTable();
      $('authAllowEmail').value = '';
      $('authAllowName').value = '';
      $('authAllowPassword').value = '';
      showToast(`✅ Authorized ${email}!`);
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || 'Could not authorize account.';
        errBox.style.display = 'block';
      }
    } finally {
      btn.disabled = false;
    }
  }

  async function handleRevokeEmail(email) {
    if (!email || !confirm(`Revoke Creator Studio access for ${email}? Any active sessions will be signed out immediately.`)) {
      return;
    }
    try {
      const data = await apiFetch(`/api/admin/access/${encodeURIComponent(email)}`, {
        method: 'DELETE'
      });
      state.authorizedAccounts = data.accounts || [];
      if ($('navAccessCount')) $('navAccessCount').textContent = String(state.authorizedAccounts.length);
      if ($('accessCountBadge')) $('accessCountBadge').textContent = String(state.authorizedAccounts.length);
      renderAccessTable();
      showToast(`🔒 Revoked access for ${email}.`);
    } catch (err) {
      showToast(err.message || 'Failed to revoke access.');
    }
  }

  async function handleChangePasswordSubmit(e) {
    e.preventDefault();
    const errBox = $('pwChangeError');
    if (errBox) errBox.style.display = 'none';
    const currentPassword = $('currentPwInput').value;
    const newPassword = $('newPwInput').value;
    const btn = $('changePwSubmitBtn');
    btn.disabled = true;
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      $('currentPwInput').value = '';
      $('newPwInput').value = '';
      showToast('🔑 Password updated successfully!');
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || 'Failed to update password.';
        errBox.style.display = 'block';
      }
    } finally {
      btn.disabled = false;
    }
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    const btn = $('loginSubmitBtn');
    $('authErrorBox').style.display = 'none';

    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Signing in...';

    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      persistAuth(data.token, data.user);
      $('loginPassword').value = '';
      enterStudioWorkspace();
      const tasks = [loadQuizzes(), loadReports()];
      if (data.user.role === 'superadmin') tasks.push(loadAccessList());
      await Promise.all(tasks);
      showToast(`Welcome back, ${data.user.name}!`);
    } catch (err) {
      $('authErrorBox').textContent = err.message || 'Invalid email or password.';
      $('authErrorBox').style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  async function handleRegisterSubmit(e) {
    e.preventDefault();
    const name = $('registerName').value.trim();
    const email = $('registerEmail').value.trim();
    const password = $('registerPassword').value;
    const btn = $('registerSubmitBtn');
    $('authErrorBox').style.display = 'none';

    if (password.length < 6) {
      $('authErrorBox').textContent = 'Password must be at least 6 characters.';
      $('authErrorBox').style.display = 'block';
      return;
    }

    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Creating account...';

    try {
      const data = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password })
      });
      persistAuth(data.token, data.user);
      $('registerPassword').value = '';
      enterStudioWorkspace();
      const tasks = [loadQuizzes(), loadReports()];
      if (data.user.role === 'superadmin') tasks.push(loadAccessList());
      await Promise.all(tasks);
      showToast(`🎉 Account activated! Welcome to QuizArena, ${data.user.name}.`);
    } catch (err) {
      $('authErrorBox').textContent = err.message || 'Could not create account.';
      $('authErrorBox').style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  async function handleLogout() {
    try {
      if (state.token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.token}`
          }
        });
      }
    } catch {
      // Ignore network error on logout
    }
    persistAuth('', null);
    state.myQuizzes = [];
    state.sessions = [];
    state.activeReport = null;
    initBlankEditorDraft({ switchTab: false });
    history.replaceState(null, '', '/studio');
    showAuthScreen('');
    showToast('Signed out of Creator Studio.');
  }

  async function loadPublicShowcasePreview() {
    try {
      const res = await fetch('/api/quizzes/public');
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data.quizzes) ? data.quizzes : [];
      if (!list.length) return;
      const container = $('authPublicPreviewList');
      container.innerHTML = list.slice(0, 5).map((q) => {
        const count = Array.isArray(q.questions) ? q.questions.length : (q.questionCount || 0);
        return `<div class="showcase-tpl-chip">${escapeHtml(q.coverEmoji || '⚡')} ${escapeHtml(q.title)} <span class="mono" style="color:var(--text-muted);font-size:11px;">(${count}Q)</span></div>`;
      }).join('');
    } catch {
      // Keep static fallback chips
    }
  }

  // ==================== QUIZZES & TEMPLATES DATA ====================

  async function loadQuizzes() {
    if (!state.token) return;
    try {
      const data = await apiFetch('/api/quizzes');
      state.myQuizzes = Array.isArray(data.myQuizzes) ? data.myQuizzes : [];
      state.publicQuizzes = Array.isArray(data.publicQuizzes) ? data.publicQuizzes : [];
      updateNavCounts();
      renderMyQuizzes();
      renderTemplates();
    } catch (err) {
      showToast(err.message || 'Could not load quizzes.');
    }
  }

  function updateNavCounts() {
    $('navMyCount').textContent = String(state.myQuizzes.length);
    $('myQuizzesCountBadge').textContent = String(state.myQuizzes.length);
    $('navTplCount').textContent = String(state.publicQuizzes.length);
    $('templatesCountBadge').textContent = String(state.publicQuizzes.length);
    $('navRepCount').textContent = String(state.sessions.length);
    $('reportsCountBadge').textContent = String(state.sessions.length);
  }

  function summarizeQuestionTypes(quiz) {
    const qs = Array.isArray(quiz.questions) ? quiz.questions : [];
    const total = qs.length || Number(quiz.questionCount) || 0;
    let tfCount = 0;
    let bossCount = 0;
    let pollCount = 0;
    for (const q of qs) {
      if (q.type === 'tf' || (Array.isArray(q.options) && q.options.length === 2)) tfCount++;
      const mult = q.pointsMultiplier !== undefined ? Number(q.pointsMultiplier) : (q.doublePoints ? 2 : 1);
      if (mult === 2) bossCount++;
      if (mult === 0) pollCount++;
    }
    return { total, tfCount, bossCount, pollCount };
  }

  function visibilityBadgeHtml(quiz, isTemplateTab = false) {
    if (quiz.isTemplate || quiz.ownerId === 'system') {
      return '<span class="vis-badge official">⭐ Official Template</span>';
    }
    const vis = (quiz.visibility || 'private').toLowerCase();
    if (isTemplateTab && quiz.ownerName) {
      return `<span class="vis-badge public">🌎 By ${escapeHtml(quiz.ownerName)}</span>`;
    }
    if (vis === 'public') return '<span class="vis-badge public">🌎 Public</span>';
    if (vis === 'unlisted') return '<span class="vis-badge unlisted">🔗 Unlisted</span>';
    return '<span class="vis-badge private">🔒 Private</span>';
  }

  function formatShortDate(ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'number' || /^\d+$/.test(String(ts)) ? Number(ts) : ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(typeof ts === 'number' || /^\d+$/.test(String(ts)) ? Number(ts) : ts);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function renderMyQuizzes() {
    const query = ($('myQuizzesSearch').value || '').trim().toLowerCase();
    const sortBy = $('myQuizzesSort').value || 'recent';
    const grid = $('myQuizzesGrid');
    const empty = $('myQuizzesEmpty');

    let items = state.myQuizzes.filter((q) => {
      if (!query) return true;
      const hay = `${q.title || ''} ${q.description || ''}`.toLowerCase();
      return hay.includes(query);
    });

    items = [...items].sort((a, b) => {
      if (sortBy === 'plays') return (Number(b.playsCount) || 0) - (Number(a.playsCount) || 0);
      if (sortBy === 'alpha') return String(a.title || '').localeCompare(String(b.title || ''));
      const tA = new Date(a.updatedAt || a.createdAt || 0).getTime() || 0;
      const tB = new Date(b.updatedAt || b.createdAt || 0).getTime() || 0;
      return tB - tA;
    });

    if (state.myQuizzes.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    grid.style.display = 'grid';

    if (items.length === 0) {
      grid.innerHTML = `
        <div class="empty-studio-card" style="grid-column:1 / -1;padding:34px 20px;">
          <h3>No quizzes match "${escapeHtml(query)}"</h3>
          <p style="margin-bottom:0;">Try clearing your search filter above.</p>
        </div>
      `;
      return;
    }

    const tokenParam = encodeURIComponent(state.token);

    grid.innerHTML = items.map((quiz) => {
      const stats = summarizeQuestionTypes(quiz);
      const idEnc = encodeURIComponent(quiz.id);
      const dateStr = formatShortDate(quiz.updatedAt || quiz.createdAt);

      return `
        <article class="quiz-card" data-quiz-id="${escapeHtml(quiz.id)}">
          <div>
            <div class="quiz-card-head">
              <div class="quiz-emoji-tile">${escapeHtml(quiz.coverEmoji || '🚀')}</div>
              ${visibilityBadgeHtml(quiz, false)}
            </div>
            <h3 class="quiz-card-title">${escapeHtml(quiz.title || 'Untitled Quiz')}</h3>
            <p class="quiz-card-desc">${escapeHtml(quiz.description || 'Custom interactive multiplayer quiz.')}</p>
            <div class="quiz-meta-strip">
              <span class="meta-chip">📝 ${stats.total} ${stats.total === 1 ? 'Question' : 'Questions'}</span>
              <span class="meta-chip">🎮 ${Number(quiz.playsCount) || 0} plays</span>
              ${stats.tfCount > 0 ? `<span class="meta-chip tf">${stats.tfCount} T/F</span>` : ''}
              ${stats.bossCount > 0 ? `<span class="meta-chip boss">🔥 ${stats.bossCount} Boss</span>` : ''}
              ${stats.pollCount > 0 ? `<span class="meta-chip poll">📊 ${stats.pollCount} Poll</span>` : ''}
              ${dateStr ? `<span class="meta-chip">${escapeHtml(dateStr)}</span>` : ''}
            </div>
          </div>

          <div class="quiz-card-footer">
            <div class="quiz-primary-btns">
              <button type="button" class="btn btn-success btn-sm" data-action="host" data-id="${escapeHtml(quiz.id)}">
                ▶ Host Live
              </button>
              <button type="button" class="btn btn-primary btn-sm" data-action="edit" data-id="${escapeHtml(quiz.id)}">
                ✏️ Edit
              </button>
            </div>
            <div class="quiz-secondary-btns">
              <div style="display:flex;gap:5px;flex-wrap:wrap;">
                <button type="button" class="icon-action-btn" data-action="clone" data-id="${escapeHtml(quiz.id)}" title="Duplicate quiz">
                  📋 Duplicate
                </button>
                <a class="icon-action-btn" href="/api/quizzes/${idEnc}/export.csv?token=${tokenParam}" download title="Export as CSV">
                  📤 CSV
                </a>
                <a class="icon-action-btn" href="/api/quizzes/${idEnc}/export.json?token=${tokenParam}" download title="Export as JSON">
                  📄 JSON
                </a>
              </div>
              <button type="button" class="icon-action-btn danger" data-action="delete" data-id="${escapeHtml(quiz.id)}" title="Delete quiz">
                🗑️
              </button>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderTemplates() {
    const query = ($('templatesSearch').value || '').trim().toLowerCase();
    const filter = state.templateFilter;
    const grid = $('templatesGrid');
    const empty = $('templatesEmpty');

    const items = state.publicQuizzes.filter((q) => {
      const isOfficial = Boolean(q.isTemplate || q.ownerId === 'system');
      if (filter === 'official' && !isOfficial) return false;
      if (filter === 'community' && isOfficial) return false;
      if (!query) return true;
      const hay = `${q.title || ''} ${q.description || ''} ${q.ownerName || ''}`.toLowerCase();
      return hay.includes(query);
    });

    $('templatesCountBadge').textContent = String(items.length);

    if (items.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    grid.style.display = 'grid';

    const tokenParam = encodeURIComponent(state.token);

    grid.innerHTML = items.map((quiz) => {
      const stats = summarizeQuestionTypes(quiz);
      const idEnc = encodeURIComponent(quiz.id);

      return `
        <article class="quiz-card" data-tpl-id="${escapeHtml(quiz.id)}">
          <div>
            <div class="quiz-card-head">
              <div class="quiz-emoji-tile">${escapeHtml(quiz.coverEmoji || '🌟')}</div>
              ${visibilityBadgeHtml(quiz, true)}
            </div>
            <h3 class="quiz-card-title">${escapeHtml(quiz.title || 'Starter Template')}</h3>
            <p class="quiz-card-desc">${escapeHtml(quiz.description || 'Ready-to-play live multiplayer quiz deck.')}</p>
            <div class="quiz-meta-strip">
              <span class="meta-chip">📝 ${stats.total} Questions</span>
              <span class="meta-chip">🎮 ${Number(quiz.playsCount) || 0} plays</span>
              ${stats.tfCount > 0 ? `<span class="meta-chip tf">${stats.tfCount} True/False</span>` : ''}
              ${stats.bossCount > 0 ? `<span class="meta-chip boss">🔥 ${stats.bossCount} Boss</span>` : ''}
              ${stats.pollCount > 0 ? `<span class="meta-chip poll">📊 ${stats.pollCount} Poll</span>` : ''}
            </div>
          </div>

          <div class="quiz-card-footer">
            <div class="quiz-primary-btns">
              <button type="button" class="btn btn-success btn-sm" data-action="host" data-id="${escapeHtml(quiz.id)}">
                ▶ Host Live Now
              </button>
              <button type="button" class="btn btn-primary btn-sm" data-action="clone-edit" data-id="${escapeHtml(quiz.id)}">
                📋 Clone &amp; Edit
              </button>
            </div>
            <div class="quiz-secondary-btns">
              <button type="button" class="icon-action-btn" data-action="preview" data-id="${escapeHtml(quiz.id)}">
                👁️ Preview Questions
              </button>
              <div style="display:flex;gap:5px;">
                <a class="icon-action-btn" href="/api/quizzes/${idEnc}/export.csv?token=${tokenParam}" download title="Download CSV">
                  📤 CSV
                </a>
                <a class="icon-action-btn" href="/api/quizzes/${idEnc}/export.json?token=${tokenParam}" download title="Download JSON">
                  📄 JSON
                </a>
              </div>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  function findKnownQuiz(quizId) {
    return (
      state.myQuizzes.find((q) => q.id === quizId) ||
      state.publicQuizzes.find((q) => q.id === quizId) ||
      null
    );
  }

  async function fetchFullQuiz(quizId) {
    const data = await apiFetch(`/api/quizzes/${encodeURIComponent(quizId)}`);
    return data.quiz || data;
  }

  async function duplicateQuiz(quizId, { openEditorAfter = false } = {}) {
    try {
      const data = await apiFetch(`/api/quizzes/${encodeURIComponent(quizId)}/clone`, {
        method: 'POST'
      });
      const cloned = data.quiz || data;
      await loadQuizzes();
      if (openEditorAfter && cloned && cloned.id) {
        loadQuizIntoEditor(cloned);
        switchStudioTab('editor');
        showToast(`📋 Cloned "${cloned.title}"! Customize any question and click Save.`);
      } else {
        showToast(`📋 Duplicated "${(cloned && cloned.title) || 'Quiz'}" into My Quizzes.`);
      }
    } catch (err) {
      showToast(err.message || 'Could not duplicate quiz.');
    }
  }

  function openDeleteModal(quiz) {
    state.deleteTargetQuiz = quiz;
    $('deleteQuizTitleText').textContent = `"${quiz.title || 'Untitled Quiz'}"`;
    openModal('deleteModal');
  }

  async function confirmDeleteQuiz() {
    if (!state.deleteTargetQuiz) return;
    const target = state.deleteTargetQuiz;
    const btn = $('confirmDeleteQuizBtn');
    btn.disabled = true;

    try {
      await apiFetch(`/api/quizzes/${encodeURIComponent(target.id)}`, {
        method: 'DELETE'
      });
      if (state.editor.quizId === target.id) {
        initBlankEditorDraft({ switchTab: false });
      }
      closeModal('deleteModal');
      state.deleteTargetQuiz = null;
      await loadQuizzes();
      showToast(`🗑️ Deleted "${target.title}".`);
    } catch (err) {
      showToast(err.message || 'Could not delete quiz.');
    } finally {
      btn.disabled = false;
    }
  }

  // ==================== LAUNCH LIVE GAME MODAL ====================

  function openLaunchModal(quiz) {
    if (!quiz || !quiz.id) return;
    state.launchTargetQuiz = quiz;
    const qCount = Array.isArray(quiz.questions) ? quiz.questions.length : (quiz.questionCount || 0);
    $('launchQuizEmoji').textContent = quiz.coverEmoji || '🚀';
    $('launchModalTitle').textContent = quiz.title || 'Host Live Game';
    $('launchQuizSubtitle').textContent = `${qCount} ${qCount === 1 ? 'question' : 'questions'} · Live QR + 6-digit PIN lobby`;
    openModal('launchModal');
  }

  function executeLaunchLiveRoom() {
    if (!state.launchTargetQuiz || !state.launchTargetQuiz.id) return;
    const maxPlayers = Number($('launchMaxPlayers').value) || 100;
    const overrideTime = Number($('launchTimerOverride').value) || 0;
    const shuffle = Boolean($('launchShuffleOptions').checked);

    const params = new URLSearchParams({
      hostQuiz: state.launchTargetQuiz.id,
      maxPlayers: String(maxPlayers),
      shuffle: String(shuffle),
      overrideTime: String(overrideTime)
    });

    window.location.href = `/?${params.toString()}`;
  }

  // ==================== TEMPLATE PREVIEW MODAL ====================

  async function openPreviewModal(quizSummary) {
    try {
      const quiz = Array.isArray(quizSummary.questions) && quizSummary.questions.length > 0
        ? quizSummary
        : await fetchFullQuiz(quizSummary.id);

      state.previewTargetQuiz = quiz;
      $('previewQuizEmoji').textContent = quiz.coverEmoji || '🌟';
      $('previewModalTitle').textContent = quiz.title || 'Quiz Preview';
      const qCount = Array.isArray(quiz.questions) ? quiz.questions.length : 0;
      const author = quiz.isTemplate || quiz.ownerId === 'system' ? 'QuizArena Official' : (quiz.ownerName || 'Community');
      $('previewModalMeta').textContent = `${qCount} questions · Created by ${author}`;
      $('previewQuizDesc').textContent = quiz.description || '';

      renderPreviewQuestions();
      openModal('previewModal');
    } catch (err) {
      showToast(err.message || 'Could not load template preview.');
    }
  }

  function renderPreviewQuestions() {
    const quiz = state.previewTargetQuiz;
    if (!quiz) return;
    const showAns = Boolean($('previewShowAnswers').checked);
    const qs = Array.isArray(quiz.questions) ? quiz.questions : [];

    $('previewQuestionsList').innerHTML = qs.map((q, idx) => {
      const mult = q.pointsMultiplier !== undefined ? Number(q.pointsMultiplier) : (q.doublePoints ? 2 : 1);
      const isPoll = mult === 0;
      const opts = Array.isArray(q.options) ? q.options : [];
      const modeBadge = mult === 2
        ? '<span class="sq-mini-badge boss">🔥 2× Boss</span>'
        : isPoll
          ? '<span class="sq-mini-badge poll">📊 Live Poll</span>'
          : '';

      const optsHtml = opts.map((optText, oIdx) => {
        const isRight = showAns && !isPoll && oIdx === q.correctIndex;
        return `
          <div class="preview-opt ${isRight ? 'correct' : ''}">
            <span>${SHAPES[oIdx] || '•'}</span>
            <span style="flex:1;">${escapeHtml(optText)}</span>
            ${isRight ? '<span>✓</span>' : ''}
          </div>
        `;
      }).join('');

      return `
        <div class="preview-q-card">
          <div class="preview-q-head">
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <span class="sq-mini-badge">Q${idx + 1}</span>
              ${q.category ? `<span class="sq-mini-badge">${escapeHtml(q.category)}</span>` : ''}
              ${modeBadge}
            </div>
            <span class="sq-mini-badge mono">${Number(q.timeLimit) || 20}s</span>
          </div>
          <div class="preview-q-title">${escapeHtml(q.question)}</div>
          <div class="preview-opts-grid">${optsHtml}</div>
          ${showAns && q.explanation ? `<div class="preview-explain">💡 ${escapeHtml(q.explanation)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // ==================== TAB 3: PAST GAME REPORTS ====================

  async function loadReports() {
    if (!state.token) return;
    try {
      const data = await apiFetch('/api/sessions');
      state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      updateNavCounts();
      renderReportsList();
    } catch (err) {
      showToast(err.message || 'Could not load session reports.');
    }
  }

  function accuracyClass(pct) {
    const n = Number(pct) || 0;
    if (n >= 70) return 'high';
    if (n >= 45) return 'mid';
    return 'low';
  }

  function renderReportsList() {
    if (state.activeReport) {
      $('reportsListSection').style.display = 'none';
      $('reportDetailView').style.display = 'block';
      return;
    }

    $('reportDetailView').style.display = 'none';
    $('reportsListSection').style.display = 'block';

    const sessions = state.sessions;
    if (!sessions.length) {
      $('reportsKpiStrip').style.display = 'none';
      $('reportsTableCard').style.display = 'none';
      $('reportsEmpty').style.display = 'block';
      return;
    }

    $('reportsEmpty').style.display = 'none';
    $('reportsKpiStrip').style.display = 'grid';
    $('reportsTableCard').style.display = 'block';

    const totalPlayers = sessions.reduce((sum, s) => sum + (Number(s.totalPlayers) || 0), 0);
    const avgAcc = Math.round(
      sessions.reduce((sum, s) => sum + (Number(s.avgAccuracy) || 0), 0) / sessions.length
    );

    $('kpiTotalSessions').textContent = String(sessions.length);
    $('kpiTotalPlayers').textContent = String(totalPlayers);
    $('kpiAvgAccuracy').textContent = `${avgAcc}%`;

    const tokenParam = encodeURIComponent(state.token);

    $('reportsTableBody').innerHTML = sessions.map((s) => {
      const acc = Number(s.avgAccuracy) || 0;
      const hardest = s.hardestQuestion
        ? (typeof s.hardestQuestion === 'string'
          ? s.hardestQuestion
          : `${s.hardestQuestion.question || 'Question'} (${s.hardestQuestion.accuracyPct ?? 0}%)`)
        : '—';
      const idEnc = encodeURIComponent(s.id);

      return `
        <tr class="clickable-row" data-session-id="${escapeHtml(s.id)}">
          <td style="white-space:nowrap;color:var(--text-muted);">${escapeHtml(formatDateTime(s.createdAt))}</td>
          <td style="font-weight:800;">${escapeHtml(s.title || 'Live Quiz Session')}</td>
          <td><span class="pin-mini">${escapeHtml(s.roomCode || '------')}</span></td>
          <td class="mono">👥 ${Number(s.totalPlayers) || 0}</td>
          <td><span class="acc-pill ${accuracyClass(acc)}">${acc}%</span></td>
          <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);" title="${escapeHtml(hardest)}">
            ${escapeHtml(hardest)}
          </td>
          <td style="text-align:right;white-space:nowrap;" data-stop-row="1">
            <button type="button" class="icon-action-btn" data-inspect-session="${escapeHtml(s.id)}">🔍 Inspect</button>
            <a class="icon-action-btn" href="/api/sessions/${idEnc}/export.csv?token=${tokenParam}" download>📥 CSV</a>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function inspectSessionReport(sessionId) {
    try {
      const data = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      const report = data.session || data;
      state.activeReport = report;
      renderReportDetail(report);
    } catch (err) {
      showToast(err.message || 'Could not load session report details.');
    }
  }

  function renderReportDetail(rep) {
    $('reportsListSection').style.display = 'none';
    $('reportDetailView').style.display = 'block';

    $('repDetailTitle').textContent = rep.title || 'Game Session Report';
    $('repDetailMeta').textContent = `Hosted ${formatDateTime(rep.createdAt)} · Room PIN ${rep.roomCode || '------'}`;

    $('repKpiPin').textContent = rep.roomCode || '------';
    $('repKpiPlayers').textContent = String(Number(rep.totalPlayers) || 0);
    $('repKpiAccuracy').textContent = `${Number(rep.avgAccuracy) || 0}%`;
    $('repKpiQuestions').textContent = String(
      Number(rep.totalQuestions) || (Array.isArray(rep.questionStats) ? rep.questionStats.length : 0)
    );

    const tokenParam = encodeURIComponent(state.token);
    $('repDetailCsvBtn').href = `/api/sessions/${encodeURIComponent(rep.id)}/export.csv?token=${tokenParam}`;

    const hostAgainBtn = $('repDetailHostAgainBtn');
    const linkedQuiz = rep.quizId ? findKnownQuiz(rep.quizId) : null;
    if (linkedQuiz) {
      hostAgainBtn.style.display = 'inline-flex';
      hostAgainBtn.onclick = () => openLaunchModal(linkedQuiz);
    } else {
      hostAgainBtn.style.display = 'none';
    }

    if (rep.hardestQuestion) {
      const h = rep.hardestQuestion;
      const label = typeof h === 'string'
        ? h
        : `Q${(Number(h.questionIndex) || 0) + 1}: "${h.question || ''}" — ${h.accuracyPct ?? 0}% accuracy (${h.correctPlayers ?? 0}/${h.totalAnswered ?? 0} correct)`;
      $('repHardestText').textContent = label;
      $('repHardestBanner').style.display = 'flex';
    } else {
      $('repHardestBanner').style.display = 'none';
    }

    const qStats = Array.isArray(rep.questionStats) ? rep.questionStats : [];
    const qBars = $('repQuestionBars');
    if (!qStats.length) {
      qBars.innerHTML = '<div style="color:var(--text-muted);font-size:13.5px;">No per-question stats recorded for this session.</div>';
    } else {
      qBars.innerHTML = qStats.map((qs, idx) => {
        const pct = Math.max(0, Math.min(100, Number(qs.accuracyPct) || 0));
        const cls = accuracyClass(pct);
        const qNum = (qs.questionIndex !== undefined ? Number(qs.questionIndex) : idx) + 1;
        return `
          <div class="q-acc-item">
            <div class="q-acc-top">
              <div class="q-acc-title">
                <span class="mono" style="color:var(--g-blue);margin-right:6px;">Q${qNum}</span>
                ${escapeHtml(qs.question || 'Question')}
              </div>
              <span class="acc-pill ${cls}">${pct}% (${Number(qs.correctPlayers) || 0}/${Number(qs.totalAnswered) || 0})</span>
            </div>
            <div class="q-acc-track">
              <div class="q-acc-fill ${cls}" style="width:${pct}%;"></div>
            </div>
          </div>
        `;
      }).join('');
    }

    const lb = Array.isArray(rep.leaderboard) ? rep.leaderboard : [];
    const lbBody = $('repLeaderboardBody');
    if (!lb.length) {
      lbBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No players recorded in leaderboard.</td></tr>';
    } else {
      lbBody.innerHTML = lb.map((p, idx) => {
        const rank = Number(p.rank) || idx + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
        const ans = Number(p.answeredCount) || 0;
        const corr = Number(p.correctCount) || 0;
        const pAcc = ans > 0 ? Math.round((corr / ans) * 100) : 0;
        const avgSec = p.avgResponseMs ? `${(Number(p.avgResponseMs) / 1000).toFixed(1)}s` : '—';

        return `
          <tr>
            <td class="mono" style="font-weight:800;">${medal}</td>
            <td>
              <span style="margin-right:6px;">${escapeHtml(p.avatar || '🚀')}</span>
              <strong>${escapeHtml(p.name || 'Player')}</strong>
              ${p.isBot ? '<span class="sq-mini-badge" style="margin-left:6px;">BOT</span>' : ''}
            </td>
            <td class="mono" style="font-weight:800;color:var(--g-blue);">${Number(p.score) || 0}</td>
            <td class="mono">${corr}/${ans} <span style="color:var(--text-muted);">(${pAcc}%)</span></td>
            <td class="mono">${Number(p.maxStreak) > 0 ? `🔥 ${Number(p.maxStreak)}` : '—'}</td>
            <td class="mono" style="color:var(--text-muted);">${avgSec}</td>
          </tr>
        `;
      }).join('');
    }
  }

  // ==================== TAB 4: VISUAL WYSIWYG QUIZ EDITOR ====================

  function initBlankEditorDraft({ switchTab = true } = {}) {
    state.editor = {
      quizId: null,
      title: '',
      description: '',
      coverEmoji: '🚀',
      visibility: 'private',
      questions: [createBlankQuestion('mcq')],
      activeIndex: 0,
      dirty: false,
      dragSourceIndex: null
    };
    updateDirtyStatus('New Draft');
    renderEditorAll();
    if (switchTab) {
      switchStudioTab('editor');
      setTimeout(() => $('editorQuizTitle').focus(), 40);
    }
  }

  async function openQuizByIdInEditor(quizId) {
    try {
      const fullQuiz = await fetchFullQuiz(quizId);
      loadQuizIntoEditor(fullQuiz);
      switchStudioTab('editor');
    } catch (err) {
      showToast(err.message || 'Could not open quiz in editor.');
    }
  }

  function loadQuizIntoEditor(quiz, { asUnsavedDraft = false } = {}) {
    const rawQs = Array.isArray(quiz.questions) && quiz.questions.length > 0
      ? quiz.questions
      : [createBlankQuestion('mcq')];

    state.editor = {
      quizId: asUnsavedDraft ? null : (quiz.id || null),
      title: String(quiz.title || ''),
      description: String(quiz.description || ''),
      coverEmoji: String(quiz.coverEmoji || '🚀'),
      visibility: ['private', 'unlisted', 'public'].includes(quiz.visibility) ? quiz.visibility : 'private',
      questions: rawQs.map((q, i) => normalizeClientQuestion(q, i)),
      activeIndex: 0,
      dirty: Boolean(asUnsavedDraft),
      dragSourceIndex: null
    };

    updateDirtyStatus(asUnsavedDraft ? 'Unsaved AI / Imported Draft' : 'All changes saved');
    renderEditorAll();
  }

  function markEditorDirty() {
    state.editor.dirty = true;
    updateDirtyStatus('Unsaved changes');
  }

  function updateDirtyStatus(customText) {
    const pill = $('editorStatusPill');
    const dot = $('navEditorDirtyDot');
    pill.classList.remove('unsaved', 'saved');

    if (state.editor.dirty) {
      pill.textContent = customText || 'Unsaved changes';
      pill.classList.add('unsaved');
      dot.style.display = 'inline-block';
    } else if (state.editor.quizId) {
      pill.textContent = customText || '✓ Saved';
      pill.classList.add('saved');
      dot.style.display = 'none';
    } else {
      pill.textContent = customText || 'New Draft';
      dot.style.display = 'none';
    }
  }

  function isQuestionComplete(q) {
    if (!q || !String(q.question || '').trim()) return false;
    const needed = q.type === 'tf' ? 2 : 4;
    if (!Array.isArray(q.options) || q.options.length < needed) return false;
    for (let i = 0; i < needed; i++) {
      if (!String(q.options[i] || '').trim()) return false;
    }
    return true;
  }

  function hasMeaningfulDraftContent() {
    if (state.editor.quizId) return true;
    if (state.editor.title.trim()) return true;
    if (state.editor.questions.length > 1) return true;
    const first = state.editor.questions[0];
    return Boolean(first && first.question.trim());
  }

  function renderEditorAll() {
    const ed = state.editor;
    if (!ed.questions.length) {
      ed.questions = [createBlankQuestion('mcq')];
    }
    if (ed.activeIndex < 0 || ed.activeIndex >= ed.questions.length) {
      ed.activeIndex = 0;
    }

    $('editorEmojiDisplay').textContent = ed.coverEmoji || '🚀';
    $('editorQuizTitle').value = ed.title;
    $('editorQuizDesc').value = ed.description;
    $('editorQuizVisibility').value = ed.visibility;

    renderEditorSidebar();
    renderActiveQuestionStage();
  }

  function renderEditorSidebar() {
    const ed = state.editor;
    $('editorQCount').textContent = String(ed.questions.length);

    const listEl = $('editorQuestionList');
    listEl.innerHTML = ed.questions.map((q, idx) => {
      const isActive = idx === ed.activeIndex;
      const mult = Number(q.pointsMultiplier);
      const typeLabel = q.type === 'tf' ? 'T/F' : 'MCQ';
      const promptPreview = q.question.trim() || 'Untitled question...';
      const complete = isQuestionComplete(q);

      const multBadge = mult === 2
        ? '<span class="sq-mini-badge boss">2× Boss</span>'
        : mult === 0
          ? '<span class="sq-mini-badge poll">Poll</span>'
          : '';

      return `
        <div
          class="sidebar-q-item ${isActive ? 'active' : ''}"
          draggable="true"
          data-q-index="${idx}"
        >
          <div class="sq-num">${idx + 1}</div>
          <div class="sq-body">
            <div class="sq-prompt">${escapeHtml(promptPreview)}</div>
            <div class="sq-badges">
              <span class="sq-mini-badge">${typeLabel}</span>
              <span class="sq-mini-badge mono">${Number(q.timeLimit) || 20}s</span>
              ${multBadge}
              ${!complete ? '<span class="sq-mini-badge warn" title="Missing prompt or answer text">Incomplete</span>' : ''}
            </div>
          </div>
          <div class="sq-mini-order" data-no-select="1">
            <button type="button" class="sq-arrow-btn" data-move-dir="-1" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} title="Move up">▲</button>
            <button type="button" class="sq-arrow-btn" data-move-dir="1" data-idx="${idx}" ${idx === ed.questions.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderActiveQuestionStage() {
    const ed = state.editor;
    const q = ed.questions[ed.activeIndex];
    if (!q) return;

    const isTf = q.type === 'tf';
    $('qTypeMcqBtn').classList.toggle('active', !isTf);
    $('qTypeTfBtn').classList.toggle('active', isTf);

    const timeSelect = $('qTimeLimitSelect');
    const timeStr = String(Number(q.timeLimit) || 20);
    if (!Array.from(timeSelect.options).some((o) => o.value === timeStr)) {
      const customOpt = document.createElement('option');
      customOpt.value = timeStr;
      customOpt.textContent = `${timeStr} sec`;
      timeSelect.appendChild(customOpt);
    }
    timeSelect.value = timeStr;

    const mult = [0, 1, 2].includes(Number(q.pointsMultiplier)) ? Number(q.pointsMultiplier) : 1;
    $('qPointsModeSelect').value = String(mult);
    $('qCategoryInput').value = q.category || '';

    updateStageHeaderPreview();

    $('qPromptInput').value = q.question || '';
    updatePromptCharCounter();

    $('qExplanationInput').value = q.explanation || '';
    updateExplainCharCounter();

    $('resetTfPresetBtn').style.display = isTf ? 'inline' : 'none';
    $('tilesInstructionText').innerHTML = mult === 0
      ? '📊 <strong>Live Poll Mode:</strong> Players vote freely on any option (0 points, all bars highlighted on reveal).'
      : 'Click the checkmark circle (<strong>✓</strong>) on an answer tile to mark it as the <strong>Correct Answer</strong>:';

    renderAnswerTiles(q);

    $('moveQUpBtn').disabled = ed.activeIndex === 0;
    $('moveQDownBtn').disabled = ed.activeIndex === ed.questions.length - 1;
  }

  function updateStageHeaderPreview() {
    const ed = state.editor;
    const q = ed.questions[ed.activeIndex];
    if (!q) return;
    const mult = Number(q.pointsMultiplier);

    $('stageQNumberPill').textContent = `Question ${ed.activeIndex + 1} of ${ed.questions.length}`;
    $('stageCategoryPill').textContent = (q.category || '').trim() || 'General';
    $('stageTimerPill').textContent = `${Number(q.timeLimit) || 20}s`;
    $('stageBossPill').style.display = mult === 2 ? 'inline-block' : 'none';
    $('stagePollPill').style.display = mult === 0 ? 'inline-block' : 'none';
  }

  function updatePromptCharCounter() {
    const len = ($('qPromptInput').value || '').length;
    const el = $('qPromptCharCount');
    el.textContent = `${len} / 280`;
    el.classList.toggle('near-limit', len > 220);
  }

  function updateExplainCharCounter() {
    const len = ($('qExplanationInput').value || '').length;
    $('qExplainCharCount').textContent = `${len} / 400`;
  }

  function renderAnswerTiles(q) {
    const grid = $('editorTilesGrid');
    const isTf = q.type === 'tf';
    const isPoll = Number(q.pointsMultiplier) === 0;
    const count = isTf ? 2 : 4;

    grid.classList.toggle('tf-mode', isTf);

    const html = [];
    for (let idx = 0; idx < count; idx++) {
      const val = q.options[idx] !== undefined ? q.options[idx] : '';
      const isRight = !isPoll && q.correctIndex === idx;
      const placeholder = isTf
        ? (idx === 0 ? 'True' : 'False')
        : `Add answer option ${idx + 1}${idx === q.correctIndex && !isPoll ? ' (Correct)' : ''}...`;

      const rightControl = isPoll
        ? '<span class="tile-poll-tag">Vote Tile</span>'
        : `<button
             type="button"
             class="tile-check-btn ${isRight ? 'selected' : ''}"
             data-correct-idx="${idx}"
             title="${isRight ? 'Marked as Correct Answer' : 'Click to mark as Correct Answer'}"
             aria-label="Mark option ${idx + 1} as correct"
             aria-pressed="${isRight}"
           >${isRight ? '✓' : ''}</button>`;

      html.push(`
        <div class="editor-tile tile-${idx} ${isRight ? 'is-correct' : ''}" data-tile-wrap="${idx}">
          <div class="tile-shape-badge">${SHAPES[idx]}</div>
          <div class="tile-input-wrap">
            <input
              type="text"
              class="tile-text-input"
              maxlength="110"
              data-opt-idx="${idx}"
              value="${escapeHtml(val)}"
              placeholder="${escapeHtml(placeholder)}"
              aria-label="Answer option ${idx + 1}"
            />
          </div>
          ${rightControl}
        </div>
      `);
    }
    grid.innerHTML = html.join('');
  }

  function setQuestionType(newType) {
    const q = state.editor.questions[state.editor.activeIndex];
    if (!q || q.type === newType) return;

    if (newType === 'tf') {
      q._mcqBackup = [...q.options];
      q.type = 'tf';
      q.options = Array.isArray(q._tfBackup) && q._tfBackup.length === 2
        ? [...q._tfBackup]
        : ['True', 'False'];
      if (q.correctIndex > 1) q.correctIndex = 0;
    } else {
      q._tfBackup = [...q.options];
      q.type = 'mcq';
      if (Array.isArray(q._mcqBackup) && q._mcqBackup.length === 4) {
        q.options = [...q._mcqBackup];
      } else {
        const isDefaultTf =
          String(q.options[0] || '').trim().toLowerCase() === 'true' &&
          String(q.options[1] || '').trim().toLowerCase() === 'false';
        q.options = isDefaultTf
          ? ['', '', '', '']
          : [q.options[0] || '', q.options[1] || '', '', ''];
      }
    }

    markEditorDirty();
    renderEditorSidebar();
    renderActiveQuestionStage();
  }

  function moveQuestion(fromIdx, toIdx) {
    const qs = state.editor.questions;
    if (toIdx < 0 || toIdx >= qs.length || fromIdx === toIdx) return;
    const [moved] = qs.splice(fromIdx, 1);
    qs.splice(toIdx, 0, moved);
    state.editor.activeIndex = toIdx;
    markEditorDirty();
    renderEditorSidebar();
    renderActiveQuestionStage();
  }

  function addQuestionToEditor(type = 'mcq') {
    const prev = state.editor.questions[state.editor.activeIndex];
    const nextQ = createBlankQuestion(type);
    if (prev && prev.category) {
      nextQ.category = prev.category;
    }
    state.editor.questions.push(nextQ);
    state.editor.activeIndex = state.editor.questions.length - 1;
    markEditorDirty();
    renderEditorSidebar();
    renderActiveQuestionStage();
    setTimeout(() => $('qPromptInput').focus(), 30);
  }

  function duplicateActiveQuestion() {
    const idx = state.editor.activeIndex;
    const orig = state.editor.questions[idx];
    if (!orig) return;
    const copy = normalizeClientQuestion({
      ...orig,
      id: `q_${Math.random().toString(36).slice(2, 9)}`,
      options: [...orig.options]
    }, idx + 1);
    state.editor.questions.splice(idx + 1, 0, copy);
    state.editor.activeIndex = idx + 1;
    markEditorDirty();
    renderEditorSidebar();
    renderActiveQuestionStage();
    showToast(`📋 Duplicated Question ${idx + 1}.`);
  }

  function deleteActiveQuestion() {
    const qs = state.editor.questions;
    if (qs.length <= 1) {
      qs[0] = createBlankQuestion('mcq');
      state.editor.activeIndex = 0;
      markEditorDirty();
      renderEditorSidebar();
      renderActiveQuestionStage();
      showToast('Cleared question (a quiz needs at least 1 question).');
      return;
    }
    const removedNum = state.editor.activeIndex + 1;
    qs.splice(state.editor.activeIndex, 1);
    if (state.editor.activeIndex >= qs.length) {
      state.editor.activeIndex = qs.length - 1;
    }
    markEditorDirty();
    renderEditorSidebar();
    renderActiveQuestionStage();
    showToast(`🗑️ Removed Question ${removedNum}.`);
  }

  function validateEditorDraft() {
    const ed = state.editor;
    if (!ed.questions.length) {
      showToast('Add at least 1 question before saving.');
      return false;
    }

    for (let i = 0; i < ed.questions.length; i++) {
      const q = ed.questions[i];
      if (!String(q.question || '').trim()) {
        ed.activeIndex = i;
        renderEditorAll();
        $('qPromptInput').focus();
        showToast(`Question ${i + 1} needs a question prompt.`);
        return false;
      }
      const needed = q.type === 'tf' ? 2 : 4;
      for (let o = 0; o < needed; o++) {
        if (!String(q.options[o] || '').trim()) {
          ed.activeIndex = i;
          renderEditorAll();
          const optInput = document.querySelector(`.tile-text-input[data-opt-idx="${o}"]`);
          if (optInput) optInput.focus();
          showToast(`Question ${i + 1}: Please fill in answer option ${o + 1}.`);
          return false;
        }
      }
    }
    return true;
  }

  async function saveCurrentQuiz({ andHost = false } = {}) {
    if (!validateEditorDraft()) return;

    const ed = state.editor;
    const finalTitle = ed.title.trim() || 'Untitled Quiz';
    ed.title = finalTitle;
    $('editorQuizTitle').value = finalTitle;

    const payload = {
      title: finalTitle,
      description: ed.description.trim(),
      coverEmoji: ed.coverEmoji || '🚀',
      visibility: ed.visibility || 'private',
      questions: ed.questions.map((q, idx) => {
        const isTf = q.type === 'tf';
        const options = (isTf ? q.options.slice(0, 2) : q.options.slice(0, 4)).map((o) => String(o || '').trim());
        const mult = [0, 1, 2].includes(Number(q.pointsMultiplier)) ? Number(q.pointsMultiplier) : 1;
        const correctIndex = Math.max(0, Math.min(options.length - 1, Number(q.correctIndex) || 0));
        return {
          id: q.id || `q_${idx + 1}`,
          type: isTf ? 'tf' : 'mcq',
          category: String(q.category || 'General').trim() || 'General',
          slideRef: String(q.slideRef || '').trim(),
          question: String(q.question || '').trim().slice(0, 280),
          options,
          correctIndex,
          timeLimit: Number(q.timeLimit) || 20,
          pointsMultiplier: mult,
          doublePoints: mult === 2,
          explanation: String(q.explanation || '').trim()
        };
      })
    };

    const saveBtn = $('saveQuizBtn');
    const hostBtn = $('saveAndHostBtn');
    saveBtn.disabled = true;
    hostBtn.disabled = true;

    try {
      const isUpdate = Boolean(ed.quizId);
      const url = isUpdate ? `/api/quizzes/${encodeURIComponent(ed.quizId)}` : '/api/quizzes';
      const method = isUpdate ? 'PUT' : 'POST';

      const data = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      const saved = data.quiz || data;
      ed.quizId = saved.id;
      ed.dirty = false;
      if (Array.isArray(saved.questions) && saved.questions.length > 0) {
        ed.questions = saved.questions.map((q, i) => normalizeClientQuestion(q, i));
      }

      updateDirtyStatus('✓ All changes saved');
      renderEditorSidebar();
      await loadQuizzes();

      if (andHost) {
        openLaunchModal(saved);
      } else {
        showToast(`💾 Saved "${saved.title}" (${ed.questions.length} questions)!`);
      }
    } catch (err) {
      showToast(err.message || 'Could not save quiz.');
    } finally {
      saveBtn.disabled = false;
      hostBtn.disabled = false;
    }
  }

  // ==================== MODAL 2: AI QUIZ GENERATOR ====================

  function openAiModal({ append = false } = {}) {
    state.aiAppendMode = Boolean(append && hasMeaningfulDraftContent());
    $('aiErrorBox').style.display = 'none';
    $('aiGeneratingBanner').style.display = 'none';
    $('confirmAiGenerateBtn').disabled = false;

    if (state.aiAppendMode) {
      $('aiModalTitle').textContent = '✨ Generate More Questions with AI';
      $('aiModalSubtitle').textContent = `New questions will be appended to "${state.editor.title || 'your current quiz'}".`;
      $('confirmAiGenerateBtn').textContent = '✨ Generate & Append Questions';
      if (!$('aiPromptInput').value.trim() && state.editor.title.trim()) {
        $('aiPromptInput').value = state.editor.title.trim();
      }
    } else {
      $('aiModalTitle').textContent = '✨ Generate Quiz with Gemini AI';
      $('aiModalSubtitle').textContent = 'Powered by Vertex AI Gemini 3.8 Flash — generates balanced options, boss rounds & debrief notes.';
      $('confirmAiGenerateBtn').textContent = '✨ Generate Draft in Editor';
    }

    openModal('aiModal');
    setTimeout(() => $('aiPromptInput').focus(), 40);
  }

  async function handleAiGenerateSubmit(e) {
    e.preventDefault();
    const prompt = $('aiPromptInput').value.trim();
    const sourceText = $('aiSourceText').value.trim();
    const questionCount = Number($('aiQuestionCount').value) || 10;
    const difficulty = $('aiDifficulty').value || 'medium';
    const includeTrueFalse = Boolean($('aiIncludeTf').checked);

    const errBox = $('aiErrorBox');
    errBox.style.display = 'none';

    if (!prompt && !sourceText) {
      errBox.textContent = 'Please enter a quiz topic or paste source notes/text first.';
      errBox.style.display = 'block';
      $('aiPromptInput').focus();
      return;
    }

    const submitBtn = $('confirmAiGenerateBtn');
    const cancelBtn = $('cancelAiModalBtn');
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    $('aiGeneratingBanner').style.display = 'block';

    try {
      const data = await apiFetch('/api/quizzes/generate', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          sourceText,
          questionCount,
          difficulty,
          includeTrueFalse
        })
      });

      const draft = data.draftQuiz || data.quiz || data;
      const newQuestions = (Array.isArray(draft.questions) ? draft.questions : []).map((q, i) =>
        normalizeClientQuestion(q, i)
      );

      if (!newQuestions.length) {
        throw new Error('AI returned 0 questions. Try a clearer topic or source snippet.');
      }

      closeModal('aiModal');

      if (state.aiAppendMode) {
        const startIdx = state.editor.questions.length;
        state.editor.questions.push(...newQuestions);
        state.editor.activeIndex = startIdx;
        markEditorDirty();
        switchStudioTab('editor');
        showToast(`✨ Added ${newQuestions.length} AI-generated questions! Review & save.`);
      } else {
        loadQuizIntoEditor(
          {
            id: null,
            title: draft.title || prompt.slice(0, 70) || 'AI Generated Quiz',
            description: draft.description || `AI-generated ${difficulty} quiz`,
            coverEmoji: draft.coverEmoji || '✨',
            visibility: 'private',
            questions: newQuestions
          },
          { asUnsavedDraft: true }
        );
        switchStudioTab('editor');
        showToast(`✨ Generated ${newQuestions.length} questions! Review and click Save Quiz.`);
      }
    } catch (err) {
      errBox.textContent = err.message || 'AI quiz generation failed. Please try again.';
      errBox.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      $('aiGeneratingBanner').style.display = 'none';
    }
  }

  // ==================== MODAL 3: MULTI-FORMAT IMPORT ====================

  function openImportModal({ append = false } = {}) {
    state.importAppendMode = Boolean(append && hasMeaningfulDraftContent());
    $('importErrorBox').style.display = 'none';
    $('importFileInput').value = '';
    $('importFileName').textContent = 'No file selected (or paste below)';
    openModal('importModal');
  }

  function handleImportFileChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    $('importFileName').textContent = `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`;
    const baseTitle = file.name.replace(/\.(csv|tsv|json|md|markdown|txt)$/i, '').replace(/[_-]+/g, ' ').trim();
    if (baseTitle && !$('importTitleInput').value.trim()) {
      $('importTitleInput').value = baseTitle;
    }

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'csv' || ext === 'tsv') $('importFormatSelect').value = 'csv';
    else if (ext === 'json') $('importFormatSelect').value = 'json';
    else if (ext === 'md' || ext === 'markdown') $('importFormatSelect').value = 'markdown';

    const reader = new FileReader();
    reader.onload = () => {
      $('importContentInput').value = String(reader.result || '');
    };
    reader.readAsText(file, 'UTF-8');
  }

  function insertSampleImportSnippet() {
    const fmt = $('importFormatSelect').value;
    if (fmt === 'json') {
      $('importContentInput').value = JSON.stringify(
        {
          title: 'Cloud & GenAI Quick Check',
          coverEmoji: '⚡',
          questions: [
            {
              question: 'Which HTTP status code signals rate-limiting on an API gateway?',
              options: ['200 OK', '401 Unauthorized', '429 Too Many Requests', '502 Bad Gateway'],
              correctIndex: 2,
              timeLimit: 20,
              pointsMultiplier: 1,
              category: 'APIs & SRE',
              explanation: 'HTTP 429 indicates the client sent too many requests in a given window.'
            },
            {
              question: 'True or False: WebSockets operate over a single persistent TCP connection.',
              options: ['True', 'False'],
              correctIndex: 0,
              timeLimit: 15,
              pointsMultiplier: 2,
              category: 'Networking',
              explanation: 'WebSockets upgrade an HTTP handshake into a full-duplex persistent TCP stream.'
            }
          ]
        },
        null,
        2
      );
    } else if (fmt === 'markdown') {
      $('importContentInput').value = [
        '## 1. Which Vertex AI feature grounds model answers in your enterprise data?',
        '- [ ] Temperature scaling',
        '- [x] Vertex AI Search & Grounding',
        '- [ ] Top-K sampling',
        '- [ ] Token padding',
        'Explanation: Grounding connects Gemini responses to verifiable enterprise or web sources.',
        '',
        '## 2. Cloud Run scales stateless containers down to zero when idle.',
        '- [x] True',
        '- [ ] False',
        'Explanation: Cloud Run bills only while requests are actively processed by default.'
      ].join('\n');
    } else {
      $('importContentInput').value = [
        'Question,OptionA,OptionB,OptionC,OptionD,Correct,TimeLimit,Multiplier,Category,Explanation',
        '"Which protocol powers QuizArena real-time multiplayer rooms?","FTP","WebSockets","SMTP","SNMP",B,20,1,"Architecture","WebSockets deliver sub-50ms bidirectional state sync."',
        '"True or False: 2x Boss Questions award double speed + streak points.","True","False",,,A,15,2,"Game Mechanics","Boss rounds multiply total earned points by 2x."'
      ].join('\n');
    }
    if (!$('importTitleInput').value.trim()) {
      $('importTitleInput').value = 'Sample Imported Quiz';
    }
  }

  async function handleImportSubmit(e) {
    e.preventDefault();
    const format = $('importFormatSelect').value || 'auto';
    const title = $('importTitleInput').value.trim() || 'Imported Quiz';
    const content = $('importContentInput').value.trim();
    const errBox = $('importErrorBox');
    errBox.style.display = 'none';

    if (!content) {
      errBox.textContent = 'Please upload a file or paste quiz content to import.';
      errBox.style.display = 'block';
      return;
    }

    const btn = $('confirmImportBtn');
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Parsing questions...';

    try {
      const data = await apiFetch('/api/quizzes/import', {
        method: 'POST',
        body: JSON.stringify({ format, content, title })
      });

      const draft = data.draftQuiz || data.quiz || data;
      const parsedQs = (Array.isArray(draft.questions) ? draft.questions : []).map((q, i) =>
        normalizeClientQuestion(q, i)
      );

      if (!parsedQs.length) {
        throw new Error('No valid questions found in imported content.');
      }

      closeModal('importModal');
      $('importContentInput').value = '';

      if (state.importAppendMode) {
        const startIdx = state.editor.questions.length;
        state.editor.questions.push(...parsedQs);
        state.editor.activeIndex = startIdx;
        markEditorDirty();
        switchStudioTab('editor');
        showToast(`📥 Imported ${parsedQs.length} questions into your quiz!`);
      } else {
        loadQuizIntoEditor(
          {
            id: null,
            title: draft.title || title,
            description: draft.description || '',
            coverEmoji: draft.coverEmoji || '📝',
            visibility: 'private',
            questions: parsedQs
          },
          { asUnsavedDraft: true }
        );
        switchStudioTab('editor');
        showToast(`📥 Parsed ${parsedQs.length} questions! Review and click Save Quiz.`);
      }
    } catch (err) {
      errBox.textContent = err.message || 'Could not parse imported content.';
      errBox.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  // ==================== MODAL HELPERS ====================

  function openModal(id) {
    const el = $(id);
    if (el) el.style.display = 'flex';
  }

  function closeModal(id) {
    const el = $(id);
    if (el) el.style.display = 'none';
  }

  function closeAllModals() {
    document.querySelectorAll('.modal-backdrop').forEach((m) => {
      m.style.display = 'none';
    });
  }

  // ==================== EVENT BINDING ====================

  function bindEvents() {
    // Brand & Topbar Navigation
    $('studioBrandBtn').addEventListener('click', () => {
      if (state.token && state.user) {
        switchStudioTab('quizzes');
      }
    });

    document.querySelectorAll('#studioNavTabs .studio-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        if (target === 'reports') state.activeReport = null;
        switchStudioTab(target);
      });
    });

    $('logoutBtn').addEventListener('click', handleLogout);

    // Auth Tabs & Forms
    $('authTabLogin').addEventListener('click', () => setAuthMode('login'));
    $('authTabRegister').addEventListener('click', () => setAuthMode('register'));
    $('loginForm').addEventListener('submit', handleLoginSubmit);
    $('registerForm').addEventListener('submit', handleRegisterSubmit);

    if ($('authorizeAccountForm')) {
      $('authorizeAccountForm').addEventListener('submit', handleAuthorizeSubmit);
    }
    if ($('changePasswordForm')) {
      $('changePasswordForm').addEventListener('submit', handleChangePasswordSubmit);
    }
    if ($('refreshAccessBtn')) {
      $('refreshAccessBtn').addEventListener('click', loadAccessList);
    }
    if ($('accessAccountsTableBody')) {
      $('accessAccountsTableBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-revoke-email]');
        if (btn) handleRevokeEmail(btn.dataset.revokeEmail);
      });
    }

    // Hero Quick-Action Cards & Empty State CTAs
    $('heroCreateBlankBtn').addEventListener('click', () => initBlankEditorDraft({ switchTab: true }));
    $('heroGenerateAiBtn').addEventListener('click', () => openAiModal({ append: false }));
    $('heroImportQuizBtn').addEventListener('click', () => openImportModal({ append: false }));

    $('emptyCreateBtn').addEventListener('click', () => initBlankEditorDraft({ switchTab: true }));
    $('emptyAiBtn').addEventListener('click', () => openAiModal({ append: false }));
    $('emptyBrowseTplBtn').addEventListener('click', () => switchStudioTab('templates'));

    // Search & Filters
    $('myQuizzesSearch').addEventListener('input', renderMyQuizzes);
    $('myQuizzesSort').addEventListener('change', renderMyQuizzes);
    $('templatesSearch').addEventListener('input', renderTemplates);

    $('templateFilterGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tpl-filter]');
      if (!btn) return;
      state.templateFilter = btn.dataset.tplFilter;
      document.querySelectorAll('#templateFilterGroup .filter-pill').forEach((p) => {
        p.classList.toggle('active', p === btn);
      });
      renderTemplates();
    });

    // Delegated Card Actions (My Quizzes & Templates)
    $('myQuizzesGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const quizId = btn.dataset.id;
      const quiz = findKnownQuiz(quizId);
      const action = btn.dataset.action;

      if (action === 'host' && quiz) openLaunchModal(quiz);
      else if (action === 'edit') openQuizByIdInEditor(quizId);
      else if (action === 'clone') duplicateQuiz(quizId, { openEditorAfter: false });
      else if (action === 'delete' && quiz) openDeleteModal(quiz);
    });

    $('templatesGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const quizId = btn.dataset.id;
      const quiz = findKnownQuiz(quizId);
      const action = btn.dataset.action;

      if (action === 'host' && quiz) openLaunchModal(quiz);
      else if (action === 'clone-edit') duplicateQuiz(quizId, { openEditorAfter: true });
      else if (action === 'preview' && quiz) openPreviewModal(quiz);
    });

    // Reports Events
    $('refreshReportsBtn').addEventListener('click', () => {
      state.activeReport = null;
      loadReports();
    });
    $('emptyReportsGoQuizzesBtn').addEventListener('click', () => switchStudioTab('quizzes'));
    $('emptyReportsGoTemplatesBtn').addEventListener('click', () => switchStudioTab('templates'));
    $('closeReportDetailBtn').addEventListener('click', () => {
      state.activeReport = null;
      renderReportsList();
    });

    $('reportsTableBody').addEventListener('click', (e) => {
      const inspectBtn = e.target.closest('[data-inspect-session]');
      if (inspectBtn) {
        inspectSessionReport(inspectBtn.dataset.inspectSession);
        return;
      }
      if (e.target.closest('[data-stop-row]')) return;
      const row = e.target.closest('tr[data-session-id]');
      if (row) inspectSessionReport(row.dataset.sessionId);
    });

    // Visual Quiz Editor Topbar & Metadata
    $('editorBackBtn').addEventListener('click', () => switchStudioTab('quizzes'));
    $('editorImportBtn').addEventListener('click', () => openImportModal({ append: true }));
    $('saveQuizBtn').addEventListener('click', () => saveCurrentQuiz({ andHost: false }));
    $('saveAndHostBtn').addEventListener('click', () => saveCurrentQuiz({ andHost: true }));

    $('emojiPickerBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('emojiPickerPopover');
      const isOpen = pop.style.display === 'grid';
      pop.style.display = isOpen ? 'none' : 'grid';
      $('emojiPickerBtn').setAttribute('aria-expanded', String(!isOpen));
    });

    $('emojiPickerPopover').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      const emoji = btn.dataset.emoji || DEFAULT_EMOJIS[0];
      state.editor.coverEmoji = emoji;
      $('editorEmojiDisplay').textContent = emoji;
      $('emojiPickerPopover').style.display = 'none';
      $('emojiPickerBtn').setAttribute('aria-expanded', 'false');
      markEditorDirty();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.emoji-picker-wrap')) {
        $('emojiPickerPopover').style.display = 'none';
        $('emojiPickerBtn').setAttribute('aria-expanded', 'false');
      }
    });

    $('editorQuizTitle').addEventListener('input', (e) => {
      state.editor.title = e.target.value;
      markEditorDirty();
    });

    $('editorQuizDesc').addEventListener('input', (e) => {
      state.editor.description = e.target.value;
      markEditorDirty();
    });

    $('editorQuizVisibility').addEventListener('change', (e) => {
      state.editor.visibility = e.target.value;
      markEditorDirty();
    });

    // Sidebar Question List (Click, Up/Down Buttons, Drag & Drop)
    $('editorQuestionList').addEventListener('click', (e) => {
      const moveBtn = e.target.closest('[data-move-dir]');
      if (moveBtn) {
        e.stopPropagation();
        const idx = Number(moveBtn.dataset.idx);
        const dir = Number(moveBtn.dataset.moveDir);
        moveQuestion(idx, idx + dir);
        return;
      }
      const item = e.target.closest('[data-q-index]');
      if (!item) return;
      state.editor.activeIndex = Number(item.dataset.qIndex);
      renderEditorSidebar();
      renderActiveQuestionStage();
    });

    $('editorQuestionList').addEventListener('dragstart', (e) => {
      const item = e.target.closest('[data-q-index]');
      if (!item) return;
      state.editor.dragSourceIndex = Number(item.dataset.qIndex);
      e.dataTransfer.effectAllowed = 'move';
    });

    $('editorQuestionList').addEventListener('dragover', (e) => {
      const item = e.target.closest('[data-q-index]');
      if (!item) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('#editorQuestionList .sidebar-q-item').forEach((el) => {
        el.classList.toggle('drag-over', el === item);
      });
    });

    $('editorQuestionList').addEventListener('dragleave', (e) => {
      const item = e.target.closest('[data-q-index]');
      if (item) item.classList.remove('drag-over');
    });

    $('editorQuestionList').addEventListener('drop', (e) => {
      e.preventDefault();
      document.querySelectorAll('#editorQuestionList .sidebar-q-item').forEach((el) => {
        el.classList.remove('drag-over');
      });
      const item = e.target.closest('[data-q-index]');
      if (!item || state.editor.dragSourceIndex === null) return;
      const targetIdx = Number(item.dataset.qIndex);
      const srcIdx = state.editor.dragSourceIndex;
      state.editor.dragSourceIndex = null;
      moveQuestion(srcIdx, targetIdx);
    });

    $('editorQuestionList').addEventListener('dragend', () => {
      state.editor.dragSourceIndex = null;
      document.querySelectorAll('#editorQuestionList .sidebar-q-item').forEach((el) => {
        el.classList.remove('drag-over');
      });
    });

    $('addMcqBtn').addEventListener('click', () => addQuestionToEditor('mcq'));
    $('addTfBtn').addEventListener('click', () => addQuestionToEditor('tf'));
    $('addAiMoreBtn').addEventListener('click', () => openAiModal({ append: true }));

    // Active Question Controls
    $('qTypeMcqBtn').addEventListener('click', () => setQuestionType('mcq'));
    $('qTypeTfBtn').addEventListener('click', () => setQuestionType('tf'));

    $('qTimeLimitSelect').addEventListener('change', (e) => {
      const q = state.editor.questions[state.editor.activeIndex];
      if (!q) return;
      q.timeLimit = Number(e.target.value) || 20;
      markEditorDirty();
      updateStageHeaderPreview();
      renderEditorSidebar();
    });

    $('qPointsModeSelect').addEventListener('change', (e) => {
      const q = state.editor.questions[state.editor.activeIndex];
      if (!q) return;
      const mult = Number(e.target.value);
      q.pointsMultiplier = [0, 1, 2].includes(mult) ? mult : 1;
      q.doublePoints = q.pointsMultiplier === 2;
      markEditorDirty();
      renderEditorSidebar();
      renderActiveQuestionStage();
    });

    $('qCategoryInput').addEventListener('input', (e) => {
      const q = state.editor.questions[state.editor.activeIndex];
      if (!q) return;
      q.category = e.target.value;
      markEditorDirty();
      updateStageHeaderPreview();
    });

    $('qPromptInput').addEventListener('input', (e) => {
      const q = state.editor.questions[state.editor.activeIndex];
      if (!q) return;
      q.question = e.target.value;
      updatePromptCharCounter();
      markEditorDirty();
      renderEditorSidebar();
    });

    $('resetTfPresetBtn').addEventListener('click', () => {
      const q = state.editor.questions[state.editor.activeIndex];
      if (!q || q.type !== 'tf') return;
      q.options = ['True', 'False'];
      markEditorDirty();
      renderAnswerTiles(q);
      renderEditorSidebar();
    });

    $('editorTilesGrid').addEventListener('input', (e) => {
      const input = e.target.closest('.tile-text-input');
      if (!input) return;
      const q = state.editor.questions[state.editor.activeIndex];
      if (!q) return;
      const optIdx = Number(input.dataset.optIdx);
      q.options[optIdx] = input.value;
      markEditorDirty();
      renderEditorSidebar();
    });

    $('editorTilesGrid').addEventListener('click', (e) => {
      const checkBtn = e.target.closest('[data-correct-idx]');
      if (!checkBtn) return;
      const q = state.editor.questions[state.editor.activeIndex];
      if (!q) return;
      q.correctIndex = Number(checkBtn.dataset.correctIdx);
      markEditorDirty();

      document.querySelectorAll('#editorTilesGrid [data-tile-wrap]').forEach((tile) => {
        const idx = Number(tile.dataset.tileWrap);
        const isRight = idx === q.correctIndex;
        tile.classList.toggle('is-correct', isRight);
        const btn = tile.querySelector('[data-correct-idx]');
        if (btn) {
          btn.classList.toggle('selected', isRight);
          btn.textContent = isRight ? '✓' : '';
          btn.setAttribute('aria-pressed', String(isRight));
        }
      });
    });

    $('qExplanationInput').addEventListener('input', (e) => {
      const q = state.editor.questions[state.editor.activeIndex];
      if (!q) return;
      q.explanation = e.target.value;
      updateExplainCharCounter();
      markEditorDirty();
    });

    $('moveQUpBtn').addEventListener('click', () => {
      moveQuestion(state.editor.activeIndex, state.editor.activeIndex - 1);
    });
    $('moveQDownBtn').addEventListener('click', () => {
      moveQuestion(state.editor.activeIndex, state.editor.activeIndex + 1);
    });
    $('duplicateQuestionBtn').addEventListener('click', duplicateActiveQuestion);
    $('deleteQuestionBtn').addEventListener('click', deleteActiveQuestion);

    // Modals: Close Buttons, Backdrop Click, ESC
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });

    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          backdrop.style.display = 'none';
        }
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();
    });

    // Launch Modal
    $('confirmLaunchLiveBtn').addEventListener('click', executeLaunchLiveRoom);

    // AI Generator Modal
    document.querySelectorAll('[data-ai-sample]').forEach((chip) => {
      chip.addEventListener('click', () => {
        $('aiPromptInput').value = chip.dataset.aiSample || '';
        $('aiPromptInput').focus();
      });
    });
    $('aiGenerateForm').addEventListener('submit', handleAiGenerateSubmit);

    // Import Modal
    $('importFileInput').addEventListener('change', handleImportFileChange);
    $('insertImportSampleBtn').addEventListener('click', insertSampleImportSnippet);
    $('importQuizForm').addEventListener('submit', handleImportSubmit);

    // Preview Modal
    $('previewShowAnswers').addEventListener('change', renderPreviewQuestions);
    $('previewCloneBtn').addEventListener('click', () => {
      if (!state.previewTargetQuiz) return;
      const id = state.previewTargetQuiz.id;
      closeModal('previewModal');
      duplicateQuiz(id, { openEditorAfter: true });
    });
    $('previewHostNowBtn').addEventListener('click', () => {
      if (!state.previewTargetQuiz) return;
      const quiz = state.previewTargetQuiz;
      closeModal('previewModal');
      openLaunchModal(quiz);
    });

    // Delete Modal
    $('confirmDeleteQuizBtn').addEventListener('click', confirmDeleteQuiz);

    // Hash Navigation Support (e.g. /studio#reports from Live Podium)
    window.addEventListener('hashchange', () => {
      if (!state.token || !state.user) return;
      const next = parseTabFromHash();
      if (next && next !== state.activeTab) {
        if (next === 'reports') state.activeReport = null;
        switchStudioTab(next, { updateHash: false });
      }
    });
  }

  // ==================== INITIALIZATION ====================

  async function boot() {
    bindEvents();

    if (!state.token) {
      showAuthScreen('');
      return;
    }

    $('studioBootLoader').style.display = 'flex';
    try {
      const me = await apiFetch('/api/auth/me');
      persistAuth(state.token, me.user);
      enterStudioWorkspace();
      const tasks = [loadQuizzes(), loadReports()];
      if (me.user.role === 'superadmin') tasks.push(loadAccessList());
      await Promise.all(tasks);
    } catch {
      persistAuth('', null);
      showAuthScreen('');
    }
  }

  boot();
})();
