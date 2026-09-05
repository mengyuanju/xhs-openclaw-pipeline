import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PASSWORD_HASH_PREFIX = 'scrypt-v1';
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 64;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_BYTES = 1_024;
const SCRYPT_OPTIONS = Object.freeze({
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
const REVIEW_ACCOUNT_ROLES = Object.freeze([
  'ADMIN',
  'REVIEWER',
  'USER',
  'QC_LEAD',
  'QUERY_REVIEWER',
  'COPY_REVIEWER',
]);
const DUMMY_PASSWORD_HASH = 'scrypt-v1.MDEyMzQ1Njc4OWFiY2RlZg.MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZg';

export const ADMIN_SESSION_COOKIE = 'xhs_admin_session';
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

export function serializeAdminSessionCookie(token, { secure = false, clear = false } = {}) {
  if (typeof token !== 'string' || (!clear && token.length === 0)) {
    throw new TypeError('session token is invalid');
  }
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=${clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${clear ? 0 : ADMIN_SESSION_SECONDS}`,
    'Priority=High',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function assertStrongPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new TypeError('admin password must contain at least 12 characters');
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new TypeError('admin password is too long');
  }
}

function decodeBase64Url(value, expectedBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) return null;
  return decoded;
}

function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const parts = encoded.split('.');
  if (parts.length !== 3 || parts[0] !== PASSWORD_HASH_PREFIX) return null;
  const salt = decodeBase64Url(parts[1], PASSWORD_SALT_BYTES);
  const digest = decodeBase64Url(parts[2], PASSWORD_KEY_BYTES);
  return salt && digest ? { salt, digest } : null;
}

export async function hashAdminPassword(password) {
  assertStrongPassword(password);
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const digest = await scrypt(password, salt, PASSWORD_KEY_BYTES, SCRYPT_OPTIONS);
  return `${PASSWORD_HASH_PREFIX}.${salt.toString('base64url')}.${Buffer.from(digest).toString('base64url')}`;
}

export async function verifyAdminPassword(password, encoded) {
  const parsed = parsePasswordHash(encoded);
  if (!parsed || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return false;
  }
  const actual = Buffer.from(await scrypt(password, parsed.salt, PASSWORD_KEY_BYTES, SCRYPT_OPTIONS));
  return timingSafeEqual(actual, parsed.digest);
}

function assertSessionSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new TypeError('session secret must contain at least 32 bytes');
  }
}

function signSessionPayload(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest();
}

/**
 * @param {string} secret
 * @param {{nowSeconds?: number, actor?: null | {userId: number, username: string, displayName?: string, roles: string[], credentialVersion: number, mustChangePassword?: boolean}}} options
 */
export function createSessionToken(secret, {
  nowSeconds = Math.floor(Date.now() / 1_000),
  actor = null,
} = {}) {
  assertSessionSecret(secret);
  if (!Number.isSafeInteger(nowSeconds)) {
    throw new TypeError('session timing is invalid');
  }
  let identity = { v: 1, sub: 'admin' };
  if (actor !== null) {
    if (!actor || !Number.isSafeInteger(actor.userId) || actor.userId < 1) {
      throw new TypeError('session user id is invalid');
    }
    if (typeof actor.username !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{2,49}$/u.test(actor.username)) {
      throw new TypeError('session username is invalid');
    }
    if (!Array.isArray(actor.roles) || actor.roles.length < 1) {
      throw new TypeError('session roles are invalid');
    }
    const roles = [...new Set(actor.roles)];
    if (roles.some((role) => !REVIEW_ACCOUNT_ROLES.includes(role))) {
      throw new TypeError('session role is invalid');
    }
    if (!Number.isSafeInteger(actor.credentialVersion) || actor.credentialVersion < 1) {
      throw new TypeError('session credential version is invalid');
    }
    identity = {
      v: 2,
      sub: 'user',
      uid: actor.userId,
      usr: actor.username,
      roles,
      cv: actor.credentialVersion,
      ...(typeof actor.displayName === 'string' && actor.displayName.trim()
        ? { nam: actor.displayName.trim().slice(0, 80) }
        : {}),
      ...(actor.mustChangePassword === true ? { mcp: true } : {}),
    };
  }
  const payload = Buffer.from(JSON.stringify({
    ...identity,
    iat: nowSeconds,
    exp: nowSeconds + ADMIN_SESSION_SECONDS,
    jti: randomBytes(16).toString('base64url'),
  })).toString('base64url');
  const signature = signSessionPayload(payload, secret).toString('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token, secret, {
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  if (typeof token !== 'string' || typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) return null;
  const actualSignature = decodeBase64Url(parts[1], 32);
  if (!actualSignature) return null;
  const expectedSignature = signSessionPayload(parts[0], secret);
  if (!timingSafeEqual(actualSignature, expectedSignature)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const isAdmin = payload?.v === 1 && payload?.sub === 'admin';
  const isReviewer = payload?.v === 2
    && payload?.sub === 'user'
    && Number.isSafeInteger(payload.uid)
    && payload.uid > 0
    && typeof payload.usr === 'string'
    && /^[a-z0-9][a-z0-9._-]{2,49}$/u.test(payload.usr)
    && Array.isArray(payload.roles)
    && payload.roles.length > 0
    && new Set(payload.roles).size === payload.roles.length
    && payload.roles.every((role) => REVIEW_ACCOUNT_ROLES.includes(role))
    && Number.isSafeInteger(payload.cv)
    && payload.cv > 0
    && (payload.nam === undefined || (typeof payload.nam === 'string' && payload.nam.length <= 80))
    && (payload.mcp === undefined || payload.mcp === true);
  if (
    (!isAdmin && !isReviewer)
    || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp)
    || !decodeBase64Url(payload.jti, 16)
    || payload.iat > nowSeconds + 60
    || payload.exp <= nowSeconds
    || payload.exp - payload.iat !== ADMIN_SESSION_SECONDS
  ) {
    return null;
  }
  if (isReviewer) {
    return {
      subject: 'user',
      userId: payload.uid,
      username: payload.usr,
      roles: payload.roles,
      credentialVersion: payload.cv,
      ...(payload.nam === undefined ? {} : { displayName: payload.nam }),
      ...(payload.mcp === true ? { mustChangePassword: true } : {}),
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  }
  return {
    subject: 'admin',
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

export { REVIEW_ACCOUNT_ROLES };

export function readAuthConfig(environment = process.env) {
  const passwordHash = environment.XHS_ADMIN_PASSWORD_HASH;
  const sessionSecret = environment.XHS_SESSION_SECRET;
  if (!parsePasswordHash(passwordHash)) return null;
  if (typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret, 'utf8') < 32) return null;
  return { passwordHash, sessionSecret };
}

export function readSessionConfig(environment = process.env) {
  const sessionSecret = environment.XHS_SESSION_SECRET;
  if (typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret, 'utf8') < 32) return null;
  return { sessionSecret };
}

export class LoginRateLimiter {
  #failures = [];

  constructor({ maxFailures = 5, windowMs = 15 * 60 * 1_000 } = {}) {
    if (!Number.isInteger(maxFailures) || maxFailures < 1) {
      throw new TypeError('maxFailures must be a positive integer');
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new TypeError('windowMs must be a positive integer');
    }
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
  }

  #prune(nowMs) {
    const cutoff = nowMs - this.windowMs;
    this.#failures = this.#failures.filter((timestamp) => timestamp > cutoff);
  }

  check(nowMs = Date.now()) {
    this.#prune(nowMs);
    if (this.#failures.length < this.maxFailures) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const retryAfterMs = Math.max(1, this.#failures[0] + this.windowMs - nowMs);
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1_000) };
  }

  recordFailure(nowMs = Date.now()) {
    this.#prune(nowMs);
    this.#failures.push(nowMs);
  }

  reset() {
    this.#failures = [];
  }
}

export async function attemptAdminLogin(password, {
  environment = process.env,
  limiter,
  nowMs = Date.now(),
}) {
  if (!(limiter instanceof LoginRateLimiter)) {
    throw new TypeError('login limiter is required');
  }
  const rateLimit = limiter.check(nowMs);
  if (!rateLimit.allowed) {
    return { status: 'blocked', retryAfterSeconds: rateLimit.retryAfterSeconds };
  }

  const config = readAuthConfig(environment);
  const isValid = config
    ? await verifyAdminPassword(password, config.passwordHash)
    : false;
  if (!isValid || !config) {
    limiter.recordFailure(nowMs);
    return { status: 'invalid' };
  }

  limiter.reset();
  return {
    status: 'authenticated',
    token: createSessionToken(config.sessionSecret),
    expiresInSeconds: ADMIN_SESSION_SECONDS,
  };
}

export async function attemptReviewUserLogin({
  username,
  password,
  lookupUser,
  sessionSecret,
  limiter,
  nowMs = Date.now(),
}) {
  if (!(limiter instanceof LoginRateLimiter)) throw new TypeError('login limiter is required');
  if (typeof lookupUser !== 'function') throw new TypeError('review user lookup is required');
  const rateLimit = limiter.check(nowMs);
  if (!rateLimit.allowed) {
    return { status: 'blocked', retryAfterSeconds: rateLimit.retryAfterSeconds };
  }
  const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const user = await lookupUser(normalizedUsername);
  const isValid = await verifyAdminPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
  if (!user || !isValid) {
    limiter.recordFailure(nowMs);
    return { status: 'invalid' };
  }
  limiter.reset();
  return {
    status: 'authenticated',
    token: createSessionToken(sessionSecret, {
      actor: {
        userId: user.id,
        username: user.username,
        roles: user.roles,
        credentialVersion: user.credentialVersion,
      },
    }),
    expiresInSeconds: ADMIN_SESSION_SECONDS,
  };
}
