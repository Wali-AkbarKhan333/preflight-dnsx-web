import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInput } from './src/input.js';
import { JobStore } from './src/store.js';
import { AppDatabase } from './src/db.js';
import { locateDnsx, parseResolverList, runScan } from './src/scanner.js';
import { ScanQueue } from './src/scan-queue.js';
import { buildPartialArtifacts, PARTIAL_DOWNLOADS } from './src/partial-reports.js';
import {
  hashPassword,
  verifyPassword,
  validateUsername,
  validatePassword,
  newSessionToken,
  hashSessionToken,
  parseCookies,
  publicUser
} from './src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnv(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] == null) process.env[key] = value;
    }
  } catch {
    // .env is optional.
  }
}
await loadEnv(path.join(__dirname, '.env'));

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 25);
const maxBodyBytes = (maxUploadMb + 2) * 1024 * 1024;
const resultRetentionHours = Number(process.env.RESULT_FILE_RETENTION_HOURS || 720);
const sessionDays = Math.max(1, Number(process.env.SESSION_DAYS || 14));
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const db = new AppDatabase(path.join(dataDir, 'app.db'));
const store = new JobStore(path.join(dataDir, 'jobs'), db);
await store.init();
db.cleanupSessions();
await store.cleanupResultFiles(resultRetentionHours).catch(() => {});

const scanQueue = new ScanQueue({
  store,
  runner: runScan,
  partialBuilder: buildPartialArtifacts,
  concurrency: Number(process.env.MAX_CONCURRENT_SCANS || 1)
});
await scanQueue.recover(await store.list(500));

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const publicStatic = new Set(['/styles.css', '/login.js', '/setup.js']);
const loginAttempts = new Map();
const allowedDownloads = new Set(['scan-summary.csv', 'full-results.csv', 'domain-results.csv', 'mx-enabled-emails.csv', 'mx-enabled-domains.csv', 'mail-enabled.csv', 'excluded.csv', 'review.csv', ...PARTIAL_DOWNLOADS]);
const partialReportBuilds = new Map();

async function ensurePartialReports(jobId) {
  if (partialReportBuilds.has(jobId)) return partialReportBuilds.get(jobId);
  const task = (async () => {
    const patch = await buildPartialArtifacts(jobId, store, { generateFiles: true });
    if (patch && Object.keys(patch).length) await store.update(jobId, patch);
    return patch;
  })().finally(() => partialReportBuilds.delete(jobId));
  partialReportBuilds.set(jobId, task);
  return task;
}

function securityHeaders(req, extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cache-Control': 'no-store',
    ...extra
  };
}

function sendJson(req, res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, securityHeaders(req, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extra
  }));
  res.end(body);
}

function sendText(req, res, status, value, extra = {}) {
  const body = String(value);
  res.writeHead(status, securityHeaders(req, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extra
  }));
  res.end(body);
}

function redirect(req, res, location, status = 302) {
  res.writeHead(status, securityHeaders(req, { Location: location }));
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let ended = false;
    req.on('data', (chunk) => {
      if (ended) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        ended = true;
        reject(Object.assign(new Error(`Request too large. Maximum input is about ${maxUploadMb} MB.`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (ended) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON request.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function serveStaticFile(req, res, relativePath) {
  let relative = relativePath.replace(/^\/+/, '');
  relative = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(publicDir, relative);
  if (!file.startsWith(publicDir)) return false;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return false;
    res.writeHead(200, securityHeaders(req, {
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size
    }));
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '';
}

function requestIsHttps(req) {
  const forced = String(process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (forced === 'true' || forced === '1') return true;
  if (forced === 'false' || forced === '0') return false;
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function sessionCookie(req, token, maxAgeSeconds) {
  const parts = [
    `mx_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (requestIsHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(req) {
  return sessionCookie(req, '', 0);
}

function getAuth(req) {
  const token = parseCookies(req.headers.cookie || '').mx_session;
  if (!token) return null;
  return db.getSession(hashSessionToken(token));
}

function createSessionFor(req, user) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  db.createSession({
    tokenHash: hashSessionToken(token),
    userId: user.id,
    expiresAt,
    userAgent: String(req.headers['user-agent'] || ''),
    ip: requestIp(req)
  });
  return { token, expiresAt };
}

function isStateChanging(req) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
}

function sameOriginOkay(req) {
  if (!isStateChanging(req)) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!hostHeader) return false;
  try {
    return new URL(origin).origin === `${proto}://${hostHeader}`;
  } catch {
    return false;
  }
}

function loginRateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.startedAt > windowMs) {
    loginAttempts.set(ip, { startedAt: now, count: 0 });
    return false;
  }
  return entry.count >= 8;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.startedAt > 10 * 60 * 1000) {
    loginAttempts.set(ip, { startedAt: now, count: 1 });
  } else {
    entry.count += 1;
  }
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function safeUser(row) {
  const value = publicUser(row);
  if (!value) return null;
  delete value.isActive;
  return value;
}

function requireAdmin(req, res, auth) {
  if (auth?.user?.role === 'admin') return true;
  sendJson(req, res, 403, { error: 'Administrator access required.' });
  return false;
}

function canAccessJob(auth, job) {
  return Boolean(auth?.user && job && (auth.user.role === 'admin' || job.userId === auth.user.id));
}

async function bootstrapAdminFromEnv() {
  if (db.userCount() > 0) return;
  const rawUsername = process.env.ADMIN_USERNAME || '';
  const rawPassword = process.env.ADMIN_PASSWORD || '';
  if (!rawUsername || !rawPassword) return;
  const username = validateUsername(rawUsername);
  const password = validatePassword(rawPassword);
  const passwordData = await hashPassword(password);
  db.createUser({ username, ...passwordData, role: 'admin' });
  console.log(`Initial administrator created from environment: ${username}`);
}
await bootstrapAdminFromEnv();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (!sameOriginOkay(req)) return sendJson(req, res, 403, { error: 'Cross-origin request rejected.' });

    // Public static assets and authentication pages.
    if (req.method === 'GET' && publicStatic.has(pathname)) {
      if (await serveStaticFile(req, res, pathname)) return;
    }
    if (req.method === 'GET' && pathname === '/login') {
      if (db.userCount() === 0) return redirect(req, res, '/setup');
      if (getAuth(req)) return redirect(req, res, '/');
      return serveStaticFile(req, res, '/login.html');
    }
    if (req.method === 'GET' && pathname === '/setup') {
      if (db.userCount() > 0) return redirect(req, res, '/login');
      return serveStaticFile(req, res, '/setup.html');
    }

    if (req.method === 'GET' && pathname === '/api/auth/status') {
      const auth = getAuth(req);
      return sendJson(req, res, 200, {
        setupRequired: db.userCount() === 0,
        authenticated: Boolean(auth),
        user: auth ? auth.user : null
      });
    }

    if (req.method === 'POST' && pathname === '/api/setup') {
      if (db.userCount() > 0) return sendJson(req, res, 409, { error: 'Initial setup has already been completed.' });
      const body = await readJson(req);
      const username = validateUsername(body.username);
      const password = validatePassword(body.password);
      if (password !== String(body.confirmPassword ?? '')) return sendJson(req, res, 400, { error: 'Passwords do not match.' });
      const passwordData = await hashPassword(password);
      const user = db.createUser({ username, ...passwordData, role: 'admin' });
      const session = createSessionFor(req, user);
      return sendJson(req, res, 201, { user: safeUser(user) }, { 'Set-Cookie': sessionCookie(req, session.token, sessionDays * 86400) });
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      if (db.userCount() === 0) return sendJson(req, res, 409, { error: 'Initial setup is required first.' });
      const ip = requestIp(req);
      if (loginRateLimited(ip)) return sendJson(req, res, 429, { error: 'Too many failed login attempts. Try again later.' });
      const body = await readJson(req);
      const username = String(body.username || '').trim().toLowerCase();
      const user = db.getUserByUsername(username);
      const ok = user && user.is_active && await verifyPassword(String(body.password || ''), user);
      if (!ok) {
        recordLoginFailure(ip);
        return sendJson(req, res, 401, { error: 'Invalid username or password.' });
      }
      clearLoginFailures(ip);
      db.markLogin(user.id);
      const fresh = db.getUserById(user.id);
      const session = createSessionFor(req, fresh);
      return sendJson(req, res, 200, { user: safeUser(fresh) }, { 'Set-Cookie': sessionCookie(req, session.token, sessionDays * 86400) });
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const token = parseCookies(req.headers.cookie || '').mx_session;
      if (token) db.deleteSession(hashSessionToken(token));
      return sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req) });
    }

    const auth = getAuth(req);
    if (!auth) {
      if (pathname.startsWith('/api/')) return sendJson(req, res, 401, { error: 'Authentication required.' });
      return redirect(req, res, db.userCount() === 0 ? '/setup' : '/login');
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveStaticFile(req, res, '/index.html');
    }
    if (req.method === 'GET' && pathname === '/app.js') {
      return serveStaticFile(req, res, '/app.js');
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      return sendJson(req, res, 200, { user: auth.user, sessionExpiresAt: auth.expiresAt });
    }

    if (req.method === 'POST' && pathname === '/api/me/password') {
      const body = await readJson(req);
      const row = db.getUserById(auth.user.id);
      if (!row || !await verifyPassword(String(body.currentPassword || ''), row)) {
        return sendJson(req, res, 400, { error: 'Current password is incorrect.' });
      }
      const newPassword = validatePassword(body.newPassword);
      if (newPassword !== String(body.confirmPassword ?? '')) return sendJson(req, res, 400, { error: 'New passwords do not match.' });
      const passwordData = await hashPassword(newPassword);
      db.setPassword(row.id, passwordData);
      return sendJson(req, res, 200, { ok: true, loggedOut: true }, { 'Set-Cookie': clearSessionCookie(req) });
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      const dnsx = locateDnsx();
      return sendJson(req, res, 200, {
        ok: true,
        dnsxInstalled: Boolean(dnsx),
        dnsx: dnsx ? { path: dnsx.path, version: dnsx.versionOutput.split(/\r?\n/).filter(Boolean).slice(-1)[0] } : null,
        database: { type: 'SQLite', file: 'data/app.db' },
        scanQueue: scanQueue.snapshot(),
        limits: {
          maxUploadMb,
          maxThreads: Number(process.env.MAX_THREADS || 500),
          maxRateLimit: Number(process.env.MAX_RATE_LIMIT || 10000)
        },
        resolvers: {
          main: parseResolverList(process.env.DNS_RESOLVERS),
          retry: parseResolverList(process.env.UNKNOWN_RETRY_RESOLVERS, parseResolverList(process.env.DNS_RESOLVERS))
        }
      });
    }

    if (req.method === 'GET' && pathname === '/api/jobs') {
      return sendJson(req, res, 200, { jobs: await store.list(50, { userId: auth.user.id }) });
    }

    if (req.method === 'POST' && pathname === '/api/jobs') {
      const body = await readJson(req);
      const parsed = parseInput({ fileText: body.fileText || '', filename: body.filename || '', pastedText: body.pastedText || '' });
      if (!parsed.uniqueDomains.length) return sendJson(req, res, 400, { error: 'No valid domains or email addresses were found in the input.' });

      const settings = {
        threads: Number(body.threads || process.env.DEFAULT_THREADS || 200),
        rateLimit: Number(body.rateLimit || process.env.DEFAULT_RATE_LIMIT || 2000)
      };
      const job = await store.create({
        userId: auth.user.id,
        sourceName: body.filename || 'Pasted input',
        records: parsed.records,
        uniqueDomains: parsed.uniqueDomains,
        parseStats: parsed.stats,
        settings
      });

      const queuedJob = await scanQueue.enqueue(job.id);
      return sendJson(req, res, 202, { job: queuedJob });
    }

    const resumeMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/resume$/i);
    if (resumeMatch && req.method === 'POST') {
      const job = await store.get(resumeMatch[1]);
      if (!canAccessJob(auth, job)) return sendJson(req, res, job ? 403 : 404, { error: job ? 'Access denied.' : 'Job not found.' });
      if (!['interrupted', 'failed', 'paused'].includes(job.status) || !job.resumable) {
        return sendJson(req, res, 409, { error: 'This job does not have a resumable checkpoint.' });
      }
      await store.removeFiles(job.id, PARTIAL_DOWNLOADS);
      await store.update(job.id, { downloads: [] });
      const updated = await scanQueue.resume(job.id);
      if (!updated?.resumable && updated?.status !== 'queued' && updated?.status !== 'running') {
        return sendJson(req, res, 409, { error: updated?.error || 'The saved checkpoint is unavailable.' });
      }
      return sendJson(req, res, 202, { job: updated });
    }

    const pauseMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/pause$/i);
    if (pauseMatch && req.method === 'POST') {
      const job = await store.get(pauseMatch[1]);
      if (!canAccessJob(auth, job)) return sendJson(req, res, job ? 403 : 404, { error: job ? 'Access denied.' : 'Job not found.' });
      if (job.status !== 'running') return sendJson(req, res, 409, { error: 'Only a running job can be paused.' });
      const updated = await scanQueue.pause(job.id);
      return sendJson(req, res, 202, { job: updated });
    }

    const cancelMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/cancel$/i);
    if (cancelMatch && req.method === 'POST') {
      const job = await store.get(cancelMatch[1]);
      if (!canAccessJob(auth, job)) return sendJson(req, res, job ? 403 : 404, { error: job ? 'Access denied.' : 'Job not found.' });
      if (!['queued', 'running', 'paused', 'interrupted', 'failed'].includes(job.status)) return sendJson(req, res, 409, { error: 'This job cannot be canceled in its current state.' });
      const updated = await scanQueue.cancel(job.id);
      return sendJson(req, res, 202, { job: updated });
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);
    if (jobMatch && req.method === 'GET') {
      const job = await store.get(jobMatch[1]);
      if (!canAccessJob(auth, job)) return sendJson(req, res, job ? 403 : 404, { error: job ? 'Access denied.' : 'Job not found.' });
      return sendJson(req, res, 200, { job });
    }

    if (jobMatch && req.method === 'DELETE') {
      const job = await store.get(jobMatch[1]);
      if (!canAccessJob(auth, job)) return sendJson(req, res, job ? 403 : 404, { error: job ? 'Access denied.' : 'Job not found.' });
      if (['running', 'queued'].includes(job.status)) return sendJson(req, res, 409, { error: 'A running or queued job cannot be deleted.' });
      await store.remove(job.id);
      res.writeHead(204, securityHeaders(req));
      res.end();
      return;
    }

    const dlMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/download\/([^/]+)$/i);
    if (dlMatch && req.method === 'GET') {
      const [, id, name] = dlMatch;
      if (!allowedDownloads.has(name)) return sendJson(req, res, 400, { error: 'Invalid download.' });
      const job = await store.get(id);
      if (!canAccessJob(auth, job)) return sendJson(req, res, job ? 403 : 404, { error: job ? 'Access denied.' : 'Job not found.' });
      if (job.filesDeleted) return sendJson(req, res, 410, { error: 'Result files for this historical job have expired.' });
      const file = store.file(id, name);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        if (PARTIAL_DOWNLOADS.includes(name)) {
          try {
            await ensurePartialReports(id);
            stat = await fsp.stat(file);
          } catch (error) {
            return sendJson(req, res, 409, { error: error?.message || 'Partial report could not be generated.' });
          }
        } else {
          return sendJson(req, res, 404, { error: 'Result file not available yet.' });
        }
      }
      res.writeHead(200, securityHeaders(req, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${id.slice(0, 8)}-${name}"`
      }));
      fs.createReadStream(file).pipe(res);
      return;
    }

    // Admin user and history management.
    if (pathname.startsWith('/api/admin/')) {
      if (!requireAdmin(req, res, auth)) return;

      if (req.method === 'GET' && pathname === '/api/admin/users') {
        return sendJson(req, res, 200, { users: db.listUsers() });
      }

      if (req.method === 'POST' && pathname === '/api/admin/users') {
        const body = await readJson(req);
        const username = validateUsername(body.username);
        if (db.getUserByUsername(username)) return sendJson(req, res, 409, { error: 'That username already exists.' });
        const password = validatePassword(body.password);
        const role = body.role === 'admin' ? 'admin' : 'user';
        const passwordData = await hashPassword(password);
        const user = db.createUser({ username, ...passwordData, role, createdBy: auth.user.id });
        return sendJson(req, res, 201, { user: safeUser(user) });
      }

      const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)$/i);
      if (adminUserMatch && req.method === 'PATCH') {
        const targetId = adminUserMatch[1];
        const body = await readJson(req);
        const patch = {};
        if (body.role != null) patch.role = body.role === 'admin' ? 'admin' : 'user';
        if (body.isActive != null) patch.isActive = Boolean(body.isActive);
        const user = db.updateUser(targetId, patch);
        if (!user) return sendJson(req, res, 404, { error: 'User not found.' });
        return sendJson(req, res, 200, { user: safeUser(user) });
      }

      const resetMatch = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/password$/i);
      if (resetMatch && req.method === 'POST') {
        const target = db.getUserById(resetMatch[1]);
        if (!target) return sendJson(req, res, 404, { error: 'User not found.' });
        const body = await readJson(req);
        const password = validatePassword(body.password);
        const passwordData = await hashPassword(password);
        db.setPassword(target.id, passwordData);
        return sendJson(req, res, 200, { ok: true });
      }

      if (req.method === 'GET' && pathname === '/api/admin/jobs') {
        const userId = url.searchParams.get('userId') || null;
        if (userId && !db.getUserById(userId)) return sendJson(req, res, 404, { error: 'User not found.' });
        return sendJson(req, res, 200, { jobs: await store.list(100, { userId }) });
      }
    }

    return sendText(req, res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(req, res, error.status || 500, { error: error?.message || 'Unexpected server error.' });
  }
});

server.listen(port, host, () => {
  console.log(`MX Preflight v2.6.2 running at http://localhost:${port}`);
  console.log(`Scan queue concurrency: ${scanQueue.concurrency}`);
  console.log(`Database: ${path.join(dataDir, 'app.db')}`);
  if (db.userCount() === 0) console.log('Initial setup required: open /setup or set ADMIN_USERNAME and ADMIN_PASSWORD before starting.');
  const dnsx = locateDnsx();
  console.log(dnsx ? `dnsx detected: ${dnsx.path}` : 'dnsx not detected. Run the setup script before scanning.');
});

function shutdown() {
  try { db.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
