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

test('v2.5 automatically adds resume columns to an existing v2.4 jobs table', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { dir, file } = tempDb();
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        parse_stats_json TEXT NOT NULL DEFAULT '{}',
        settings_json TEXT NOT NULL DEFAULT '{}',
        summary_json TEXT,
        error TEXT,
        downloads_json TEXT NOT NULL DEFAULT '[]',
        preview_json TEXT NOT NULL DEFAULT '[]',
        dnsx_json TEXT,
        files_deleted INTEGER NOT NULL DEFAULT 0
      );
    `);
  } finally {
    legacy.close();
  }

  const db = new AppDatabase(file);
  try {
    const columns = new Set(db.db.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name));
    assert.equal(columns.has('resumable'), true);
    assert.equal(columns.has('checkpoint_json'), true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
