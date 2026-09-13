import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildRecordResults,
  classifyDomains,
  mergeDnsxObjects,
  summarize,
  validateConsistency
} from '../src/classifier.js';
import { runScan } from '../src/scanner.js';

test('dashboard-style summary separates MX-enabled domains from MX-enabled email rows', () => {
  const map = mergeDnsxObjects([
    { host: 'acme.com', mx: ['mx.acme.com'], status_code: 'NOERROR', resolver: '1.1.1.1:53' },
    { host: 'nomx.com', status_code: 'NOERROR', resolver: '1.1.1.1:53' }
  ]);
  const domains = classifyDomains(['acme.com', 'nomx.com'], map);
  const records = [
    { input: 'a@acme.com', domain: 'acme.com', inputType: 'email' },
    { input: 'b@acme.com', domain: 'acme.com', inputType: 'email' },
    { input: 'acme.com', domain: 'acme.com', inputType: 'domain' },
    { input: 'c@nomx.com', domain: 'nomx.com', inputType: 'email' }
  ];

  const summary = summarize(domains, records);
  assert.equal(summary.totalDomains, 2);
  assert.equal(summary.totalInputRecords, 4);
  assert.equal(summary.inputEmails, 3);
  assert.equal(summary.mxEnabledDomains, 1);
  assert.equal(summary.mxEnabledEmails, 2);
  assert.equal(summary.noMx, 1);
  assert.equal(validateConsistency(summary), true);

  const recordResults = buildRecordResults(records, domains);
  assert.equal(recordResults.filter((r) => r.inputType === 'email' && r.mailStatus === 'MAIL_ENABLED').length, summary.mxEnabledEmails);
});

test('missing MX JSON rows are resolved by RCODE status retry and canonical exports match summary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-preflight-v261-'));
  const jobDir = path.join(root, 'job1');
  await fs.mkdir(jobDir, { recursive: true });

  const domains = ['stable.com', 'nomx.com', 'dead.com'];
  const records = [
    { input: 'a@stable.com', domain: 'stable.com', inputType: 'email' },
    { input: 'b@nomx.com', domain: 'nomx.com', inputType: 'email' },
    { input: 'c@dead.com', domain: 'dead.com', inputType: 'email' }
  ];
  await fs.writeFile(path.join(jobDir, 'input-domains.txt'), `${domains.join('\n')}\n`);
  await fs.writeFile(path.join(jobDir, 'source-records.json'), JSON.stringify(records));

  const fakeDnsx = { path: 'fake-dnsx', versionOutput: '[INF] Current Version: test' };
  const invocations = [];
  const fakeRunProcess = async (_command, args) => {
    invocations.push([...args]);
    const input = args[args.indexOf('-l') + 1];
    const output = args[args.indexOf('-o') + 1];
    const list = (await fs.readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean);
    const isMxJson = args.includes('-json') && args.includes('-mx');
    const lines = [];

    if (isMxJson) {
      for (const domain of list) {
        if (domain === 'stable.com') {
          lines.push(JSON.stringify({ host: domain, mx: ['mx.stable.com'], status_code: 'NOERROR', resolver: '9.9.9.9' }));
        }
        // Intentionally omit nomx.com and dead.com, matching the real-world
        // record-filter behavior that previously inflated UNKNOWN.
      }
    } else {
      for (const domain of list) {
        if (domain === 'nomx.com') lines.push(`${domain} [NOERROR]`);
        else if (domain === 'dead.com') lines.push(`${domain} [NXDOMAIN]`);
      }
    }

    await fs.writeFile(output, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
    return { code: 0, stderr: '' };
  };

  const job = { id: 'job1', settings: { threads: 10, rateLimit: 100 } };
  const store = {
    dir: () => jobDir,
    file: (_id, name) => path.join(jobDir, name),
    async update(_id, patch) { Object.assign(job, patch); return job; }
  };

  const old = {
    DNS_RESOLVERS: process.env.DNS_RESOLVERS,
    UNKNOWN_RETRY_RESOLVERS: process.env.UNKNOWN_RETRY_RESOLVERS,
    UNKNOWN_RETRY_THREADS: process.env.UNKNOWN_RETRY_THREADS,
    UNKNOWN_RETRY_RATE_LIMIT: process.env.UNKNOWN_RETRY_RATE_LIMIT
  };
  process.env.DNS_RESOLVERS = '9.9.9.9';
  process.env.UNKNOWN_RETRY_RESOLVERS = '1.1.1.1';
  process.env.UNKNOWN_RETRY_THREADS = '5';
  process.env.UNKNOWN_RETRY_RATE_LIMIT = '20';

  try {
    await runScan(job, store, { dnsx: fakeDnsx, runProcess: fakeRunProcess });
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }

  assert.equal(job.status, 'completed');
  assert.equal(job.summary.consistencyOk, true);
  assert.equal(job.summary.mxEnabledDomains, 1);
  assert.equal(job.summary.mxEnabledEmails, 1);
  assert.equal(job.summary.noMx, 1);
  assert.equal(job.summary.dnsFailed, 1);
  assert.equal(job.summary.unknown, 0);
  assert.ok(invocations.some((args) => args.includes('-mx') && args.includes('-json')));
  assert.ok(invocations.some((args) => args.includes('-rcode') && !args.includes('-json') && !args.includes('-mx')));

  const domainCsv = await fs.readFile(path.join(jobDir, 'mx-enabled-domains.csv'), 'utf8');
  const emailCsv = await fs.readFile(path.join(jobDir, 'mx-enabled-emails.csv'), 'utf8');
  assert.equal(domainCsv.trim().split(/\r?\n/).length - 1, job.summary.mxEnabledDomains);
  assert.equal(emailCsv.trim().split(/\r?\n/).length - 1, job.summary.mxEnabledEmails);
  const canonicalJson = JSON.parse(await fs.readFile(path.join(jobDir, 'domain-results.json'), 'utf8'));
  const canonicalJsonl = (await fs.readFile(path.join(jobDir, 'canonical-domain-results.jsonl'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(canonicalJson.length, job.summary.totalDomains);
  assert.equal(canonicalJsonl.length, job.summary.totalDomains);

  await fs.rm(root, { recursive: true, force: true });
});
