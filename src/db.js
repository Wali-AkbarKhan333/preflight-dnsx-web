import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    ownerUsername: row.owner_username || undefined,
    sourceName: row.source_name,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parseStats: parseJson(row.parse_stats_json, {}),
    settings: parseJson(row.settings_json, {}),
    summary: parseJson(row.summary_json, null),
    error: row.error || null,
    downloads: parseJson(row.downloads_json, []),
    preview: parseJson(row.preview_json, []),
    dnsx: parseJson(row.dnsx_json, null),
    filesDeleted: Boolean(row.files_deleted)
  };
}

export class AppDatabase {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')) DEFAULT 'user',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        password_changed_at TEXT NOT NULL,
        created_by TEXT,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        user_agent TEXT,
        ip TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        parse_stats_json TEXT NOT NULL DEFAULT '{}',
        settings_json TEXT NOT NULL DEFAULT '{}',
        summary_json TEXT,
        error TEXT,
        downloads_json TEXT NOT NULL DEFAULT '[]',
        preview_json TEXT NOT NULL DEFAULT '[]',
        dnsx_json TEXT,
        files_deleted INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at);
    `);
  }

  close() {
    this.db.close();
  }

  userCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count || 0);
  }

  activeAdminCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND is_active=1").get().count || 0);
  }

  getUserByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) || null;
  }

  getUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  }

  createUser({ username, passwordHash, passwordSalt, role = 'user', createdBy = null }) {
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO users (id, username, password_hash, password_salt, role, is_active, created_at, updated_at, password_changed_at, created_by)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(id, username, passwordHash, passwordSalt, role, now, now, now, createdBy);
    return this.getUserById(id);
  }

  listUsers() {
    return this.db.prepare(`
      SELECT u.id, u.username, u.role, u.is_active, u.created_at, u.updated_at, u.last_login_at,
             COUNT(j.id) AS job_count, MAX(j.created_at) AS last_scan_at
      FROM users u
      LEFT JOIN jobs j ON j.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at ASC
    `).all().map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at || null,
      jobCount: Number(row.job_count || 0),
      lastScanAt: row.last_scan_at || null
    }));
  }

  updateUser(id, patch = {}) {
    const current = this.getUserById(id);
    if (!current) return null;

    const nextRole = patch.role ?? current.role;
    const nextActive = patch.isActive == null ? Boolean(current.is_active) : Boolean(patch.isActive);
    if (current.role === 'admin' && current.is_active && (nextRole !== 'admin' || !nextActive) && this.activeAdminCount() <= 1) {
      const error = new Error('You cannot disable or demote the last active administrator.');
      error.status = 409;
      throw error;
    }

    this.db.prepare(`
      UPDATE users SET role = ?, is_active = ?, updated_at = ? WHERE id = ?
    `).run(nextRole, nextActive ? 1 : 0, nowIso(), id);
    if (!nextActive) this.deleteSessionsForUser(id);
    return this.getUserById(id);
  }

  setPassword(id, { passwordHash, passwordSalt }) {
    const now = nowIso();
    this.db.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, password_changed_at = ?, updated_at = ? WHERE id = ?
    `).run(passwordHash, passwordSalt, now, now, id);
    this.deleteSessionsForUser(id);
  }

  markLogin(id) {
    this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
  }

  createSession({ tokenHash, userId, expiresAt, userAgent = '', ip = '' }) {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tokenHash, userId, now, expiresAt, now, userAgent.slice(0, 500), ip.slice(0, 120));
  }

  getSession(tokenHash) {
    const row = this.db.prepare(`
      SELECT s.token_hash, s.user_id, s.created_at AS session_created_at, s.expires_at, s.last_seen_at,
             u.id, u.username, u.role, u.is_active
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash);
    if (!row) return null;
    if (!row.is_active || new Date(row.expires_at).getTime() <= Date.now()) {
      this.deleteSession(tokenHash);
      return null;
    }
    const lastSeen = new Date(row.last_seen_at).getTime();
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 15 * 60 * 1000) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
    }
    return {
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      user: {
        id: row.id,
        username: row.username,
        role: row.role,
        isActive: Boolean(row.is_active)
      }
    };
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteSessionsForUser(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  cleanupSessions() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
  }

  insertJob(job) {
    this.db.prepare(`
      INSERT INTO jobs (
        id, user_id, source_name, status, stage, progress, created_at, updated_at,
        parse_stats_json, settings_json, summary_json, error, downloads_json, preview_json, dnsx_json, files_deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, job.userId, job.sourceName, job.status, job.stage, job.progress,
      job.createdAt, job.updatedAt,
      JSON.stringify(job.parseStats || {}), JSON.stringify(job.settings || {}),
      job.summary == null ? null : JSON.stringify(job.summary), job.error || null,
      JSON.stringify(job.downloads || []), JSON.stringify(job.preview || []),
      job.dnsx == null ? null : JSON.stringify(job.dnsx), job.filesDeleted ? 1 : 0
    );
    return job;
  }

  saveJob(job) {
    this.db.prepare(`
      UPDATE jobs SET
        source_name = ?, status = ?, stage = ?, progress = ?, updated_at = ?,
        parse_stats_json = ?, settings_json = ?, summary_json = ?, error = ?,
        downloads_json = ?, preview_json = ?, dnsx_json = ?, files_deleted = ?
      WHERE id = ?
    `).run(
      job.sourceName, job.status, job.stage, job.progress, job.updatedAt,
      JSON.stringify(job.parseStats || {}), JSON.stringify(job.settings || {}),
      job.summary == null ? null : JSON.stringify(job.summary), job.error || null,
      JSON.stringify(job.downloads || []), JSON.stringify(job.preview || []),
      job.dnsx == null ? null : JSON.stringify(job.dnsx), job.filesDeleted ? 1 : 0,
      job.id
    );
  }

  getJob(id) {
    return toJob(this.db.prepare(`
      SELECT j.*, u.username AS owner_username
      FROM jobs j JOIN users u ON u.id = j.user_id
      WHERE j.id = ?
    `).get(id));
  }

  listJobs({ userId = null, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    const sql = userId
      ? `SELECT j.*, u.username AS owner_username FROM jobs j JOIN users u ON u.id=j.user_id WHERE j.user_id=? ORDER BY j.created_at DESC LIMIT ?`
      : `SELECT j.*, u.username AS owner_username FROM jobs j JOIN users u ON u.id=j.user_id ORDER BY j.created_at DESC LIMIT ?`;
    const rows = userId
      ? this.db.prepare(sql).all(userId, safeLimit)
      : this.db.prepare(sql).all(safeLimit);
    return rows.map(toJob);
  }

  listJobsOlderThan(cutoffIso) {
    return this.db.prepare(`
      SELECT j.*, u.username AS owner_username
      FROM jobs j JOIN users u ON u.id=j.user_id
      WHERE j.updated_at < ? AND j.files_deleted = 0 AND j.status NOT IN ('running','queued')
      ORDER BY j.updated_at ASC
    `).all(cutoffIso).map(toJob);
  }

  deleteJob(id) {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }
}
