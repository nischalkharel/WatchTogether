// Password hashing for offline accounts. scrypt is built into Node, slow and
// memory-hard on purpose, so a stolen database can't be cracked quickly.
// Stored format: scrypt$N$r$p$salt$hash (base64url), so the cost can be
// raised later without breaking existing passwords.
import crypto from 'node:crypto';
import { ApiError } from './errors.js';

const PARAMS = { N: 2 ** 15, r: 8, p: 1 }; // ~32 MB and ~50-100 ms per check
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  );
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  let key;
  try {
    key = await scrypt(password, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Same work as a real check, for usernames that don't exist.
let dummy = null;
export async function verifyDummy(password) {
  dummy ??= hashPassword('not-a-real-password-' + crypto.randomUUID());
  await verifyPassword(password, await dummy);
  return false;
}

// Usernames: 3-30 of a-z 0-9 . _ - (case-insensitive). Private login names,
// never shown to anyone else.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$/;
export function normalizeUsername(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return USERNAME_RE.test(s) ? s : null;
}

// Long enough to resist guessing; no other composition rules (they don't help).
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop',
  'iloveyou', 'iloveyou1', 'sunshine1', 'princess1', 'football1', 'baseball1', 'welcome1', 'abc12345',
  'letmein1', 'trustno1', 'qwerty123', '11111111', '00000000', 'passw0rd', 'watchtogether',
]);
export const MIN_PASSWORD = 10;
export function checkPassword(password, username) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) throw new ApiError(400, 'weak-password');
  if (password.length > 200) throw new ApiError(400, 'bad-password');
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || (username && lower.includes(username)) || /^(.)\1+$/.test(password)) {
    throw new ApiError(400, 'common-password');
  }
}
