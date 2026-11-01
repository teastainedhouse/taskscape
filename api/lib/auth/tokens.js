import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'tsk_';
const PREFIX_SHOWN = 12;

/** @returns {string} a fresh plaintext token */
export function generateToken() {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** @returns {string} a fresh sign-in session value (the password provider's cookie); 32 random bytes, base64url */
export function generateSessionToken() {
  return randomBytes(32).toString('base64url');
}

/** @param {string} value @returns {boolean} looks like a value generateSessionToken() made, so junk is never looked up */
export function isSessionToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** @param {string} plaintext @returns {string} sha256 hex */
export function hashToken(plaintext) {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** @param {string} plaintext @returns {string} the displayable prefix */
export function tokenPrefix(plaintext) {
  return plaintext.slice(0, PREFIX_SHOWN);
}

/** @param {string|null} authorization @returns {string|null} the bearer value, if any */
export function bearerFrom(authorization) {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return m ? m[1] : null;
}
