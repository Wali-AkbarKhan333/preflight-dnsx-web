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
