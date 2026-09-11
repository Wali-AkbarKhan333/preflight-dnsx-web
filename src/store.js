import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class JobStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
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

  async create({ sourceName, records, uniqueDomains, parseStats, settings }) {
    const id = crypto.randomUUID();
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });

    const now = new Date().toISOString();
    const job = {
      id,
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
      downloads: []
    };

    await fs.writeFile(this.file(id, 'source-records.json'), JSON.stringify(records), 'utf8');
    await fs.writeFile(this.file(id, 'input-domains.txt'), `${uniqueDomains.join('\n')}\n`, 'utf8');
    await this.save(job);
    return job;
  }

  async save(job) {
    const next = { ...job, updatedAt: new Date().toISOString() };
    await fs.writeFile(this.file(job.id, 'job.json'), JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  async update(id, patch) {
    const current = await this.get(id);
    if (!current) throw new Error('Job not found');
    return this.save({ ...current, ...patch });
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(this.file(id, 'job.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async list(limit = 20) {
    let entries = [];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await this.get(entry.name);
      if (job) jobs.push(job);
    }

    return jobs
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);
  }

  async remove(id) {
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }

  async cleanup(hours) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const jobs = await this.list(5000);
    for (const job of jobs) {
      if (new Date(job.createdAt).getTime() < cutoff && !['running', 'queued'].includes(job.status)) {
        await this.remove(job.id);
      }
    }
  }
}
