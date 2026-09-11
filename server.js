import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInput } from './src/input.js';
import { JobStore } from './src/store.js';
import { locateDnsx, runScan } from './src/scanner.js';

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
const retentionHours = Number(process.env.JOB_RETENTION_HOURS || 24);
const publicDir = path.join(__dirname, 'public');
const store = new JobStore(path.join(__dirname, 'data', 'jobs'));
await store.init();
await store.cleanup(retentionHours).catch(() => {});

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, value) {
  const body = String(value);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function isAuthorized(req, res) {
  const password = process.env.APP_PASSWORD || '';
  if (!password) return true;
  const username = process.env.APP_USERNAME || 'admin';
  const header = req.headers.authorization || '';
  const token = header.startsWith('Basic ') ? header.slice(6) : '';
  let decoded = '';
  try { decoded = Buffer.from(token, 'base64').toString('utf8'); } catch {}
  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : '';
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (user === username && pass === password) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MX Preflight"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Authentication required');
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error(`Request too large. Maximum input is about ${maxUploadMb} MB.`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON request.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(pathname, res) {
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  relative = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(publicDir, relative);
  if (!file.startsWith(publicDir)) return false;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return false;
    res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const allowedDownloads = new Set(['full-results.csv', 'domain-results.csv', 'mail-enabled.csv', 'excluded.csv', 'review.csv']);

const server = http.createServer(async (req, res) => {
  if (!isAuthorized(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      const dnsx = locateDnsx();
      return sendJson(res, 200, {
        ok: true,
        dnsxInstalled: Boolean(dnsx),
        dnsx: dnsx ? { path: dnsx.path, version: dnsx.versionOutput.split(/\r?\n/).filter(Boolean).slice(-1)[0] } : null,
        limits: {
          maxUploadMb,
          maxThreads: Number(process.env.MAX_THREADS || 300),
          maxRateLimit: Number(process.env.MAX_RATE_LIMIT || 5000)
        }
      });
    }

    if (req.method === 'GET' && pathname === '/api/jobs') {
      return sendJson(res, 200, { jobs: await store.list(20) });
    }

    if (req.method === 'POST' && pathname === '/api/jobs') {
      const body = await readJson(req);
      const parsed = parseInput({ fileText: body.fileText || '', filename: body.filename || '', pastedText: body.pastedText || '' });
      if (!parsed.uniqueDomains.length) return sendJson(res, 400, { error: 'No valid domains or email addresses were found in the input.' });

      const settings = {
        threads: Number(body.threads || process.env.DEFAULT_THREADS || 100),
        rateLimit: Number(body.rateLimit || process.env.DEFAULT_RATE_LIMIT || 1000)
      };
      const job = await store.create({
        sourceName: body.filename || 'Pasted input',
        records: parsed.records,
        uniqueDomains: parsed.uniqueDomains,
        parseStats: parsed.stats,
        settings
      });

      setImmediate(async () => {
        try {
          await runScan(job, store);
        } catch (error) {
          await store.update(job.id, { status: 'failed', stage: 'Failed', progress: 100, error: error?.message || String(error) }).catch(() => {});
        }
      });
      return sendJson(res, 202, { job });
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);
    if (jobMatch && req.method === 'GET') {
      const job = await store.get(jobMatch[1]);
      return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: 'Job not found' });
    }

    if (jobMatch && req.method === 'DELETE') {
      const job = await store.get(jobMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'Job not found' });
      if (['running', 'queued'].includes(job.status)) return sendJson(res, 409, { error: 'A running job cannot be deleted.' });
      await store.remove(job.id);
      res.writeHead(204); res.end(); return;
    }

    const dlMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/download\/([^/]+)$/i);
    if (dlMatch && req.method === 'GET') {
      const [, id, name] = dlMatch;
      if (!allowedDownloads.has(name)) return sendJson(res, 400, { error: 'Invalid download' });
      const job = await store.get(id);
      if (!job) return sendJson(res, 404, { error: 'Job not found' });
      const file = store.file(id, name);
      let stat;
      try { stat = await fsp.stat(file); } catch { return sendJson(res, 404, { error: 'Result file not available yet' }); }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${id.slice(0, 8)}-${name}"`
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (req.method === 'GET' && await serveStatic(pathname, res)) return;
    return sendText(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error?.message || 'Unexpected server error' });
  }
});

server.listen(port, host, () => {
  console.log(`MX Preflight running at http://localhost:${port}`);
  const dnsx = locateDnsx();
  console.log(dnsx ? `dnsx detected: ${dnsx.path}` : 'dnsx not detected. Run the setup script before scanning.');
});
