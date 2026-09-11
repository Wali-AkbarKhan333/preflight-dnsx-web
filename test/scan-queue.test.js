import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanQueue } from '../src/scan-queue.js';

function wait(ms = 10) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(check, timeout = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for condition');
    await wait(5);
  }
}

function fakeStore(initial) {
  const jobs = new Map(initial.map((job) => [job.id, { progress: 5, stage: 'Queued', ...job }]));
  return {
    async get(id) { const v = jobs.get(id); return v ? structuredClone(v) : null; },
    async update(id, patch) { const next = { ...jobs.get(id), ...patch }; jobs.set(id, next); return structuredClone(next); },
    jobs
  };
}

test('scan queue runs only one job at a time and then starts the next', async () => {
  const store = fakeStore([{ id:'a', status:'queued' }, { id:'b', status:'queued' }]);
  const releases = new Map();
  const started = [];
  let concurrent = 0;
  let maxConcurrent = 0;

  const runner = async (job, jobStore, deps) => {
    started.push(job.id);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await jobStore.update(job.id, { status:'running', stage:'Running' });
    await new Promise((resolve, reject) => {
      releases.set(job.id, resolve);
      deps.control.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name:'AbortError', code:'ABORT_ERR' })), { once:true });
    });
    concurrent -= 1;
    await jobStore.update(job.id, { status:'completed', stage:'Complete', progress:100 });
  };

  const queue = new ScanQueue({ store, runner, concurrency:1 });
  await queue.enqueue('a');
  await queue.enqueue('b');
  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ['a']);
  assert.equal((await store.get('b')).status, 'queued');
  releases.get('a')();
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ['a','b']);
  releases.get('b')();
  await waitFor(async () => (await store.get('b')).status === 'completed');
  assert.equal(maxConcurrent, 1);
});

test('queued job can be canceled without affecting the active job', async () => {
  const store = fakeStore([{ id:'a', status:'queued' }, { id:'b', status:'queued' }]);
  let releaseA;
  const runner = async (job, jobStore) => {
    await jobStore.update(job.id, { status:'running', stage:'Running' });
    await new Promise((resolve) => { if (job.id === 'a') releaseA = resolve; else resolve(); });
    await jobStore.update(job.id, { status:'completed', stage:'Complete', progress:100 });
  };
  const queue = new ScanQueue({ store, runner, concurrency:1 });
  await queue.enqueue('a');
  await queue.enqueue('b');
  await waitFor(() => Boolean(releaseA));
  await queue.cancel('b');
  assert.equal((await store.get('b')).status, 'canceled');
  assert.equal((await store.get('a')).status, 'running');
  releaseA();
});

test('canceling the active job aborts it and allows the next queued job to start', async () => {
  const store = fakeStore([{ id:'a', status:'queued' }, { id:'b', status:'queued' }]);
  const started = [];
  let releaseB;
  const runner = async (job, jobStore, deps) => {
    started.push(job.id);
    await jobStore.update(job.id, { status:'running', stage:'Running' });
    if (job.id === 'a') {
      await new Promise((resolve, reject) => {
        deps.control.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name:'AbortError', code:'ABORT_ERR' })), { once:true });
      });
    } else {
      await new Promise((resolve) => { releaseB = resolve; });
      await jobStore.update(job.id, { status:'completed', stage:'Complete', progress:100 });
    }
  };

  const queue = new ScanQueue({ store, runner, concurrency:1 });
  await queue.enqueue('a');
  await queue.enqueue('b');
  await waitFor(() => started.includes('a'));
  await queue.cancel('a');
  await waitFor(() => started.includes('b'));
  assert.equal((await store.get('a')).status, 'canceled');
  assert.equal((await store.get('b')).status, 'running');
  releaseB();
});
