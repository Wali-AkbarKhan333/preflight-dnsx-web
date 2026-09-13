import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { once } from 'node:events';

function quote(value) {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  if (/[,"\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function rowsToCsv(rows, columns) {
  const header = columns.map((c) => quote(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => quote(c.value(row))).join(',')).join('\n');
  return `${header}\n${body}${body ? '\n' : ''}`;
}

function abortError() {
  const error = new Error('Operation canceled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

async function writeChunk(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

async function finishStream(stream) {
  stream.end();
  await once(stream, 'finish');
}

async function atomicStreamWrite(file, writer) {
  const temp = `${file}.tmp`;
  await fsp.rm(temp, { force: true });
  const stream = fs.createWriteStream(temp, { encoding: 'utf8' });
  try {
    await writer(stream);
    await finishStream(stream);
    await fsp.rename(temp, file);
  } catch (error) {
    stream.destroy();
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Stream CSV rows to disk instead of constructing one large in-memory string.
 * `rows` may be an Array, generator, or synchronous/asynchronous iterable.
 */
export async function writeCsvFile(file, rows, columns, options = {}) {
  const { signal, checkControl, progressEvery = 2000, onProgress } = options;
  let written = 0;

  await atomicStreamWrite(file, async (stream) => {
    await writeChunk(stream, `${columns.map((c) => quote(c.label)).join(',')}\n`);
    for await (const row of rows) {
      if (signal?.aborted) throw abortError();
      if (checkControl && written % progressEvery === 0) checkControl();
      await writeChunk(stream, `${columns.map((c) => quote(c.value(row))).join(',')}\n`);
      written += 1;
      if (onProgress && written % progressEvery === 0) await onProgress(written);
    }
  });

  return written;
}

export async function writeJsonlFile(file, rows, options = {}) {
  const { signal, checkControl, progressEvery = 2000 } = options;
  let written = 0;
  await atomicStreamWrite(file, async (stream) => {
    for await (const row of rows) {
      if (signal?.aborted) throw abortError();
      if (checkControl && written % progressEvery === 0) checkControl();
      await writeChunk(stream, `${JSON.stringify(row)}\n`);
      written += 1;
    }
  });
  return written;
}

export async function writeJsonArrayFile(file, rows, options = {}) {
  const { signal, checkControl, progressEvery = 2000 } = options;
  let written = 0;
  await atomicStreamWrite(file, async (stream) => {
    await writeChunk(stream, '[');
    let first = true;
    for await (const row of rows) {
      if (signal?.aborted) throw abortError();
      if (checkControl && written % progressEvery === 0) checkControl();
      if (!first) await writeChunk(stream, ',');
      await writeChunk(stream, JSON.stringify(row));
      first = false;
      written += 1;
    }
    await writeChunk(stream, ']');
  });
  return written;
}

export const domainColumns = [
  { label: 'domain', value: (r) => r.domain },
  { label: 'dns_status', value: (r) => r.dnsStatus },
  { label: 'mail_status', value: (r) => r.mailStatus },
  { label: 'mx_provider', value: (r) => r.provider },
  { label: 'mx_servers', value: (r) => r.mx },
  { label: 'dns_status_code', value: (r) => r.statusCode },
  { label: 'dns_status_codes_seen', value: (r) => r.statusCodes },
  { label: 'resolvers_used', value: (r) => r.resolvers },
  { label: 'attempts', value: (r) => r.attempts },
  { label: 'last_checked_at', value: (r) => r.lastCheckedAt },
  { label: 'recommended_action', value: (r) => r.recommendedAction }
];

export const recordColumns = [
  { label: 'input', value: (r) => r.input },
  { label: 'input_type', value: (r) => r.inputType },
  { label: 'domain', value: (r) => r.domain },
  { label: 'dns_status', value: (r) => r.dnsStatus },
  { label: 'mail_status', value: (r) => r.mailStatus },
  { label: 'mx_provider', value: (r) => r.provider },
  { label: 'mx_servers', value: (r) => r.mx },
  { label: 'dns_status_code', value: (r) => r.statusCode },
  { label: 'resolvers_used', value: (r) => r.resolvers },
  { label: 'attempts', value: (r) => r.attempts },
  { label: 'last_checked_at', value: (r) => r.lastCheckedAt },
  { label: 'recommended_action', value: (r) => r.recommendedAction }
];

export const summaryColumns = [
  { label: 'metric', value: (r) => r.metric },
  { label: 'value', value: (r) => r.value }
];

export const simpleDomainColumns = [
  { label: 'domain', value: (r) => typeof r === 'string' ? r : r.domain }
];
