function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || /aborted|cancell?ed/i.test(String(error?.message || ''));
}

function isPauseError(error) {
  return error?.name === 'PauseRequested' || error?.code === 'PAUSE_REQUESTED';
}

export class ScanQueue {
  constructor({ store, runner, concurrency = 1, partialBuilder = null }) {
    this.store = store;
    this.runner = runner;
    this.partialBuilder = partialBuilder;
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

  async buildPartialPatch(jobId) {
    if (!this.partialBuilder) return {};
    try {
      return await this.partialBuilder(jobId, this.store, { generateFiles: false }) || {};
    } catch (error) {
      console.error(`Could not build partial reports for ${jobId}:`, error?.message || error);
      return {};
    }
  }

  async enqueue(jobId) {
    const job = await this.store.get(jobId);
    if (!job || job.status !== 'queued') return job;
    if (!this.pending.includes(jobId) && !this.active.has(jobId)) this.pending.push(jobId);
    await this.refreshQueueStages();
    this.pump();
    return this.store.get(jobId);
  }

  async resume(jobId) {
    const job = await this.store.get(jobId);
    if (!job) return null;
    if (!['interrupted', 'failed', 'paused'].includes(job.status) || !job.resumable) return job;
    const hasCheckpoint = typeof this.store.checkpointExists === 'function'
      ? await this.store.checkpointExists(jobId)
      : Boolean(job.resumable);
    if (!hasCheckpoint) {
      return this.store.update(jobId, {
        resumable: false,
        checkpoint: null,
        error: 'The saved checkpoint is unavailable, so this job cannot be resumed.'
      });
    }
    await this.store.update(jobId, {
      status: 'queued',
      stage: 'Queued for resume',
      error: null,
      resumable: true
    });
    return this.enqueue(jobId);
  }

  async recover(jobs = []) {
    const ordered = [...jobs].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    for (const job of ordered) {
      if (job.status === 'running') {
        const checkpoint = typeof this.store.loadCheckpoint === 'function' ? await this.store.loadCheckpoint(job.id) : null;
        const resumable = Boolean(checkpoint && checkpoint.version === 1 && checkpoint.phase !== 'completed');
        let updated = await this.store.update(job.id, {
          status: 'interrupted',
          stage: resumable ? 'Interrupted by server restart · checkpoint preserved' : 'Interrupted by server restart',
          error: resumable
            ? 'The server restarted. Progress through the last completed checkpoint was preserved.'
            : 'The scan process stopped when the application restarted. No resumable checkpoint was available.',
          resumable,
          checkpoint: resumable ? publicCheckpoint(checkpoint) : null
        });
        if (resumable) {
          const partialPatch = await this.buildPartialPatch(job.id);
          if (Object.keys(partialPatch).length) updated = await this.store.update(job.id, partialPatch);
        }
      } else if (job.status === 'queued') {
        if (!this.pending.includes(job.id)) this.pending.push(job.id);
      } else if (['interrupted', 'failed', 'paused', 'canceled'].includes(job.status)) {
        const checkpoint = typeof this.store.loadCheckpoint === 'function' ? await this.store.loadCheckpoint(job.id).catch(() => null) : null;
        if (checkpoint && checkpoint.version === 1 && checkpoint.phase !== 'completed' && Number(checkpoint.mainProcessed || 0) > 0) {
          const partialPatch = await this.buildPartialPatch(job.id);
          if (Object.keys(partialPatch).length) await this.store.update(job.id, partialPatch).catch(() => {});
        }
      }
    }
    await this.refreshQueueStages();
    this.pump();
  }

  async pause(jobId) {
    const job = await this.store.get(jobId);
    if (!job) return null;
    if (job.status !== 'running') return job;
    const active = this.active.get(jobId);
    if (!active) return job;
    active.pauseRequested = true;
    return this.store.update(jobId, {
      stage: 'Pausing after current checkpoint batch…',
      resumable: true
    });
  }

  async cancel(jobId) {
    const job = await this.store.get(jobId);
    if (!job) return null;

    if (job.status === 'queued') {
      this.pending = this.pending.filter((id) => id !== jobId);
      const updated = await this.store.update(jobId, {
        status: 'canceled',
        stage: 'Canceled before start',
        error: null,
        resumable: false
      });
      await this.refreshQueueStages();
      this.pump();
      return updated;
    }

    if (job.status === 'running') {
      const active = this.active.get(jobId);
      if (!active) {
        const partialPatch = await this.buildPartialPatch(jobId);
        return this.store.update(jobId, {
          status: 'canceled',
          stage: 'Canceled · checkpointed results preserved',
          error: null,
          resumable: false,
          ...partialPatch
        });
      }
      active.pauseRequested = false;
      await this.store.update(jobId, { stage: 'Canceling…', resumable: false });
      active.controller.abort();
      return this.store.get(jobId);
    }

    if (['paused', 'interrupted', 'failed'].includes(job.status)) {
      const partialPatch = await this.buildPartialPatch(jobId);
      return this.store.update(jobId, {
        status: 'canceled',
        stage: 'Canceled · checkpointed results preserved',
        error: null,
        resumable: false,
        ...partialPatch
      });
    }

    return job;
  }

  async refreshQueueStages() {
    const updates = this.pending.map(async (id, index) => {
      const job = await this.store.get(id);
      if (!job || job.status !== 'queued') return;
      const position = index + 1;
      const action = job.resumable ? 'resume' : 'scan';
      const stage = this.active.size
        ? `Queued to ${action} · position ${position} · waiting for active scan`
        : `Queued to ${action} · position ${position}`;
      await this.store.update(id, { stage, progress: Math.max(5, Number(job.progress || 0)) });
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

          const activeState = { controller: new AbortController(), pauseRequested: false };
          this.active.set(id, activeState);
          await this.refreshQueueStages();
          this.runOne(job, activeState).catch(() => {});
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  async runOne(job, activeState) {
    try {
      await this.runner(job, this.store, {
        control: {
          signal: activeState.controller.signal,
          isPauseRequested: () => activeState.pauseRequested
        }
      });
    } catch (error) {
      if (isPauseError(error)) {
        const checkpoint = typeof this.store.loadCheckpoint === 'function' ? await this.store.loadCheckpoint(job.id).catch(() => null) : null;
        const resumable = Boolean(checkpoint && checkpoint.version === 1 && checkpoint.phase !== 'completed');
        let updated = await this.store.update(job.id, {
          status: 'paused',
          stage: resumable ? 'Paused · checkpoint saved' : 'Paused',
          error: null,
          resumable,
          checkpoint: resumable ? publicCheckpoint(checkpoint) : null
        }).catch(() => null);
        if (updated && resumable) {
          const partialPatch = await this.buildPartialPatch(job.id);
          if (Object.keys(partialPatch).length) await this.store.update(job.id, partialPatch).catch(() => {});
        }
      } else if (activeState.controller.signal.aborted || isAbortError(error)) {
        const checkpoint = typeof this.store.loadCheckpoint === 'function' ? await this.store.loadCheckpoint(job.id).catch(() => null) : null;
        let updated = await this.store.update(job.id, {
          status: 'canceled',
          stage: checkpoint ? 'Canceled · checkpointed results preserved' : 'Canceled',
          error: null,
          resumable: false,
          checkpoint: checkpoint ? publicCheckpoint(checkpoint) : null
        }).catch(() => null);
        if (updated && checkpoint) {
          const partialPatch = await this.buildPartialPatch(job.id);
          if (Object.keys(partialPatch).length) await this.store.update(job.id, partialPatch).catch(() => {});
        }
      } else {
        const checkpoint = typeof this.store.loadCheckpoint === 'function' ? await this.store.loadCheckpoint(job.id).catch(() => null) : null;
        const resumable = Boolean(checkpoint && checkpoint.version === 1 && checkpoint.phase !== 'completed');
        let updated = await this.store.update(job.id, {
          status: resumable ? 'interrupted' : 'failed',
          stage: resumable ? 'Interrupted · checkpoint preserved' : 'Failed',
          error: error?.message || String(error),
          resumable,
          checkpoint: resumable ? publicCheckpoint(checkpoint) : null
        }).catch(() => null);
        if (updated && resumable) {
          const partialPatch = await this.buildPartialPatch(job.id);
          if (Object.keys(partialPatch).length) await this.store.update(job.id, partialPatch).catch(() => {});
        }
      }
    } finally {
      this.active.delete(job.id);
      await this.refreshQueueStages().catch(() => {});
      this.pump();
    }
  }
}

function publicCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  return {
    phase: checkpoint.phase,
    mainProcessed: Number(checkpoint.mainProcessed || 0),
    totalDomains: Number(checkpoint.totalDomains || 0),
    retryCandidates: Number(checkpoint.retryCandidates || 0),
    retryResolverIndex: Number(checkpoint.retryResolverIndex || 0),
    retryOffset: Number(checkpoint.retryOffset || 0),
    activeElapsedMs: Number(checkpoint.activeElapsedMs || 0),
    updatedAt: checkpoint.updatedAt || null
  };
}
