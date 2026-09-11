import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!/^[a-z0-9][a-z0-9._@-]{2,63}$/.test(username)) {
    const error = new Error('Username must be 3–64 characters and use letters, numbers, dot, underscore, @ or hyphen.');
    error.status = 400;
    throw error;
  }
  return username;
}

export function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < 10) {
    const error = new Error('Password must be at least 10 characters.');
    error.status = 400;
    throw error;
  }
  if (password.length > 256) {
    const error = new Error('Password is too long.');
    error.status = 400;
    throw error;
  }
  return password;
}

export async function hashPassword(password) {
  const checked = validatePassword(password);
  const salt = crypto.randomBytes(24);
  const derived = await scrypt(checked, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { passwordHash: Buffer.from(derived).toString('hex'), passwordSalt: salt.toString('hex') };
}

export async function verifyPassword(password, userRow) {
  if (!userRow?.password_hash || !userRow?.password_salt) return false;
  const salt = Buffer.from(userRow.password_salt, 'hex');
  const expected = Buffer.from(userRow.password_hash, 'hex');
  const derived = await scrypt(String(password ?? ''), salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const actual = Buffer.from(derived);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isActive: row.is_active == null ? Boolean(row.isActive) : Boolean(row.is_active)
  };
}
