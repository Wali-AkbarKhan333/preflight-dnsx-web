import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleDomainColumns, writeCsvFile } from '../src/csv.js';

test('CSV writer accepts asynchronous row streams and leaves an atomic final file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-preflight-csv-'));
  try {
    const file = path.join(root, 'domains.csv');
    async function* rows() {
      yield 'first.example';
      await Promise.resolve();
      yield 'second.example';
    }

    await writeCsvFile(file, rows(), simpleDomainColumns);

    assert.equal(await fs.readFile(file, 'utf8'), 'domain\nfirst.example\nsecond.example\n');
    await assert.rejects(fs.access(`${file}.tmp`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
