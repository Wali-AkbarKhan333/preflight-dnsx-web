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

function candidatesFromText(text) {
  return String(text ?? '')
    .split(/[\r\n\t,; ]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Small RFC-4180-style CSV cell reader. We only need cell values, not column names.
function candidatesFromCsv(text) {
  const cells = [];
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
      if (cell.trim()) cells.push(cell.trim());
      cell = '';
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
    } else {
      cell += ch;
    }
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

export function parseInput({ fileText = '', filename = '', pastedText = '' } = {}) {
  const values = [];

  if (fileText) {
    const isCsv = filename.toLowerCase().endsWith('.csv');
    values.push(...(isCsv ? candidatesFromCsv(fileText) : candidatesFromText(fileText)));
  }

  if (pastedText) values.push(...candidatesFromText(pastedText));

  const records = [];
  for (const value of values) {
    const normalized = normalizeCandidate(value);
    if (normalized) records.push(normalized);
  }

  const uniqueDomains = [...new Set(records.map((r) => r.domain))];

  return {
    records,
    uniqueDomains,
    stats: {
      rawValues: values.length,
      acceptedRecords: records.length,
      rejectedValues: Math.max(0, values.length - records.length),
      uniqueDomains: uniqueDomains.length
    }
  };
}
