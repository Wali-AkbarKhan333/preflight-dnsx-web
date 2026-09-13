import fs from 'node:fs/promises';
import { mergeDnsxObjects, classifyDomains, summarize } from './classifier.js';
import {
  domainColumns,
  recordColumns,
  summaryColumns,
  simpleDomainColumns,
  writeCsvFile
} from './csv.js';

export const PARTIAL_DOWNLOADS = [
  'partial-scan-summary.csv',
  'partial-all-results.csv',
  'partial-domain-results.csv',
  'partial-mx-enabled-emails.csv',
  'partial-mx-enabled-domains.csv',
  'partial-excluded.csv',
  'partial-review.csv',
  'unprocessed-domains.csv'
];

async function readLines(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function parseJsonl(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const objects = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { objects.push(JSON.parse(line)); } catch {}
  }
  return objects;
}

async function loadAttempts(file) {
  const map = new Map();
  for (const domain of await readLines(file)) {
    map.set(domain, Number(map.get(domain) || 0) + 1);
  }
  return map;
}

function recordRow(record, byDomain) {
  return {
    ...record,
    ...(byDomain.get(record.domain) || {
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

function* recordRows(records, byDomain, predicate = null) {
  for (const record of records) {
    const row = recordRow(record, byDomain);
    if (!predicate || predicate(row)) yield row;
  }
}

function overallInputMetrics(records) {
  const inputEmails = records.reduce((count, row) => count + (row.inputType === 'email' ? 1 : 0), 0);
  return {
    totalInputRecords: records.length,
    inputEmails,
    inputOtherRecords: records.length - inputEmails
  };
}

function processedDomainsForCheckpoint(domains, checkpoint) {
  if (!checkpoint || checkpoint.version !== 1) return [];
  if (checkpoint.phase === 'main') {
    const count = Math.max(0, Math.min(domains.length, Number(checkpoint.mainProcessed || 0)));
    return domains.slice(0, count);
  }
  if (['retry', 'finalizing', 'completed'].includes(checkpoint.phase)) return [...domains];
  return [];
}

function summaryRows(summary, job, checkpoint) {
  const dnsx = job.dnsx || {};
  return [
    ['scan_status', 'PARTIAL'],
    ['job_status', job.status || 'stopped'],
    ['checkpoint_phase', checkpoint?.phase || 'unknown'],
    ['total_input_records', summary.totalInputRecords],
    ['processed_input_records', summary.processedInputRecords],
    ['input_emails', summary.inputEmails],
    ['processed_input_emails', summary.processedInputEmails],
    ['total_unique_domains', summary.totalDomains],
    ['processed_unique_domains', summary.processedDomains],
    ['unprocessed_unique_domains', summary.unprocessedDomains],
    ['progress_percent', summary.partialProgressPercent],
    ['mx_enabled_domains', summary.mxEnabledDomains],
    ['mx_enabled_emails', summary.mxEnabledEmails],
    ['no_mx_domains', summary.noMx],
    ['null_mx_domains', summary.nullMx],
    ['dns_failed_domains', summary.dnsFailed],
    ['unknown_domains', summary.unknown],
    ['main_resolvers', Array.isArray(dnsx.mainResolvers) ? dnsx.mainResolvers.join('; ') : ''],
    ['retry_resolvers', Array.isArray(dnsx.retryResolvers) ? dnsx.retryResolvers.join('; ') : ''],
    ['generated_at', new Date().toISOString()]
  ].map(([metric, value]) => ({ metric, value }));
}

/**
 * Build downloadable reports from only fully checkpointed work.
 * This can be called after pause, cancel, crash recovery, or a scan error.
 */
export async function buildPartialArtifacts(jobId, store, options = {}) {
  const job = await store.get(jobId);
  if (!job || job.filesDeleted) return {};

  const checkpoint = await store.loadCheckpoint(jobId);
  const totalFromCheckpoint = Number(checkpoint?.totalDomains || job.summary?.totalDomains || job.parseStats?.uniqueDomains || 0);
  const processedFromCheckpoint = checkpoint?.phase === 'main'
    ? Math.max(0, Math.min(totalFromCheckpoint, Number(checkpoint?.mainProcessed || 0)))
    : ['retry', 'finalizing', 'completed'].includes(checkpoint?.phase) ? totalFromCheckpoint : 0;

  if (options.generateFiles === false) {
    if (!processedFromCheckpoint) return {};
    return {
      downloads: [...PARTIAL_DOWNLOADS],
      summary: job.summary ? {
        ...job.summary,
        partial: true,
        processedDomains: processedFromCheckpoint,
        unprocessedDomains: Math.max(0, totalFromCheckpoint - processedFromCheckpoint)
      } : job.summary
    };
  }

  const domains = await readLines(store.file(jobId, 'input-domains.txt'));
  const processedDomains = processedDomainsForCheckpoint(domains, checkpoint);
  if (!processedDomains.length) {
    return {
      downloads: [],
      preview: [],
      summary: job.summary ? { ...job.summary, processedDomains: 0, unprocessedDomains: domains.length } : job.summary
    };
  }

  const [sourceRecords, objects, attempts] = await Promise.all([
    readJson(store.file(jobId, 'source-records.json'), []),
    parseJsonl(store.file(jobId, 'dns.jsonl')),
    loadAttempts(store.file(jobId, 'attempts.log'))
  ]);
  const successMap = mergeDnsxObjects(objects);
  const checkedAt = checkpoint?.updatedAt || new Date().toISOString();
  const domainResults = classifyDomains(processedDomains, successMap, new Set(), { attempts, checkedAt });
  const processedSet = new Set(processedDomains);
  const processedRecords = sourceRecords.filter((record) => processedSet.has(record.domain));
  const byDomain = new Map(domainResults.map((row) => [row.domain, row]));
  const partialCounts = summarize(domainResults, processedRecords);
  const fullInput = overallInputMetrics(sourceRecords);
  const processedInput = overallInputMetrics(processedRecords);
  const unprocessedDomains = domains.slice(processedDomains.length);

  const summary = {
    ...partialCounts,
    ...fullInput,
    totalDomains: domains.length,
    uniqueDomains: domains.length,
    processedDomains: processedDomains.length,
    unprocessedDomains: domains.length - processedDomains.length,
    processedInputRecords: processedInput.totalInputRecords,
    processedInputEmails: processedInput.inputEmails,
    partial: true,
    partialProgressPercent: domains.length ? Number(((processedDomains.length / domains.length) * 100).toFixed(2)) : 0,
    stageProcessed: processedDomains.length,
    stageTotal: domains.length,
    rateDomainsPerSec: Number(job.summary?.rateDomainsPerSec || 0),
    elapsedSeconds: Number(job.summary?.elapsedSeconds || checkpoint?.activeElapsedMs / 1000 || 0),
    etaSeconds: null,
    retryCandidates: Number(job.summary?.retryCandidates || checkpoint?.retryCandidates || 0),
    retryRemaining: partialCounts.unknown,
    consistencyOk: null
  };

  const mailDomains = domainResults.filter((row) => row.mailStatus === 'MAIL_ENABLED');
  const control = { progressEvery: 5000 };

  await writeCsvFile(store.file(jobId, 'partial-scan-summary.csv'), summaryRows(summary, job, checkpoint), summaryColumns, control);
  await writeCsvFile(store.file(jobId, 'partial-domain-results.csv'), domainResults, domainColumns, control);
  await writeCsvFile(store.file(jobId, 'partial-mx-enabled-domains.csv'), mailDomains, domainColumns, control);
  await writeCsvFile(store.file(jobId, 'partial-all-results.csv'), recordRows(processedRecords, byDomain), recordColumns, control);
  await writeCsvFile(
    store.file(jobId, 'partial-mx-enabled-emails.csv'),
    recordRows(processedRecords, byDomain, (row) => row.inputType === 'email' && row.mailStatus === 'MAIL_ENABLED'),
    recordColumns,
    control
  );
  await writeCsvFile(
    store.file(jobId, 'partial-excluded.csv'),
    recordRows(processedRecords, byDomain, (row) => ['NULL_MX', 'DNS_FAILED'].includes(row.mailStatus)),
    recordColumns,
    control
  );
  await writeCsvFile(
    store.file(jobId, 'partial-review.csv'),
    recordRows(processedRecords, byDomain, (row) => ['NO_MX', 'UNKNOWN'].includes(row.mailStatus)),
    recordColumns,
    control
  );
  await writeCsvFile(store.file(jobId, 'unprocessed-domains.csv'), unprocessedDomains, simpleDomainColumns, control);

  return {
    downloads: [...PARTIAL_DOWNLOADS],
    preview: domainResults.slice(0, 200),
    summary
  };
}
