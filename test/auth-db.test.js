import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../src/db.js';
import { hashPassword, verifyPassword, newSessionToken, hashSessionToken } from '../src/auth.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-preflight-'));
  return { dir, file: path.join(dir, 'app.db') };
}

test('user passwords are hashed and sessions resolve to the user', async () => {
  const { dir, file } = tempDb();
  const db = new AppDatabase(file);
  try {
    const credentials = await hashPassword('correct-horse-battery-staple');
    const user = db.createUser({ username: 'admin', ...credentials, role: 'admin' });
    const raw = db.getUserByUsername('ADMIN');
    assert.equal(raw.username, 'admin');
    assert.equal(await verifyPassword('correct-horse-battery-staple', raw), true);
    assert.equal(await verifyPassword('wrong-password', raw), false);

    const token = newSessionToken();
    db.createSession({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const session = db.getSession(hashSessionToken(token));
    assert.equal(session.user.username, 'admin');
    assert.equal(session.user.role, 'admin');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('last active administrator cannot be disabled', async () => {
  const { dir, file } = tempDb();
  const db = new AppDatabase(file);
  try {
    const credentials = await hashPassword('a-strong-admin-password');
    const admin = db.createUser({ username: 'admin', ...credentials, role: 'admin' });
    assert.throws(() => db.updateUser(admin.id, { isActive: false }), /last active administrator/i);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
