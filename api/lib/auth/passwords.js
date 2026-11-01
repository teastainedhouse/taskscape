import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { serviceUnavailable } from '../errors.js';

// scrypt parameters for new hashes. Stored with each hash, so raising them later
// does not break existing passwords (they verify with the parameters they were made with).
const N = 2 ** 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// scrypt needs about 128 * N * r * p bytes; Node's default limit is exactly that, which is too tight.
const maxmemFor = (n, r, p) => 256 * n * r * p;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

// Each scrypt holds ~32 MB and a libuv thread for tens of milliseconds, so at most
// MAX_ACTIVE run at once in this process and at most MAX_QUEUED wait; past that the
// caller gets 503 instead of the server running out of memory or threads.
const MAX_ACTIVE = 2;
const MAX_QUEUED = 16;
let active = 0;
/** @type {Array<() => void>} */
const queue = [];

/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
async function gated(fn) {
  if (active >= MAX_ACTIVE) {
    if (queue.length >= MAX_QUEUED) throw serviceUnavailable(1);
    await new Promise((resolve) => queue.push(resolve));
  } else {
    active++;
  }
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next(); // hand the slot straight to the next waiter
    else active--;
  }
}

/** @param {string} plain @param {Buffer} salt @param {number} n @param {number} r @param {number} p @param {number} len @returns {Promise<Buffer>} */
function derive(plain, salt, n, r, p, len) {
  return gated(() => new Promise((resolve, reject) => {
    scrypt(plain.normalize('NFC'), salt, len, { N: n, r, p, maxmem: maxmemFor(n, r, p) }, (err, key) => (err ? reject(err) : resolve(key)));
  }));
}

/**
 * A hash of a random password nobody knows, made once per process with the current
 * parameters. Verified against when the user is unknown or disabled, so the response
 * takes as long as a real wrong password and timing does not reveal which usernames exist.
 * @type {Promise<string>|null}
 */
let dummyHash = null;

/** Build the dummy hash ahead of the first sign-in (createApp calls this for the password provider). */
export function warmDummyHash() {
  if (!dummyHash) {
    dummyHash = hashPassword(randomBytes(32).toString('base64'));
    dummyHash.catch(() => { dummyHash = null; }); // a 503 while warming is retried on next use
  }
  return dummyHash;
}

/**
 * What is wrong with a proposed new password, or null. Counts characters, not bytes.
 * @param {unknown} plain
 * @returns {string|null}
 */
export function passwordProblem(plain) {
  if (typeof plain !== 'string') return 'must be a string';
  const length = [...plain].length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) return `must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`;
  return null;
}

/**
 * @param {string} plain
 * @returns {Promise<string>} `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`
 */
export async function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plain, salt, N, R, P, KEY_BYTES);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Check a password against a stored hash. A malformed hash or out-of-range
 * parameters verify as false instead of throwing or running an unbounded scrypt.
 * @param {string} plain
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plain, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (!Number.isInteger(n) || n < 2 || n > 2 ** 20 || (n & (n - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length < 16 || expected.length > 128) return false;
  const actual = await derive(plain, salt, n, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * Spend the same time as a real verify, for an unknown or disabled user. Always false.
 * @param {string} plain
 * @returns {Promise<false>}
 */
export async function verifyDummy(plain) {
  await verifyPassword(plain, await warmDummyHash());
  return false;
}
