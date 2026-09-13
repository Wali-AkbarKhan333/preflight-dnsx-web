import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRcodeOutput, runScan } from '../src/scanner.js';

test('parses dnsx rcode text output used by the status retry pass', () => {
  const rows = parseRcodeOutput([
    'nomx.example.com [NOERROR]',
    'dead.example.com [NXDOMAIN]',
    'slow.example.com [SERVFAIL]',
    'blocked.example.com [REFUSED]'
  ].join('\n'), '1.1.1.1');

  assert.deepEqual(rows.map((row) => [row.host, row.status_code]), [
    ['nomx.example.com', 'NOERROR'],
    ['dead.example.com', 'NXDOMAIN'],
    ['slow.example.com', 'SERVFAIL'],
    ['blocked.example.com', 'REFUSED']
  ]);
  assert.ok(rows.every((row) => row.resolver === '1.1.1.1'));
});

test('scanner uses MX JSON first, then RCODE status retry for missing MX output', async () => {
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
    const isJsonMxPass = args.includes('-json') && args.includes('-mx');
    const lines = [];

    if (isJsonMxPass) {
      // Mimic current dnsx JSON record-type filtering: positive/null MX rows are
      // present, but NO_MX/NXDOMAIN/SERVFAIL rows may be omitted entirely.
      for (const d of domains) {
        if (d.startsWith('live.')) lines.push(JSON.stringify({ host: d, mx: [`mx.${d}`], status_code: 'NOERROR' }));
        else if (d.startsWith('null.')) lines.push(JSON.stringify({ host: d, mx: [''], status_code: 'NOERROR' }));
      }
    } else {
      for (const d of domains) {
        if (d.startsWith('nomx.')) lines.push(`${d} [NOERROR]`);
        else if (d.startsWith('dead.')) lines.push(`${d} [NXDOMAIN]`);
        else lines.push(`${d} [SERVFAIL]`);
      }
    }

    await fs.writeFile(output, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
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
  const previousRetryResolvers = process.env.UNKNOWN_RETRY_RESOLVERS;
  process.env.SCAN_CHUNK_SIZE = '1000';
  process.env.UNKNOWN_RETRY_RESOLVERS = '1.1.1.1';
  try {
    await runScan(job, store, { dnsx: fakeDnsx, runProcess: fakeRunProcess });
  } finally {
    if (previousChunk == null) delete process.env.SCAN_CHUNK_SIZE; else process.env.SCAN_CHUNK_SIZE = previousChunk;
    if (previousRetryResolvers == null) delete process.env.UNKNOWN_RETRY_RESOLVERS; else process.env.UNKNOWN_RETRY_RESOLVERS = previousRetryResolvers;
  }

  assert.equal(job.status, 'completed');
  assert.equal(job.progress, 100);
  assert.equal(job.summary.totalDomains, 5);
  assert.equal(job.summary.mailEnabled, 1);
  assert.equal(job.summary.noMx, 1);
  assert.equal(job.summary.nullMx, 1);
  assert.equal(job.summary.dnsFailed, 1);
  assert.equal(job.summary.unknown, 1);

  const mxCalls = invocations.filter((args) => args.includes('-json') && args.includes('-mx'));
  const statusCalls = invocations.filter((args) => args.includes('-rcode') && !args.includes('-json') && !args.includes('-mx'));
  assert.ok(mxCalls.length >= 1);
  assert.ok(statusCalls.length >= 1);
  assert.ok(updates.some((u) => String(u.stage || '').startsWith('DNS status retry via')));
  assert.ok(updates.some((u) => u.summary?.stageTotal === 3 && u.summary?.stageProcessed > 0));

  await fs.rm(root, { recursive: true, force: true });
});
