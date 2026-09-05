import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PREFIX = 'scrypt-v1';
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const OPTIONS = Object.freeze({ N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function passwordText(password) {
  if (typeof password !== 'string' || password.length < 6) {
    throw new TypeError('password must contain at least 6 characters');
  }
  if (Buffer.byteLength(password, 'utf8') > 1_024) throw new TypeError('password is too long');
  return password;
}

function parsedHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const [prefix, rawSalt, rawDigest, extra] = encoded.split('.');
  if (prefix !== PREFIX || extra !== undefined) return null;
  try {
    const salt = Buffer.from(rawSalt, 'base64url');
    const digest = Buffer.from(rawDigest, 'base64url');
    if (salt.length !== SALT_BYTES || digest.length !== KEY_BYTES) return null;
    if (salt.toString('base64url') !== rawSalt || digest.toString('base64url') !== rawDigest) return null;
    return { salt, digest };
  } catch {
    return null;
  }
}

export async function hashUserPassword(password) {
  const value = passwordText(password);
  const salt = randomBytes(SALT_BYTES);
  const digest = Buffer.from(await scrypt(value, salt, KEY_BYTES, OPTIONS));
  return `${PREFIX}.${salt.toString('base64url')}.${digest.toString('base64url')}`;
}

export async function verifyUserPassword(password, encoded) {
  const parsed = parsedHash(encoded);
  if (!parsed || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1_024) return false;
  const actual = Buffer.from(await scrypt(password, parsed.salt, KEY_BYTES, OPTIONS));
  return timingSafeEqual(actual, parsed.digest);
}
