import { domainToASCII } from 'node:url';
import net from 'node:net';

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EMAIL_RE = /^[^\s@<>]+@([^\s@<>]+)$/;

function cleanToken(value) {
  return String(value ?? '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[),.;]+$/g, '')
    .trim();
}

export function normalizeCandidate(value) {
  const original = cleanToken(value);
  if (!original) return null;

  let candidate = original;
  const emailMatch = candidate.match(EMAIL_RE);
  if (emailMatch) candidate = emailMatch[1];

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).hostname;
    } catch {
      return null;
    }
  } else {
    candidate = candidate.replace(/^\/\//, '');
    candidate = candidate.split('/')[0].split('?')[0].split('#')[0];
    candidate = candidate.replace(/:\d+$/, '');
  }

  candidate = candidate.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!candidate || net.isIP(candidate)) return null;

  const ascii = domainToASCII(candidate);
  if (!ascii || !DOMAIN_RE.test(ascii)) return null;

  return {
    input: original,
    domain: ascii.toLowerCase(),
    inputType: emailMatch ? 'email' : 'domain'
  };
}

// Yield tokens one-by-one instead of building another large array in memory.
function* candidatesFromText(text) {
  const source = String(text ?? '');
  let token = '';
  const flush = function* () {
    const value = token.trim();
    token = '';
    if (value) yield value;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\r' || ch === '\n' || ch === '\t' || ch === ',' || ch === ';' || ch === ' ') {
      yield* flush();
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
    } else {
      token += ch;
    }
  }
  yield* flush();
}

// Small RFC-4180-style CSV cell reader. Values are yielded incrementally so
// large CSVs do not create a huge temporary argument/array allocation.
function* candidatesFromCsv(text) {
  let cell = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      const value = cell.trim();
      if (value) yield value;
      cell = '';
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
    } else {
      cell += ch;
    }
  }

  const value = cell.trim();
  if (value) yield value;
}

export function parseInput({ fileText = '', filename = '', pastedText = '' } = {}) {
  const records = [];
  const uniqueDomainSet = new Set();
  let rawValues = 0;
  let rejectedValues = 0;

  const consume = (iterable) => {
    for (const value of iterable) {
      rawValues += 1;
      const normalized = normalizeCandidate(value);
      if (!normalized) {
        rejectedValues += 1;
        continue;
      }
      records.push(normalized);
      uniqueDomainSet.add(normalized.domain);
    }
  };

  if (fileText) {
    const isCsv = filename.toLowerCase().endsWith('.csv');
    consume(isCsv ? candidatesFromCsv(fileText) : candidatesFromText(fileText));
  }

  if (pastedText) consume(candidatesFromText(pastedText));

  const uniqueDomains = Array.from(uniqueDomainSet);

  return {
    records,
    uniqueDomains,
    stats: {
      rawValues,
      acceptedRecords: records.length,
      rejectedValues,
      uniqueDomains: uniqueDomains.length
    }
  };
}
