function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || /aborted|cancell?ed/i.test(String(error?.message || ''));
}

export class ScanQueue {
  constructor({ store, runner, concurrency = 1 }) {
    this.store = store;
    this.runner = runner;
    this.concurrency = Math.max(1, Math.min(4, Number(concurrency) || 1));
    this.pending = [];
    this.active = new Map();
    this.pumping = false;
  }

  snapshot() {
    return {
      concurrency: this.concurrency,
      activeJobIds: [...this.active.keys()],
      queuedJobIds: [...this.pending]
    };
  }

  async enqueue(jobId) {
    const job = await this.store.get(jobId);
    if (!job || job.status !== 'queued') return job;
    if (!this.pending.includes(jobId) && !this.active.has(jobId)) this.pending.push(jobId);
    await this.refreshQueueStages();
    this.pump();
    return this.store.get(jobId);
  }

  async recover(jobs = []) {
    const ordered = [...jobs].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    for (const job of ordered) {
      if (job.status === 'running') {
        await this.store.update(job.id, {
          status: 'canceled',
          stage: 'Interrupted by server restart',
          error: 'The scan process stopped when the application restarted.'
        });
      } else if (job.status === 'queued') {
        if (!this.pending.includes(job.id)) this.pending.push(job.id);
      }
    }
    await this.refreshQueueStages();
    this.pump();
  }

  async cancel(jobId) {
    const job = await this.store.get(jobId);
    if (!job) return null;

    if (job.status === 'queued') {
      this.pending = this.pending.filter((id) => id !== jobId);
      const updated = await this.store.update(jobId, {
        status: 'canceled',
        stage: 'Canceled before start',
        error: null
      });
      await this.refreshQueueStages();
      this.pump();
      return updated;
    }

    if (job.status === 'running') {
      const active = this.active.get(jobId);
      if (!active) {
        return this.store.update(jobId, {
          status: 'canceled',
          stage: 'Canceled',
          error: null
        });
      }
      await this.store.update(jobId, { stage: 'Canceling…' });
      active.controller.abort();
      return this.store.get(jobId);
    }

    return job;
  }

  async refreshQueueStages() {
    const updates = this.pending.map(async (id, index) => {
      const job = await this.store.get(id);
      if (!job || job.status !== 'queued') return;
      const position = index + 1;
      const stage = this.active.size
        ? `Queued · position ${position} · waiting for active scan`
        : `Queued · position ${position}`;
      await this.store.update(id, { stage, progress: 5 });
    });
    await Promise.all(updates);
  }

  pump() {
    if (this.pumping) return;
    this.pumping = true;

    queueMicrotask(async () => {
      try {
        while (this.active.size < this.concurrency && this.pending.length) {
          const id = this.pending.shift();
          const job = await this.store.get(id);
          if (!job || job.status !== 'queued') continue;

          const controller = new AbortController();
          this.active.set(id, { controller });
          await this.refreshQueueStages();
          this.runOne(job, controller).catch(() => {});
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  async runOne(job, controller) {
    try {
      await this.runner(job, this.store, { control: { signal: controller.signal } });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        await this.store.update(job.id, {
          status: 'canceled',
          stage: 'Canceled',
          error: null
        }).catch(() => {});
      } else {
        await this.store.update(job.id, {
          status: 'failed',
          stage: 'Failed',
          progress: 100,
          error: error?.message || String(error)
        }).catch(() => {});
      }
    } finally {
      this.active.delete(job.id);
      await this.refreshQueueStages().catch(() => {});
      this.pump();
    }
  }
}
