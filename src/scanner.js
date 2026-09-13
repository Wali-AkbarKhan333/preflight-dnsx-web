import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import {
  classifyDomain,
  mergeDnsxObjects,
  validateConsistency
} from './classifier.js';
import { domainColumns, recordColumns, summaryColumns, writeCsvFile, writeJsonlFile, writeJsonArrayFile } from './csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

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

async function* readJsonlRows(file) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // Ignore malformed lines; canonical output is written atomically.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
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


function pauseError() {
  const error = new Error('Pause requested');
  error.name = 'PauseRequested';
  error.code = 'PAUSE_REQUESTED';
  return error;
}

function checkControl(control) {
  if (control?.signal?.aborted) {
    const error = new Error('Scan canceled');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
  }
  if (control?.isPauseRequested?.()) throw pauseError();
}

export function parseResolverList(value, fallback = DEFAULT_RESOLVERS) {
  const raw = String(value || '').trim();
  const source = raw ? raw.split(/[\s,]+/) : fallback;
  const unique = [];
  const seen = new Set();
  for (const item of source) {
    const resolver = String(item || '').trim();
    if (!resolver || seen.has(resolver)) continue;
    seen.add(resolver);
    unique.push(resolver);
  }
  return unique.length ? unique : [...fallback];
}

function mergeDataMaps(target, source) {
  const mergeValues = (row, field, values) => {
    for (const value of values || []) {
      if (!row[field]) row[field] = [];
      if (!row[field].includes(value)) row[field].push(value);
    }
  };

  for (const [host, incoming] of source) {
    if (!target.has(host)) {
      target.set(host, {
        host,
        observations: 0,
        mxFieldSeen: false,
        nullMxSeen: false
      });
    }
    const row = target.get(host);
    mergeValues(row, 'a', incoming.a);
    mergeValues(row, 'aaaa', incoming.aaaa);
    mergeValues(row, 'ns', incoming.ns);
    mergeValues(row, 'mx', incoming.mx);
    mergeValues(row, 'statusCodes', incoming.statusCodes);
    mergeValues(row, 'resolvers', incoming.resolvers);
    mergeValues(row, 'queryTimes', incoming.queryTimes);
    row.observations += Number(incoming.observations || 0);
    row.mxFieldSeen ||= Boolean(incoming.mxFieldSeen);
    row.nullMxSeen ||= Boolean(incoming.nullMxSeen);
  }
}

function inputMetrics(sourceRecords) {
  const inputEmails = sourceRecords.reduce((count, record) => count + (record.inputType === 'email' ? 1 : 0), 0);
  return {
    totalInputRecords: sourceRecords.length,
    inputEmails,
    inputOtherRecords: sourceRecords.length - inputEmails
  };
}

function emailCountMap(sourceRecords) {
  const map = new Map();
  for (const record of sourceRecords) {
    if (record.inputType !== 'email') continue;
    map.set(record.domain, Number(map.get(record.domain) || 0) + 1);
  }
  return map;
}

function blankSummary(totalDomains, sourceRecords) {
  return {
    totalDomains,
    uniqueDomains: totalDomains,
    ...inputMetrics(sourceRecords),
    processedDomains: 0,
    dnsActive: 0,
    dnsFailed: 0,
    unknown: 0,
    mailEnabled: 0,
    mxEnabledDomains: 0,
    mxEnabledEmails: 0,
    noMx: 0,
    nullMx: 0,
    stageProcessed: 0,
    stageTotal: totalDomains,
    rateDomainsPerSec: 0,
    elapsedSeconds: 0,
    etaSeconds: null,
    retryCandidates: 0,
    retryRemaining: 0,
    consistencyOk: null
  };
}

function changeRowCounts(summary, row, direction, emailCounts, domain = row?.domain) {
  if (!row) return;
  if (row.dnsStatus === 'DNS_ACTIVE') summary.dnsActive += direction;
  else if (row.dnsStatus === 'DNS_FAILED') summary.dnsFailed += direction;
  else summary.unknown += direction;

  if (row.mailStatus === 'MAIL_ENABLED') {
    summary.mailEnabled += direction;
    summary.mxEnabledDomains += direction;
    summary.mxEnabledEmails += Number(emailCounts.get(domain) || 0) * direction;
  } else if (row.mailStatus === 'NO_MX') summary.noMx += direction;
  else if (row.mailStatus === 'NULL_MX') summary.nullMx += direction;
}

function applyPartialResult(summary, resultMap, row, emailCounts) {
  if (!row) return;
  const previous = resultMap.get(row.domain);
  if (previous) changeRowCounts(summary, previous, -1, emailCounts, row.domain);
  else summary.processedDomains += 1;
  changeRowCounts(summary, row, 1, emailCounts);
  // Only these fields are needed to reverse a live counter when a retry
  // produces a newer observation. The canonical row is rebuilt later from
  // successMap, so retaining every full result object here is unnecessary.
  resultMap.set(row.domain, {
    dnsStatus: row.dnsStatus,
    mailStatus: row.mailStatus
  });
}

function liveFields({ summary, stageStartedAt, stageProcessed, stageTotal }) {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - stageStartedAt) / 1000);
  const rateDomainsPerSec = stageProcessed > 0 && elapsedSeconds > 0 ? stageProcessed / elapsedSeconds : 0;
  const etaSeconds = rateDomainsPerSec > 0 ? Math.max(0, (stageTotal - stageProcessed) / rateDomainsPerSec) : null;

  return {
    ...summary,
    stageProcessed,
    stageTotal,
    rateDomainsPerSec,
    elapsedSeconds,
    etaSeconds
  };
}

function mainProgress(processed, totalDomains) {
  if (!totalDomains) return 8;
  return Math.max(8, Math.min(80, Math.round(8 + (processed / totalDomains) * 72)));
}

function retryProgress(totalCandidates, remainingUnknown) {
  const total = Number(totalCandidates || 0);
  if (!total) return 95;
  const remaining = Math.max(0, Math.min(total, Number(remainingUnknown ?? total)));
  const resolved = total - remaining;
  return Math.max(81, Math.min(95, Math.round(81 + (resolved / total) * 14)));
}

function addAttempts(attempts, domains) {
  for (const domain of domains) attempts.set(domain, Number(attempts.get(domain) || 0) + 1);
}

function dnsArgs({ threads, rateLimit, resolverValue, retry = 1, timeout = '2s' }) {
  return [
    '-json', '-omit-raw', '-silent',
    '-mx', '-rcode', 'noerror,nxdomain,servfail,refused',
    '-retry', String(retry), '-timeout', String(timeout),
    '-t', String(threads), '-rl', String(rateLimit),
    '-r', resolverValue
  ];
}

function statusArgs({ threads, rateLimit, resolverValue, retry = 1, timeout = '4s' }) {
  return [
    '-silent', '-nc',
    '-rcode', 'noerror,nxdomain,servfail,refused',
    '-retry', String(retry), '-timeout', String(timeout),
    '-t', String(threads), '-rl', String(rateLimit),
    '-r', resolverValue
  ];
}

export function parseRcodeOutput(text, resolver = '') {
  const objects = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const codeMatch = line.match(/\[(NOERROR|NXDOMAIN|SERVFAIL|REFUSED)\]/i);
    if (!codeMatch) continue;
    const host = line.split(/\s+/)[0]?.trim().toLowerCase().replace(/\.$/, '');
    if (!host) continue;
    objects.push({
      host,
      status_code: codeMatch[1].toUpperCase(),
      resolver
    });
  }
  return objects;
}

async function appendAttempts(file, domains) {
  if (!domains.length) return;
  await fs.appendFile(file, `${domains.join('\n')}\n`, 'utf8');
}

async function loadAttempts(file) {
  const attempts = new Map();
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch { return attempts; }
  for (const domain of text.split(/\r?\n/)) {
    const value = domain.trim();
    if (!value) continue;
    attempts.set(value, Number(attempts.get(value) || 0) + 1);
  }
  return attempts;
}

async function executeChunk({
  chunk,
  found,
  processRunner,
  dir,
  chunkInput,
  chunkOutput,
  dnsOutput,
  attemptsLog,
  args,
  successMap,
  attempts,
  signal
}) {
  await fs.writeFile(chunkInput, `${chunk.join('\n')}\n`, 'utf8');
  await fs.rm(chunkOutput, { force: true });

  if (signal?.aborted) {
    const error = new Error('Scan canceled');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
  }

  await processRunner(found.path, ['-l', chunkInput, ...args, '-o', chunkOutput], dir, undefined, { signal });
  addAttempts(attempts, chunk);
  await appendAttempts(attemptsLog, chunk);
  const objects = await parseJsonl(chunkOutput);
  await appendFileIfPresent(chunkOutput, dnsOutput);
  mergeDataMaps(successMap, mergeDnsxObjects(objects));
  return objects;
}

async function executeStatusChunk({
  chunk,
  found,
  processRunner,
  dir,
  chunkInput,
  statusOutput,
  dnsOutput,
  attemptsLog,
  args,
  resolver,
  successMap,
  attempts,
  signal
}) {
  await fs.writeFile(chunkInput, `${chunk.join('\n')}\n`, 'utf8');
  await fs.rm(statusOutput, { force: true });

  if (signal?.aborted) {
    const error = new Error('Scan canceled');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
  }

  await processRunner(found.path, ['-l', chunkInput, ...args, '-o', statusOutput], dir, undefined, { signal });
  addAttempts(attempts, chunk);
  await appendAttempts(attemptsLog, chunk);

  const text = await fs.readFile(statusOutput, 'utf8').catch(() => '');
  const objects = parseRcodeOutput(text, resolver);
  if (objects.length) {
    await fs.appendFile(dnsOutput, `${objects.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    mergeDataMaps(successMap, mergeDnsxObjects(objects));
  }
  return objects;
}

function summaryRows(summary, scanMetadata) {
  return [
    ['total_input_records', summary.totalInputRecords],
    ['input_emails', summary.inputEmails],
    ['input_other_records', summary.inputOtherRecords],
    ['unique_domains', summary.totalDomains],
    ['mx_enabled_domains', summary.mxEnabledDomains],
    ['mx_enabled_emails', summary.mxEnabledEmails],
    ['no_mx_domains', summary.noMx],
    ['null_mx_domains', summary.nullMx],
    ['dns_failed_domains', summary.dnsFailed],
    ['unknown_domains', summary.unknown],
    ['main_resolvers', scanMetadata.mainResolvers.join('; ')],
    ['retry_resolvers', scanMetadata.retryResolvers.join('; ')],
    ['consistency_ok', summary.consistencyOk ? 'true' : 'false']
  ].map(([metric, value]) => ({ metric, value }));
}

function publicCheckpoint(checkpoint) {
  return {
    phase: checkpoint.phase,
    mainProcessed: Number(checkpoint.mainProcessed || 0),
    totalDomains: Number(checkpoint.totalDomains || 0),
    retryResolverIndex: Number(checkpoint.retryResolverIndex || 0),
    retryOffset: Number(checkpoint.retryOffset || 0),
    retryCandidates: Number(checkpoint.retryCandidates || 0),
    retryRemaining: Number(checkpoint.retryRemaining || 0),
    retryMode: checkpoint.retryMode || null,
    activeElapsedMs: Number(checkpoint.activeElapsedMs || 0),
    updatedAt: checkpoint.updatedAt || null
  };
}

function checkpointProgress(checkpoint) {
  if (checkpoint.phase === 'finalizing') return 96;
  if (checkpoint.phase === 'retry') {
    return retryProgress(
      Number(checkpoint.retryCandidates || 0),
      Number(checkpoint.retryRemaining ?? checkpoint.retryCandidates ?? 0)
    );
  }
  return mainProgress(Number(checkpoint.mainProcessed || 0), Number(checkpoint.totalDomains || 0));
}

async function loadSuccessMap(dnsOutput) {
  const objects = await parseJsonl(dnsOutput);
  return mergeDnsxObjects(objects);
}

async function readDomainList(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function writeDomainList(file, values) {
  const tempFile = `${file}.tmp`;
  try {
    await fs.writeFile(tempFile, values.length ? `${values.join('\n')}\n` : '', 'utf8');
    await fs.rename(tempFile, file);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

function checkpointFileOffset(value, fileLength) {
  const offset = Number(value);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  const normalized = Math.floor(offset);
  // A shorter worklist with an old larger offset means the process stopped
  // between replacing the worklist and saving its next-resolver checkpoint.
  // Replaying the pass is safe; silently skipping it is not.
  return normalized > fileLength ? 0 : normalized;
}

function unknownDomains(domains, successMap, attempts) {
  const unknown = [];
  const nxdomainHosts = new Set();
  for (const domain of domains) {
    const row = classifyDomain(domain, successMap, nxdomainHosts, { attempts });
    if (row.mailStatus === 'UNKNOWN') unknown.push(domain);
  }
  return unknown;
}

function reconstructSummary({ domains, mainProcessed, sourceRecords, successMap, attempts }) {
  const summary = blankSummary(domains.length, sourceRecords);
  const partialResults = new Map();
  const emailCounts = emailCountMap(sourceRecords);
  const checkedAt = new Date().toISOString();
  const alreadyMainProcessed = domains.slice(0, Math.max(0, Math.min(domains.length, mainProcessed)));
  for (const domain of alreadyMainProcessed) {
    applyPartialResult(summary, partialResults, classifyDomain(domain, successMap, new Set(), { attempts, checkedAt }), emailCounts);
  }
  return { summary, partialResults, emailCounts };
}

function liveResumeFields({ summary, sessionStartedAt, sessionStartProcessed, stageProcessed, stageTotal, activeElapsedMs }) {
  const sessionElapsedSeconds = Math.max(0.001, (Date.now() - sessionStartedAt) / 1000);
  const sessionWork = Math.max(0, stageProcessed - sessionStartProcessed);
  const rateDomainsPerSec = sessionWork > 0 ? sessionWork / sessionElapsedSeconds : 0;
  const etaSeconds = rateDomainsPerSec > 0 ? Math.max(0, (stageTotal - stageProcessed) / rateDomainsPerSec) : null;
  return {
    ...summary,
    stageProcessed,
    stageTotal,
    rateDomainsPerSec,
    elapsedSeconds: Math.max(0, activeElapsedMs / 1000),
    etaSeconds
  };
}

function makeCheckpoint(base, patch, activeElapsedMs) {
  return {
    ...base,
    ...patch,
    version: 1,
    activeElapsedMs: Math.max(0, Math.round(activeElapsedMs)),
    updatedAt: new Date().toISOString()
  };
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
  const chunkSize = clamp(process.env.SCAN_CHUNK_SIZE, 1000, 50000, 5000);

  const mainResolvers = parseResolverList(process.env.DNS_RESOLVERS);
  const retryResolvers = parseResolverList(process.env.UNKNOWN_RETRY_RESOLVERS, mainResolvers);
  const mainRetryAttempts = clamp(process.env.MAIN_RETRY_ATTEMPTS, 1, 3, 2);
  const retryThreads = clamp(process.env.UNKNOWN_RETRY_THREADS, 1, maxThreads, 50);
  const retryRate = clamp(process.env.UNKNOWN_RETRY_RATE_LIMIT, 1, maxRate, 250);
  const retryAttempts = clamp(process.env.UNKNOWN_RETRY_ATTEMPTS, 1, 5, 2);
  const retryTimeoutSeconds = clamp(process.env.UNKNOWN_RETRY_TIMEOUT_SECONDS, 1, 15, 4);

  const dir = store.dir(job.id);
  const input = store.file(job.id, 'input-domains.txt');
  const recordsFile = store.file(job.id, 'source-records.json');
  const dnsOutput = store.file(job.id, 'dns.jsonl');
  const attemptsLog = store.file(job.id, 'attempts.log');
  const retryPassFile = store.file(job.id, 'retry-pass-domains.txt');
  const chunkInput = store.file(job.id, '.chunk-input.txt');
  const chunkOutput = store.file(job.id, '.chunk-output.jsonl');
  const statusOutput = store.file(job.id, '.status-output.txt');

  const [domainText, sourceRecords] = await Promise.all([
    fs.readFile(input, 'utf8'),
    fs.readFile(recordsFile, 'utf8').then(JSON.parse)
  ]);
  const domains = domainText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const totalDomains = domains.length;
  const nxdomainHosts = new Set();

  const scanMetadata = {
    mainResolvers,
    retryResolvers,
    mainRetryAttempts,
    mainThreads: threads,
    mainRateLimit: rateLimit,
    retryThreads,
    retryRateLimit: retryRate,
    retryAttempts,
    retryTimeoutSeconds,
    chunkSize
  };

  let checkpoint = typeof store.loadCheckpoint === 'function' ? await store.loadCheckpoint(job.id) : null;
  const validCheckpoint = checkpoint
    && checkpoint.version === 1
    && Number(checkpoint.totalDomains) === totalDomains
    && ['main', 'retry', 'finalizing'].includes(checkpoint.phase);

  if (!validCheckpoint) {
    await Promise.all([
      fs.writeFile(dnsOutput, '', 'utf8'),
      fs.writeFile(attemptsLog, '', 'utf8'),
      fs.rm(retryPassFile, { force: true })
    ]);
    checkpoint = {
      version: 1,
      phase: 'main',
      totalDomains,
      mainProcessed: 0,
      retryCandidates: 0,
      retryResolverCount: retryResolvers.length,
      retryResolverIndex: 0,
      retryOffset: 0,
      retryWorkCompleted: 0,
      retryMode: 'rcode-status-v1',
      retryRemaining: 0,
      activeElapsedMs: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (typeof store.saveCheckpoint === 'function') await store.saveCheckpoint(job.id, checkpoint);
  }

  const baseActiveElapsedMs = Number(checkpoint.activeElapsedMs || 0);
  const sessionStartedAt = Date.now();
  const activeElapsedNow = () => baseActiveElapsedMs + (Date.now() - sessionStartedAt);

  const successMap = await loadSuccessMap(dnsOutput);
  const attempts = await loadAttempts(attemptsLog);
  const reconstructed = reconstructSummary({
    domains,
    mainProcessed: checkpoint.mainProcessed,
    sourceRecords,
    successMap,
    attempts
  });
  const summary = reconstructed.summary;
  const partialResults = reconstructed.partialResults;
  const emailCounts = reconstructed.emailCounts;

  // v2.6 used an MX-only JSON retry pass. With current dnsx releases, JSON output
  // can legitimately omit hosts that have no requested MX record, so that retry
  // could never distinguish NO_MX / NXDOMAIN from a missing output row. Migrate
  // an in-progress legacy retry checkpoint into the explicit RCODE status pass.
  if (checkpoint.phase === 'retry' && checkpoint.retryMode !== 'rcode-status-v1') {
    const legacyUnknown = unknownDomains(domains, successMap, attempts);
    await writeDomainList(retryPassFile, legacyUnknown);
    checkpoint = {
      ...checkpoint,
      retryMode: 'rcode-status-v1',
      retryCandidates: legacyUnknown.length,
      retryResolverCount: retryResolvers.length,
      retryResolverIndex: 0,
      retryOffset: 0,
      retryWorkCompleted: 0,
      retryRemaining: legacyUnknown.length,
      updatedAt: new Date().toISOString()
    };
    if (typeof store.saveCheckpoint === 'function') await store.saveCheckpoint(job.id, checkpoint);
  }

  if (Number(checkpoint.mainProcessed || 0) >= totalDomains) {
    const checkedAt = new Date().toISOString();
    summary.processedDomains = 0;
    summary.dnsActive = 0;
    summary.dnsFailed = 0;
    summary.unknown = 0;
    summary.mailEnabled = 0;
    summary.mxEnabledDomains = 0;
    summary.mxEnabledEmails = 0;
    summary.noMx = 0;
    summary.nullMx = 0;
    partialResults.clear();
    for (const domain of domains) {
      applyPartialResult(summary, partialResults, classifyDomain(domain, successMap, nxdomainHosts, { attempts, checkedAt }), emailCounts);
    }
  }
  summary.retryCandidates = Number(checkpoint.retryCandidates || 0);
  summary.retryRemaining = domains.filter((domain) => partialResults.get(domain)?.mailStatus === 'UNKNOWN').length;

  let initialStageProcessed = checkpoint.phase === 'main' ? Number(checkpoint.mainProcessed || 0) : totalDomains;
  let initialStageTotal = totalDomains;
  if (checkpoint.phase === 'retry') {
    const retryPassDomains = await readDomainList(retryPassFile);
    initialStageProcessed = checkpointFileOffset(checkpoint.retryOffset, retryPassDomains.length);
    initialStageTotal = retryPassDomains.length || Number(checkpoint.retryRemaining || checkpoint.retryCandidates || 0);
  }

  await store.update(job.id, {
    status: 'running',
    stage: checkpoint.phase === 'finalizing'
      ? 'Resuming finalization · DNS scan already complete'
      : checkpoint.phase === 'retry'
        ? `Resuming DNS status retry · ${initialStageProcessed.toLocaleString()} / ${initialStageTotal.toLocaleString()}`
        : `MX preflight · ${Number(checkpoint.mainProcessed || 0).toLocaleString()} / ${totalDomains.toLocaleString()}`,
    progress: checkpointProgress(checkpoint),
    summary: {
      ...summary,
      stageProcessed: initialStageProcessed,
      stageTotal: initialStageTotal,
      elapsedSeconds: activeElapsedNow() / 1000,
      etaSeconds: null
    },
    resumable: true,
    checkpoint: publicCheckpoint(checkpoint),
    error: null,
    dnsx: {
      path: found.path,
      version: found.versionOutput.split(/\r?\n/).filter(Boolean).slice(-1)[0] || found.versionOutput,
      ...scanMetadata
    }
  });

  const persistCheckpoint = async (patch = {}) => {
    checkpoint = makeCheckpoint(checkpoint, patch, activeElapsedNow());
    if (typeof store.saveCheckpoint === 'function') await store.saveCheckpoint(job.id, checkpoint);
    return checkpoint;
  };

  const mainArgs = dnsArgs({
    threads,
    rateLimit,
    resolverValue: mainResolvers.join(','),
    retry: mainRetryAttempts,
    timeout: '2s'
  });

  try {
    if (checkpoint.phase === 'main') {
      let processed = Number(checkpoint.mainProcessed || 0);
      const mainSessionStartProcessed = processed;
      const mainStageStartedAt = Date.now();

      while (processed < totalDomains) {
        const chunk = domains.slice(processed, Math.min(totalDomains, processed + chunkSize));
        await executeChunk({
          chunk,
          found,
          processRunner,
          dir,
          chunkInput,
          chunkOutput,
          dnsOutput,
          attemptsLog,
          args: mainArgs,
          successMap,
          attempts,
          signal: deps.control?.signal
        });

        const checkedAt = new Date().toISOString();
        for (const domain of chunk) {
          applyPartialResult(summary, partialResults, classifyDomain(domain, successMap, nxdomainHosts, { attempts, checkedAt }), emailCounts);
        }
        processed += chunk.length;

        await persistCheckpoint({ phase: 'main', mainProcessed: processed });
        await store.update(job.id, {
          stage: `MX preflight · ${processed.toLocaleString()} / ${totalDomains.toLocaleString()} · checkpoint saved`,
          progress: mainProgress(processed, totalDomains),
          resumable: true,
          checkpoint: publicCheckpoint(checkpoint),
          summary: liveResumeFields({
            summary,
            sessionStartedAt: mainStageStartedAt,
            sessionStartProcessed: mainSessionStartProcessed,
            stageProcessed: processed,
            stageTotal: totalDomains,
            activeElapsedMs: activeElapsedNow()
          })
        });
        checkControl(deps.control);
      }

      let remainingUnknown = domains.filter((domain) => partialResults.get(domain)?.mailStatus === 'UNKNOWN');
      summary.retryCandidates = remainingUnknown.length;
      summary.retryRemaining = remainingUnknown.length;

      if (remainingUnknown.length && retryResolvers.length) {
        await writeDomainList(retryPassFile, remainingUnknown);
        await persistCheckpoint({
          phase: 'retry',
          mainProcessed: totalDomains,
          retryCandidates: remainingUnknown.length,
          retryResolverCount: retryResolvers.length,
          retryResolverIndex: 0,
          retryOffset: 0,
          retryWorkCompleted: 0,
          retryMode: 'rcode-status-v1',
          retryRemaining: remainingUnknown.length
        });
      } else {
        await persistCheckpoint({ phase: 'finalizing', mainProcessed: totalDomains, retryOffset: 0 });
      }
    }

    if (checkpoint.phase === 'retry') {
      summary.retryCandidates = Number(checkpoint.retryCandidates || summary.retryCandidates || 0);

      for (let resolverIndex = Number(checkpoint.retryResolverIndex || 0); resolverIndex < retryResolvers.length; resolverIndex += 1) {
        const resolver = retryResolvers[resolverIndex];
        let passDomains;
        let offset;

        if (resolverIndex === Number(checkpoint.retryResolverIndex || 0)) {
          passDomains = await readDomainList(retryPassFile);
          offset = checkpointFileOffset(checkpoint.retryOffset, passDomains.length);
          if (!passDomains.length && offset === 0) {
            passDomains = unknownDomains(domains, successMap, attempts);
            await writeDomainList(retryPassFile, passDomains);
          }
        } else {
          passDomains = unknownDomains(domains, successMap, attempts);
          offset = 0;
          await writeDomainList(retryPassFile, passDomains);
          await persistCheckpoint({ retryResolverIndex: resolverIndex, retryOffset: 0 });
        }

        if (!passDomains.length) break;
        offset = checkpointFileOffset(offset, passDomains.length);
        const passStartOffset = offset;
        const passStartedAt = Date.now();
        const retryArgs = statusArgs({
          threads: retryThreads,
          rateLimit: retryRate,
          resolverValue: resolver,
          retry: retryAttempts,
          timeout: `${retryTimeoutSeconds}s`
        });

        while (offset < passDomains.length) {
          const chunk = passDomains.slice(offset, Math.min(passDomains.length, offset + chunkSize));
          await executeStatusChunk({
            chunk,
            found,
            processRunner,
            dir,
            chunkInput,
            statusOutput,
            dnsOutput,
            attemptsLog,
            args: retryArgs,
            resolver,
            successMap,
            attempts,
            signal: deps.control?.signal
          });

          const checkedAt = new Date().toISOString();
          for (const domain of chunk) {
            applyPartialResult(summary, partialResults, classifyDomain(domain, successMap, nxdomainHosts, { attempts, checkedAt }), emailCounts);
          }
          offset += chunk.length;
          summary.retryRemaining = domains.filter((domain) => partialResults.get(domain)?.mailStatus === 'UNKNOWN').length;

          await persistCheckpoint({
            phase: 'retry',
            mainProcessed: totalDomains,
            retryResolverIndex: resolverIndex,
            retryOffset: offset,
            retryWorkCompleted: Number(checkpoint.retryWorkCompleted || 0) + chunk.length,
            retryMode: 'rcode-status-v1',
            retryRemaining: summary.retryRemaining
          });

          await store.update(job.id, {
            stage: `DNS status retry via ${resolver} · ${offset.toLocaleString()} / ${passDomains.length.toLocaleString()} checked · ${summary.retryRemaining.toLocaleString()} still uncertain · checkpoint saved`,
            progress: retryProgress(summary.retryCandidates, summary.retryRemaining),
            resumable: true,
            checkpoint: publicCheckpoint(checkpoint),
            summary: liveResumeFields({
              summary,
              sessionStartedAt: passStartedAt,
              sessionStartProcessed: passStartOffset,
              stageProcessed: offset,
              stageTotal: passDomains.length,
              activeElapsedMs: activeElapsedNow()
            })
          });
          checkControl(deps.control);
        }

        const remainingUnknown = unknownDomains(domains, successMap, attempts);
        summary.retryRemaining = remainingUnknown.length;
        if (!remainingUnknown.length || resolverIndex >= retryResolvers.length - 1) break;

        await persistCheckpoint({
          retryResolverIndex: resolverIndex + 1,
          retryOffset: 0,
          retryRemaining: remainingUnknown.length,
          retryMode: 'rcode-status-v1'
        });
        await writeDomainList(retryPassFile, remainingUnknown);
      }

      await persistCheckpoint({ phase: 'finalizing', mainProcessed: totalDomains, retryOffset: 0 });
    }

    if (checkpoint.phase === 'finalizing') {
      partialResults.clear();
      await store.update(job.id, {
        stage: 'Building canonical results and reports · DNS scan checkpoint complete',
        progress: 96,
        resumable: true,
        checkpoint: publicCheckpoint(checkpoint),
        summary: {
          ...summary,
          stageProcessed: totalDomains,
          stageTotal: totalDomains,
          elapsedSeconds: activeElapsedNow() / 1000,
          etaSeconds: null
        }
      });

      const checkedAt = new Date().toISOString();
      checkControl(deps.control);
      const noNxHosts = new Set();
      const resolveDomain = (domain) => classifyDomain(domain, successMap, noNxHosts, { attempts, checkedAt });
      const finalCounts = blankSummary(totalDomains, sourceRecords);
      const preview = [];
      const canonicalFile = store.file(job.id, 'canonical-domain-results.jsonl');

      function* canonicalRows() {
        for (const domain of domains) {
          const row = resolveDomain(domain);
          if (preview.length < 200) preview.push(row);
          finalCounts.processedDomains += 1;
          changeRowCounts(finalCounts, row, 1, emailCounts);
          yield row;
        }
      }

      function recordRow(record) {
        return {
          ...record,
          ...(resolveDomain(record.domain) || {
            dnsStatus: 'UNKNOWN',
            mailStatus: 'UNKNOWN',
            provider: '',
            mx: [],
            statusCode: '',
            statusCodes: [],
            resolvers: [],
            attempts: 0,
            lastCheckedAt: null,
            recommendedAction: 'RETRY_OR_REVIEW'
          })
        };
      }

      async function* recordRows(predicate = null) {
        for (const record of sourceRecords) {
          const row = recordRow(record);
          if (!predicate || predicate(row)) yield row;
        }
      }

      async function* canonicalReportRows(predicate = null) {
        for await (const row of readJsonlRows(canonicalFile)) {
          if (!predicate || predicate(row)) yield row;
        }
      }

      const streamOptions = {
        signal: deps.control?.signal,
        checkControl: () => checkControl(deps.control),
        progressEvery: 5000
      };

      await store.update(job.id, {
        stage: 'Writing canonical DNS archive · 1 / 9',
        progress: 96,
        resumable: true,
        checkpoint: publicCheckpoint(checkpoint)
      });
      await writeJsonlFile(canonicalFile, canonicalRows(), streamOptions);

      validateConsistency(finalCounts);
      finalCounts.consistencyOk = true;

      const metadata = {
        jobId: job.id,
        completedAt: checkedAt,
        resumedFromCheckpoint: Boolean(validCheckpoint),
        ...scanMetadata,
        summary: finalCounts
      };

      const reportSteps = [
        ['Writing unique-domain report', () => writeCsvFile(store.file(job.id, 'domain-results.csv'), canonicalReportRows(), domainColumns, streamOptions)],
        ['Writing MX-enabled domain report', () => writeCsvFile(store.file(job.id, 'mx-enabled-domains.csv'), canonicalReportRows((r) => r.mailStatus === 'MAIL_ENABLED'), domainColumns, streamOptions)],
        ['Writing full input report', () => writeCsvFile(store.file(job.id, 'full-results.csv'), recordRows(), recordColumns, streamOptions)],
        ['Writing MX-enabled email report', () => writeCsvFile(store.file(job.id, 'mx-enabled-emails.csv'), recordRows((r) => r.inputType === 'email' && r.mailStatus === 'MAIL_ENABLED'), recordColumns, streamOptions)],
        ['Writing excluded-input report', () => writeCsvFile(store.file(job.id, 'excluded.csv'), recordRows((r) => ['NULL_MX', 'DNS_FAILED'].includes(r.mailStatus)), recordColumns, streamOptions)],
        ['Writing review report', () => writeCsvFile(store.file(job.id, 'review.csv'), recordRows((r) => ['NO_MX', 'UNKNOWN'].includes(r.mailStatus)), recordColumns, streamOptions)],
        ['Writing scan summary', () => writeCsvFile(store.file(job.id, 'scan-summary.csv'), summaryRows(finalCounts, scanMetadata), summaryColumns, streamOptions)],
        ['Writing canonical JSON archive', () => writeJsonArrayFile(store.file(job.id, 'domain-results.json'), readJsonlRows(canonicalFile), streamOptions)]
      ];

      for (let i = 0; i < reportSteps.length; i += 1) {
        const [label, writer] = reportSteps[i];
        const stepNumber = i + 2;
        checkControl(deps.control);
        await store.update(job.id, {
          stage: `${label} · ${stepNumber} / 9`,
          progress: Math.min(99, 96 + Math.floor((stepNumber / 9) * 3)),
          resumable: true,
          checkpoint: publicCheckpoint(checkpoint)
        });
        await writer();
      }

      checkControl(deps.control);
      await fs.writeFile(store.file(job.id, 'scan-metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

      const elapsedSeconds = Math.max(0, activeElapsedNow() / 1000);
      const finalSummary = {
        ...finalCounts,
        processedDomains: totalDomains,
        unprocessedDomains: 0,
        partial: false,
        stageProcessed: totalDomains,
        stageTotal: totalDomains,
        rateDomainsPerSec: elapsedSeconds > 0 ? totalDomains / elapsedSeconds : 0,
        elapsedSeconds,
        etaSeconds: 0,
        retryCandidates: summary.retryCandidates,
        retryRemaining: finalCounts.unknown
      };

      checkpoint = makeCheckpoint(checkpoint, { phase: 'completed', mainProcessed: totalDomains }, activeElapsedNow());
      if (typeof store.saveCheckpoint === 'function') await store.saveCheckpoint(job.id, checkpoint);

      await store.update(job.id, {
        status: 'completed',
        stage: 'Complete · consistency verified',
        progress: 100,
        summary: finalSummary,
        resumable: false,
        checkpoint: publicCheckpoint(checkpoint),
        downloads: [
          'scan-summary.csv',
          'full-results.csv',
          'domain-results.csv',
          'mx-enabled-emails.csv',
          'mx-enabled-domains.csv',
          'excluded.csv',
          'review.csv'
        ],
        preview
      });
    }
  } finally {
    await Promise.all([
      fs.rm(chunkInput, { force: true }),
      fs.rm(chunkOutput, { force: true }),
      fs.rm(statusOutput, { force: true })
    ]);
  }
}
