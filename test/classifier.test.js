import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDomains, detectProvider, mergeDnsxObjects, summarize } from '../src/classifier.js';

test('detects common MX providers', () => {
  assert.equal(detectProvider(['aspmx.l.google.com']), 'Google Workspace');
  assert.equal(detectProvider(['x.mail.protection.outlook.com']), 'Microsoft 365');
});

test('classifies mail-enabled, null MX, no MX and NXDOMAIN', () => {
  const map = mergeDnsxObjects([
    { host: 'good.com', a: ['1.2.3.4'], mx: ['mx.good.com'], status_code: 'NOERROR' },
    { host: 'null.com', a: ['1.2.3.5'], mx: ['.'], status_code: 'NOERROR' },
    { host: 'nomx.com', a: ['1.2.3.6'], status_code: 'NOERROR' }
  ]);
  const rows = classifyDomains(['good.com', 'null.com', 'nomx.com', 'dead.com'], map, new Set(['dead.com']));
  assert.equal(rows[0].mailStatus, 'MAIL_ENABLED');
  assert.equal(rows[1].mailStatus, 'NULL_MX');
  assert.equal(rows[2].mailStatus, 'NO_MX');
  assert.equal(rows[3].dnsStatus, 'DNS_FAILED');
  const sum = summarize(rows);
  assert.equal(sum.totalDomains, 4);
  assert.equal(sum.mailEnabled, 1);
});

test('normalizes MX presentation values with preference and null-MX targets', () => {
  const map = mergeDnsxObjects([
    {
      host: 'weighted.example',
      mx: ['10 mx1.weighted.example.', '20 mx2.weighted.example.'],
      status_code: 'NOERROR'
    },
    {
      host: 'null-weighted.example',
      mx: ['0 .'],
      status_code: 'NOERROR'
    }
  ]);

  const rows = classifyDomains(['weighted.example', 'null-weighted.example'], map);
  assert.equal(rows[0].mailStatus, 'MAIL_ENABLED');
  assert.deepEqual(rows[0].mx, ['mx1.weighted.example', 'mx2.weighted.example']);
  assert.equal(rows[1].mailStatus, 'NULL_MX');
});
