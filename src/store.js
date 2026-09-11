import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class JobStore {
  constructor(rootDir, db) {
    this.rootDir = rootDir;
    this.db = db;
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  dir(id) {
    return path.join(this.rootDir, id);
  }

  file(id, name) {
    return path.join(this.dir(id), name);
  }

  async create({ userId, sourceName, records, uniqueDomains, parseStats, settings }) {
    const id = crypto.randomUUID();
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });

    const now = new Date().toISOString();
    const job = {
      id,
      userId,
      status: 'queued',
      stage: 'Queued',
      progress: 5,
      createdAt: now,
      updatedAt: now,
      sourceName,
      parseStats,
      settings,
      summary: null,
      error: null,
      downloads: [],
      preview: [],
      dnsx: null,
      filesDeleted: false
    };

    await fs.writeFile(this.file(id, 'source-records.json'), JSON.stringify(records), 'utf8');
    await fs.writeFile(this.file(id, 'input-domains.txt'), `${uniqueDomains.join('\n')}\n`, 'utf8');
    this.db.insertJob(job);
    return this.get(id);
  }

  async save(job) {
    const next = { ...job, updatedAt: new Date().toISOString() };
    this.db.saveJob(next);
    return this.get(job.id);
  }

  async update(id, patch) {
    const current = await this.get(id);
    if (!current) throw new Error('Job not found');
    return this.save({ ...current, ...patch });
  }

  async get(id) {
    return this.db.getJob(id);
  }

  async list(limit = 20, { userId = null } = {}) {
    return this.db.listJobs({ userId, limit });
  }

  async remove(id) {
    await fs.rm(this.dir(id), { recursive: true, force: true });
    this.db.deleteJob(id);
  }

  async cleanupResultFiles(hours) {
    if (!Number.isFinite(hours) || hours <= 0) return;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const jobs = this.db.listJobsOlderThan(cutoff);
    for (const job of jobs) {
      await fs.rm(this.dir(job.id), { recursive: true, force: true });
      await this.update(job.id, { filesDeleted: true, downloads: [], preview: job.preview || [] });
    }
  }
}
