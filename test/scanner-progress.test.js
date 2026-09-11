import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScan } from '../src/scanner.js';

test('fast scanner classifies MX/rcode results in one chunked pass', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-preflight-scan-'));
  const fakeDnsx = { path: 'fake-dnsx', versionOutput: '[INF] Current Version: test' };
  const invocations = [];
  const fakeRunProcess = async (_command, args) => {
    invocations.push([...args]);
    let input = '';
    let output = '';
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-l') input = args[i + 1];
      if (args[i] === '-o') output = args[i + 1];
    }

    const domains = (await fs.readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean);
    const lines = [];
    for (const d of domains) {
      if (d.startsWith('live.')) lines.push(JSON.stringify({ host: d, mx: [`mx.${d}`], status_code: 'NOERROR' }));
      else if (d.startsWith('nomx.')) lines.push(JSON.stringify({ host: d, status_code: 'NOERROR' }));
      else if (d.startsWith('null.')) lines.push(JSON.stringify({ host: d, mx: [''], status_code: 'NOERROR' }));
      else if (d.startsWith('dead.')) lines.push(JSON.stringify({ host: d, status_code: 'NXDOMAIN' }));
      else lines.push(JSON.stringify({ host: d, status_code: 'SERVFAIL' }));
    }
    await fs.writeFile(output, `${lines.join('\n')}\n`, 'utf8');
    return { code: 0, stderr: '' };
  };

  const jobDir = path.join(root, 'job1');
  await fs.mkdir(jobDir, { recursive: true });
  const domains = ['live.example.com', 'nomx.example.com', 'null.example.com', 'dead.example.com', 'unknown.example.com'];
  const records = domains.map((domain) => ({ input: domain, domain, inputType: 'domain' }));
  await fs.writeFile(path.join(jobDir, 'input-domains.txt'), `${domains.join('\n')}\n`);
  await fs.writeFile(path.join(jobDir, 'source-records.json'), JSON.stringify(records));

  const job = { id: 'job1', settings: { threads: 5, rateLimit: 50 } };
  const updates = [];
  const store = {
    dir: () => jobDir,
    file: (_id, name) => path.join(jobDir, name),
    async update(_id, patch) {
      Object.assign(job, patch);
      updates.push(structuredClone(patch));
      return job;
    }
  };

  const previousChunk = process.env.SCAN_CHUNK_SIZE;
  process.env.SCAN_CHUNK_SIZE = '2';
  try {
    await runScan(job, store, { dnsx: fakeDnsx, runProcess: fakeRunProcess });
  } finally {
    if (previousChunk == null) delete process.env.SCAN_CHUNK_SIZE; else process.env.SCAN_CHUNK_SIZE = previousChunk;
  }

  assert.equal(job.status, 'completed');
  assert.equal(job.progress, 100);
  assert.equal(job.summary.totalDomains, 5);
  assert.equal(job.summary.mailEnabled, 1);
  assert.equal(job.summary.noMx, 1);
  assert.equal(job.summary.nullMx, 1);
  assert.equal(job.summary.dnsFailed, 1);
  assert.equal(job.summary.unknown, 1);
  assert.ok(updates.some((u) => u.summary?.stageProcessed > 0 && u.progress < 100));
  assert.ok(updates.some((u) => String(u.stage || '').startsWith('Fast MX preflight ·')));
  assert.ok(invocations.length >= 1);
  for (const args of invocations) {
    assert.ok(args.includes('-mx'));
    assert.ok(args.includes('-rcode'));
    assert.ok(!args.includes('-aaaa'));
    assert.ok(!args.includes('-ns'));
  }

  await fs.rm(root, { recursive: true, force: true });
});
