'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { QUESTIONS } = require('../questions');

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_TIMEOUT_MS = 1500;
const GCS_TIMEOUT_MS = 8000;
const SAVE_DEBOUNCE_MS = 500;
const MAX_REPORTS = 500;
const SCRYPT_KEYLEN = 64;

function hashInitialPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${derivedKey}`;
}

const GENERAL_TECH_QUESTIONS = [
  {
    id: 'gt-1',
    type: 'mcq',
    category: 'Live Pulse Poll',
    slideRef: '',
    question: 'ICEBREAKER POLL: How are you using Generative AI in your work right now?',
    options: [
      'Daily coding, writing & research copilot',
      'Shipping customer-facing AI features in production',
      'Prototyping & evaluating early use cases',
      'Just getting started — excited to explore!'
    ],
    correctIndex: 0,
    timeLimit: 20,
    pointsMultiplier: 0,
    doublePoints: false,
    explanation: 'Live Polls (0× points) capture instant audience sentiment before diving into scored rounds!'
  },
  {
    id: 'gt-2',
    type: 'mcq',
    category: 'Serverless Cloud',
    slideRef: '',
    question: 'What lets serverless container platforms like Cloud Run cut idle compute bills to $0?',
    options: [
      'Scaling instances down to zero when no requests arrive',
      'Compressing Docker images into ZIP archives at rest',
      'Running containers without a Linux kernel',
      'Skipping TLS encryption on internal traffic'
    ],
    correctIndex: 0,
    timeLimit: 20,
    pointsMultiplier: 1,
    doublePoints: false,
    explanation: 'Request-driven autoscaling spins instances up on demand and scales to zero when traffic stops.'
  },
  {
    id: 'gt-3',
    type: 'tf',
    category: 'LLM Determinism',
    slideRef: '',
    question: 'True or False: Setting an LLM temperature to 0 guarantees 100% identical outputs across every GPU batch.',
    options: ['True', 'False'],
    correctIndex: 1,
    timeLimit: 15,
    pointsMultiplier: 1,
    doublePoints: false,
    explanation: 'False! GPU floating-point non-associativity and dynamic batching can still cause tiny token-level differences at temperature 0.'
  },
  {
    id: 'gt-4',
    type: 'mcq',
    category: 'RAG Architecture',
    slideRef: '',
    question: 'When an AI assistant needs facts from internal docs that change every hour, what works best?',
    options: [
      'Retrieval-Augmented Generation (RAG) over a live search index',
      'Re-training foundation model weights from scratch hourly',
      'Increasing temperature to 1.5 so the model guesses updates',
      'Hardcoding every document inside the frontend bundle'
    ],
    correctIndex: 0,
    timeLimit: 20,
    pointsMultiplier: 1,
    doublePoints: false,
    explanation: 'RAG grounds responses in fresh retrieved documents with citations—without expensive or slow weight updates.'
  },
  {
    id: 'gt-5',
    type: 'tf',
    category: 'API Reliability',
    slideRef: '',
    question: 'True or False: HTTP 429 ("Too Many Requests") means the client hit a rate limit, not an internal server crash.',
    options: ['True', 'False'],
    correctIndex: 0,
    timeLimit: 15,
    pointsMultiplier: 1,
    doublePoints: false,
    explanation: 'True! HTTP 429 signals quota or rate-limit throttling—handle it with exponential backoff and jitter.'
  },
  {
    id: 'gt-6',
    type: 'mcq',
    category: 'Tokens & Context',
    slideRef: '',
    question: 'In modern English tokenization, roughly how much text equals 1,000 tokens?',
    options: [
      'About 750 words (~1.5 single-spaced pages)',
      'Exactly 1,000 complete sentences',
      'About 40,000 words (a short novel)',
      'Exactly 100 ASCII characters'
    ],
    correctIndex: 0,
    timeLimit: 20,
    pointsMultiplier: 1,
    doublePoints: false,
    explanation: 'A handy rule of thumb is 1 token ≈ 4 characters or ~0.75 English words (1,000 tokens ≈ 750 words).'
  },
  {
    id: 'gt-7',
    type: 'mcq',
    category: 'Real-Time Web',
    slideRef: '',
    question: 'Why do live multiplayer arenas use WebSockets instead of repeated HTTP polling?',
    options: [
      'A single persistent full-duplex connection pushes instant updates with minimal overhead',
      'WebSockets bypass TCP/IP and connect directly over Bluetooth',
      'Standard HTTP servers cannot serialize JSON payloads',
      'WebSockets automatically persist data into cloud storage'
    ],
    correctIndex: 0,
    timeLimit: 20,
    pointsMultiplier: 1,
    doublePoints: false,
    explanation: 'WebSockets keep one TCP connection open for low-latency bidirectional broadcasts to 100+ players at once.'
  },
  {
    id: 'gt-8',
    type: 'mcq',
    category: 'Production Resilience',
    slideRef: '',
    question: 'BOSS ROUND (2×): Which defense-in-depth combo best protects an API during a sudden 20× traffic spike?',
    options: [
      'Rate limiting, bounded autoscaling, caching, and graceful circuit breakers',
      'Disabling authentication checks to save CPU cycles',
      'Setting infinite request timeouts so slow calls never drop',
      'Moving secret API keys into client-side localStorage'
    ],
    correctIndex: 0,
    timeLimit: 25,
    pointsMultiplier: 2,
    doublePoints: true,
    explanation: 'Caching absorbs read load, rate limits shed excess bursts cleanly, and circuit breakers prevent cascading downstream failures.'
  }
];

function deepClone(val) {
  if (val === null || val === undefined) return val;
  return JSON.parse(JSON.stringify(val));
}

function toEpochMs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeVisibility(val, fallback = 'private') {
  const v = String(val || '').trim().toLowerCase();
  if (v === 'public' || v === 'unlisted' || v === 'private') return v;
  return fallback;
}

function normalizeQuestion(raw, idx = 0) {
  const q = raw && typeof raw === 'object' ? raw : {};
  let rawOptions = Array.isArray(q.options)
    ? q.options.map((o) => String(o ?? '').trim()).filter((_, i, arr) => arr.length <= 4 || i < 4)
    : [];

  // Preserve True/False when type === 'tf' or 2 options supplied
  let options;
  let correctIndex = Number.isInteger(Number(q.correctIndex)) ? Number(q.correctIndex) : 0;

  if (rawOptions.length === 2 || (q.type === 'tf' && rawOptions.length === 0)) {
    options = rawOptions.length === 2
      ? [rawOptions[0] || 'True', rawOptions[1] || 'False']
      : ['True', 'False'];
  } else {
    const fullList = Array.isArray(q.options) ? q.options.map((o) => String(o ?? '').trim()) : [];
    if (fullList.length > 4) {
      if (correctIndex >= 4 && correctIndex < fullList.length) {
        const correctOpt = fullList[correctIndex];
        options = [fullList[0], fullList[1], fullList[2], correctOpt];
        correctIndex = 3;
      } else {
        options = fullList.slice(0, 4);
      }
    } else if (fullList.length === 4) {
      options = fullList;
    } else {
      const defaults = ['Option A', 'Option B', 'Option C', 'Option D'];
      options = defaults.map((fallbackOpt, i) => fullList[i] || fallbackOpt);
    }
  }

  const type = options.length === 2 ? 'tf' : 'mcq';
  if (correctIndex < 0 || correctIndex >= options.length || !Number.isFinite(correctIndex)) {
    correctIndex = 0;
  }

  const rawTime = Number(q.timeLimit);
  const timeLimit = Number.isFinite(rawTime) && rawTime > 0
    ? Math.max(5, Math.min(120, Math.round(rawTime)))
    : 20;

  let pointsMultiplier;
  if (
    q.pointsMultiplier !== undefined &&
    q.pointsMultiplier !== null &&
    q.pointsMultiplier !== '' &&
    [0, 1, 2].includes(Number(q.pointsMultiplier))
  ) {
    pointsMultiplier = Number(q.pointsMultiplier);
  } else {
    pointsMultiplier = q.doublePoints ? 2 : 1;
  }

  const doublePoints = pointsMultiplier === 2;

  return {
    id: String(q.id || `q_${idx + 1}_${crypto.randomBytes(3).toString('hex')}`).trim(),
    type,
    category: String(q.category || 'General').trim().slice(0, 80) || 'General',
    slideRef: String(q.slideRef || '').trim().slice(0, 120),
    question: String(q.question || '').trim().slice(0, 280),
    options,
    correctIndex,
    timeLimit,
    pointsMultiplier,
    doublePoints,
    explanation: String(q.explanation || '').trim().slice(0, 500)
  };
}

function buildInterleavedApacQuestions() {
  const uc1 = QUESTIONS.filter((q) => q.deck === 'UC1');
  const uc2 = QUESTIONS.filter((q) => q.deck === 'UC2');
  const interleaved = [];
  const maxLen = Math.max(uc1.length, uc2.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < uc1.length) interleaved.push(uc1[i]);
    if (i < uc2.length) interleaved.push(uc2[i]);
  }
  return interleaved;
}

function buildSystemTemplates(baseMs) {
  const uc1 = QUESTIONS.filter((q) => q.deck === 'UC1');
  const uc2 = QUESTIONS.filter((q) => q.deck === 'UC2');
  const full = buildInterleavedApacQuestions();

  const specs = [
    {
      id: 'tpl_general_tech',
      title: 'Cloud, AI & Tech Fundamentals (Quick 8)',
      description:
        'Fast-paced 8-question icebreaker showcasing 4-choice MCQs, True/False rounds, a 0× Live Pulse Poll, and a 2× Boss finale.',
      coverEmoji: '🌎',
      questions: GENERAL_TECH_QUESTIONS,
      offsetMs: 0
    },
    {
      id: 'tpl_apac_uc2',
      title: 'APAC AI Expert — UC2 Production Agents',
      description:
        '15 practical questions on Agent harnesses, Zero Trust blast radius, indirect prompt injection, ADK Plugins, HITL, and observability.',
      coverEmoji: '🤖',
      questions: uc2,
      offsetMs: 1
    },
    {
      id: 'tpl_apac_uc1',
      title: 'APAC AI Expert — UC1 GenAI & FinOps',
      description:
        '15 practical questions on Batch vs. Live serving, Provisioned Throughput, FP8 quantization, Context Caching, model cascades, and AI FinOps.',
      coverEmoji: '🛍️',
      questions: uc1,
      offsetMs: 2
    },
    {
      id: 'tpl_apac_full',
      title: 'APAC AI Expert — Full Gauntlet (UC1 + UC2)',
      description:
        'Complete 30-question interleaved workshop gauntlet covering GenAI Architecture, FinOps, Production Agent Security, ADK, and Observability.',
      coverEmoji: '⚡',
      questions: full,
      offsetMs: 3
    }
  ];

  return specs.map((spec) => {
    const ts = new Date(baseMs + spec.offsetMs).toISOString();
    const normalizedQs = spec.questions.map((q, idx) => normalizeQuestion(q, idx));
    return {
      id: spec.id,
      title: spec.title,
      description: spec.description,
      coverEmoji: spec.coverEmoji,
      ownerId: 'system',
      ownerName: 'QuizArena Official',
      visibility: 'public',
      isTemplate: true,
      playsCount: 0,
      questionCount: normalizedQs.length,
      questions: normalizedQs,
      createdAt: ts,
      updatedAt: ts
    };
  });
}

function httpGetBuffer(urlString, headers = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      parsed,
      { method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`GET timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPostJson(urlString, bodyString, headers = {}, timeoutMs = GCS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const payloadBuf = Buffer.from(bodyString, 'utf8');
    const req = https.request(
      parsed,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payloadBuf.length,
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`POST timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payloadBuf);
    req.end();
  });
}

function createStore(options = {}) {
  const dataFilePath = options.dataFilePath || path.join(__dirname, '..', 'data', 'store.json');
  const gcsBucket =
    options.gcsBucket !== undefined
      ? String(options.gcsBucket || '').trim()
      : String(process.env.GCS_BUCKET || '').trim();

  const superAdminEmail = String(
    options.superAdminEmail || process.env.SUPERADMIN_EMAIL || 'admin@example.com'
  )
    .trim()
    .toLowerCase();
  const defaultAdminPassword = String(
    options.defaultAdminPassword || process.env.ADMIN_PASSWORD || 'change-me-in-env'
  );
  const envAuthorizedList = String(options.authorizedEmails || process.env.AUTHORIZED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  let state = {
    users: [],
    authorizedEmails: [],
    sessions: {},
    quizzes: [],
    reports: []
  };

  let initialized = false;
  let initPromise = null;
  let lastTsMs = 0;
  let writeSeq = 0;
  let debounceTimer = null;
  let saveChain = Promise.resolve();

  // Cached GCE metadata ADC token state
  let cachedToken = null;
  let cachedTokenExpiresAt = 0;
  let metadataUnavailableUntil = 0;

  function nextIsoTimestamp() {
    const now = Math.max(Date.now(), lastTsMs + 1);
    lastTsMs = now;
    return new Date(now).toISOString();
  }

  async function getMetadataToken() {
    if (!gcsBucket) return null;
    const now = Date.now();
    if (cachedToken && now < cachedTokenExpiresAt) {
      return cachedToken;
    }
    if (now < metadataUnavailableUntil) {
      return null;
    }
    try {
      const res = await httpGetBuffer(
        METADATA_TOKEN_URL,
        { 'Metadata-Flavor': 'Google' },
        METADATA_TIMEOUT_MS
      );
      if (res.statusCode !== 200) {
        metadataUnavailableUntil = Date.now() + 30_000;
        return null;
      }
      const parsed = JSON.parse(res.body);
      if (!parsed || !parsed.access_token) {
        metadataUnavailableUntil = Date.now() + 30_000;
        return null;
      }
      const ttlSec = Math.max(60, Number(parsed.expires_in) || 3600);
      cachedToken = String(parsed.access_token);
      cachedTokenExpiresAt = Date.now() + (ttlSec - 60) * 1000;
      return cachedToken;
    } catch {
      // Not running on GCE / Cloud Run — cache negative lookup briefly so local saves stay instant
      metadataUnavailableUntil = Date.now() + 60_000;
      return null;
    }
  }

  async function writeLocalAtomic(serialized) {
    const dir = path.dirname(dataFilePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${dataFilePath}.${process.pid}.${++writeSeq}.tmp`;
    await fs.writeFile(tmpPath, serialized, 'utf8');
    await fs.rename(tmpPath, dataFilePath);
  }

  async function uploadToGcsBackground(serialized) {
    if (!gcsBucket) return;
    try {
      const token = await getMetadataToken();
      if (!token) return;
      const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(
        gcsBucket
      )}/o?uploadType=media&name=store.json`;
      const res = await httpsPostJson(uploadUrl, serialized, {
        Authorization: `Bearer ${token}`
      });
      if (res.statusCode >= 400 && process.env.DEBUG_STORE) {
        console.warn(`[store] GCS background upload HTTP ${res.statusCode}`);
      }
    } catch (err) {
      if (process.env.DEBUG_STORE) {
        console.warn('[store] GCS background upload skipped:', err.message);
      }
    }
  }

  function enqueuePersist({ syncGcsInBackground = true } = {}) {
    const snapshot = JSON.stringify(state, null, 2);
    saveChain = saveChain
      .catch(() => {})
      .then(async () => {
        await writeLocalAtomic(snapshot);
        if (syncGcsInBackground && gcsBucket) {
          uploadToGcsBackground(snapshot).catch(() => {});
        }
      })
      .catch((err) => {
        if (process.env.DEBUG_STORE) {
          console.warn('[store] Local persist warning:', err.message);
        }
      });
    return saveChain;
  }

  function scheduleSave() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      enqueuePersist();
    }, SAVE_DEBOUNCE_MS);
  }

  async function flush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      await enqueuePersist();
    } else {
      await saveChain;
    }
  }

  function hydrateLoadedData(raw) {
    if (!raw || typeof raw !== 'object') return;
    const now = Date.now();

    if (Array.isArray(raw.users)) {
      state.users = raw.users
        .filter((u) => u && u.id && !u.isGuest && u.email)
        .map((u) => ({
          id: String(u.id),
          email: String(u.email).trim().toLowerCase(),
          name: String(u.name || 'Creator').trim(),
          role: u.role === 'superadmin' ? 'superadmin' : 'creator',
          passwordHash: u.passwordHash || null,
          isGuest: false,
          createdAt: u.createdAt || new Date(now).toISOString()
        }));
    }

    if (Array.isArray(raw.authorizedEmails)) {
      const seen = new Set();
      state.authorizedEmails = [];
      for (const entry of raw.authorizedEmails) {
        const email = typeof entry === 'string'
          ? entry.trim().toLowerCase()
          : String((entry && entry.email) || '').trim().toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        state.authorizedEmails.push({
          email,
          name: String((entry && entry.name) || email.split('@')[0]).trim().slice(0, 80),
          role: entry && entry.role === 'superadmin' ? 'superadmin' : 'creator',
          addedBy: String((entry && entry.addedBy) || 'system'),
          createdAt: (entry && entry.createdAt) || new Date(now).toISOString()
        });
      }
    }

    if (raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) {
      const nextSessions = {};
      for (const [tok, sess] of Object.entries(raw.sessions)) {
        if (!sess || !sess.userId) continue;
        const exp = toEpochMs(sess.expiresAt);
        if (exp > 0 && exp <= now) continue;
        nextSessions[tok] = {
          userId: String(sess.userId),
          expiresAt: exp,
          createdAt: toEpochMs(sess.createdAt) || now
        };
      }
      state.sessions = nextSessions;
    }

    if (Array.isArray(raw.quizzes)) {
      state.quizzes = raw.quizzes
        .filter((q) => q && q.id)
        .map((q) => {
          const normalizedQs = Array.isArray(q.questions)
            ? q.questions.map((item, idx) => normalizeQuestion(item, idx))
            : [];
          const createdAt = q.createdAt || new Date(now).toISOString();
          const updatedAt = q.updatedAt || createdAt;
          const maxLoadedMs = Math.max(toEpochMs(createdAt), toEpochMs(updatedAt));
          if (maxLoadedMs > lastTsMs) lastTsMs = maxLoadedMs;
          return {
            id: String(q.id),
            title: String(q.title || 'Untitled Quiz').trim(),
            description: String(q.description || '').trim(),
            coverEmoji: String(q.coverEmoji || '🎯').trim() || '🎯',
            ownerId: String(q.ownerId || 'system'),
            ownerName: String(q.ownerName || 'Creator').trim(),
            visibility: normalizeVisibility(q.visibility, q.isTemplate ? 'public' : 'private'),
            isTemplate: Boolean(q.isTemplate),
            playsCount: Math.max(0, Number(q.playsCount) || 0),
            questionCount: normalizedQs.length,
            questions: normalizedQs,
            createdAt,
            updatedAt
          };
        });
    }

    if (Array.isArray(raw.reports)) {
      state.reports = raw.reports
        .filter((r) => r && r.id)
        .sort((a, b) => toEpochMs(b.createdAt) - toEpochMs(a.createdAt))
        .slice(0, MAX_REPORTS);
      for (const r of state.reports) {
        const ms = toEpochMs(r.createdAt);
        if (ms > lastTsMs) lastTsMs = ms;
      }
    }
  }

  async function loadInitialPayload() {
    // 1. Try GCS object first when gcsBucket is configured and GCE metadata token is available
    if (gcsBucket) {
      const token = await getMetadataToken();
      if (token) {
        try {
          const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
            gcsBucket
          )}/o/${encodeURIComponent('store.json')}?alt=media`;
          const res = await httpGetBuffer(
            gcsUrl,
            { Authorization: `Bearer ${token}` },
            GCS_TIMEOUT_MS
          );
          if (res.statusCode === 200 && res.body) {
            return { data: JSON.parse(res.body), source: 'gcs' };
          }
        } catch {
          // Silent fallback to local file
        }
      }
    }

    // 2. Fallback to local file
    try {
      const content = await fs.readFile(dataFilePath, 'utf8');
      if (content && content.trim()) {
        return { data: JSON.parse(content), source: 'local' };
      }
    } catch {
      // File doesn't exist yet or is empty
    }
    return { data: null, source: 'empty' };
  }

  async function init() {
    if (initialized) return store;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const loaded = await loadInitialPayload();
      if (loaded.data) {
        hydrateLoadedData(loaded.data);
      }

      // Seed Super Admin + env AUTHORIZED_EMAILS into allowlist & users
      let seededAuth = false;
      const nowIso = new Date().toISOString();

      if (superAdminEmail) {
        let saEntry = state.authorizedEmails.find((e) => e.email === superAdminEmail);
        if (!saEntry) {
          saEntry = {
            email: superAdminEmail,
            name: process.env.SUPERADMIN_NAME || 'Platform Admin',
            role: 'superadmin',
            addedBy: 'system',
            createdAt: nowIso
          };
          state.authorizedEmails.unshift(saEntry);
          seededAuth = true;
        } else if (saEntry.role !== 'superadmin') {
          saEntry.role = 'superadmin';
          seededAuth = true;
        }

        let saUser = state.users.find((u) => u.email === superAdminEmail);
        if (!saUser) {
          state.users.unshift({
            id: `usr_${crypto.randomBytes(8).toString('hex')}`,
            email: superAdminEmail,
            name: saEntry.name || 'Admin',
            role: 'superadmin',
            passwordHash: hashInitialPassword(defaultAdminPassword),
            isGuest: false,
            createdAt: nowIso
          });
          seededAuth = true;
        } else if (saUser.role !== 'superadmin') {
          saUser.role = 'superadmin';
          seededAuth = true;
        }
      }

      for (const envEmail of envAuthorizedList) {
        if (!state.authorizedEmails.some((e) => e.email === envEmail)) {
          state.authorizedEmails.push({
            email: envEmail,
            name: envEmail.split('@')[0],
            role: 'creator',
            addedBy: 'env',
            createdAt: nowIso
          });
          seededAuth = true;
        }
      }

      // Purge any sessions belonging to unauthorized or deleted/guest users
      const authorizedSet = new Set(state.authorizedEmails.map((e) => e.email));
      const validUserIds = new Set(
        state.users.filter((u) => u.email && authorizedSet.has(u.email) && !u.isGuest).map((u) => u.id)
      );
      for (const [tok, sess] of Object.entries(state.sessions)) {
        if (!validUserIds.has(sess.userId)) {
          delete state.sessions[tok];
          seededAuth = true;
        }
      }

      // Seed official system public templates if not already present
      const existingIds = new Set(state.quizzes.map((q) => q.id));
      const baseMs = Math.max(Date.now() - 10_000, 1700000000000);
      const templates = buildSystemTemplates(baseMs);
      let seededAny = seededAuth;
      for (const tpl of templates) {
        if (!existingIds.has(tpl.id)) {
          state.quizzes.push(tpl);
          const ms = toEpochMs(tpl.updatedAt);
          if (ms > lastTsMs) lastTsMs = ms;
          seededAny = true;
        }
      }

      if (seededAny || loaded.source !== 'local') {
        await enqueuePersist({ syncGcsInBackground: seededAny });
      }

      initialized = true;
      return store;
    })();

    return initPromise;
  }

  function sortQuizzesNewestFirst(list) {
    return [...list].sort((a, b) => {
      const diff = toEpochMs(b.updatedAt || b.createdAt) - toEpochMs(a.updatedAt || a.createdAt);
      if (diff !== 0) return diff;
      return String(b.id).localeCompare(String(a.id));
    });
  }

  // ==================== USERS & ALLOWLIST ====================
  function getSuperAdminEmail() {
    return superAdminEmail;
  }

  function getAuthorizedEntry(email) {
    if (!email) return null;
    const clean = String(email).trim().toLowerCase();
    const found = state.authorizedEmails.find((e) => e.email === clean);
    return found ? deepClone(found) : null;
  }

  function isEmailAuthorized(email) {
    return Boolean(getAuthorizedEntry(email));
  }

  function listAuthorizedAccounts() {
    return state.authorizedEmails.map((entry) => {
      const user = state.users.find((u) => u.email === entry.email);
      return {
        email: entry.email,
        name: (user && user.name) || entry.name || entry.email.split('@')[0],
        role: entry.role === 'superadmin' ? 'superadmin' : 'creator',
        isPrimarySuperAdmin: entry.email === superAdminEmail,
        activated: Boolean(user && user.passwordHash),
        userId: user ? user.id : null,
        addedBy: entry.addedBy || 'admin',
        createdAt: entry.createdAt
      };
    });
  }

  function addAuthorizedEmail({ email, name, role = 'creator', addedBy = 'admin' } = {}) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) throw new Error('Email is required');
    const normalizedRole =
      cleanEmail === superAdminEmail || role === 'superadmin' ? 'superadmin' : 'creator';
    const cleanName = String(name || cleanEmail.split('@')[0]).trim().slice(0, 80);

    let entry = state.authorizedEmails.find((e) => e.email === cleanEmail);
    if (entry) {
      if (name) entry.name = cleanName;
      entry.role = normalizedRole;
    } else {
      entry = {
        email: cleanEmail,
        name: cleanName,
        role: normalizedRole,
        addedBy: String(addedBy || 'admin'),
        createdAt: nextIsoTimestamp()
      };
      state.authorizedEmails.push(entry);
    }

    const existingUser = state.users.find((u) => u.email === cleanEmail);
    if (existingUser) {
      existingUser.role = normalizedRole;
      if (name) existingUser.name = cleanName;
    }

    scheduleSave();
    return deepClone(entry);
  }

  function removeAuthorizedEmail(email) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) return false;
    if (cleanEmail === superAdminEmail) {
      const err = new Error('Cannot revoke the primary Super Admin account.');
      err.status = 400;
      throw err;
    }
    const idx = state.authorizedEmails.findIndex((e) => e.email === cleanEmail);
    if (idx === -1) return false;
    state.authorizedEmails.splice(idx, 1);

    // Revoke active sessions for any user with this email
    const targetUser = state.users.find((u) => u.email === cleanEmail);
    if (targetUser) {
      for (const [tok, sess] of Object.entries(state.sessions)) {
        if (sess.userId === targetUser.id) {
          delete state.sessions[tok];
        }
      }
    }
    scheduleSave();
    return true;
  }

  function createUser({ email = null, name, passwordHash = null, role = 'creator' } = {}) {
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    if (!cleanEmail) {
      throw new Error('Authorized email is required to create a user.');
    }
    const cleanName = String(name || 'Creator').trim().slice(0, 80) || 'Creator';
    const normalizedRole =
      cleanEmail === superAdminEmail || role === 'superadmin' ? 'superadmin' : 'creator';

    const existing = state.users.find((u) => u.email === cleanEmail);
    if (existing) {
      existing.name = cleanName;
      existing.role = normalizedRole;
      if (passwordHash) existing.passwordHash = passwordHash;
      existing.isGuest = false;
      scheduleSave();
      return deepClone(existing);
    }

    const createdAt = nextIsoTimestamp();
    const user = {
      id: `usr_${crypto.randomBytes(8).toString('hex')}`,
      email: cleanEmail,
      name: cleanName,
      role: normalizedRole,
      passwordHash: passwordHash || null,
      isGuest: false,
      createdAt
    };
    state.users.push(user);
    scheduleSave();
    return deepClone(user);
  }

  function updateUserPassword(userId, passwordHash) {
    const u = state.users.find((item) => item.id === String(userId));
    if (!u) return null;
    u.passwordHash = passwordHash;
    scheduleSave();
    return deepClone(u);
  }

  function getUserByEmail(email) {
    if (!email) return null;
    const target = String(email).trim().toLowerCase();
    if (!target) return null;
    const found = state.users.find((u) => u.email && u.email.toLowerCase() === target);
    return found ? deepClone(found) : null;
  }

  function getUserById(id) {
    if (!id) return null;
    const target = String(id);
    const found = state.users.find((u) => u.id === target);
    return found ? deepClone(found) : null;
  }

  // ==================== AUTH SESSIONS ====================
  function saveAuthSession(token, { userId, expiresAt } = {}) {
    const tok = String(token || '').trim();
    if (!tok || !userId) {
      throw new Error('saveAuthSession requires token and userId');
    }
    const expMs = toEpochMs(expiresAt);
    const entry = {
      userId: String(userId),
      expiresAt: expMs,
      createdAt: Date.now()
    };
    state.sessions[tok] = entry;
    scheduleSave();
    return deepClone(entry);
  }

  function getAuthSession(token) {
    if (!token) return null;
    const tok = String(token).trim();
    if (!tok) return null;
    const entry = state.sessions[tok];
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > toEpochMs(entry.expiresAt)) {
      delete state.sessions[tok];
      scheduleSave();
      return null;
    }
    return deepClone(entry);
  }

  function deleteAuthSession(token) {
    if (!token) return false;
    const tok = String(token).trim();
    if (!tok || !Object.prototype.hasOwnProperty.call(state.sessions, tok)) {
      return false;
    }
    delete state.sessions[tok];
    scheduleSave();
    return true;
  }

  // ==================== QUIZZES ====================
  function listQuizzesForUser(userId) {
    const uid = userId ? String(userId) : '';
    const myQuizzes = uid
      ? sortQuizzesNewestFirst(state.quizzes.filter((q) => q.ownerId === uid))
      : [];
    const publicQuizzes = sortQuizzesNewestFirst(
      state.quizzes.filter((q) => q.visibility === 'public')
    );
    return {
      myQuizzes: deepClone(myQuizzes),
      publicQuizzes: deepClone(publicQuizzes)
    };
  }

  function listPublicQuizzes() {
    return deepClone(
      sortQuizzesNewestFirst(state.quizzes.filter((q) => q.visibility === 'public'))
    );
  }

  function getQuiz(quizId) {
    if (!quizId) return null;
    const found = state.quizzes.find((q) => q.id === String(quizId));
    return found ? deepClone(found) : null;
  }

  function createQuiz(quizData = {}) {
    const ts = nextIsoTimestamp();
    const rawQuestions = Array.isArray(quizData.questions) ? quizData.questions : [];
    const normalizedQuestions = rawQuestions.map((q, idx) => normalizeQuestion(q, idx));
    const title = String(quizData.title || 'Untitled Quiz').trim().slice(0, 140) || 'Untitled Quiz';
    const description = String(quizData.description || '').trim().slice(0, 600);
    const coverEmoji = String(quizData.coverEmoji || '🎯').trim().slice(0, 8) || '🎯';

    const quiz = {
      id: `quiz_${crypto.randomBytes(6).toString('hex')}`,
      title,
      description,
      coverEmoji,
      ownerId: String(quizData.ownerId || 'anonymous'),
      ownerName: String(quizData.ownerName || 'Creator').trim().slice(0, 80) || 'Creator',
      visibility: normalizeVisibility(quizData.visibility, 'private'),
      isTemplate: Boolean(quizData.isTemplate),
      playsCount: 0,
      questionCount: normalizedQuestions.length,
      questions: normalizedQuestions,
      createdAt: ts,
      updatedAt: ts
    };

    state.quizzes.push(quiz);
    scheduleSave();
    return deepClone(quiz);
  }

  function updateQuiz(quizId, patch = {}) {
    if (!quizId || !patch || typeof patch !== 'object') return null;
    const quiz = state.quizzes.find((q) => q.id === String(quizId));
    if (!quiz) return null;

    if (patch.title !== undefined) {
      const nextTitle = String(patch.title || '').trim().slice(0, 140);
      if (nextTitle) quiz.title = nextTitle;
    }
    if (patch.description !== undefined) {
      quiz.description = String(patch.description ?? '').trim().slice(0, 600);
    }
    if (patch.coverEmoji !== undefined) {
      const nextEmoji = String(patch.coverEmoji || '').trim().slice(0, 8);
      if (nextEmoji) quiz.coverEmoji = nextEmoji;
    }
    if (patch.visibility !== undefined) {
      quiz.visibility = normalizeVisibility(patch.visibility, quiz.visibility);
    }
    if (patch.questions !== undefined && Array.isArray(patch.questions)) {
      quiz.questions = patch.questions.map((q, idx) => normalizeQuestion(q, idx));
      quiz.questionCount = quiz.questions.length;
    }
    if (patch.playsCount !== undefined) {
      quiz.playsCount = Math.max(0, Math.floor(Number(patch.playsCount) || 0));
    }

    quiz.updatedAt = nextIsoTimestamp();
    scheduleSave();
    return deepClone(quiz);
  }

  function incrementQuizPlays(quizId) {
    if (!quizId) return null;
    const quiz = state.quizzes.find((q) => q.id === String(quizId));
    if (!quiz) return null;
    quiz.playsCount = (Number(quiz.playsCount) || 0) + 1;
    scheduleSave();
    return deepClone(quiz);
  }

  function deleteQuiz(quizId) {
    if (!quizId) return false;
    const idx = state.quizzes.findIndex((q) => q.id === String(quizId));
    if (idx === -1) return false;
    const target = state.quizzes[idx];
    if (target.ownerId === 'system' || target.isTemplate) {
      return false;
    }
    state.quizzes.splice(idx, 1);
    scheduleSave();
    return true;
  }

  function cloneQuiz(quizId, { ownerId, ownerName } = {}) {
    if (!quizId || !ownerId) return null;
    const source = state.quizzes.find((q) => q.id === String(quizId));
    if (!source) return null;

    const ts = nextIsoTimestamp();
    const clonedQuestions = source.questions.map((q, idx) =>
      normalizeQuestion(
        {
          ...deepClone(q),
          id: `q_${idx + 1}_${crypto.randomBytes(3).toString('hex')}`
        },
        idx
      )
    );

    const baseTitle = String(source.title || 'Untitled Quiz').trim();
    const copyTitle = `${baseTitle} (Copy)`.slice(0, 140);

    const cloned = {
      id: `quiz_${crypto.randomBytes(6).toString('hex')}`,
      title: copyTitle,
      description: source.description || '',
      coverEmoji: source.coverEmoji || '🎯',
      ownerId: String(ownerId),
      ownerName: String(ownerName || 'Creator').trim().slice(0, 80) || 'Creator',
      visibility: 'private',
      isTemplate: false,
      playsCount: 0,
      questionCount: clonedQuestions.length,
      questions: clonedQuestions,
      createdAt: ts,
      updatedAt: ts
    };

    state.quizzes.push(cloned);
    scheduleSave();
    return deepClone(cloned);
  }

  // ==================== GAME SESSION REPORTS ====================
  function saveGameReport(report = {}) {
    const clonedInput = deepClone(report && typeof report === 'object' ? report : {});
    const createdAt = nextIsoTimestamp();
    const saved = {
      ...clonedInput,
      id: `rep_${crypto.randomBytes(6).toString('hex')}`,
      createdAt
    };

    state.reports.unshift(saved);
    state.reports.sort((a, b) => toEpochMs(b.createdAt) - toEpochMs(a.createdAt));
    if (state.reports.length > MAX_REPORTS) {
      state.reports = state.reports.slice(0, MAX_REPORTS);
    }

    scheduleSave();
    return deepClone(saved);
  }

  function listGameReportsForUser(userId) {
    if (!userId) return [];
    const uid = String(userId);
    const matching = state.reports
      .filter((r) => r.hostUserId === uid)
      .sort((a, b) => toEpochMs(b.createdAt) - toEpochMs(a.createdAt));
    return deepClone(matching);
  }

  function getGameReport(reportId) {
    if (!reportId) return null;
    const found = state.reports.find((r) => r.id === String(reportId));
    return found ? deepClone(found) : null;
  }

  const store = {
    init,
    flush,
    getSuperAdminEmail,
    getAuthorizedEntry,
    isEmailAuthorized,
    listAuthorizedAccounts,
    addAuthorizedEmail,
    removeAuthorizedEmail,
    createUser,
    updateUserPassword,
    getUserByEmail,
    getUserById,
    saveAuthSession,
    getAuthSession,
    deleteAuthSession,
    listQuizzesForUser,
    listPublicQuizzes,
    getQuiz,
    createQuiz,
    updateQuiz,
    incrementQuizPlays,
    deleteQuiz,
    cloneQuiz,
    saveGameReport,
    listGameReportsForUser,
    getGameReport
  };

  return store;
}

module.exports = {
  createStore,
  normalizeQuestion
};
