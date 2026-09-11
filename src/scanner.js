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

function runProcess(command, args, cwd, onLine, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, signal: options.signal });
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
      // Ignore malformed lines; dnsx warnings should not normally be in JSON output.
    }
  }
  return objects;
}

async function appendFileIfPresent(source, destination) {
  try {
    const text = await fs.readFile(source, 'utf8');
    if (text) await fs.appendFile(destination, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  } catch {
    // No output for a chunk is valid.
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function chunks(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

function mergeDataMaps(target, source) {
  for (const [host, incoming] of source) {
    if (!target.has(host)) {
      target.set(host, {
        host,
        a: new Set(),
        aaaa: new Set(),
        ns: new Set(),
        mx: new Set(),
        statusCodes: new Set(),
        mxFieldSeen: false,
        nullMxSeen: false
      });
    }
    const row = target.get(host);
    for (const value of incoming.a || []) row.a.add(value);
    for (const value of incoming.aaaa || []) row.aaaa.add(value);
    for (const value of incoming.ns || []) row.ns.add(value);
    for (const value of incoming.mx || []) row.mx.add(value);
    for (const value of incoming.statusCodes || []) row.statusCodes.add(value);
    row.mxFieldSeen ||= Boolean(incoming.mxFieldSeen);
    row.nullMxSeen ||= Boolean(incoming.nullMxSeen);
  }
}

function blankSummary(totalDomains) {
  return {
    totalDomains,
    processedDomains: 0,
    dnsActive: 0,
    dnsFailed: 0,
    unknown: 0,
    mailEnabled: 0,
    noMx: 0,
    nullMx: 0,
    stageProcessed: 0,
    stageTotal: totalDomains,
    rateDomainsPerSec: 0,
    elapsedSeconds: 0,
    etaSeconds: null
  };
}

function changeRowCounts(summary, row, direction) {
  if (!row) return;
  if (row.dnsStatus === 'DNS_ACTIVE') summary.dnsActive += direction;
  else if (row.dnsStatus === 'DNS_FAILED') summary.dnsFailed += direction;
  else summary.unknown += direction;

  if (row.mailStatus === 'MAIL_ENABLED') summary.mailEnabled += direction;
  else if (row.mailStatus === 'NO_MX') summary.noMx += direction;
  else if (row.mailStatus === 'NULL_MX') summary.nullMx += direction;
}

function applyPartialResults(summary, resultMap, rows) {
  for (const row of rows) {
    const previous = resultMap.get(row.domain);
    if (previous) {
      changeRowCounts(summary, previous, -1);
    } else {
      summary.processedDomains += 1;
    }
    resultMap.set(row.domain, row);
    changeRowCounts(summary, row, 1);
  }
}

function liveFields({ summary, scanStartedAt, processed, totalDomains }) {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - scanStartedAt) / 1000);
  const rateDomainsPerSec = processed > 0 && elapsedSeconds > 0 ? processed / elapsedSeconds : 0;
  const etaSeconds = rateDomainsPerSec > 0 ? Math.max(0, (totalDomains - processed) / rateDomainsPerSec) : null;

  return {
    ...summary,
    stageProcessed: processed,
    stageTotal: totalDomains,
    rateDomainsPerSec,
    elapsedSeconds,
    etaSeconds
  };
}

function progressFor(processed, totalDomains) {
  if (!totalDomains) return 8;
  return Math.max(8, Math.min(94, Math.round(8 + (processed / totalDomains) * 86)));
}

export async function runScan(job, store, deps = {}) {
  const found = deps.dnsx || (deps.locateDnsx || locateDnsx)();
  const processRunner = deps.runProcess || runProcess;
  if (!found) {
    throw new Error('dnsx was not found. Run scripts/setup-windows.ps1 or scripts/setup-linux.sh, or set DNSX_PATH.');
  }

  const maxThreads = Number(process.env.MAX_THREADS || 500);
  const maxRate = Number(process.env.MAX_RATE_LIMIT || 10000);
  const threads = clamp(job.settings?.threads, 1, maxThreads, Number(process.env.DEFAULT_THREADS || 200));
  const rateLimit = clamp(job.settings?.rateLimit, 1, maxRate, Number(process.env.DEFAULT_RATE_LIMIT || 2000));
  const chunkSize = clamp(process.env.SCAN_CHUNK_SIZE, 1000, 50000, 10000);

  const dir = store.dir(job.id);
  const input = store.file(job.id, 'input-domains.txt');
  const recordsFile = store.file(job.id, 'source-records.json');
  const dnsOutput = store.file(job.id, 'dns.jsonl');
  const chunkInput = store.file(job.id, '.chunk-input.txt');
  const chunkOutput = store.file(job.id, '.chunk-output.jsonl');

  const domainText = await fs.readFile(input, 'utf8');
  const domains = domainText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const totalDomains = domains.length;
  const domainChunks = chunks(domains, chunkSize);

  await fs.writeFile(dnsOutput, '', 'utf8');

  const scanStartedAt = Date.now();
  const summary = blankSummary(totalDomains);
  const partialResults = new Map();
  const successMap = new Map();
  let processed = 0;

  await store.update(job.id, {
    status: 'running',
    stage: `Fast MX preflight · 0 / ${totalDomains.toLocaleString()}`,
    progress: 8,
    summary,
    dnsx: { path: found.path, version: found.versionOutput.split(/\r?\n/).filter(Boolean).slice(-1)[0] || found.versionOutput }
  });

  // Fast path: one MX query per domain. -rcode forces dnsx to emit NOERROR/NXDOMAIN
  // responses even when the MX answer itself is empty, so we can distinguish NO_MX
  // from DNS_FAILED without a second full-domain pass.
  const common = [
    '-json', '-omit-raw', '-silent',
    '-mx', '-rcode', 'noerror,nxdomain,servfail,refused',
    '-retry', '1', '-timeout', '2s',
    '-t', String(threads), '-rl', String(rateLimit)
  ];

  try {
    for (const chunk of domainChunks) {
      await fs.writeFile(chunkInput, `${chunk.join('\n')}\n`, 'utf8');
      await fs.rm(chunkOutput, { force: true });

      if (deps.control?.signal?.aborted) {
        const error = new Error('Scan canceled');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        throw error;
      }

      await processRunner(found.path, [
        '-l', chunkInput,
        ...common,
        '-o', chunkOutput
      ], dir, undefined, { signal: deps.control?.signal });

      const objects = await parseJsonl(chunkOutput);
      await appendFileIfPresent(chunkOutput, dnsOutput);
      mergeDataMaps(successMap, mergeDnsxObjects(objects));

      const rows = classifyDomains(chunk, successMap);
      applyPartialResults(summary, partialResults, rows);
      processed += chunk.length;

      await store.update(job.id, {
        stage: `Fast MX preflight · ${processed.toLocaleString()} / ${totalDomains.toLocaleString()}`,
        progress: progressFor(processed, totalDomains),
        summary: liveFields({ summary, scanStartedAt, processed, totalDomains })
      });
    }

    await store.update(job.id, {
      stage: 'Classifying and writing results',
      progress: 96,
      summary: liveFields({ summary, scanStartedAt, processed: totalDomains, totalDomains })
    });

    const sourceRecords = await fs.readFile(recordsFile, 'utf8').then(JSON.parse);
    const domainResults = classifyDomains(domains, successMap);
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
      fs.writeFile(store.file(job.id, 'domain-results.json'), JSON.stringify(domainResults), 'utf8')
    ]);

    const finalCounts = summarize(domainResults);
    const elapsedSeconds = Math.max(0, (Date.now() - scanStartedAt) / 1000);
    const finalSummary = {
      ...finalCounts,
      processedDomains: totalDomains,
      stageProcessed: totalDomains,
      stageTotal: totalDomains,
      rateDomainsPerSec: elapsedSeconds > 0 ? totalDomains / elapsedSeconds : 0,
      elapsedSeconds,
      etaSeconds: 0
    };

    await store.update(job.id, {
      status: 'completed', stage: 'Complete', progress: 100,
      summary: finalSummary,
      downloads: ['full-results.csv', 'domain-results.csv', 'mail-enabled.csv', 'excluded.csv', 'review.csv'],
      preview: domainResults.slice(0, 200)
    });
  } finally {
    await Promise.all([
      fs.rm(chunkInput, { force: true }),
      fs.rm(chunkOutput, { force: true })
    ]);
  }
}
