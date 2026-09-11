import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../src/db.js';
import { JobStore } from '../src/store.js';
import { hashPassword } from '../src/auth.js';

test('jobs are isolated by user in history queries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-preflight-store-'));
  const db = new AppDatabase(path.join(dir, 'app.db'));
  const store = new JobStore(path.join(dir, 'jobs'), db);
  await store.init();
  try {
    const p1 = await hashPassword('first-user-password');
    const p2 = await hashPassword('second-user-password');
    const u1 = db.createUser({ username: 'one', ...p1, role: 'user' });
    const u2 = db.createUser({ username: 'two', ...p2, role: 'user' });

    await store.create({ userId: u1.id, sourceName: 'one.csv', records: [{ input:'a.com', domain:'a.com', inputType:'domain' }], uniqueDomains:['a.com'], parseStats:{uniqueDomains:1}, settings:{} });
    await store.create({ userId: u2.id, sourceName: 'two.csv', records: [{ input:'b.com', domain:'b.com', inputType:'domain' }], uniqueDomains:['b.com'], parseStats:{uniqueDomains:1}, settings:{} });

    const one = await store.list(20, { userId: u1.id });
    const two = await store.list(20, { userId: u2.id });
    assert.equal(one.length, 1);
    assert.equal(one[0].sourceName, 'one.csv');
    assert.equal(two.length, 1);
    assert.equal(two[0].sourceName, 'two.csv');
  } finally {
    db.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
