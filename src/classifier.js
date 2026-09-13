function toArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(toArray);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0 || value === '');
  }
  return [String(value)];
}

function cleanHost(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

function cleanResolver(value) {
  return String(value ?? '').trim().replace(/\.$/, '');
}

function addUniqueValue(row, field, value) {
  if (!row[field]) row[field] = [];
  if (!row[field].includes(value)) row[field].push(value);
}

function normalizeMxValue(value) {
  const text = String(value ?? '').trim();
  // dnsx normally emits the MX target, but tolerate the presentation form
  // used by DNS libraries as well: "10 mail.example.com." and "0 .".
  const target = text.replace(/^\d+(?:\s+|$)/, '').trim();
  const host = cleanHost(target);
  return {
    host,
    isNull: !host || host === '.'
  };
}

export function detectProvider(mxServers) {
  const joined = mxServers.map(cleanHost).join(' ');
  if (!joined) return '';
  if (/google\.com|googlemail\.com/.test(joined)) return 'Google Workspace';
  if (/protection\.outlook\.com|outlook\.com/.test(joined)) return 'Microsoft 365';
  if (/zoho\.(com|eu|in)|zohomail\.com/.test(joined)) return 'Zoho Mail';
  if (/protonmail\.ch|proton\.me/.test(joined)) return 'Proton Mail';
  if (/yahoodns\.net|yahoo\.com/.test(joined)) return 'Yahoo Mail';
  if (/secureserver\.net/.test(joined)) return 'GoDaddy';
  if (/emailsrvr\.com/.test(joined)) return 'Rackspace';
  if (/mimecast\.com/.test(joined)) return 'Mimecast';
  if (/pphosted\.com|pp-hosted\.com/.test(joined)) return 'Proofpoint';
  if (/icloud\.com/.test(joined)) return 'Apple iCloud';
  if (/amazonaws\.com|amazonses\.com/.test(joined)) return 'Amazon SES';
  if (/mx\.cloudflare\.net/.test(joined)) return 'Cloudflare Email Routing';
  if (/mxroute\.com/.test(joined)) return 'MXroute';
  return 'Other / Custom';
}

export function mergeDnsxObjects(objects = []) {
  const map = new Map();

  for (const obj of objects) {
    const host = cleanHost(obj.host ?? obj.input ?? obj.name);
    if (!host) continue;

    if (!map.has(host)) {
      map.set(host, {
        host,
        observations: 0,
        mxFieldSeen: false,
        nullMxSeen: false
      });
    }

    const row = map.get(host);
    row.observations += 1;

    for (const item of toArray(obj.a)) if (item) addUniqueValue(row, 'a', cleanHost(item));
    for (const item of toArray(obj.aaaa)) if (item) addUniqueValue(row, 'aaaa', cleanHost(item));
    for (const item of toArray(obj.ns)) if (item) addUniqueValue(row, 'ns', cleanHost(item));

    if (Object.prototype.hasOwnProperty.call(obj, 'mx')) {
      row.mxFieldSeen = true;
      const mxValues = toArray(obj.mx);
      for (const raw of mxValues) {
        const normalized = normalizeMxValue(raw);
        if (normalized.isNull) {
          row.nullMxSeen = true;
        } else {
          addUniqueValue(row, 'mx', normalized.host);
        }
      }
    }

    const status = String(obj.status_code ?? obj.statusCode ?? '').toUpperCase().trim();
    if (status) addUniqueValue(row, 'statusCodes', status);

    for (const resolver of toArray(obj.resolver)) {
      const value = cleanResolver(resolver);
      if (value) addUniqueValue(row, 'resolvers', value);
    }

    const queryTime = obj['query-time'] ?? obj.query_time ?? obj.queryTime;
    if (queryTime != null && String(queryTime).trim()) addUniqueValue(row, 'queryTimes', String(queryTime).trim());
  }

  return map;
}

function preferredStatusCode(statusCodes) {
  const codes = new Set(statusCodes);
  for (const code of ['NOERROR', 'NXDOMAIN', 'SERVFAIL', 'REFUSED']) {
    if (codes.has(code)) return code;
  }
  return [...codes][0] || '';
}

export function classifyDomain(domain, successMap, nxdomainHosts = new Set(), options = {}) {
  const attemptsMap = options.attempts instanceof Map ? options.attempts : new Map();
  const checkedAt = options.checkedAt || null;

  const data = successMap.get(domain);
  const a = data ? [...(data.a || [])] : [];
  const aaaa = data ? [...(data.aaaa || [])] : [];
  const ns = data ? [...(data.ns || [])] : [];
  const mx = data ? [...(data.mx || [])] : [];
  const statusCodes = data ? [...(data.statusCodes || [])] : [];
  const resolvers = data ? [...(data.resolvers || [])] : [];

  const hasNoError = statusCodes.includes('NOERROR');
  const hasPositiveDns = Boolean(data && (
    a.length || aaaa.length || ns.length || mx.length || data.nullMxSeen || hasNoError
  ));
  const isNx = nxdomainHosts.has(domain) || statusCodes.includes('NXDOMAIN');

  let dnsStatus = 'UNKNOWN';
  if (hasPositiveDns) dnsStatus = 'DNS_ACTIVE';
  else if (isNx) dnsStatus = 'DNS_FAILED';

  let mailStatus = 'UNKNOWN';
  // Prefer a positive MX answer if conflicting observations ever occur.
  if (mx.length > 0) {
    mailStatus = 'MAIL_ENABLED';
    dnsStatus = 'DNS_ACTIVE';
  } else if (data?.nullMxSeen) {
    mailStatus = 'NULL_MX';
    dnsStatus = 'DNS_ACTIVE';
  } else if (dnsStatus === 'DNS_FAILED') {
    mailStatus = 'DNS_FAILED';
  } else if (dnsStatus === 'DNS_ACTIVE') {
    mailStatus = 'NO_MX';
  }

  let recommendedAction = 'RETRY_OR_REVIEW';
  if (mailStatus === 'MAIL_ENABLED') recommendedAction = 'CONTINUE_EMAIL_VERIFICATION';
  if (mailStatus === 'NO_MX') recommendedAction = 'REVIEW_NO_MX';
  if (mailStatus === 'NULL_MX' || mailStatus === 'DNS_FAILED') recommendedAction = 'EXCLUDE_FROM_OUTBOUND';

  return {
    domain,
    dnsStatus,
    mailStatus,
    provider: detectProvider(mx),
    mx,
    a,
    aaaa,
    ns,
    statusCode: preferredStatusCode(statusCodes),
    statusCodes,
    resolvers,
    attempts: Number(attemptsMap.get(domain) || 0),
    observations: Number(data?.observations || 0),
    lastCheckedAt: checkedAt,
    recommendedAction
  };
}

export function classifyDomains(domains, successMap, nxdomainHosts = new Set(), options = {}) {
  return domains.map((domain) => classifyDomain(domain, successMap, nxdomainHosts, options));
}

export function buildRecordResults(sourceRecords, domainResults) {
  const byDomain = new Map(domainResults.map((row) => [row.domain, row]));
  return sourceRecords.map((record) => ({
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
  }));
}

export function summarize(results, sourceRecords = []) {
  const summary = {
    totalDomains: results.length,
    uniqueDomains: results.length,
    totalInputRecords: sourceRecords.length,
    inputEmails: 0,
    inputOtherRecords: 0,
    dnsActive: 0,
    dnsFailed: 0,
    unknown: 0,
    mailEnabled: 0,
    mxEnabledDomains: 0,
    mxEnabledEmails: 0,
    noMx: 0,
    nullMx: 0
  };

  const byDomain = new Map(results.map((row) => [row.domain, row]));

  for (const row of results) {
    if (row.dnsStatus === 'DNS_ACTIVE') summary.dnsActive += 1;
    else if (row.dnsStatus === 'DNS_FAILED') summary.dnsFailed += 1;
    else summary.unknown += 1;

    if (row.mailStatus === 'MAIL_ENABLED') {
      summary.mailEnabled += 1;
      summary.mxEnabledDomains += 1;
    } else if (row.mailStatus === 'NO_MX') summary.noMx += 1;
    else if (row.mailStatus === 'NULL_MX') summary.nullMx += 1;
  }

  for (const record of sourceRecords) {
    if (record.inputType === 'email') {
      summary.inputEmails += 1;
      if (byDomain.get(record.domain)?.mailStatus === 'MAIL_ENABLED') summary.mxEnabledEmails += 1;
    } else {
      summary.inputOtherRecords += 1;
    }
  }

  return summary;
}

export function validateConsistency(summary) {
  const classifiedDomainTotal = Number(summary.mxEnabledDomains || 0)
    + Number(summary.noMx || 0)
    + Number(summary.nullMx || 0)
    + Number(summary.dnsFailed || 0)
    + Number(summary.unknown || 0);

  if (classifiedDomainTotal !== Number(summary.totalDomains || 0)) {
    throw new Error(`Consistency check failed: domain categories total ${classifiedDomainTotal}, expected ${summary.totalDomains}.`);
  }

  const inputTotal = Number(summary.inputEmails || 0) + Number(summary.inputOtherRecords || 0);
  if (inputTotal !== Number(summary.totalInputRecords || 0)) {
    throw new Error(`Consistency check failed: input categories total ${inputTotal}, expected ${summary.totalInputRecords}.`);
  }

  if (Number(summary.mxEnabledEmails || 0) > Number(summary.inputEmails || 0)) {
    throw new Error('Consistency check failed: MX-enabled email count exceeds input email count.');
  }

  return true;
}
