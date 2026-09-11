import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyDomains, mergeDnsxObjects, summarize } from './classifier.js';
import { domainColumns, recordColumns, rowsToCsv } from './csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function candidateDnsxPaths() {
  const list = [];
  if (process.env.DNSX_PATH) list.push(process.env.DNSX_PATH);
  list.push(path.join(projectRoot, 'tools', process.platform === 'win32' ? 'dnsx.exe' : 'dnsx'));
  list.push(process.platform === 'win32' ? 'dnsx.exe' : 'dnsx');
  return list;
}

export function locateDnsx() {
  for (const candidate of candidateDnsxPaths()) {
    try {
      const res = spawnSync(candidate, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (!res.error && res.status === 0) {
        const output = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
        return { path: candidate, versionOutput: output };
      }
    } catch {
      // continue
    }
  }
  return null;
}

function runProcess(command, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let stderr = '';

    const collect = (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onLine) onLine(text);
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stderr });
      else reject(new Error(`dnsx exited with code ${code}. ${stderr.trim()}`));
    });
  });
}

async function parseJsonl(file) {
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }

  const objects = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      objects.push(JSON.parse(line));
    } catch {
      // Ignore a malformed output line; dnsx warnings are normally not written to JSON output.
    }
  }
  return objects;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function runScan(job, store) {
  const found = locateDnsx();
  if (!found) {
    throw new Error('dnsx was not found. Run scripts/setup-windows.ps1 or scripts/setup-linux.sh, or set DNSX_PATH.');
  }

  const maxThreads = Number(process.env.MAX_THREADS || 300);
  const maxRate = Number(process.env.MAX_RATE_LIMIT || 5000);
  const threads = clamp(job.settings?.threads, 1, maxThreads, Number(process.env.DEFAULT_THREADS || 100));
  const rateLimit = clamp(job.settings?.rateLimit, 1, maxRate, Number(process.env.DEFAULT_RATE_LIMIT || 1000));

  const dir = store.dir(job.id);
  const input = store.file(job.id, 'input-domains.txt');
  const recordsFile = store.file(job.id, 'source-records.json');
  const dnsOutput = store.file(job.id, 'dns.jsonl');
  const nxOutput = store.file(job.id, 'nxdomain.jsonl');

  await store.update(job.id, {
    status: 'running', stage: 'DNS + MX scan', progress: 20,
    dnsx: { path: found.path, version: found.versionOutput.split(/\r?\n/).filter(Boolean).slice(-1)[0] || found.versionOutput }
  });

  const common = [
    '-l', input,
    '-json', '-omit-raw', '-silent',
    '-retry', '2', '-timeout', '3s',
    '-t', String(threads), '-rl', String(rateLimit)
  ];

  await runProcess(found.path, [
    ...common,
    '-a', '-aaaa', '-mx', '-ns',
    '-o', dnsOutput
  ], dir);

  await store.update(job.id, { stage: 'NXDOMAIN pass', progress: 68 });

  // A second pass is used only to positively identify NXDOMAIN. Anything else unresolved stays UNKNOWN.
  await runProcess(found.path, [
    '-l', input,
    '-a', '-json', '-omit-raw', '-silent',
    '-rcode', 'nxdomain',
    '-retry', '1', '-timeout', '3s',
    '-t', String(threads), '-rl', String(rateLimit),
    '-o', nxOutput
  ], dir);

  await store.update(job.id, { stage: 'Classifying', progress: 82 });

  const [objects, nxObjects, sourceRecords, domainText] = await Promise.all([
    parseJsonl(dnsOutput),
    parseJsonl(nxOutput),
    fs.readFile(recordsFile, 'utf8').then(JSON.parse),
    fs.readFile(input, 'utf8')
  ]);

  const domains = domainText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const successMap = mergeDnsxObjects(objects);
  const nxHosts = new Set(nxObjects.map((o) => String(o.host || '').toLowerCase().replace(/\.$/, '')).filter(Boolean));
  const domainResults = classifyDomains(domains, successMap, nxHosts);
  const byDomain = new Map(domainResults.map((r) => [r.domain, r]));

  const recordResults = sourceRecords.map((record) => ({
    ...record,
    ...(byDomain.get(record.domain) || {
      dnsStatus: 'UNKNOWN', mailStatus: 'UNKNOWN', provider: '', mx: [], recommendedAction: 'RETRY_OR_REVIEW'
    })
  }));

  const mailEnabled = recordResults.filter((r) => r.mailStatus === 'MAIL_ENABLED');
  const excluded = recordResults.filter((r) => ['NULL_MX', 'DNS_FAILED'].includes(r.mailStatus));
  const review = recordResults.filter((r) => ['NO_MX', 'UNKNOWN'].includes(r.mailStatus));

  await Promise.all([
    fs.writeFile(store.file(job.id, 'domain-results.csv'), rowsToCsv(domainResults, domainColumns), 'utf8'),
    fs.writeFile(store.file(job.id, 'full-results.csv'), rowsToCsv(recordResults, recordColumns), 'utf8'),
    fs.writeFile(store.file(job.id, 'mail-enabled.csv'), rowsToCsv(mailEnabled, recordColumns), 'utf8'),
    fs.writeFile(store.file(job.id, 'excluded.csv'), rowsToCsv(excluded, recordColumns), 'utf8'),
    fs.writeFile(store.file(job.id, 'review.csv'), rowsToCsv(review, recordColumns), 'utf8'),
    fs.writeFile(store.file(job.id, 'domain-results.json'), JSON.stringify(domainResults, null, 2), 'utf8')
  ]);

  const summary = summarize(domainResults);
  await store.update(job.id, {
    status: 'completed', stage: 'Complete', progress: 100,
    summary,
    downloads: ['full-results.csv', 'domain-results.csv', 'mail-enabled.csv', 'excluded.csv', 'review.csv'],
    preview: domainResults.slice(0, 200)
  });
}
