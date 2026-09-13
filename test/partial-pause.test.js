import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScanQueue } from '../src/scan-queue.js';
import { buildPartialArtifacts, PARTIAL_DOWNLOADS } from '../src/partial-reports.js';

function wait(ms = 10) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(check, timeout = 1500) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for condition');
    await wait(5);
  }
}

function fakeQueueStore(initial) {
  const jobs = new Map(initial.map((job) => [job.id, { progress: 5, stage: 'Queued', ...job }]));
  const checkpoints = new Map();
  return {
    async get(id) { const v = jobs.get(id); return v ? structuredClone(v) : null; },
    async update(id, patch) { const next = { ...jobs.get(id), ...patch }; jobs.set(id, next); return structuredClone(next); },
    async loadCheckpoint(id) { return checkpoints.get(id) || null; },
    async checkpointExists(id) { const cp = checkpoints.get(id); return Boolean(cp && cp.phase !== 'completed'); },
    jobs,
    checkpoints
  };
}

test('pause waits for runner checkpoint, marks job resumable, and exposes partial downloads', async () => {
  const store = fakeQueueStore([{ id: 'a', status: 'queued', resumable: false, summary: { totalDomains: 5000, processedDomains: 0 } }]);
  let calls = 0;
  const runner = async (job, jobStore, deps) => {
    calls += 1;
    await jobStore.update(job.id, { status: 'running', stage: 'Running' });
    if (calls === 1) {
      while (!deps.control.isPauseRequested()) await wait(5);
      store.checkpoints.set(job.id, { version: 1, phase: 'main', mainProcessed: 1000, totalDomains: 5000, activeElapsedMs: 100 });
      const error = new Error('pause');
      error.name = 'PauseRequested';
      error.code = 'PAUSE_REQUESTED';
      throw error;
    }
    await jobStore.update(job.id, { status: 'completed', stage: 'Complete', progress: 100, resumable: false });
  };
  const partialBuilder = async (_id, _store, options) => {
    assert.equal(options.generateFiles, false);
    return { downloads: [...PARTIAL_DOWNLOADS], summary: { totalDomains: 5000, processedDomains: 1000, unprocessedDomains: 4000, partial: true } };
  };

  const queue = new ScanQueue({ store, runner, partialBuilder, concurrency: 1 });
  await queue.enqueue('a');
  await waitFor(async () => (await store.get('a')).status === 'running');
  await queue.pause('a');
  await waitFor(async () => (await store.get('a')).status === 'paused');
  const paused = await store.get('a');
  assert.equal(paused.resumable, true);
  assert.equal(paused.summary.processedDomains, 1000);
  assert.ok(paused.downloads.includes('partial-all-results.csv'));

  await queue.resume('a');
  await waitFor(async () => (await store.get('a')).status === 'completed');
  assert.equal(calls, 2);
});

test('partial artifacts contain only checkpointed domains and list unprocessed domains separately', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-preflight-partial-'));
  const jobDir = path.join(root, 'job1');
  await fs.mkdir(jobDir, { recursive: true });
  try {
    const domains = ['a.test', 'b.test', 'c.test'];
    const records = [
      { input: 'alice@a.test', inputType: 'email', domain: 'a.test' },
      { input: 'b.test', inputType: 'domain', domain: 'b.test' },
      { input: 'carol@c.test', inputType: 'email', domain: 'c.test' }
    ];
    await fs.writeFile(path.join(jobDir, 'input-domains.txt'), `${domains.join('\n')}\n`);
    await fs.writeFile(path.join(jobDir, 'source-records.json'), JSON.stringify(records));
    await fs.writeFile(path.join(jobDir, 'dns.jsonl'), [
      JSON.stringify({ host: 'a.test', mx: ['mx.a.test'], status_code: 'NOERROR', resolver: '1.1.1.1' }),
      JSON.stringify({ host: 'b.test', status_code: 'NOERROR', resolver: '1.1.1.1' })
    ].join('\n') + '\n');
    await fs.writeFile(path.join(jobDir, 'attempts.log'), 'a.test\nb.test\n');
    await fs.writeFile(path.join(jobDir, 'checkpoint.json'), JSON.stringify({
      version: 1,
      phase: 'main',
      mainProcessed: 2,
      totalDomains: 3,
      activeElapsedMs: 1000,
      updatedAt: new Date().toISOString()
    }));

    const job = {
      id: 'job1', status: 'paused', filesDeleted: false,
      summary: { totalDomains: 3, elapsedSeconds: 1 },
      parseStats: { uniqueDomains: 3 },
      dnsx: { mainResolvers: ['1.1.1.1'], retryResolvers: ['1.1.1.1'] }
    };
    const store = {
      file: (_id, name) => path.join(jobDir, name),
      async get() { return structuredClone(job); },
      async loadCheckpoint() { return JSON.parse(await fs.readFile(path.join(jobDir, 'checkpoint.json'), 'utf8')); }
    };

    const patch = await buildPartialArtifacts('job1', store, { generateFiles: true });
    assert.equal(patch.summary.totalDomains, 3);
    assert.equal(patch.summary.processedDomains, 2);
    assert.equal(patch.summary.unprocessedDomains, 1);
    assert.equal(patch.summary.mxEnabledDomains, 1);
    assert.equal(patch.summary.mxEnabledEmails, 1);
    assert.equal(patch.summary.noMx, 1);

    const partialDomains = (await fs.readFile(path.join(jobDir, 'partial-domain-results.csv'), 'utf8')).trim().split(/\r?\n/);
    assert.equal(partialDomains.length, 3); // header + 2 checkpointed domains
    const unprocessed = (await fs.readFile(path.join(jobDir, 'unprocessed-domains.csv'), 'utf8')).trim().split(/\r?\n/);
    assert.deepEqual(unprocessed, ['domain', 'c.test']);
    const mxEmails = await fs.readFile(path.join(jobDir, 'partial-mx-enabled-emails.csv'), 'utf8');
    assert.match(mxEmails, /alice@a\.test/);
    assert.doesNotMatch(mxEmails, /carol@c\.test/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
