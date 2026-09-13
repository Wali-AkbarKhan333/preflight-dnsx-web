import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScan } from '../src/scanner.js';

function makeStore(jobDir, job) {
  return {
    dir: () => jobDir,
    file: (_id, name) => path.join(jobDir, name),
    async get() { return structuredClone(job); },
    async update(_id, patch) { Object.assign(job, patch); return structuredClone(job); },
    async loadCheckpoint() {
      try { return JSON.parse(await fs.readFile(path.join(jobDir, 'checkpoint.json'), 'utf8')); }
      catch { return null; }
    },
    async saveCheckpoint(_id, checkpoint) {
      await fs.writeFile(path.join(jobDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
      return checkpoint;
    }
  };
}

function noMxRunner({ failOnCall = 0, calls = [], firstDomains = [] } = {}) {
  let count = 0;
  return async (_command, args) => {
    count += 1;
    let input = '';
    let output = '';
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-l') input = args[i + 1];
      if (args[i] === '-o') output = args[i + 1];
    }
    const domains = (await fs.readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean);
    calls.push(domains.length);
    firstDomains.push(domains[0]);
    if (failOnCall && count === failOnCall) throw new Error('simulated dnsx interruption');
    const lines = domains.map((domain) => JSON.stringify({ host: domain, status_code: 'NOERROR', resolver: '1.1.1.1' }));
    await fs.writeFile(output, `${lines.join('\n')}\n`);
    return { code: 0, stderr: '' };
  };
}

async function setupJob(root, domainCount) {
  const jobDir = path.join(root, 'job1');
  await fs.mkdir(jobDir, { recursive: true });
  const domains = Array.from({ length: domainCount }, (_, i) => `d${String(i).padStart(4, '0')}.example.test`);
  const records = domains.map((domain) => ({ input: domain, domain, inputType: 'domain' }));
  await fs.writeFile(path.join(jobDir, 'input-domains.txt'), `${domains.join('\n')}\n`);
  await fs.writeFile(path.join(jobDir, 'source-records.json'), JSON.stringify(records));
  const job = { id: 'job1', status: 'queued', settings: { threads: 5, rateLimit: 50 } };
  return { jobDir, domains, job, store: makeStore(jobDir, job) };
}

test('scanner resumes from the last completed main-scan checkpoint instead of domain 1', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-preflight-resume-'));
  const oldChunk = process.env.SCAN_CHUNK_SIZE;
  process.env.SCAN_CHUNK_SIZE = '1000';
  try {
    const { jobDir, domains, job, store } = await setupJob(root, 2001);
    const fakeDnsx = { path: 'fake-dnsx', versionOutput: 'test' };
    const firstCalls = [];
    await assert.rejects(
      runScan(job, store, { dnsx: fakeDnsx, runProcess: noMxRunner({ failOnCall: 2, calls: firstCalls }) }),
      /simulated dnsx interruption/
    );

    const checkpoint = await store.loadCheckpoint('job1');
    assert.equal(checkpoint.phase, 'main');
    assert.equal(checkpoint.mainProcessed, 1000);
    assert.equal(firstCalls[0], 1000);

    const resumedFirstDomains = [];
    await runScan(job, store, { dnsx: fakeDnsx, runProcess: noMxRunner({ firstDomains: resumedFirstDomains }) });

    assert.equal(job.status, 'completed');
    assert.equal(job.summary.totalDomains, 2001);
    assert.equal(job.summary.noMx, 2001);
    assert.equal(resumedFirstDomains[0], domains[1000]);
    assert.notEqual(resumedFirstDomains[0], domains[0]);
    const finalCheckpoint = await store.loadCheckpoint('job1');
    assert.equal(finalCheckpoint.phase, 'completed');
  } finally {
    if (oldChunk == null) delete process.env.SCAN_CHUNK_SIZE; else process.env.SCAN_CHUNK_SIZE = oldChunk;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('finalization checkpoint resumes without performing DNS lookups again', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-preflight-finalize-'));
  try {
    const { jobDir, domains, job, store } = await setupJob(root, 3);
    const dnsLines = [
      { host: domains[0], mx: [`mx.${domains[0]}`], status_code: 'NOERROR', resolver: '1.1.1.1' },
      { host: domains[1], status_code: 'NOERROR', resolver: '1.1.1.1' },
      { host: domains[2], status_code: 'NXDOMAIN', resolver: '1.1.1.1' }
    ].map(JSON.stringify).join('\n');
    await fs.writeFile(path.join(jobDir, 'dns.jsonl'), `${dnsLines}\n`);
    await fs.writeFile(path.join(jobDir, 'attempts.log'), `${domains.join('\n')}\n`);
    await store.saveCheckpoint('job1', {
      version: 1,
      phase: 'finalizing',
      totalDomains: 3,
      mainProcessed: 3,
      retryCandidates: 0,
      retryResolverCount: 3,
      retryResolverIndex: 0,
      retryOffset: 0,
      retryWorkCompleted: 0,
      activeElapsedMs: 1234,
      updatedAt: new Date().toISOString()
    });

    let dnsCalls = 0;
    await runScan(job, store, {
      dnsx: { path: 'fake-dnsx', versionOutput: 'test' },
      runProcess: async () => { dnsCalls += 1; throw new Error('DNS should not run during finalization resume'); }
    });

    assert.equal(dnsCalls, 0);
    assert.equal(job.status, 'completed');
    assert.equal(job.summary.mxEnabledDomains, 1);
    assert.equal(job.summary.noMx, 1);
    assert.equal(job.summary.dnsFailed, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanner resumes inside an uncertain-domain retry pass from its retry checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-preflight-retry-resume-'));
  const oldChunk = process.env.SCAN_CHUNK_SIZE;
  const oldRetryResolvers = process.env.UNKNOWN_RETRY_RESOLVERS;
  process.env.SCAN_CHUNK_SIZE = '1000';
  process.env.UNKNOWN_RETRY_RESOLVERS = '1.1.1.1,8.8.8.8';
  try {
    const { domains, job, store } = await setupJob(root, 1001);
    const fakeDnsx = { path: 'fake-dnsx', versionOutput: 'test' };
    let call = 0;
    const firstRun = async (_command, args) => {
      call += 1;
      let input = '';
      let output = '';
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '-l') input = args[i + 1];
        if (args[i] === '-o') output = args[i + 1];
      }
      const values = (await fs.readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean);
      // Two main chunks, then one successful retry chunk, then interrupt the second retry chunk.
      if (call === 4) throw new Error('retry interrupted');
      const lines = values.map((domain) => JSON.stringify({ host: domain, status_code: 'SERVFAIL', resolver: '1.1.1.1' }));
      await fs.writeFile(output, `${lines.join('\n')}\n`);
      return { code:0, stderr:'' };
    };

    await assert.rejects(runScan(job, store, { dnsx: fakeDnsx, runProcess: firstRun }), /retry interrupted/);
    const checkpoint = await store.loadCheckpoint('job1');
    assert.equal(checkpoint.phase, 'retry');
    assert.equal(checkpoint.retryResolverIndex, 0);
    assert.equal(checkpoint.retryOffset, 1000);

    const resumedFirstDomains = [];
    const resumedRunner = async (_command, args) => {
      let input = '';
      let output = '';
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '-l') input = args[i + 1];
        if (args[i] === '-o') output = args[i + 1];
      }
      const values = (await fs.readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean);
      resumedFirstDomains.push(values[0]);
      const lines = values.map((domain) => JSON.stringify({ host: domain, status_code: 'SERVFAIL', resolver: '8.8.8.8' }));
      await fs.writeFile(output, `${lines.join('\n')}\n`);
      return { code:0, stderr:'' };
    };

    await runScan(job, store, { dnsx: fakeDnsx, runProcess: resumedRunner });
    assert.equal(resumedFirstDomains[0], domains[1000]);
    assert.equal(job.status, 'completed');
    assert.equal(job.summary.unknown, 1001);
  } finally {
    if (oldChunk == null) delete process.env.SCAN_CHUNK_SIZE; else process.env.SCAN_CHUNK_SIZE = oldChunk;
    if (oldRetryResolvers == null) delete process.env.UNKNOWN_RETRY_RESOLVERS; else process.env.UNKNOWN_RETRY_RESOLVERS = oldRetryResolvers;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retry resolver transition replays a pass when its worklist is ahead of the checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-preflight-retry-transition-'));
  const oldRetryResolvers = process.env.UNKNOWN_RETRY_RESOLVERS;
  process.env.UNKNOWN_RETRY_RESOLVERS = '1.1.1.1,8.8.8.8';
  try {
    const { jobDir, domains, job, store } = await setupJob(root, 3);
    const retryPassFile = path.join(jobDir, 'retry-pass-domains.txt');
    const dnsLines = domains.map((domain) => JSON.stringify({
      host: domain,
      status_code: 'SERVFAIL',
      resolver: '1.1.1.1'
    })).join('\n');
    await fs.writeFile(path.join(jobDir, 'dns.jsonl'), `${dnsLines}\n`, 'utf8');
    await fs.writeFile(path.join(jobDir, 'attempts.log'), `${domains.join('\n')}\n`, 'utf8');
    await fs.writeFile(retryPassFile, `${domains[1]}\n${domains[2]}\n`, 'utf8');
    await store.saveCheckpoint('job1', {
      version: 1,
      phase: 'retry',
      totalDomains: 3,
      mainProcessed: 3,
      retryCandidates: 3,
      retryResolverCount: 2,
      retryResolverIndex: 0,
      retryOffset: 3,
      retryWorkCompleted: 3,
      retryMode: 'rcode-status-v1',
      retryRemaining: 3,
      activeElapsedMs: 0,
      updatedAt: new Date().toISOString()
    });

    const checkpointWorklists = [];
    const originalSaveCheckpoint = store.saveCheckpoint.bind(store);
    store.saveCheckpoint = async (id, checkpoint) => {
      if (checkpoint.retryResolverIndex === 1) {
        checkpointWorklists.push(await fs.readFile(retryPassFile, 'utf8'));
      }
      return originalSaveCheckpoint(id, checkpoint);
    };

    const calls = [];
    const runner = async (_command, args) => {
      const input = args[args.indexOf('-l') + 1];
      const output = args[args.indexOf('-o') + 1];
      const resolver = args[args.indexOf('-r') + 1];
      const values = (await fs.readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean);
      calls.push({ resolver, values });
      const lines = values.map((domain) => {
        if (resolver === '1.1.1.1' && domain === domains[1]) return `${domain} [NOERROR]`;
        return `${domain} [SERVFAIL]`;
      });
      await fs.writeFile(output, `${lines.join('\n')}\n`, 'utf8');
      return { code: 0, stderr: '' };
    };

    await runScan(job, store, {
      dnsx: { path: 'fake-dnsx', versionOutput: 'test' },
      runProcess: runner
    });

    assert.deepEqual(calls[0], { resolver: '1.1.1.1', values: [domains[1], domains[2]] });
    assert.equal(calls[1].resolver, '8.8.8.8');
    assert.deepEqual(checkpointWorklists[0].trim().split(/\r?\n/), [domains[1], domains[2]]);
    assert.equal(job.status, 'completed');
    assert.equal(job.summary.noMx, 1);
    assert.equal(job.summary.unknown, 2);
    assert.equal(job.summary.mxEnabledDomains + job.summary.noMx + job.summary.nullMx + job.summary.dnsFailed + job.summary.unknown, 3);
  } finally {
    if (oldRetryResolvers == null) delete process.env.UNKNOWN_RETRY_RESOLVERS; else process.env.UNKNOWN_RETRY_RESOLVERS = oldRetryResolvers;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy v2.6 MX-only retry checkpoint migrates to RCODE status retry without restarting main scan', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-preflight-legacy-retry-'));
  const oldRetryResolvers = process.env.UNKNOWN_RETRY_RESOLVERS;
  process.env.UNKNOWN_RETRY_RESOLVERS = '1.1.1.1';
  try {
    const { jobDir, domains, job, store } = await setupJob(root, 4);
    await fs.writeFile(path.join(jobDir, 'dns.jsonl'), '', 'utf8');
    await fs.writeFile(path.join(jobDir, 'attempts.log'), `${domains.join('\n')}\n`, 'utf8');
    await fs.writeFile(path.join(jobDir, 'retry-pass-domains.txt'), `${domains.join('\n')}\n`, 'utf8');
    await store.saveCheckpoint('job1', {
      version: 1,
      phase: 'retry',
      totalDomains: 4,
      mainProcessed: 4,
      retryCandidates: 4,
      retryResolverCount: 3,
      retryResolverIndex: 0,
      retryOffset: 2,
      retryWorkCompleted: 2,
      activeElapsedMs: 500,
      updatedAt: new Date().toISOString()
      // Deliberately no retryMode: this represents v2.6.0.
    });

    const firstDomains = [];
    let sawMxJson = false;
    const runner = async (_command, args) => {
      const input = args[args.indexOf('-l') + 1];
      const output = args[args.indexOf('-o') + 1];
      const values = (await fs.readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean);
      firstDomains.push(values[0]);
      sawMxJson ||= args.includes('-json') || args.includes('-mx');
      await fs.writeFile(output, `${values.map((domain) => `${domain} [NOERROR]`).join('\n')}\n`, 'utf8');
      return { code: 0, stderr: '' };
    };

    await runScan(job, store, {
      dnsx: { path: 'fake-dnsx', versionOutput: 'test' },
      runProcess: runner
    });

    assert.equal(sawMxJson, false, 'main MX scan must not restart');
    assert.equal(firstDomains[0], domains[0], 'legacy retry offset must be reset for the new status pass');
    assert.equal(job.status, 'completed');
    assert.equal(job.summary.noMx, 4);
    assert.equal(job.summary.unknown, 0);
  } finally {
    if (oldRetryResolvers == null) delete process.env.UNKNOWN_RETRY_RESOLVERS; else process.env.UNKNOWN_RETRY_RESOLVERS = oldRetryResolvers;
    await fs.rm(root, { recursive: true, force: true });
  }
});
