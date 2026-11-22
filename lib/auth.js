'use strict';

const crypto = require('crypto');

const USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_KEYLEN = 64;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function createAuthError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  return err;
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email || null,
    name: user.name,
    role: user.role === 'superadmin' ? 'superadmin' : 'creator',
    isGuest: false,
    createdAt: user.createdAt
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [salt, keyHex] = parts;
  try {
    const keyBuf = Buffer.from(keyHex, 'hex');
    if (keyBuf.length === 0) return false;
    const derivedBuf = crypto.scryptSync(String(password), salt, keyBuf.length);
    if (keyBuf.length !== derivedBuf.length) return false;
    return crypto.timingSafeEqual(keyBuf, derivedBuf);
  } catch {
    return false;
  }
}

function generateSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function createAuth(store) {
  if (!store) {
    throw new Error('createAuth requires a store instance');
  }

  // Activate a pre-authorized email account (open registration is strictly disabled)
  function registerUser({ email, password, name } = {}) {
    const cleanEmail = String(email ?? '').trim().toLowerCase();
    if (!cleanEmail || cleanEmail.length > 254 || !EMAIL_REGEX.test(cleanEmail)) {
      throw createAuthError(400, 'Please provide a valid email address.');
    }

    const authEntry = store.getAuthorizedEntry(cleanEmail);
    if (!authEntry) {
      throw createAuthError(
        403,
        'This email is not authorized to create a creator account. Contact an administrator to request access.'
      );
    }

    const existing = store.getUserByEmail(cleanEmail);
    if (existing && existing.passwordHash) {
      throw createAuthError(409, 'This account is already activated. Please use Sign In.');
    }

    const cleanName = String(name ?? authEntry.name ?? '').trim();
    if (!cleanName) {
      throw createAuthError(400, 'Name is required.');
    }

    const rawPassword = typeof password === 'string' ? password : String(password ?? '');
    if (rawPassword.length < 6) {
      throw createAuthError(400, 'Password must be at least 6 characters long.');
    }

    const passwordHash = hashPassword(rawPassword);
    const user = store.createUser({
      email: cleanEmail,
      name: cleanName.slice(0, 80),
      passwordHash,
      role: authEntry.role || 'creator'
    });

    const token = generateSessionToken();
    store.saveAuthSession(token, {
      userId: user.id,
      expiresAt: Date.now() + USER_SESSION_TTL_MS
    });

    return {
      user: sanitizeUser(user),
      token
    };
  }

  function loginUser({ email, password } = {}) {
    let cleanEmail = String(email ?? '').trim().toLowerCase();
    const rawPassword = typeof password === 'string' ? password : '';

    if (!cleanEmail || !rawPassword) {
      throw createAuthError(401, 'Invalid email or password.');
    }

    // Convenience shorthand: 'admin' maps to the configured Super Admin email
    if (cleanEmail === 'admin' && typeof store.getSuperAdminEmail === 'function') {
      cleanEmail = store.getSuperAdminEmail();
    }

    if (!store.isEmailAuthorized(cleanEmail)) {
      throw createAuthError(403, 'This account is not authorized for Creator Studio access.');
    }

    const user = store.getUserByEmail(cleanEmail);
    if (!user || user.isGuest || !user.passwordHash || !verifyPassword(rawPassword, user.passwordHash)) {
      throw createAuthError(401, 'Invalid email or password.');
    }

    const authEntry = store.getAuthorizedEntry(cleanEmail);
    const effectiveUser = {
      ...user,
      role: (authEntry && authEntry.role === 'superadmin') || user.role === 'superadmin' ? 'superadmin' : 'creator'
    };

    const token = generateSessionToken();
    store.saveAuthSession(token, {
      userId: user.id,
      expiresAt: Date.now() + USER_SESSION_TTL_MS
    });

    return {
      user: sanitizeUser(effectiveUser),
      token
    };
  }

  function createGuestUser() {
    throw createAuthError(
      403,
      'Guest creator access is disabled. Only authorized accounts may sign in.'
    );
  }

  function changePassword({ userId, currentPassword, newPassword } = {}) {
    const user = store.getUserById(userId);
    if (!user || !user.passwordHash) {
      throw createAuthError(404, 'User account not found.');
    }
    if (!verifyPassword(String(currentPassword || ''), user.passwordHash)) {
      throw createAuthError(401, 'Current password is incorrect.');
    }
    const nextPass = String(newPassword || '');
    if (nextPass.length < 6) {
      throw createAuthError(400, 'New password must be at least 6 characters.');
    }
    const updated = store.updateUserPassword(user.id, hashPassword(nextPass));
    return sanitizeUser(updated);
  }

  function authorizeAccount({ email, name, role = 'creator', initialPassword = '', addedBy = 'admin' } = {}) {
    const cleanEmail = String(email ?? '').trim().toLowerCase();
    if (!cleanEmail || cleanEmail.length > 254 || !EMAIL_REGEX.test(cleanEmail)) {
      throw createAuthError(400, 'Please enter a valid email address.');
    }
    const cleanName = String(name || cleanEmail.split('@')[0]).trim().slice(0, 80);
    const normalizedRole = role === 'superadmin' ? 'superadmin' : 'creator';

    const entry = store.addAuthorizedEmail({
      email: cleanEmail,
      name: cleanName,
      role: normalizedRole,
      addedBy
    });

    const trimmedPass = String(initialPassword || '');
    if (trimmedPass) {
      if (trimmedPass.length < 6) {
        throw createAuthError(400, 'Initial password must be at least 6 characters (or leave blank for user activation).');
      }
      store.createUser({
        email: cleanEmail,
        name: cleanName,
        passwordHash: hashPassword(trimmedPass),
        role: entry.role
      });
    }

    return store.listAuthorizedAccounts().find((a) => a.email === cleanEmail);
  }

  function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const cleanToken = token.trim();
    if (!cleanToken) return null;

    const session = store.getAuthSession(cleanToken);
    if (!session || !session.userId) return null;

    const expMs =
      typeof session.expiresAt === 'number'
        ? session.expiresAt
        : Date.parse(String(session.expiresAt || ''));
    if (Number.isFinite(expMs) && expMs > 0 && Date.now() > expMs) {
      store.deleteAuthSession(cleanToken);
      return null;
    }

    const user = store.getUserById(session.userId);
    if (!user || user.isGuest || !user.email || !store.isEmailAuthorized(user.email)) {
      store.deleteAuthSession(cleanToken);
      return null;
    }

    const authEntry = store.getAuthorizedEntry(user.email);
    return sanitizeUser({
      ...user,
      role: (authEntry && authEntry.role === 'superadmin') || user.role === 'superadmin' ? 'superadmin' : 'creator'
    });
  }

  function extractToken(req) {
    if (!req || typeof req !== 'object') return null;

    const headers = req.headers || {};
    const authHeader = headers.authorization || headers.Authorization;
    if (typeof authHeader === 'string') {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match && match[1] && match[1].trim()) {
        return match[1].trim();
      }
    }

    const headerToken = headers['x-auth-token'] || headers['X-Auth-Token'];
    if (typeof headerToken === 'string' && headerToken.trim()) {
      return headerToken.trim();
    }

    if (req.query && typeof req.query.token === 'string' && req.query.token.trim()) {
      return req.query.token.trim();
    }

    if (req.body && typeof req.body.token === 'string' && req.body.token.trim()) {
      return req.body.token.trim();
    }

    return null;
  }

  function requireAuth(req, res, next) {
    const token = extractToken(req);
    const user = token ? verifyToken(token) : null;
    if (!user) {
      return res.status(401).json({
        ok: false,
        message: 'Authorized creator sign-in required.'
      });
    }
    req.user = user;
    req.authToken = token;
    return next();
  }

  function requireSuperAdmin(req, res, next) {
    return requireAuth(req, res, () => {
      if (!req.user || req.user.role !== 'superadmin') {
        return res.status(403).json({
          ok: false,
          message: 'Super Admin access required.'
        });
      }
      return next();
    });
  }

  function optionalAuth(req, _res, next) {
    const token = extractToken(req);
    const user = token ? verifyToken(token) : null;
    req.user = user || null;
    req.authToken = user ? token : null;
    return next();
  }

  return {
    registerUser,
    loginUser,
    createGuestUser,
    changePassword,
    authorizeAccount,
    verifyToken,
    extractToken,
    requireAuth,
    requireSuperAdmin,
    optionalAuth,
    sanitizeUser
  };
}

module.exports = {
  createAuth
};
