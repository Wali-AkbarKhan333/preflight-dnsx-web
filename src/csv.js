function quote(value) {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function rowsToCsv(rows, columns) {
  const header = columns.map((c) => quote(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => quote(c.value(row))).join(',')).join('\n');
  return `${header}\n${body}${body ? '\n' : ''}`;
}

export const domainColumns = [
  { label: 'domain', value: (r) => r.domain },
  { label: 'dns_status', value: (r) => r.dnsStatus },
  { label: 'mail_status', value: (r) => r.mailStatus },
  { label: 'mx_provider', value: (r) => r.provider },
  { label: 'mx_servers', value: (r) => r.mx },
  { label: 'a_records', value: (r) => r.a },
  { label: 'aaaa_records', value: (r) => r.aaaa },
  { label: 'ns_records', value: (r) => r.ns },
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
  { label: 'recommended_action', value: (r) => r.recommendedAction }
];
