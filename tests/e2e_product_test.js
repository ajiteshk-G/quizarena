#!/usr/bin/env node
'use strict';

/**
 * QuizArena — Full-Product End-to-End Verification Suite
 *
 * Covers:
 *  1. Public Landing (/), Creator Studio (/studio), Health, QR, & Static Assets (HTTP 200)
 *  2. Invite-Only Creator Auth: Guest Block (403), Unapproved Email Block (403), Super Admin Allowlist, Sign-Up, Sign-In, /me, & Logout
 *  3. Built-in Public Templates (APAC UC1/UC2/Full + General Tech) & Template Cloning
 *  4. Custom Quiz CRUD (4-option MCQ, 2-option True/False, 0x Poll, 2x Boss) + CSV/JSON Export + Delete
 *  5. Multi-Format Import (CSV, JSON, Markdown) + Live Vertex AI Generation (gemini-3.8-flash)
 *  6. 100-Player Concurrent WebSocket Game (Lobby -> MCQ -> TF -> Poll -> Boss Finale -> Direct Podium)
 *  7. Persisted Session Reports (/api/sessions, /api/sessions/:id, /api/sessions/:id/export.csv)
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = Number(process.env.E2E_PORT || 8091);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const STORE_FILE_PATH = process.env.STORE_FILE_PATH || '/tmp/quizarena-e2e-store.json';
const PROJECT_ROOT = path.resolve(__dirname, '..');

function logStep(step, msg) {
  console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);
}

function logPass(msg) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function cleanupTempStore() {
  for (const suffix of ['', '.tmp']) {
    try {
      if (fs.existsSync(STORE_FILE_PATH + suffix)) {
        fs.unlinkSync(STORE_FILE_PATH + suffix);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function httpReq(pathname, { method = 'GET', token = '', body = undefined, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (token) {
    reqHeaders['Authorization'] = `Bearer ${token}`;
  }
  let payload;
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: reqHeaders,
    body: payload
  });
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (contentType.includes('application/json')) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, text, json };
}

function createWsClient(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const queue = [];
    const waiters = [];

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i];
        if (w.predicate(msg)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(msg);
          return;
        }
      }
      queue.push(msg);
    });

    ws.waitFor = (typeOrPredicate, timeoutMs = 15000) => {
      const predicate =
        typeof typeOrPredicate === 'function'
          ? typeOrPredicate
          : (m) => m && m.type === typeOrPredicate;

      const idx = queue.findIndex(predicate);
      if (idx !== -1) {
        const [found] = queue.splice(idx, 1);
        return Promise.resolve(found);
      }

      return new Promise((resWait, rejWait) => {
        const timer = setTimeout(() => {
          const wIdx = waiters.findIndex((x) => x.timer === timer);
          if (wIdx !== -1) waiters.splice(wIdx, 1);
          rejWait(
            new Error(
              `[${label}] Timed out after ${timeoutMs}ms waiting for WS message (${
                typeof typeOrPredicate === 'string' ? typeOrPredicate : 'predicate'
              }). Buffered: ${queue.map((q) => q.type).join(',')}`
            )
          );
        }, timeoutMs);
        waiters.push({ predicate, resolve: resWait, timer });
      });
    };

    ws.sendJson = (obj) => {
      ws.send(JSON.stringify(obj));
    };

    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(new Error(`[${label}] WS error: ${err.message}`)));
  });
}

async function waitForServerReady(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server on ${BASE_URL} failed to become healthy within ${timeoutMs}ms`);
}

async function run() {
  cleanupTempStore();

  const E2E_SUPERADMIN_EMAIL = 'superadmin@quizarena.example.com';
  const E2E_SUPERADMIN_PASSWORD = 'e2e-superadmin-password';

  logStep('BOOT', `Starting QuizArena server on port ${PORT} with STORE_FILE_PATH=${STORE_FILE_PATH}`);
  const serverProc = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      STORE_FILE_PATH,
      GCS_BUCKET: '',
      SUPERADMIN_EMAIL: E2E_SUPERADMIN_EMAIL,
      ADMIN_PASSWORD: E2E_SUPERADMIN_PASSWORD,
      AUTHORIZED_EMAILS: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverLogs = '';
  serverProc.stdout.on('data', (d) => { serverLogs += d.toString(); });
  serverProc.stderr.on('data', (d) => { serverLogs += d.toString(); });

  const openSockets = [];

  try {
    await waitForServerReady();
    logPass(`Server listening at ${BASE_URL}`);

    // =========================================================================
    // 1. PUBLIC PAGES & STATIC ASSETS
    // =========================================================================
    logStep('1/6', 'Verifying Public Landing (/), Creator Studio (/studio), & Static Assets');
    const landing = await httpReq('/');
    assert.equal(landing.status, 200, 'GET / should return 200');
    assert.match(landing.text, /QuizArena/i, 'Landing HTML must feature QuizArena branding');
    assert.match(landing.text, /\/studio/, 'Landing HTML must link to /studio');

    const studioPage = await httpReq('/studio');
    assert.equal(studioPage.status, 200, 'GET /studio should return 200');
    assert.match(studioPage.text, /Creator Studio/i, '/studio HTML must include Creator Studio');

    const assetPaths = [
      '/styles.css',
      '/app.js',
      '/audio.js',
      '/studio.css',
      '/studio.js',
      '/assets/correct-party.gif',
      '/assets/streak-fire.gif',
      '/assets/oops-bounce.gif',
      '/api/qr?url=https%3A%2F%2Fexample.com',
      '/api/quizzes/template.csv',
      '/health'
    ];
    for (const asset of assetPaths) {
      const r = await httpReq(asset);
      assert.equal(r.status, 200, `Asset/endpoint ${asset} must return HTTP 200 (got ${r.status})`);
    }
    logPass(`Landing (/), Studio (/studio), and ${assetPaths.length} assets/endpoints returned HTTP 200`);

    // =========================================================================
    // 2. INVITE-ONLY CREATOR AUTHENTICATION & ACCESS CONTROL
    // =========================================================================
    logStep('2/6', 'Verifying Invite-Only Access Control, Guest Block, Super Admin Allowlist, & Auth Lifecycle');

    // 2a. Guest Creator must be disabled (403)
    const guestBlocked = await httpReq('/api/auth/guest', {
      method: 'POST',
      body: { name: 'Blocked Guest Host' }
    });
    assert.equal(guestBlocked.status, 403, 'Guest Creator endpoint must return 403');

    // 2b. Unapproved email registration must be blocked (403)
    const unapprovedReg = await httpReq('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Ada Lovelace',
        email: 'ada@quizarena.example.com',
        password: 'super-secret-password'
      }
    });
    assert.equal(unapprovedReg.status, 403, 'Unapproved email registration must return 403');

    // 2c. Super Admin login & approving creators via /api/admin/access
    const saLogin = await httpReq('/api/auth/login', {
      method: 'POST',
      body: { email: E2E_SUPERADMIN_EMAIL, password: E2E_SUPERADMIN_PASSWORD }
    });
    assert.equal(saLogin.status, 200, `Super Admin login failed: ${saLogin.text}`);
    assert.equal(saLogin.json?.user?.role, 'superadmin');
    const saToken = saLogin.json.token;

    const approveAda = await httpReq('/api/admin/access', {
      method: 'POST',
      token: saToken,
      body: { email: 'ada@quizarena.example.com', name: 'Ada Lovelace' }
    });
    assert.equal(approveAda.status, 200, `Approving Ada failed: ${approveAda.text}`);

    const approveGrace = await httpReq('/api/admin/access', {
      method: 'POST',
      token: saToken,
      body: { email: 'grace@quizarena.example.com', name: 'Grace Hopper' }
    });
    assert.equal(approveGrace.status, 200, `Approving Grace failed: ${approveGrace.text}`);

    // 2d. Approved creator registration, duplicate guard, login, /me, logout, & non-admin guard
    const regRes = await httpReq('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Ada Lovelace',
        email: 'ada@quizarena.example.com',
        password: 'super-secret-password'
      }
    });
    assert.equal(regRes.status, 200, `Register failed: ${regRes.text}`);
    assert.equal(regRes.json?.ok, true);
    assert.ok(regRes.json.token, 'Register must return session token');
    assert.equal(regRes.json.user.email, 'ada@quizarena.example.com');
    assert.equal(regRes.json.user.isGuest, false);

    // Verify non-superadmin cannot view /api/admin/access
    const nonAdminAccess = await httpReq('/api/admin/access', { token: regRes.json.token });
    assert.equal(nonAdminAccess.status, 403, 'Non-superadmin must receive 403 on /api/admin/access');

    // Logout initial session token and confirm invalidation
    const logoutRes = await httpReq('/api/auth/logout', {
      method: 'POST',
      token: regRes.json.token
    });
    assert.equal(logoutRes.status, 200);
    const meAfterLogout = await httpReq('/api/auth/me', { token: regRes.json.token });
    assert.equal(meAfterLogout.status, 401, 'Logged-out token must return 401');

    const dupReg = await httpReq('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Ada Duplicate',
        email: 'ADA@quizarena.example.com',
        password: 'super-secret-password'
      }
    });
    assert.equal(dupReg.status, 409, 'Duplicate email registration must return 409');

    const badLogin = await httpReq('/api/auth/login', {
      method: 'POST',
      body: { email: 'ada@quizarena.example.com', password: 'wrong-password' }
    });
    assert.equal(badLogin.status, 401, 'Invalid password must return 401');

    const loginRes = await httpReq('/api/auth/login', {
      method: 'POST',
      body: { email: 'ADA@quizarena.example.com', password: 'super-secret-password' }
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.json?.ok, true);
    const adaToken = loginRes.json.token;
    const adaUser = loginRes.json.user;

    const meRes = await httpReq('/api/auth/me', { token: adaToken });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.json?.user?.id, adaUser.id);

    // Second approved creator user for cross-user private-quiz ACL checks
    const otherReg = await httpReq('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Grace Hopper',
        email: 'grace@quizarena.example.com',
        password: 'grace-secret-password'
      }
    });
    assert.equal(otherReg.status, 200, `Second user register failed: ${otherReg.text}`);
    const otherToken = otherReg.json.token;
    logPass('Invite-only allowlist, Guest block (403), Super Admin approval, Sign-up/Sign-in, & Logout verified');

    // =========================================================================
    // 3. BUILT-IN PUBLIC TEMPLATES & CLONING
    // =========================================================================
    logStep('3/6', 'Verifying Built-in Public Templates & Template Cloning');
    const listRes = await httpReq('/api/quizzes', { token: adaToken });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json?.myQuizzes?.length, 0);
    const pubIds = new Set((listRes.json?.publicQuizzes || []).map((q) => q.id));
    for (const expectedId of ['tpl_apac_full', 'tpl_apac_uc1', 'tpl_apac_uc2', 'tpl_general_tech']) {
      assert.ok(pubIds.has(expectedId), `Missing expected built-in template ${expectedId}`);
    }

    const genTech = listRes.json.publicQuizzes.find((q) => q.id === 'tpl_general_tech');
    assert.equal(genTech.questions.length, 8);
    assert.ok(genTech.questions.some((q) => q.type === 'tf' && q.options.length === 2), 'tpl_general_tech must include True/False');
    assert.ok(genTech.questions.some((q) => q.pointsMultiplier === 2), 'tpl_general_tech must include 2x Boss');
    assert.ok(genTech.questions.some((q) => q.pointsMultiplier === 0), 'tpl_general_tech must include 0x Poll');

    const cloneRes = await httpReq('/api/quizzes/tpl_general_tech/clone', {
      method: 'POST',
      token: adaToken
    });
    assert.equal(cloneRes.status, 200, `Clone failed: ${cloneRes.text}`);
    const clonedQuiz = cloneRes.json.quiz;
    assert.equal(clonedQuiz.ownerId, adaUser.id);
    assert.equal(clonedQuiz.isTemplate, false);
    assert.equal(clonedQuiz.visibility, 'private');
    assert.match(clonedQuiz.title, /\(Copy\)$/);
    assert.equal(clonedQuiz.questions.length, 8);
    logPass(`4 built-in public templates verified and cloned (${clonedQuiz.id})`);

    // =========================================================================
    // 4. CUSTOM QUIZ CRUD, EXPORT CSV/JSON, ACCESS CONTROL & DELETE
    // =========================================================================
    logStep('4/6', 'Verifying Custom Quiz CRUD (MCQ + True/False + 0x Poll + 2x Boss), Export, & Delete');
    const createRes = await httpReq('/api/quizzes', {
      method: 'POST',
      token: adaToken,
      body: {
        title: 'QuizArena Launch Gauntlet',
        description: 'E2E custom quiz covering MCQ, True/False, Poll, and Boss Finale',
        coverEmoji: '🚀',
        visibility: 'private',
        questions: [
          {
            category: 'Architecture',
            question: 'Which protocol powers real-time bidirectional updates in QuizArena?',
            options: ['WebSockets (RFC 6455)', 'FTP Active Mode', 'SMTP Relay', 'POP3 Polling'],
            correctIndex: 0,
            timeLimit: 20,
            pointsMultiplier: 1,
            explanation: 'WebSockets maintain a single full-duplex connection for instant room broadcasts.'
          },
          {
            category: 'Serverless',
            question: 'True or False: Cloud Run session affinity helps route WebSocket clients to the same instance.',
            options: ['True', 'False'],
            correctIndex: 0,
            timeLimit: 15,
            pointsMultiplier: 1,
            explanation: 'Session affinity + single-instance concurrency keeps in-memory rooms unified.'
          },
          {
            category: 'Audience Pulse',
            question: 'LIVE POLL: Which quiz creation mode will your team try first?',
            options: ['AI Topic Generator', 'CSV Spreadsheet Import', 'Markdown Notes Paste', 'Visual Studio Editor'],
            correctIndex: 0,
            timeLimit: 15,
            pointsMultiplier: 0,
            explanation: 'Live Polls capture sentiment with zero point pressure!'
          },
          {
            category: 'Boss Finale',
            question: 'BOSS ROUND: Which Vertex AI model powers fast low-latency quiz generation in QuizArena?',
            options: ['gemini-3.8-flash', 'text-bison-001', 'word2vec-base', 'bert-tiny'],
            correctIndex: 0,
            timeLimit: 25,
            pointsMultiplier: 2,
            explanation: 'Gemini 3.8 Flash with LOW thinking generates structured quizzes in ~5 seconds.'
          }
        ]
      }
    });
    assert.equal(createRes.status, 200, `Create quiz failed: ${createRes.text}`);
    const customQuiz = createRes.json.quiz;
    assert.equal(customQuiz.questions.length, 4);
    assert.equal(customQuiz.questions[0].type, 'mcq');
    assert.equal(customQuiz.questions[1].type, 'tf');
    assert.equal(customQuiz.questions[2].pointsMultiplier, 0);
    assert.equal(customQuiz.questions[3].pointsMultiplier, 2);
    assert.equal(customQuiz.questions[3].doublePoints, true);

    // Update quiz via PUT
    const updatedQuestions = customQuiz.questions.map((q) => ({ ...q }));
    updatedQuestions[0].explanation = 'Updated debrief: WebSockets deliver sub-50ms room updates.';
    const putRes = await httpReq(`/api/quizzes/${customQuiz.id}`, {
      method: 'PUT',
      token: adaToken,
      body: {
        title: 'QuizArena Launch Gauntlet v2',
        questions: updatedQuestions
      }
    });
    assert.equal(putRes.status, 200, `PUT quiz failed: ${putRes.text}`);
    assert.equal(putRes.json.quiz.title, 'QuizArena Launch Gauntlet v2');

    // Privacy check against unauthenticated and other user (GET + export.csv + export.json)
    const unauthGet = await httpReq(`/api/quizzes/${customQuiz.id}`);
    assert.equal(unauthGet.status, 401, 'Unauthenticated GET on private quiz must return 401');
    const unauthExportCsv = await httpReq(`/api/quizzes/${customQuiz.id}/export.csv`);
    assert.equal(unauthExportCsv.status, 401, 'Unauthenticated export.csv on private quiz must return 401');
    const unauthExportJson = await httpReq(`/api/quizzes/${customQuiz.id}/export.json`);
    assert.equal(unauthExportJson.status, 401, 'Unauthenticated export.json on private quiz must return 401');
    const otherGet = await httpReq(`/api/quizzes/${customQuiz.id}`, { token: otherToken });
    assert.equal(otherGet.status, 403, 'Non-owner GET on private quiz must return 403');
    const otherExportCsv = await httpReq(`/api/quizzes/${customQuiz.id}/export.csv`, { token: otherToken });
    assert.equal(otherExportCsv.status, 403, 'Non-owner export.csv on private quiz must return 403');

    // Export CSV & JSON as owner (via ?token= query param just like Studio download links)
    const expCsv = await httpReq(`/api/quizzes/${customQuiz.id}/export.csv?token=${encodeURIComponent(adaToken)}`);
    assert.equal(expCsv.status, 200);
    assert.match(expCsv.text, /^Question,OptionA,OptionB,OptionC,OptionD,Correct,TimeLimit,Multiplier,Category,Explanation/);
    assert.match(expCsv.text, /gemini-3\.8-flash/);

    const expJson = await httpReq(`/api/quizzes/${customQuiz.id}/export.json?token=${encodeURIComponent(adaToken)}`);
    assert.equal(expJson.status, 200);
    assert.equal(JSON.parse(expJson.text).id, customQuiz.id);

    // Delete the cloned template quiz and confirm 404
    const delRes = await httpReq(`/api/quizzes/${clonedQuiz.id}`, {
      method: 'DELETE',
      token: adaToken
    });
    assert.equal(delRes.status, 200);
    const getDeleted = await httpReq(`/api/quizzes/${clonedQuiz.id}`, { token: adaToken });
    assert.equal(getDeleted.status, 404);
    logPass('Custom Quiz CRUD (POST, PUT, private ACL, CSV/JSON export, DELETE) verified');

    // =========================================================================
    // 5. MULTI-FORMAT IMPORT (CSV, JSON, MARKDOWN) + LIVE VERTEX AI GENERATION
    // =========================================================================
    logStep('5/6', 'Verifying CSV, JSON, & Markdown Import + Live Vertex AI (gemini-3.8-flash) Generation');

    // 5a. CSV Import (round-tripping exported CSV!)
    const csvImport = await httpReq('/api/quizzes/import', {
      method: 'POST',
      token: adaToken,
      body: { format: 'csv', title: 'CSV Imported Deck', content: expCsv.text }
    });
    assert.equal(csvImport.status, 200, `CSV import failed: ${csvImport.text}`);
    assert.equal(csvImport.json.draftQuiz.questions.length, 4);
    assert.equal(csvImport.json.draftQuiz.questions[1].type, 'tf');
    assert.equal(csvImport.json.draftQuiz.questions[2].pointsMultiplier, 0);
    assert.equal(csvImport.json.draftQuiz.questions[3].pointsMultiplier, 2);

    // 5b. JSON Import
    const jsonImport = await httpReq('/api/quizzes/import', {
      method: 'POST',
      token: adaToken,
      body: {
        format: 'json',
        content: JSON.stringify({
          title: 'JSON Imported Trivia',
          questions: [
            {
              question: 'What HTTP status indicates rate limiting?',
              options: ['200 OK', '429 Too Many Requests', '500 Internal Error', '301 Moved'],
              correctIndex: 1,
              timeLimit: 15
            },
            {
              question: 'DNS translates domain names to IP addresses.',
              options: ['True', 'False'],
              correct: 'True',
              timeLimit: 10
            }
          ]
        })
      }
    });
    assert.equal(jsonImport.status, 200, `JSON import failed: ${jsonImport.text}`);
    assert.equal(jsonImport.json.draftQuiz.questions.length, 2);
    assert.equal(jsonImport.json.draftQuiz.questions[1].type, 'tf');

    // 5c. Markdown Import
    const mdContent = [
      '# Cloud Security Quick Check',
      '',
      '## 1. Which header carries a Bearer token in REST APIs?',
      '- [x] Authorization',
      '- [ ] Content-Length',
      '- [ ] Cache-Control',
      '- [ ] Accept-Encoding',
      'Explanation: Authorization: Bearer <token> is the RFC 6750 standard.',
      '',
      '## 2. TLS encrypts HTTP traffic in transit.',
      '- [x] True',
      '- [ ] False',
      'Explanation: HTTPS layers HTTP over TLS encryption.'
    ].join('\n');

    const mdImport = await httpReq('/api/quizzes/import', {
      method: 'POST',
      token: adaToken,
      body: { format: 'markdown', content: mdContent }
    });
    assert.equal(mdImport.status, 200, `Markdown import failed: ${mdImport.text}`);
    assert.equal(mdImport.json.draftQuiz.questions.length, 2);
    assert.equal(mdImport.json.draftQuiz.questions[0].correctIndex, 0);
    assert.equal(mdImport.json.draftQuiz.questions[1].type, 'tf');
    logPass('CSV, JSON, and Markdown importers verified');

    // 5d. Live Vertex AI Quiz Generation (gemini-3.8-flash)
    const aiStart = Date.now();
    const aiGen = await httpReq('/api/quizzes/generate', {
      method: 'POST',
      token: adaToken,
      body: {
        prompt: 'Cloud Run serverless containers, WebSocket scaling, and Google Cloud Storage fundamentals',
        questionCount: 4,
        difficulty: 'medium',
        includeTrueFalse: true
      }
    });
    const aiElapsedMs = Date.now() - aiStart;
    assert.equal(aiGen.status, 200, `AI generation failed: ${aiGen.text}`);
    assert.equal(aiGen.json?.ok, true);
    const aiDraft = aiGen.json.draftQuiz;
    assert.ok(aiDraft.title && aiDraft.title.length > 3, 'AI draft must have a title');
    assert.equal(aiDraft.questions.length, 4, 'AI generation with questionCount=4 must return 4 questions');
    for (const q of aiDraft.questions) {
      assert.ok(['mcq', 'tf'].includes(q.type));
      assert.ok(q.options.length === 2 || q.options.length === 4);
      assert.ok(q.correctIndex >= 0 && q.correctIndex < q.options.length);
      assert.ok(q.question.length > 5 && q.question.length <= 280);
    }
    logPass(`Live Vertex AI gemini-3.8-flash generated "${aiDraft.title}" (4 Qs) in ${aiElapsedMs}ms`);

    // =========================================================================
    // 6. 100-PLAYER CONCURRENT WEBSOCKET GAME + SESSION REPORT PERSISTENCE
    // =========================================================================
    logStep('6/6', 'Running 100-Player Concurrent WebSocket Game (MCQ -> True/False -> Poll -> Boss -> Podium)');

    // Verify unauthorized WS host_create_room is rejected
    const unauthWs = await createWsClient('unauth-host');
    openSockets.push(unauthWs);
    unauthWs.sendJson({ type: 'host_create_room', quizId: customQuiz.id });
    const authErrMsg = await unauthWs.waitFor('auth_error');
    assert.match(authErrMsg.message, /sign in/i);
    unauthWs.close();

    // Connect authenticated Creator Host
    const hostWs = await createWsClient('host');
    openSockets.push(hostWs);
    hostWs.sendJson({
      type: 'host_create_room',
      authToken: adaToken,
      quizId: customQuiz.id,
      maxPlayers: 100,
      shuffleOptions: true
    });

    const roomCreated = await hostWs.waitFor('room_created');
    const roomCode = roomCreated.code;
    assert.match(roomCode, /^\d{6}$/, 'Room PIN must be 6 digits');
    assert.equal(roomCreated.quizId, customQuiz.id);
    assert.equal(roomCreated.questionCount, 4);
    assert.equal(roomCreated.title, 'QuizArena Launch Gauntlet v2');
    await hostWs.waitFor('lobby_update');

    // Verify playsCount incremented on the quiz
    const afterHostQuiz = await httpReq(`/api/quizzes/${customQuiz.id}`, { token: adaToken });
    assert.equal(afterHostQuiz.json.quiz.playsCount, 1, 'Hosting a quiz must increment playsCount');

    // Connect 100 concurrent WebSocket player clients!
    const PLAYER_COUNT = 100;
    const players = await Promise.all(
      Array.from({ length: PLAYER_COUNT }, async (_, idx) => {
        const ws = await createWsClient(`p${idx + 1}`);
        openSockets.push(ws);
        const name = `Player_${String(idx + 1).padStart(3, '0')}`;
        ws.sendJson({
          type: 'player_join',
          code: roomCode,
          name,
          avatar: idx % 2 === 0 ? '🚀' : '⚡'
        });
        const joined = await ws.waitFor('joined_room');
        assert.equal(joined.code, roomCode);
        return { idx, name: joined.name, playerId: joined.playerId, ws };
      })
    );

    // Wait for lobby_update showing all 100 players connected
    const fullLobby = await hostWs.waitFor(
      (m) => m.type === 'lobby_update' && m.playerCount === PLAYER_COUNT,
      10000
    );
    assert.equal(fullLobby.playerCount, 100);

    // Verify 101st player gets clean room-full join_error
    const extraWs = await createWsClient('p101');
    openSockets.push(extraWs);
    extraWs.sendJson({ type: 'player_join', code: roomCode, name: 'OverflowPlayer', avatar: '🦊' });
    const fullErr = await extraWs.waitFor('join_error');
    assert.match(fullErr.message, /full/i);
    extraWs.close();

    // Test live emoji reaction from Player 1 -> Host
    players[0].ws.sendJson({ type: 'player_reaction', emoji: '🔥' });
    const reactionMsg = await hostWs.waitFor('live_reaction');
    assert.equal(reactionMsg.emoji, '🔥');
    logPass(`Room ${roomCode} created & all 100 concurrent WebSocket players joined (+ 101st cap & live reaction verified)`);

    // Start the 4-round live game!
    hostWs.sendJson({ type: 'host_start_game' });

    // ---- ROUND 1: 4-Option MCQ (1x Standard) ----
    const gr1 = await hostWs.waitFor((m) => m.type === 'phase_get_ready' && m.questionIndex === 0);
    assert.equal(gr1.questionType, 'mcq');
    assert.equal(gr1.optionCount, 4);

    const q1Host = await hostWs.waitFor((m) => m.type === 'phase_question' && m.questionIndex === 0, 10000);
    assert.equal(q1Host.options.length, 4);
    assert.equal(q1Host.isPoll, false);
    assert.equal(q1Host.pointsMultiplier, 1);
    const q1RightIdx = q1Host.options.indexOf('WebSockets (RFC 6455)');
    assert.ok(q1RightIdx >= 0, 'Shuffled MCQ options must still contain the exact correct option');
    const q1WrongIdx = (q1RightIdx + 1) % 4;

    await Promise.all(
      players.map(async (p) => {
        await p.ws.waitFor((m) => m.type === 'phase_question' && m.questionIndex === 0, 10000);
        const choice = p.idx < 70 ? q1RightIdx : q1WrongIdx;
        p.ws.sendJson({ type: 'player_answer', optionIndex: choice });
        await p.ws.waitFor('answer_locked');
      })
    );

    const rev1Host = await hostWs.waitFor((m) => m.type === 'phase_reveal' && m.questionIndex === 0, 10000);
    assert.equal(rev1Host.totalAnswered, 100);
    assert.equal(rev1Host.correctPlayers, 70);
    assert.equal(rev1Host.accuracyPct, 70);
    assert.equal(rev1Host.isLastQuestion, false);

    const p0Rev1 = await players[0].ws.waitFor((m) => m.type === 'phase_reveal' && m.questionIndex === 0);
    assert.equal(p0Rev1.isCorrect, true);
    assert.ok(p0Rev1.pointsEarned >= 500 && p0Rev1.pointsEarned <= 1000);

    // Reveal -> Leaderboard -> Next Question
    hostWs.sendJson({ type: 'host_show_leaderboard' });
    const lb1Host = await hostWs.waitFor((m) => m.type === 'phase_leaderboard' && m.questionIndex === 0);
    assert.equal(lb1Host.totalPlayers, 100);
    assert.equal(lb1Host.leaderboard.length, 12);
    await players[0].ws.waitFor('phase_leaderboard');
    logPass('Round 1 (4-option MCQ, shuffled, 70/100 accuracy, Reveal -> Leaderboard) passed');

    // ---- ROUND 2: 2-Option True/False (1x Standard) ----
    hostWs.sendJson({ type: 'host_next_question' });
    const q2Host = await hostWs.waitFor((m) => m.type === 'phase_question' && m.questionIndex === 1, 10000);
    assert.equal(q2Host.questionType, 'tf');
    assert.deepEqual(q2Host.options, ['True', 'False'], 'True/False options must remain unshuffled as [True, False]');

    await Promise.all(
      players.map(async (p) => {
        await p.ws.waitFor((m) => m.type === 'phase_question' && m.questionIndex === 1, 10000);
        const choice = p.idx < 80 ? 0 : 1; // 0 = 'True' (correct)
        p.ws.sendJson({ type: 'player_answer', optionIndex: choice });
        await p.ws.waitFor('answer_locked');
      })
    );

    const rev2Host = await hostWs.waitFor((m) => m.type === 'phase_reveal' && m.questionIndex === 1, 10000);
    assert.equal(rev2Host.distribution.length, 2);
    assert.deepEqual(rev2Host.distribution, [80, 20]);
    assert.equal(rev2Host.correctPlayers, 80);
    assert.equal(rev2Host.accuracyPct, 80);

    hostWs.sendJson({ type: 'host_show_leaderboard' });
    await hostWs.waitFor((m) => m.type === 'phase_leaderboard' && m.questionIndex === 1);
    logPass('Round 2 (2-option True/False, unshuffled [True, False], 80/100 accuracy, Reveal -> Leaderboard) passed');

    // ---- ROUND 3: 0x Live Poll (No Points, Streaks Preserved) ----
    hostWs.sendJson({ type: 'host_next_question' });
    const q3Host = await hostWs.waitFor((m) => m.type === 'phase_question' && m.questionIndex === 2, 10000);
    assert.equal(q3Host.isPoll, true);
    assert.equal(q3Host.pointsMultiplier, 0);
    assert.equal(q3Host.options.length, 4);

    await Promise.all(
      players.map(async (p) => {
        await p.ws.waitFor((m) => m.type === 'phase_question' && m.questionIndex === 2, 10000);
        p.ws.sendJson({ type: 'player_answer', optionIndex: p.idx % 4 });
        await p.ws.waitFor('answer_locked');
      })
    );

    const rev3Host = await hostWs.waitFor((m) => m.type === 'phase_reveal' && m.questionIndex === 2, 10000);
    assert.equal(rev3Host.isPoll, true);
    assert.equal(rev3Host.totalAnswered, 100);
    assert.deepEqual(rev3Host.distribution, [25, 25, 25, 25]);

    const p0Rev3 = await players[0].ws.waitFor((m) => m.type === 'phase_reveal' && m.questionIndex === 2);
    assert.equal(p0Rev3.isPoll, true);
    assert.equal(p0Rev3.pointsEarned, 0, '0x Poll must award 0 points');
    assert.equal(p0Rev3.streak, 2, '0x Poll must preserve prior 2-answer streak');

    hostWs.sendJson({ type: 'host_show_leaderboard' });
    await hostWs.waitFor((m) => m.type === 'phase_leaderboard' && m.questionIndex === 2);
    logPass('Round 3 (0x Live Poll, 25/25/25/25 split, 0 pts & preserved streaks) passed');

    // ---- ROUND 4: 2x Boss Finale -> Reveal -> Direct Podium ----
    hostWs.sendJson({ type: 'host_next_question' });
    const q4Host = await hostWs.waitFor((m) => m.type === 'phase_question' && m.questionIndex === 3, 10000);
    assert.equal(q4Host.doublePoints, true);
    assert.equal(q4Host.pointsMultiplier, 2);
    const q4RightIdx = q4Host.options.indexOf('gemini-3.8-flash');
    assert.ok(q4RightIdx >= 0);
    const q4WrongIdx = (q4RightIdx + 1) % 4;

    await Promise.all(
      players.map(async (p) => {
        await p.ws.waitFor((m) => m.type === 'phase_question' && m.questionIndex === 3, 10000);
        const choice = p.idx < 60 ? q4RightIdx : q4WrongIdx;
        p.ws.sendJson({ type: 'player_answer', optionIndex: choice });
        await p.ws.waitFor('answer_locked');
      })
    );

    const rev4Host = await hostWs.waitFor((m) => m.type === 'phase_reveal' && m.questionIndex === 3, 10000);
    assert.equal(rev4Host.isLastQuestion, true);
    assert.equal(rev4Host.correctPlayers, 60);

    const p0Rev4 = await players[0].ws.waitFor((m) => m.type === 'phase_reveal' && m.questionIndex === 3);
    assert.equal(p0Rev4.isCorrect, true);
    assert.ok(p0Rev4.pointsEarned >= 1200, `2x Boss with streak=2 should earn >=1200 pts, got ${p0Rev4.pointsEarned}`);

    // Clicking "Reveal Final Podium" sends host_show_leaderboard on the final question -> MUST go directly to phase_podium!
    hostWs.sendJson({ type: 'host_show_leaderboard' });
    const podiumHost = await hostWs.waitFor('phase_podium', 10000);
    assert.equal(podiumHost.totalPlayers, 100);
    assert.equal(podiumHost.totalQuestions, 4);
    assert.equal(podiumHost.podium.length, 3);
    assert.ok(podiumHost.reportId, 'Host phase_podium must include persisted reportId');
    // Graded questions had accuracies 70%, 80%, 60% -> avgAccuracy should be 70% (poll excluded!)
    assert.equal(podiumHost.avgAccuracy, 70);
    assert.equal(podiumHost.hardestQuestion?.accuracyPct, 60);

    const p0Podium = await players[0].ws.waitFor('phase_podium', 10000);
    assert.equal(p0Podium.totalPlayers, 100);
    assert.ok(p0Podium.myScore > 2500);
    logPass(`Round 4 (2x Boss Finale -> Final Reveal -> Direct Podium, reportId=${podiumHost.reportId}) passed`);

    // Verify Room CSV Export + Saved Session Reports API
    const roomCsv = await httpReq(`/api/room/${roomCode}/export.csv?token=${encodeURIComponent(adaToken)}`);
    assert.equal(roomCsv.status, 200);
    assert.equal(roomCsv.text.trim().split('\n').length, 101, 'Room CSV must have header + 100 player rows');

    const sessionsRes = await httpReq('/api/sessions', { token: adaToken });
    assert.equal(sessionsRes.status, 200);
    assert.equal(sessionsRes.json.sessions.length, 1);
    const savedSummary = sessionsRes.json.sessions[0];
    assert.equal(savedSummary.id, podiumHost.reportId);
    assert.equal(savedSummary.totalPlayers, 100);
    assert.equal(savedSummary.roomCode, roomCode);

    const sessionDetail = await httpReq(`/api/sessions/${podiumHost.reportId}`, { token: adaToken });
    assert.equal(sessionDetail.status, 200);
    assert.equal(sessionDetail.json.session.leaderboard.length, 100);
    assert.equal(sessionDetail.json.session.questionStats.length, 4);

    const otherSessionCheck = await httpReq(`/api/sessions/${podiumHost.reportId}`, { token: otherToken });
    assert.equal(otherSessionCheck.status, 403, 'Non-host user must not read another creator session report');

    const sessionCsv = await httpReq(
      `/api/sessions/${podiumHost.reportId}/export.csv?token=${encodeURIComponent(adaToken)}`
    );
    assert.equal(sessionCsv.status, 200);
    const csvLines = sessionCsv.text.trim().split('\n');
    assert.equal(csvLines.length, 101, 'Session report CSV must have 1 header + 100 player rows');
    assert.match(csvLines[0], /^Rank,Name,Avatar,Score,Correct,Answered,AccuracyPct,MaxStreak,AvgResponseMs,IsBot$/);
    logPass('Saved Session Report (/api/sessions, detail, ACL, & 100-player CSV export) verified');

    console.log('\n\x1b[32m==================================================================\x1b[0m');
    console.log('\x1b[32m  ALL FULL-PRODUCT E2E TESTS PASSED (100 CONCURRENT PLAYERS)!\x1b[0m');
    console.log('\x1b[32m==================================================================\x1b[0m\n');
  } catch (err) {
    console.error('\n\x1b[31m[E2E FAILURE]\x1b[0m', err);
    if (serverLogs) {
      console.error('\n--- Server Logs ---\n' + serverLogs.slice(-3000));
    }
    process.exitCode = 1;
  } finally {
    for (const ws of openSockets) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch {
        // Ignore
      }
    }
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    cleanupTempStore();
  }
}

run();
