import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate, parseInput } from '../src/input.js';

 test('normalizes email, URL and domain input', () => {
  assert.equal(normalizeCandidate('John@Example.COM').domain, 'example.com');
  assert.equal(normalizeCandidate('https://www.OpenAI.com/about').domain, 'openai.com');
  assert.equal(normalizeCandidate('github.com').domain, 'github.com');
  assert.equal(normalizeCandidate('not a domain'), null);
});

test('deduplicates domains while preserving source records', () => {
  const out = parseInput({ pastedText: 'a@example.com\nb@example.com\nopenai.com' });
  assert.equal(out.records.length, 3);
  assert.deepEqual(out.uniqueDomains.sort(), ['example.com', 'openai.com']);
});

test('parses a large CSV without overflowing the JavaScript call stack', () => {
  const rows = ['email'];
  for (let i = 0; i < 120000; i += 1) rows.push(`person${i}@company${i}.com`);
  const out = parseInput({ fileText: rows.join('\n'), filename: 'large.csv' });
  assert.equal(out.records.length, 120000);
  assert.equal(out.uniqueDomains.length, 120000);
  assert.equal(out.stats.rejectedValues, 1); // header cell is not a domain/email
});
