import { LoginRateLimiter } from './auth.mjs';

const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ACCOUNTS = 100;

function assertUsername(username) {
  if (typeof username !== 'string' || username.length < 1) {
    throw new TypeError('username is required');
  }
  return username;
}

export function createLoginRateLimitStore({
  maxAccounts = DEFAULT_MAX_ACCOUNTS,
  accountMaxFailures = 5,
  globalMaxFailures = 50,
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  if (!Number.isInteger(maxAccounts) || maxAccounts < 1) {
    throw new TypeError('maxAccounts must be a positive integer');
  }

  const accountLimiters = new Map();
  const globalLimiter = new LoginRateLimiter({ maxFailures: globalMaxFailures, windowMs });

  function limiterFor(username) {
    const key = assertUsername(username);
    const existing = accountLimiters.get(key);
    if (existing) {
      accountLimiters.delete(key);
      accountLimiters.set(key, existing);
      return existing;
    }
    if (accountLimiters.size >= maxAccounts) {
      accountLimiters.delete(accountLimiters.keys().next().value);
    }
    const limiter = new LoginRateLimiter({ maxFailures: accountMaxFailures, windowMs });
    accountLimiters.set(key, limiter);
    return limiter;
  }

  return Object.freeze({
    check(username, nowMs = Date.now()) {
      const globalStatus = globalLimiter.check(nowMs);
      if (!globalStatus.allowed) return { ...globalStatus, scope: 'global' };
      return { ...limiterFor(username).check(nowMs), scope: 'account' };
    },

    recordFailure(username, nowMs = Date.now()) {
      globalLimiter.recordFailure(nowMs);
      limiterFor(username).recordFailure(nowMs);
    },

    resetAccount(username) {
      const key = assertUsername(username);
      const limiter = accountLimiters.get(key);
      if (!limiter) return false;
      limiter.reset();
      accountLimiters.delete(key);
      return true;
    },

    resetAll() {
      const clearedAccountCount = accountLimiters.size;
      globalLimiter.reset();
      accountLimiters.clear();
      return { clearedAccountCount };
    },
  });
}

// Route handlers are compiled separately. globalThis keeps both handlers on the
// same limiter state and also preserves it across development module reloads.
const runtimeKey = Symbol.for('xhs.login-rate-limits.v1');
export const loginRateLimitStore = globalThis[runtimeKey]
  ??= createLoginRateLimitStore();
