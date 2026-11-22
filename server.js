const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

// Load local .env if present (zero external dependency; never overrides existing env vars)
(() => {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // Ignore .env parse errors
  }
})();

const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { QUESTIONS } = require('./questions');
const { createStore } = require('./lib/store');
const { createAuth } = require('./lib/auth');
const {
  generateQuizWithAI,
  importQuizFromText,
  exportQuizToCsv,
  getSampleCsvTemplate,
  validateAndNormalizeQuestions
} = require('./lib/quiz_importer');

const PORT = Number(process.env.PORT || 8085);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-in-env';
const ADMIN_TOKEN_TTL_MS = 12 * 3600 * 1000;

const store = createStore({
  dataFilePath: process.env.STORE_FILE_PATH || undefined
});
const auth = createAuth(store);
const initPromise = Promise.resolve().then(() => store.init());

const app = express();
app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Active legacy admin sessions: token -> { username, expiresAt }
const adminTokens = new Map();

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isValidAdminToken(token) {
  if (!token) return false;
  const session = adminTokens.get(String(token));
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    adminTokens.delete(String(token));
    return false;
  }
  return true;
}

function sanitizeFilenameSlug(str, fallback = 'quiz') {
  const slug = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

function formatLeaderboardCsv(lb = []) {
  const header = 'Rank,Name,Avatar,Score,Correct,Answered,AccuracyPct,MaxStreak,AvgResponseMs,IsBot\n';
  const rows = lb.map((p, idx) => {
    const rank = p.rank || idx + 1;
    const answered = Number(p.answeredCount) || 0;
    const correct = Number(p.correctCount) || 0;
    const acc = answered > 0 ? Math.round((correct / answered) * 100) : 0;
    const safeName = `"${String(p.name || '').replace(/"/g, '""')}"`;
    const safeAvatar = `"${String(p.avatar || '').replace(/"/g, '""')}"`;
    return `${rank},${safeName},${safeAvatar},${Number(p.score) || 0},${correct},${answered},${acc},${Number(p.maxStreak) || 0},${Number(p.avgResponseMs) || 0},${Boolean(p.isBot)}`;
  }).join('\n');
  return header + (rows ? rows + '\n' : '');
}

// ==================== PAGE ENTRYPOINTS ====================
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/studio', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'studio.html'));
});

// Ensure store initialization completes before serving any API route
app.use('/api', async (_req, _res, next) => {
  try {
    await initPromise;
    next();
  } catch (err) {
    next(err);
  }
});

// ==================== LEGACY ADMIN API ====================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (safeEqual(username || '', ADMIN_USERNAME) && safeEqual(password || '', ADMIN_PASSWORD)) {
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.set(token, { username: ADMIN_USERNAME, expiresAt: Date.now() + ADMIN_TOKEN_TTL_MS });
    return res.json({ ok: true, token, username: ADMIN_USERNAME });
  }
  return res.status(401).json({ ok: false, message: 'Invalid admin username or password.' });
});

app.get('/api/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  return res.json({ ok: isValidAdminToken(token) });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.body && req.body.token);
  if (token) adminTokens.delete(String(token));
  return res.json({ ok: true });
});

// ==================== CREATOR AUTH API ====================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    const { user, token } = await auth.registerUser({ email, password, name });
    return res.json({ ok: true, token, user });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { user, token } = await auth.loginUser({ email, password });
    return res.json({ ok: true, token, user });
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, message: err.message || 'Invalid email or password.' });
  }
});

app.post('/api/auth/guest', async (req, res) => {
  try {
    const { name } = req.body || {};
    const { user, token } = await auth.createGuestUser({ name });
    return res.json({ ok: true, token, user });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Failed to start guest session.' });
  }
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  return res.json({ ok: true, user: req.user });
});

app.post('/api/auth/change-password', auth.requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const user = auth.changePassword({
      userId: req.user.id,
      currentPassword,
      newPassword
    });
    return res.json({ ok: true, user });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Could not update password.' });
  }
});

// ==================== QUESTION MEDIA UPLOAD & SERVING ====================
const MEDIA_MIME_MAP = {
  'image/png': { type: 'image', ext: 'png' },
  'image/jpeg': { type: 'image', ext: 'jpg' },
  'image/jpg': { type: 'image', ext: 'jpg' },
  'image/webp': { type: 'image', ext: 'webp' },
  'image/gif': { type: 'image', ext: 'gif' },
  'audio/mpeg': { type: 'audio', ext: 'mp3' },
  'audio/mp3': { type: 'audio', ext: 'mp3' },
  'audio/wav': { type: 'audio', ext: 'wav' },
  'audio/x-wav': { type: 'audio', ext: 'wav' },
  'audio/ogg': { type: 'audio', ext: 'ogg' },
  'audio/mp4': { type: 'audio', ext: 'm4a' },
  'audio/x-m4a': { type: 'audio', ext: 'm4a' },
  'audio/webm': { type: 'audio', ext: 'webm' },
  'video/mp4': { type: 'video', ext: 'mp4' },
  'video/webm': { type: 'video', ext: 'webm' },
  'video/ogg': { type: 'video', ext: 'ogg' }
};

const EXT_CONTENT_TYPE = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm'
};

const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB

app.post('/api/media/upload', auth.requireAuth, async (req, res) => {
  try {
    const { mimeType = '', dataBase64 = '' } = req.body || {};
    const cleanMime = String(mimeType).split(';')[0].trim().toLowerCase();
    const spec = MEDIA_MIME_MAP[cleanMime];
    if (!spec) {
      return res.status(400).json({
        ok: false,
        message: 'Unsupported file type. Upload PNG, JPG, WebP, GIF, MP3, WAV, OGG, M4A, MP4, or WebM.'
      });
    }

    const stripped = String(dataBase64 || '').replace(/^data:[^;]+;base64,/i, '').trim();
    if (!stripped) {
      return res.status(400).json({ ok: false, message: 'No file data received.' });
    }

    const buffer = Buffer.from(stripped, 'base64');
    if (!buffer.length) {
      return res.status(400).json({ ok: false, message: 'Uploaded file is empty.' });
    }
    if (buffer.length > MAX_MEDIA_BYTES) {
      return res.status(413).json({
        ok: false,
        message: 'File exceeds the 10 MB upload limit. For larger videos, paste a hosted MP4 or YouTube URL.'
      });
    }

    const filename = await store.saveMediaBuffer({
      buffer,
      mimeType: cleanMime,
      ext: spec.ext
    });

    return res.json({
      ok: true,
      media: {
        type: spec.type,
        url: `/api/media/${filename}`,
        mimeType: cleanMime,
        size: buffer.length
      }
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      message: err.message || 'Media upload failed.'
    });
  }
});

app.get('/api/media/:filename', async (req, res) => {
  try {
    const filename = String(req.params.filename || '').trim();
    const buffer = await store.readMediaBuffer(filename);
    if (!buffer) {
      return res.status(404).json({ ok: false, message: 'Media not found.' });
    }

    const ext = filename.split('.').pop().toLowerCase();
    const contentType = EXT_CONTENT_TYPE[ext] || 'application/octet-stream';
    const total = buffer.length;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
        if (start >= 0 && start <= end && end < total) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', String(end - start + 1));
          return res.end(buffer.subarray(start, end + 1));
        }
      }
    }

    res.setHeader('Content-Length', String(total));
    return res.end(buffer);
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Failed to serve media.' });
  }
});

// ==================== SUPER ADMIN ACCESS CONTROL API ====================
app.get('/api/admin/access', auth.requireSuperAdmin, (_req, res) => {
  try {
    return res.json({
      ok: true,
      superAdminEmail: store.getSuperAdminEmail(),
      accounts: store.listAuthorizedAccounts()
    });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'Failed to load access list.' });
  }
});

app.post('/api/admin/access', auth.requireSuperAdmin, (req, res) => {
  try {
    const { email, name, role, initialPassword } = req.body || {};
    const account = auth.authorizeAccount({
      email,
      name,
      role,
      initialPassword,
      addedBy: req.user.email || req.user.name
    });
    return res.json({
      ok: true,
      account,
      accounts: store.listAuthorizedAccounts()
    });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Failed to authorize account.' });
  }
});

app.delete('/api/admin/access/:email', auth.requireSuperAdmin, (req, res) => {
  try {
    const targetEmail = decodeURIComponent(String(req.params.email || '')).trim().toLowerCase();
    if (targetEmail === req.user.email) {
      return res.status(400).json({ ok: false, message: 'You cannot revoke your own active Super Admin account.' });
    }
    const removed = store.removeAuthorizedEmail(targetEmail);
    if (!removed) {
      return res.status(404).json({ ok: false, message: 'Account not found in authorized list.' });
    }
    return res.json({
      ok: true,
      accounts: store.listAuthorizedAccounts()
    });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Failed to revoke access.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = auth.extractToken(req) || (req.body && req.body.token);
    if (token) {
      await store.deleteAuthSession(String(token));
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'Logout failed.' });
  }
});

// ==================== QUIZZES CRUD, AI & IMPORT/EXPORT API ====================
app.get('/api/quizzes', auth.optionalAuth, async (req, res) => {
  try {
    if (req.user) {
      const { myQuizzes, publicQuizzes } = await store.listQuizzesForUser(req.user.id);
      return res.json({ ok: true, myQuizzes, publicQuizzes });
    }
    const publicQuizzes = await store.listPublicQuizzes();
    return res.json({ ok: true, myQuizzes: [], publicQuizzes });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'Failed to list quizzes.' });
  }
});

app.get('/api/quizzes/public', async (_req, res) => {
  try {
    const quizzes = await store.listPublicQuizzes();
    return res.json({ ok: true, quizzes });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'Failed to load public quizzes.' });
  }
});

app.get('/api/quizzes/template.csv', (_req, res) => {
  try {
    const csv = getSampleCsvTemplate();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="quizarena-template.csv"');
    return res.send(csv);
  } catch (err) {
    return res.status(500).send('Failed to generate sample CSV template.');
  }
});

app.post('/api/quizzes/generate', auth.requireAuth, async (req, res) => {
  try {
    const { prompt, sourceText, questionCount, difficulty, includeTrueFalse } = req.body || {};
    const draftQuiz = await generateQuizWithAI({
      prompt,
      sourceText,
      questionCount,
      difficulty,
      includeTrueFalse
    });
    return res.json({ ok: true, draftQuiz });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'AI quiz generation failed.' });
  }
});

app.post('/api/quizzes/import', auth.requireAuth, async (req, res) => {
  try {
    const { format, content, title } = req.body || {};
    const draftQuiz = await importQuizFromText({ format, content, title });
    return res.json({ ok: true, draftQuiz });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Failed to import quiz.' });
  }
});

app.post('/api/quizzes', auth.requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const questions = validateAndNormalizeQuestions(body.questions);
    const quiz = await store.createQuiz({
      ...body,
      ownerId: req.user.id,
      ownerName: req.user.name,
      questions
    });
    return res.json({ ok: true, quiz });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Failed to create quiz.' });
  }
});

app.get('/api/quizzes/:id/export.csv', auth.optionalAuth, async (req, res) => {
  try {
    const quiz = await store.getQuiz(req.params.id);
    if (!quiz) return res.status(404).json({ ok: false, message: 'Quiz not found.' });
    if (quiz.visibility === 'private' && (!req.user || req.user.id !== quiz.ownerId)) {
      return res.status(req.user ? 403 : 401).json({ ok: false, message: 'Forbidden: Private quiz.' });
    }
    const csv = exportQuizToCsv(quiz);
    const slug = sanitizeFilenameSlug(quiz.title, quiz.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.csv"`);
    return res.send(csv);
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'Failed to export CSV.' });
  }
});

app.get('/api/quizzes/:id/export.json', auth.optionalAuth, async (req, res) => {
  try {
    const quiz = await store.getQuiz(req.params.id);
    if (!quiz) return res.status(404).json({ ok: false, message: 'Quiz not found.' });
    if (quiz.visibility === 'private' && (!req.user || req.user.id !== quiz.ownerId)) {
      return res.status(req.user ? 403 : 401).json({ ok: false, message: 'Forbidden: Private quiz.' });
    }
    const slug = sanitizeFilenameSlug(quiz.title, quiz.id);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.json"`);
    return res.send(JSON.stringify(quiz, null, 2));
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'Failed to export JSON.' });
  }
});

app.post('/api/quizzes/:id/clone', auth.requireAuth, async (req, res) => {
  try {
    const existing = await store.getQuiz(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, message: 'Quiz not found.' });
    if (existing.visibility === 'private' && existing.ownerId !== req.user.id) {
      return res.status(403).json({ ok: false, message: 'You cannot clone another creator\'s private quiz.' });
    }
    const quiz = await store.cloneQuiz(req.params.id, {
      ownerId: req.user.id,
      ownerName: req.user.name
    });
    if (!quiz) return res.status(404).json({ ok: false, message: 'Quiz not found.' });
    return res.json({ ok: true, quiz });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Failed to clone quiz.' });
  }
});

app.get('/api/quizzes/:id', auth.optionalAuth, async (req, res) => {
  try {
    const quiz = await store.getQuiz(req.params.id);
    if (!quiz) return res.status(404).json({ ok: false, message: 'Quiz not found.' });
    if (quiz.visibility === 'private' && (!req.user || req.user.id !== quiz.ownerId)) {
      return res.status(req.user ? 403 : 401).json({ ok: false, message: 'This quiz is private.' });
    }
    return res.json({ ok: true, quiz });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'Failed to load quiz.' });
  }
});

app.put('/api/quizzes/:id', auth.requireAuth, async (req, res) => {
  try {
    const existing = await store.getQuiz(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, message: 'Quiz not found.' });
    if (existing.ownerId !== req.user.id) {
      return res.status(403).json({ ok: false, message: 'Only the quiz owner can update this quiz.' });
    }
    const patch = { ...(req.body || {}) };
    if (patch.questions !== undefined) {
      patch.questions = validateAndNormalizeQuestions(patch.questions);
    }
    const quiz = await store.updateQuiz(req.params.id, patch);
    return res.json({ ok: true, quiz });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Failed to update quiz.' });
  }
});

app.delete('/api/quizzes/:id', auth.requireAuth, async (req, res) => {
  try {
    const existing = await store.getQuiz(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, message: 'Quiz not found.' });
    if (existing.ownerId !== req.user.id) {
      return res.status(403).json({ ok: false, message: 'Only the quiz owner can delete this quiz.' });
    }
    const deleted = await store.deleteQuiz(req.params.id);
    if (!deleted) {
      return res.status(400).json({ ok: false, message: 'Cannot delete built-in template.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message || 'Failed to delete quiz.' });
  }
});

// ==================== PAST GAME SESSION REPORTS API ====================
app.get('/api/sessions', auth.requireAuth, async (req, res) => {
  try {
    const sessions = await store.listGameReportsForUser(req.user.id);
    return res.json({ ok: true, sessions });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'Failed to list game sessions.' });
  }
});

app.get('/api/sessions/:id/export.csv', auth.requireAuth, async (req, res) => {
  try {
    const report = await store.getGameReport(req.params.id);
    if (!report) return res.status(404).send('Session report not found.');
    if (report.hostUserId !== req.user.id) {
      return res.status(403).send('Forbidden: You do not own this session report.');
    }
    const csv = formatLeaderboardCsv(report.leaderboard || []);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="quizarena-session-${report.roomCode || report.id}.csv"`);
    return res.send(csv);
  } catch (err) {
    return res.status(err.status || 500).send('Failed to export session CSV.');
  }
});

app.get('/api/sessions/:id', auth.requireAuth, async (req, res) => {
  try {
    const report = await store.getGameReport(req.params.id);
    if (!report) return res.status(404).json({ ok: false, message: 'Session report not found.' });
    if (report.hostUserId !== req.user.id) {
      return res.status(403).json({ ok: false, message: 'You do not have permission to view this session report.' });
    }
    return res.json({ ok: true, session: report });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message || 'Failed to load session report.' });
  }
});

// ==================== LIVE MULTIPLAYER ROOM ENGINE ====================
const rooms = new Map();

const BOT_NAMES = [
  'Aarav', 'MeiLin', 'Kenji', 'Priya', 'Sora', 'Wei', 'Ananya', 'Daisuke',
  'Rohan', 'Hana', 'Arjun', 'Yuki', 'Kavya', 'MinJun', 'Neha', 'Taro',
  'Siddharth', 'JiHoon', 'Diya', 'Haruto', 'Vikram', 'SeoYeon', 'Ishaan', 'Ren',
  'Aditi', 'JaeWon', 'Riya', 'Kaito', 'Pranav', 'EunJi', 'Tanvi', 'Riku',
  'Nikhil', 'Chloé', 'Shreya', 'Liam', 'Karan', 'Maya', 'Dev', 'Zoe',
  'Aisha', 'Lucas', 'Sanya', 'Noah', 'Varun', 'Aoi', 'Meera', 'Ethan',
  'Kabir', 'Yuna', 'Mira', 'Owen', 'Tara', 'Satoshi', 'Kunal', 'Nadia',
  'Rhea', 'Jian', 'Samar', 'Lina', 'Vihaan', 'Siti', 'Nurul', 'Farhan',
  'Budi', 'Putri', 'Thao', 'Minh', 'Somchai', 'Ploy', 'Rafael', 'Camille',
  'Daniel', 'Grace', 'Marcus', 'Chloe', 'Kevin', 'Rachel', 'Jason', 'Hannah',
  'Ryan', 'Sophia', 'Alex', 'Emma', 'Ben', 'Olivia', 'Sam', 'Aria',
  'Leo', 'Mia', 'Max', 'Ella', 'Kai', 'Nora', 'Jay', 'Ivy',
  'Ash', 'Luna', 'Zed', 'Kira'
];

const BOT_AVATARS = ['🚀', '⚡', '🤖', '🧠', '🔥', '🎯', '🌟', '🦊', '🐼', '🐯', '🦁', '🐙', '🦄', '🐳', '🦉', '🎮', '💎', '🏆'];

function generateRoomCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function getQuestionMultiplier(q) {
  if (q && q.pointsMultiplier !== undefined && q.pointsMultiplier !== null) {
    const m = Number(q.pointsMultiplier);
    if (m === 0 || m === 1 || m === 2) return m;
  }
  return q && q.doublePoints ? 2 : 1;
}

function buildQuestionList(deck, questionCount, defaultTimeLimit, customQuestions) {
  let pool;
  if (Array.isArray(customQuestions) && customQuestions.length > 0) {
    pool = customQuestions;
  } else if (deck === 'UC1') {
    pool = QUESTIONS.filter((q) => q.deck === 'UC1');
  } else if (deck === 'UC2') {
    pool = QUESTIONS.filter((q) => q.deck === 'UC2');
  } else {
    const uc1 = QUESTIONS.filter((q) => q.deck === 'UC1');
    const uc2 = QUESTIONS.filter((q) => q.deck === 'UC2');
    pool = [];
    const maxLen = Math.max(uc1.length, uc2.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < uc1.length) pool.push(uc1[i]);
      if (i < uc2.length) pool.push(uc2[i]);
    }
  }

  const count = Math.max(1, Math.min(pool.length, Number(questionCount) || pool.length));
  return prepareRoomQuestions(pool.slice(0, count), {
    shuffleOptions: true,
    overrideTimeLimit: Number(defaultTimeLimit) > 0 ? Number(defaultTimeLimit) : 0,
    fallbackDeck: deck
  });
}

function prepareRoomQuestions(sourceQuestions, { shuffleOptions = true, overrideTimeLimit = 0, fallbackDeck = 'CUSTOM' } = {}) {
  const overrideSec = Number(overrideTimeLimit) > 0
    ? Math.max(5, Math.min(120, Number(overrideTimeLimit)))
    : 0;

  return sourceQuestions.map((q, idx) => {
    const rawOptions = Array.isArray(q.options) ? [...q.options] : [];
    let finalOptions = rawOptions;
    let finalCorrectIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : 0;

    // Shuffle ONLY 4-option MCQs; keep 2-option True/False ['True', 'False'] order intact!
    if (shuffleOptions && rawOptions.length === 4) {
      const order = [0, 1, 2, 3];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      finalOptions = order.map((origIdx) => rawOptions[origIdx]);
      const mappedIdx = order.indexOf(finalCorrectIndex);
      finalCorrectIndex = mappedIdx >= 0 ? mappedIdx : 0;
    }

    const mult = getQuestionMultiplier(q);
    const timeLimit = overrideSec > 0 ? overrideSec : (Number(q.timeLimit) || 20);

    return {
      ...q,
      id: q.id || `q_${idx + 1}`,
      index: idx,
      type: finalOptions.length === 2 ? 'tf' : 'mcq',
      deck: q.deck || fallbackDeck,
      category: q.category || 'General',
      slideRef: q.slideRef || '',
      question: q.question,
      options: finalOptions,
      correctIndex: finalCorrectIndex,
      timeLimit,
      pointsMultiplier: mult,
      doublePoints: mult === 2,
      isPoll: mult === 0,
      explanation: q.explanation || ''
    };
  });
}

function getSortedLeaderboard(room) {
  const arr = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    prevRank: p.prevRank,
    streak: p.streak,
    maxStreak: p.maxStreak,
    correctCount: p.correctCount,
    answeredCount: p.answeredCount,
    avgResponseMs: p.answeredCount > 0 ? Math.round(p.totalResponseMs / p.answeredCount) : 0,
    isBot: p.isBot,
    connected: p.isBot ? true : Boolean(p.ws && p.ws.readyState === 1),
    lastPoints: p.lastPoints || 0
  }));

  arr.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
    return a.avgResponseMs - b.avgResponseMs;
  });

  return arr.map((p, idx) => ({
    ...p,
    rank: idx + 1,
    rankDelta: p.prevRank ? p.prevRank - (idx + 1) : 0
  }));
}

function broadcastToPlayers(room, payloadBuilder) {
  for (const player of room.players.values()) {
    if (player.isBot || !player.ws || player.ws.readyState !== 1) continue;
    const payload = typeof payloadBuilder === 'function' ? payloadBuilder(player) : payloadBuilder;
    if (payload) sendJson(player.ws, payload);
  }
}

function sendHostLobbyState(room) {
  const players = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    isBot: p.isBot,
    connected: p.isBot ? true : Boolean(p.ws && p.ws.readyState === 1)
  }));
  sendJson(room.hostWs, {
    type: 'lobby_update',
    code: room.code,
    quizId: room.quizId || null,
    title: room.title,
    locked: room.locked,
    maxPlayers: room.maxPlayers,
    playerCount: players.length,
    botCount: players.filter((p) => p.isBot).length,
    players,
    questionCount: room.questions.length,
    deck: room.deck
  });
}

function clearRoomTimers(room) {
  if (room.phaseTimer) {
    clearTimeout(room.phaseTimer);
    room.phaseTimer = null;
  }
  if (room.botTimers) {
    for (const t of room.botTimers) clearTimeout(t);
    room.botTimers = [];
  }
  if (room.countThrottleTimer) {
    clearTimeout(room.countThrottleTimer);
    room.countThrottleTimer = null;
  }
}

function scheduleAnswerCountUpdate(room) {
  if (room.countThrottleTimer) return;
  room.countThrottleTimer = setTimeout(() => {
    room.countThrottleTimer = null;
    if (room.phase !== 'QUESTION') return;
    sendJson(room.hostWs, {
      type: 'answer_count_update',
      answeredCount: room.currentAnswers.size,
      totalPlayers: room.players.size
    });
  }, 100);
}

function startGetReady(room) {
  clearRoomTimers(room);
  const q = room.questions[room.currentQuestionIndex];
  if (!q) {
    showPodium(room);
    return;
  }

  // Snapshot previous ranks before this question
  const currentLb = getSortedLeaderboard(room);
  for (const row of currentLb) {
    const p = room.players.get(row.id);
    if (p) p.prevRank = row.rank;
  }

  room.phase = 'GET_READY';
  room.currentAnswers = new Map();

  const mult = getQuestionMultiplier(q);
  const payload = {
    type: 'phase_get_ready',
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    questionType: q.options.length === 2 ? 'tf' : 'mcq',
    optionCount: q.options.length,
    options: q.options,
    category: q.category || 'General',
    deck: q.deck || room.deck,
    slideRef: q.slideRef || '',
    pointsMultiplier: mult,
    doublePoints: mult === 2,
    isPoll: mult === 0,
    countdownSec: 3
  };

  sendJson(room.hostWs, payload);
  broadcastToPlayers(room, payload);

  room.phaseTimer = setTimeout(() => {
    startQuestion(room);
  }, 3200);
}

function startQuestion(room) {
  clearRoomTimers(room);
  const q = room.questions[room.currentQuestionIndex];
  if (!q) return;

  room.phase = 'QUESTION';
  room.questionStartedAt = Date.now();
  room.currentAnswers = new Map();

  const mult = getQuestionMultiplier(q);
  const isPoll = mult === 0;

  const qPayload = {
    type: 'phase_question',
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    questionType: q.options.length === 2 ? 'tf' : 'mcq',
    category: q.category || 'General',
    deck: q.deck || room.deck,
    slideRef: q.slideRef || '',
    question: q.question,
    options: q.options,
    media: q.media || null,
    timeLimit: q.timeLimit,
    pointsMultiplier: mult,
    doublePoints: mult === 2,
    isPoll,
    startedAt: room.questionStartedAt,
    totalPlayers: room.players.size
  };

  sendJson(room.hostWs, qPayload);
  broadcastToPlayers(room, qPayload);

  // Schedule bot answers dynamically across 2-option or 4-option questions
  const optionCount = q.options.length;
  const allOptionIndices = Array.from({ length: optionCount }, (_, idx) => idx);
  room.botTimers = [];
  for (const player of room.players.values()) {
    if (!player.isBot) continue;
    const delayMs = Math.floor(1400 + Math.random() * Math.max(2000, (q.timeLimit - 2.5) * 1000));
    const timer = setTimeout(() => {
      if (room.phase !== 'QUESTION') return;
      let optIdx;
      if (isPoll) {
        optIdx = allOptionIndices[Math.floor(Math.random() * allOptionIndices.length)];
      } else {
        const isRight = Math.random() < (player.botSkill || 0.68);
        if (isRight) {
          optIdx = q.correctIndex;
        } else {
          const wrongChoices = allOptionIndices.filter((i) => i !== q.correctIndex);
          optIdx = wrongChoices.length > 0
            ? wrongChoices[Math.floor(Math.random() * wrongChoices.length)]
            : 0;
        }
      }
      recordAnswer(room, player, optIdx);
    }, delayMs);
    room.botTimers.push(timer);
  }

  room.phaseTimer = setTimeout(() => {
    revealQuestion(room);
  }, q.timeLimit * 1000 + 250);
}

function recordAnswer(room, player, optionIndex) {
  if (room.phase !== 'QUESTION') return false;
  if (room.currentAnswers.has(player.id)) return false;

  const q = room.questions[room.currentQuestionIndex];
  if (!q || !Array.isArray(q.options)) return false;

  const opt = Number(optionIndex);
  if (!Number.isInteger(opt) || opt < 0 || opt >= q.options.length) return false;

  const elapsedMs = Math.max(0, Date.now() - room.questionStartedAt);
  const mult = q.pointsMultiplier !== undefined ? Number(q.pointsMultiplier) : (q.doublePoints ? 2 : 1);
  const isPoll = mult === 0;
  const isCorrect = isPoll ? true : opt === q.correctIndex;

  let points = 0;
  if (!isPoll && isCorrect) {
    const timeRatio = Math.max(0, Math.min(1, 1 - elapsedMs / (q.timeLimit * 1000)));
    const speedBase = Math.round(500 + 500 * timeRatio);
    const streakBonus = Math.min(500, player.streak * 100);
    points = (speedBase + streakBonus) * mult;
  }

  room.currentAnswers.set(player.id, {
    optionIndex: opt,
    elapsedMs,
    isCorrect,
    isPoll,
    points
  });

  if (!player.isBot && player.ws) {
    sendJson(player.ws, {
      type: 'answer_locked',
      optionIndex: opt,
      answeredCount: room.currentAnswers.size
    });
  }

  scheduleAnswerCountUpdate(room);

  // If every active player has answered, end question early after a brief 550ms beat
  const activeCount = Array.from(room.players.values()).filter(
    (p) => p.isBot || (p.ws && p.ws.readyState === 1)
  ).length;

  if (activeCount > 0 && room.currentAnswers.size >= activeCount) {
    clearRoomTimers(room);
    sendJson(room.hostWs, {
      type: 'answer_count_update',
      answeredCount: room.currentAnswers.size,
      totalPlayers: room.players.size
    });
    room.phaseTimer = setTimeout(() => revealQuestion(room), 550);
  }
  return true;
}

function revealQuestion(room) {
  if (room.phase !== 'QUESTION') return;
  clearRoomTimers(room);
  room.phase = 'REVEAL';

  const q = room.questions[room.currentQuestionIndex];
  const mult = q.pointsMultiplier !== undefined ? Number(q.pointsMultiplier) : (q.doublePoints ? 2 : 1);
  const isPoll = mult === 0;
  const distribution = new Array(q.options.length).fill(0);
  let correctPlayers = 0;
  let totalAnswered = 0;

  for (const player of room.players.values()) {
    const ans = room.currentAnswers.get(player.id);
    if (ans) {
      totalAnswered++;
      if (ans.optionIndex >= 0 && ans.optionIndex < distribution.length) {
        distribution[ans.optionIndex]++;
      }
      player.answeredCount++;
      player.totalResponseMs += ans.elapsedMs;

      if (isPoll) {
        player.lastPoints = 0;
      } else if (ans.isCorrect) {
        correctPlayers++;
        player.correctCount++;
        player.streak++;
        if (player.streak > player.maxStreak) player.maxStreak = player.streak;
        player.score += ans.points;
        player.lastPoints = ans.points;
      } else {
        player.streak = 0;
        player.lastPoints = 0;
      }
    } else if (!isPoll) {
      player.streak = 0;
      player.lastPoints = 0;
    } else {
      player.lastPoints = 0;
    }
  }

  const accuracyPct = isPoll
    ? (totalAnswered > 0 ? 100 : 0)
    : (totalAnswered > 0 ? Math.round((correctPlayers / totalAnswered) * 100) : 0);

  room.questionStats.push({
    questionIndex: room.currentQuestionIndex,
    id: q.id,
    category: q.category || 'General',
    question: q.question,
    pointsMultiplier: mult,
    isPoll,
    distribution,
    accuracyPct,
    totalAnswered,
    correctPlayers: isPoll ? totalAnswered : correctPlayers
  });

  const lb = getSortedLeaderboard(room);
  const rankMap = new Map(lb.map((r) => [r.id, r]));

  sendJson(room.hostWs, {
    type: 'phase_reveal',
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    questionType: q.options.length === 2 ? 'tf' : 'mcq',
    question: q.question,
    options: q.options,
    media: q.media || null,
    correctIndex: q.correctIndex,
    pointsMultiplier: mult,
    doublePoints: mult === 2,
    isPoll,
    explanation: q.explanation || '',
    slideRef: q.slideRef || '',
    category: q.category || 'General',
    distribution,
    totalAnswered,
    totalPlayers: room.players.size,
    correctPlayers,
    accuracyPct,
    topPlayers: lb.slice(0, 5),
    isLastQuestion: room.currentQuestionIndex >= room.questions.length - 1
  });

  broadcastToPlayers(room, (player) => {
    const ans = room.currentAnswers.get(player.id);
    const myRow = rankMap.get(player.id);
    const aheadRow = myRow && myRow.rank > 1 ? lb[myRow.rank - 2] : null;
    return {
      type: 'phase_reveal',
      questionIndex: room.currentQuestionIndex,
      correctIndex: q.correctIndex,
      correctOptionText: q.options[q.correctIndex] ?? '',
      pointsMultiplier: mult,
      doublePoints: mult === 2,
      isPoll,
      explanation: q.explanation || '',
      slideRef: q.slideRef || '',
      answered: Boolean(ans),
      yourOption: ans ? ans.optionIndex : null,
      isCorrect: isPoll ? Boolean(ans) : (ans ? ans.isCorrect : false),
      pointsEarned: ans ? ans.points : 0,
      totalScore: player.score,
      streak: player.streak,
      rank: myRow ? myRow.rank : null,
      totalPlayers: lb.length,
      aheadPlayer: aheadRow ? { name: aheadRow.name, diff: aheadRow.score - player.score } : null
    };
  });
}

function showLeaderboard(room) {
  clearRoomTimers(room);
  room.phase = 'LEADERBOARD';
  const lb = getSortedLeaderboard(room);
  const rankMap = new Map(lb.map((r) => [r.id, r]));

  sendJson(room.hostWs, {
    type: 'phase_leaderboard',
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    leaderboard: lb.slice(0, 12),
    allPlayers: lb,
    totalPlayers: lb.length,
    isLastQuestion: room.currentQuestionIndex >= room.questions.length - 1
  });

  broadcastToPlayers(room, (player) => {
    const myRow = rankMap.get(player.id);
    const aheadRow = myRow && myRow.rank > 1 ? lb[myRow.rank - 2] : null;
    return {
      type: 'phase_leaderboard',
      top5: lb.slice(0, 5),
      myRank: myRow ? myRow.rank : null,
      myScore: player.score,
      myStreak: player.streak,
      rankDelta: myRow ? myRow.rankDelta : 0,
      totalPlayers: lb.length,
      aheadPlayer: aheadRow ? { name: aheadRow.name, diff: aheadRow.score - player.score } : null
    };
  });
}

async function showPodium(room) {
  clearRoomTimers(room);
  room.phase = 'PODIUM';
  const lb = getSortedLeaderboard(room);
  const rankMap = new Map(lb.map((r) => [r.id, r]));

  const gradedStats = room.questionStats.filter((s) => !s.isPoll);
  const statsPool = gradedStats.length > 0 ? gradedStats : room.questionStats;
  const sortedStats = [...statsPool].sort((a, b) => a.accuracyPct - b.accuracyPct);
  const hardestQuestion = sortedStats[0] || null;
  const avgAccuracy = statsPool.length > 0
    ? Math.round(statsPool.reduce((s, x) => s + x.accuracyPct, 0) / statsPool.length)
    : 0;

  if (!room.reportSaved) {
    room.reportSaved = true;
    if (room.hostUserId) {
      try {
        const saved = await store.saveGameReport({
          hostUserId: room.hostUserId,
          roomCode: room.code,
          quizId: room.quizId || null,
          title: room.title,
          totalPlayers: lb.length,
          totalQuestions: room.questions.length,
          avgAccuracy,
          hardestQuestion,
          questionStats: room.questionStats,
          leaderboard: lb
        });
        room.lastReportId = saved && saved.id ? saved.id : null;
      } catch (err) {
        console.error('Failed to persist session report:', err);
      }
    }
  }

  sendJson(room.hostWs, {
    type: 'phase_podium',
    reportId: room.lastReportId || null,
    podium: lb.slice(0, 3),
    leaderboard: lb,
    totalPlayers: lb.length,
    totalQuestions: room.questions.length,
    avgAccuracy,
    hardestQuestion
  });

  broadcastToPlayers(room, (player) => {
    const myRow = rankMap.get(player.id);
    return {
      type: 'phase_podium',
      podium: lb.slice(0, 3),
      myRank: myRow ? myRow.rank : null,
      myScore: player.score,
      correctCount: player.correctCount,
      totalQuestions: room.questions.length,
      maxStreak: player.maxStreak,
      totalPlayers: lb.length
    };
  });
}

// ==================== SYSTEM & UTILITY REST API ====================
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'quizarena',
    activeRooms: rooms.size,
    uptimeSec: Math.round(process.uptime())
  });
});

app.get('/api/questions', (_req, res) => {
  res.json({
    total: QUESTIONS.length,
    uc1Count: QUESTIONS.filter((q) => q.deck === 'UC1').length,
    uc2Count: QUESTIONS.filter((q) => q.deck === 'UC2').length,
    questions: QUESTIONS
  });
});

app.get('/api/qr', async (req, res) => {
  try {
    const targetUrl = String(req.query.url || '');
    if (!targetUrl || targetUrl.length > 500) {
      return res.status(400).send('Invalid url');
    }
    const svg = await QRCode.toString(targetUrl, {
      type: 'svg',
      margin: 1,
      width: 240,
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (_err) {
    res.status(500).send('QR error');
  }
});

app.get('/api/room/:code/export.csv', async (req, res) => {
  try {
    const adminCandidate = req.headers['x-admin-token'] || req.query.token;
    const authCandidate = auth.extractToken(req) || adminCandidate;
    const authedUser = authCandidate ? await auth.verifyToken(authCandidate) : null;
    const isAdmin = isValidAdminToken(adminCandidate) || isValidAdminToken(authCandidate);

    if (!isAdmin && !authedUser) {
      return res.status(401).send('Unauthorized: Sign-in required to export room leaderboard.');
    }

    const room = rooms.get(String(req.params.code || '').trim());
    if (!room) return res.status(404).send('Room not found');

    if (!isAdmin && (!room.hostUserId || authedUser.id !== room.hostUserId)) {
      return res.status(403).send('Forbidden: Only the host of this room can export its results.');
    }

    const lb = getSortedLeaderboard(room);
    const csv = formatLeaderboardCsv(lb);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="quizarena-room-${room.code}.csv"`);
    return res.send(csv);
  } catch (_err) {
    return res.status(500).send('Failed to export room CSV.');
  }
});

// Express JSON error fallback
app.use((err, _req, res, _next) => {
  const status = err && err.status ? err.status : 500;
  res.status(status).json({
    ok: false,
    message: (err && err.message) || 'Internal server error.'
  });
});

// ==================== WEBSOCKET SERVER ====================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    try {
      await initPromise;
      const { type } = msg || {};

      // ---------- HOST CREATE ROOM ----------
      if (type === 'host_create_room') {
        let hostUser = msg.authToken ? await auth.verifyToken(msg.authToken) : null;
        const isAdmin = isValidAdminToken(msg.adminToken);
        if (!hostUser && !isAdmin && msg.adminToken) {
          hostUser = await auth.verifyToken(msg.adminToken);
        }

        if (!hostUser && !isAdmin) {
          sendJson(ws, {
            type: 'auth_error',
            message: 'Please sign in at /studio to host a quiz.'
          });
          return;
        }

        const shuffleOptions = msg.shuffleOptions !== false;
        const overrideTimeLimit = Number(msg.overrideTimeLimit) > 0
          ? Number(msg.overrideTimeLimit)
          : (!msg.quizId && Number(msg.defaultTimeLimit) > 0 ? Number(msg.defaultTimeLimit) : 0);

        let questions = [];
        let quizId = null;
        let deck = msg.deck || 'CUSTOM';
        let resolvedTitle = String(msg.roomTitle || '').trim();

        if (msg.quizId) {
          const quiz = await store.getQuiz(String(msg.quizId));
          if (!quiz) {
            sendJson(ws, { type: 'error', message: 'Quiz not found.' });
            return;
          }
          if (quiz.visibility === 'private' && !isAdmin && (!hostUser || hostUser.id !== quiz.ownerId)) {
            sendJson(ws, { type: 'auth_error', message: 'You do not have permission to host this private quiz.' });
            return;
          }
          await store.incrementQuizPlays(quiz.id);
          quizId = quiz.id;
          const count = Math.max(1, Math.min(quiz.questions.length, Number(msg.questionCount) || quiz.questions.length));
          questions = prepareRoomQuestions(quiz.questions.slice(0, count), {
            shuffleOptions,
            overrideTimeLimit,
            fallbackDeck: deck
          });
          if (!resolvedTitle) resolvedTitle = quiz.title || 'QuizArena Live';
        } else if (Array.isArray(msg.customQuestions) && msg.customQuestions.length > 0) {
          const normalized = validateAndNormalizeQuestions(
            msg.customQuestions,
            overrideTimeLimit || 20
          ).map((normQ, i) => ({
            ...normQ,
            deck: (msg.customQuestions[i] && msg.customQuestions[i].deck) || deck
          }));
          const count = Math.max(1, Math.min(normalized.length, Number(msg.questionCount) || normalized.length));
          questions = prepareRoomQuestions(normalized.slice(0, count), {
            shuffleOptions,
            overrideTimeLimit,
            fallbackDeck: deck
          });
          if (!resolvedTitle) resolvedTitle = 'QuizArena Live Quiz';
        } else {
          deck = msg.deck || 'BOTH';
          questions = buildQuestionList(deck, msg.questionCount, overrideTimeLimit, null);
          if (!flushShuffleIfDisabled(shuffleOptions)) {
            // Re-prepare without option shuffling when explicitly disabled on legacy deck
            let legacyPool;
            if (deck === 'UC1') legacyPool = QUESTIONS.filter((q) => q.deck === 'UC1');
            else if (deck === 'UC2') legacyPool = QUESTIONS.filter((q) => q.deck === 'UC2');
            else {
              const uc1 = QUESTIONS.filter((q) => q.deck === 'UC1');
              const uc2 = QUESTIONS.filter((q) => q.deck === 'UC2');
              legacyPool = [];
              const maxLen = Math.max(uc1.length, uc2.length);
              for (let i = 0; i < maxLen; i++) {
                if (i < uc1.length) legacyPool.push(uc1[i]);
                if (i < uc2.length) legacyPool.push(uc2[i]);
              }
            }
            const count = Math.max(1, Math.min(legacyPool.length, Number(msg.questionCount) || legacyPool.length));
            questions = prepareRoomQuestions(legacyPool.slice(0, count), {
              shuffleOptions: false,
              overrideTimeLimit,
              fallbackDeck: deck
            });
          }
          if (!resolvedTitle) resolvedTitle = 'APAC AI Expert Live Quiz';
        }

        if (!questions || questions.length === 0) {
          sendJson(ws, { type: 'error', message: 'Cannot create a room with 0 questions.' });
          return;
        }

        const code = generateRoomCode();
        const hostSecret = crypto.randomBytes(12).toString('hex');
        const maxPlayers = Math.max(5, Math.min(250, Number(msg.maxPlayers) || 100));

        const room = {
          code,
          hostSecret,
          hostWs: ws,
          hostUserId: hostUser ? hostUser.id : null,
          hostUserName: hostUser ? hostUser.name : ADMIN_USERNAME,
          quizId,
          title: resolvedTitle.slice(0, 100),
          deck,
          questions,
          maxPlayers,
          locked: false,
          phase: 'LOBBY',
          currentQuestionIndex: 0,
          questionStartedAt: 0,
          currentAnswers: new Map(),
          players: new Map(),
          questionStats: [],
          reportSaved: false,
          lastReportId: null,
          phaseTimer: null,
          botTimers: [],
          countThrottleTimer: null,
          createdAt: Date.now()
        };

        rooms.set(code, room);
        ws.role = 'host';
        ws.roomCode = code;

        sendJson(ws, {
          type: 'room_created',
          code,
          hostSecret,
          quizId: room.quizId,
          hostUserId: room.hostUserId,
          title: room.title,
          deck: room.deck,
          maxPlayers: room.maxPlayers,
          questionCount: room.questions.length,
          questions: room.questions.map((q) => ({
            id: q.id,
            type: q.type,
            deck: q.deck,
            category: q.category,
            slideRef: q.slideRef,
            question: q.question,
            timeLimit: q.timeLimit,
            pointsMultiplier: q.pointsMultiplier,
            doublePoints: Boolean(q.doublePoints),
            isPoll: Boolean(q.isPoll)
          }))
        });
        sendHostLobbyState(room);
        return;
      }

      // ---------- HOST REJOIN ----------
      if (type === 'host_rejoin') {
        const code = String(msg.code || '').replace(/\s+/g, '');
        const room = rooms.get(code);
        if (!room || room.hostSecret !== msg.hostSecret) {
          sendJson(ws, { type: 'error', message: 'Room expired or invalid host token.' });
          return;
        }
        room.hostWs = ws;
        ws.role = 'host';
        ws.roomCode = code;
        sendJson(ws, {
          type: 'room_created',
          code: room.code,
          hostSecret: room.hostSecret,
          quizId: room.quizId,
          hostUserId: room.hostUserId,
          reportId: room.lastReportId || null,
          title: room.title,
          deck: room.deck,
          maxPlayers: room.maxPlayers,
          questionCount: room.questions.length,
          phase: room.phase
        });
        sendHostLobbyState(room);
        return;
      }

      // ---------- PLAYER JOIN ----------
      if (type === 'player_join') {
        const code = String(msg.code || '').replace(/\s+/g, '');
        const room = rooms.get(code);
        if (!room) {
          sendJson(ws, { type: 'join_error', message: 'Room PIN not found. Double-check the 6-digit code!' });
          return;
        }

        const rawName = String(msg.name || '').trim().slice(0, 24);
        if (!rawName) {
          sendJson(ws, { type: 'join_error', message: 'Please enter your nickname to join.' });
          return;
        }

        // Check reconnect by playerId
        let player = msg.playerId ? room.players.get(msg.playerId) : null;
        if (player && !player.isBot) {
          player.ws = ws;
          ws.role = 'player';
          ws.roomCode = code;
          ws.playerId = player.id;
        } else {
          if (room.locked) {
            sendJson(ws, { type: 'join_error', message: 'This room is locked by the host.' });
            return;
          }
          if (room.players.size >= room.maxPlayers) {
            sendJson(ws, { type: 'join_error', message: `Room is full (${room.maxPlayers}/${room.maxPlayers} players).` });
            return;
          }

          let finalName = rawName;
          const existingNames = new Set(Array.from(room.players.values()).map((p) => p.name.toLowerCase()));
          if (existingNames.has(finalName.toLowerCase())) {
            finalName = `${rawName.slice(0, 19)}_${Math.floor(10 + Math.random() * 89)}`;
          }

          const playerId = crypto.randomBytes(8).toString('hex');
          player = {
            id: playerId,
            name: finalName,
            avatar: String(msg.avatar || '🚀').slice(0, 4),
            ws,
            score: 0,
            prevRank: null,
            streak: 0,
            maxStreak: 0,
            correctCount: 0,
            answeredCount: 0,
            totalResponseMs: 0,
            lastPoints: 0,
            isBot: false
          };
          room.players.set(playerId, player);
          ws.role = 'player';
          ws.roomCode = code;
          ws.playerId = playerId;
        }

        sendJson(ws, {
          type: 'joined_room',
          code: room.code,
          title: room.title,
          playerId: player.id,
          name: player.name,
          avatar: player.avatar,
          phase: room.phase,
          score: player.score,
          totalQuestions: room.questions.length
        });

        // Sync active question if joining mid-question
        if (room.phase === 'QUESTION') {
          const q = room.questions[room.currentQuestionIndex];
          const mult = getQuestionMultiplier(q);
          const remainingSec = Math.max(1, Math.ceil((room.questionStartedAt + q.timeLimit * 1000 - Date.now()) / 1000));
          sendJson(ws, {
            type: 'phase_question',
            questionIndex: room.currentQuestionIndex,
            totalQuestions: room.questions.length,
            questionType: q.options.length === 2 ? 'tf' : 'mcq',
            category: q.category || 'General',
            deck: q.deck || room.deck,
            slideRef: q.slideRef || '',
            question: q.question,
            options: q.options,
            timeLimit: remainingSec,
            pointsMultiplier: mult,
            doublePoints: mult === 2,
            isPoll: mult === 0,
            startedAt: Date.now(),
            alreadyAnswered: room.currentAnswers.has(player.id)
          });
        }

        sendHostLobbyState(room);
        return;
      }

      // ---------- PLAYER ANSWER ----------
      if (type === 'player_answer') {
        if (ws.role !== 'player' || !ws.roomCode || !ws.playerId) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const player = room.players.get(ws.playerId);
        if (!player) return;
        recordAnswer(room, player, msg.optionIndex);
        return;
      }

      // ---------- PLAYER LIVE REACTION ----------
      if (type === 'player_reaction') {
        if (ws.role !== 'player' || !ws.roomCode || !ws.playerId) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const player = room.players.get(ws.playerId);
        if (!player) return;
        const allowed = ['🔥', '🚀', '👏', '🤯', '🎉', '⚡'];
        const emoji = allowed.includes(msg.emoji) ? msg.emoji : '🔥';
        sendJson(room.hostWs, {
          type: 'live_reaction',
          emoji,
          name: player.name
        });
        return;
      }

      // ---------- HOST ACTIONS ----------
      if (ws.role !== 'host' || !ws.roomCode) return;
      const room = rooms.get(ws.roomCode);
      if (!room || room.hostWs !== ws) return;

      if (type === 'host_toggle_lock') {
        room.locked = !room.locked;
        sendHostLobbyState(room);
        return;
      }

      if (type === 'host_kick_player') {
        const target = room.players.get(msg.playerId);
        if (target) {
          if (!target.isBot && target.ws) {
            sendJson(target.ws, { type: 'kicked', message: 'You were removed from the room by the host.' });
            target.ws.role = null;
          }
          room.players.delete(msg.playerId);
          sendHostLobbyState(room);
        }
        return;
      }

      if (type === 'host_add_bots') {
        const want = Math.max(1, Math.min(100, Number(msg.count) || 10));
        const availableSlots = Math.max(0, room.maxPlayers - room.players.size);
        const toAdd = Math.min(want, availableSlots);
        const existingNames = new Set(Array.from(room.players.values()).map((p) => p.name.toLowerCase()));

        for (let i = 0; i < toAdd; i++) {
          const base = BOT_NAMES[(room.players.size + i) % BOT_NAMES.length];
          let botName = base;
          let suffix = 2;
          while (existingNames.has(botName.toLowerCase())) {
            botName = `${base}${suffix++}`;
          }
          existingNames.add(botName.toLowerCase());
          const botId = `bot_${crypto.randomBytes(6).toString('hex')}`;
          room.players.set(botId, {
            id: botId,
            name: botName,
            avatar: BOT_AVATARS[Math.floor(Math.random() * BOT_AVATARS.length)],
            ws: null,
            score: 0,
            prevRank: null,
            streak: 0,
            maxStreak: 0,
            correctCount: 0,
            answeredCount: 0,
            totalResponseMs: 0,
            lastPoints: 0,
            isBot: true,
            botSkill: 0.45 + Math.random() * 0.45
          });
        }
        sendHostLobbyState(room);
        return;
      }

      if (type === 'host_clear_bots') {
        for (const [id, p] of room.players.entries()) {
          if (p.isBot) room.players.delete(id);
        }
        sendHostLobbyState(room);
        return;
      }

      if (type === 'host_start_game') {
        if (room.players.size === 0) {
          sendJson(ws, { type: 'toast', message: 'Add at least 1 player (or simulate bots) before starting!' });
          return;
        }
        room.currentQuestionIndex = 0;
        room.questionStats = [];
        room.reportSaved = false;
        room.lastReportId = null;
        for (const p of room.players.values()) {
          p.score = 0;
          p.prevRank = null;
          p.streak = 0;
          p.maxStreak = 0;
          p.correctCount = 0;
          p.answeredCount = 0;
          p.totalResponseMs = 0;
          p.lastPoints = 0;
        }
        startGetReady(room);
        return;
      }

      if (type === 'host_skip_timer') {
        if (room.phase === 'QUESTION') {
          revealQuestion(room);
        }
        return;
      }

      if (type === 'host_show_leaderboard') {
        if (room.phase === 'REVEAL') {
          if (room.currentQuestionIndex >= room.questions.length - 1) {
            await showPodium(room);
          } else {
            showLeaderboard(room);
          }
        }
        return;
      }

      if (type === 'host_next_question') {
        if (room.phase === 'REVEAL' || room.phase === 'LEADERBOARD') {
          room.currentQuestionIndex++;
          if (room.currentQuestionIndex >= room.questions.length) {
            await showPodium(room);
          } else {
            startGetReady(room);
          }
        }
        return;
      }

      if (type === 'host_end_game') {
        await showPodium(room);
        return;
      }

      if (type === 'host_reset_room') {
        clearRoomTimers(room);
        room.phase = 'LOBBY';
        room.currentQuestionIndex = 0;
        room.questionStats = [];
        room.reportSaved = false;
        room.lastReportId = null;
        for (const p of room.players.values()) {
          p.score = 0;
          p.prevRank = null;
          p.streak = 0;
          p.maxStreak = 0;
          p.correctCount = 0;
          p.answeredCount = 0;
          p.totalResponseMs = 0;
          p.lastPoints = 0;
        }
        broadcastToPlayers(room, { type: 'back_to_lobby', title: room.title });
        sendHostLobbyState(room);
        return;
      }
    } catch (err) {
      sendJson(ws, { type: 'error', message: (err && err.message) || 'Action failed.' });
    }
  });

  ws.on('close', () => {
    if (ws.role === 'player' && ws.roomCode && ws.playerId) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        const player = room.players.get(ws.playerId);
        if (player && player.ws === ws) {
          player.ws = null;
          if (room.phase === 'LOBBY') {
            sendHostLobbyState(room);
          }
        }
      }
    }
  });
});

function flushShuffleIfDisabled(shuffleOptions) {
  return Boolean(shuffleOptions);
}

// Keep-alive heartbeat every 25s
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);
if (heartbeat.unref) heartbeat.unref();

// Cleanup stale rooms older than 6 hours
const cleanup = setInterval(() => {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [code, room] of rooms.entries()) {
    if (room.createdAt < cutoff && (!room.hostWs || room.hostWs.readyState !== 1)) {
      clearRoomTimers(room);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);
if (cleanup.unref) cleanup.unref();

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(cleanup);
});

if (require.main === module) {
  const gracefulShutdown = async () => {
    try {
      if (store && typeof store.flush === 'function') {
        await store.flush();
      }
    } catch (_err) {
      // Ignore flush errors on shutdown
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  initPromise
    .then(() => {
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`QuizArena Server listening on http://0.0.0.0:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('Failed to initialize QuizArena store:', err);
      process.exit(1);
    });
}

module.exports = { app, server, wss, store, auth, initPromise };
