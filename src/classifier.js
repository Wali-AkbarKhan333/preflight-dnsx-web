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
        a: new Set(),
        aaaa: new Set(),
        ns: new Set(),
        mx: new Set(),
        statusCodes: new Set(),
        mxFieldSeen: false,
        nullMxSeen: false
      });
    }

    const row = map.get(host);
    for (const item of toArray(obj.a)) if (item) row.a.add(cleanHost(item));
    for (const item of toArray(obj.aaaa)) if (item) row.aaaa.add(cleanHost(item));
    for (const item of toArray(obj.ns)) if (item) row.ns.add(cleanHost(item));

    if (Object.prototype.hasOwnProperty.call(obj, 'mx')) {
      row.mxFieldSeen = true;
      const mxValues = toArray(obj.mx);
      for (const raw of mxValues) {
        const value = cleanHost(raw);
        if (!value || value === '.') {
          row.nullMxSeen = true;
        } else {
          row.mx.add(value);
        }
      }
    }

    const status = String(obj.status_code ?? obj.statusCode ?? '').toUpperCase().trim();
    if (status) row.statusCodes.add(status);
  }

  return map;
}

export function classifyDomains(domains, successMap, nxdomainHosts = new Set()) {
  return domains.map((domain) => {
    const data = successMap.get(domain);
    const a = data ? [...data.a] : [];
    const aaaa = data ? [...data.aaaa] : [];
    const ns = data ? [...data.ns] : [];
    const mx = data ? [...data.mx] : [];

    const statusCodes = data ? [...data.statusCodes] : [];
    const hasPositiveDns = Boolean(data && (a.length || aaaa.length || ns.length || mx.length || statusCodes.includes('NOERROR')));
    const isNx = nxdomainHosts.has(domain) || statusCodes.includes('NXDOMAIN');

    let dnsStatus = 'UNKNOWN';
    if (hasPositiveDns) dnsStatus = 'DNS_ACTIVE';
    else if (isNx) dnsStatus = 'DNS_FAILED';

    let mailStatus = 'UNKNOWN';
    if (dnsStatus === 'DNS_FAILED') {
      mailStatus = 'DNS_FAILED';
    } else if (data?.nullMxSeen && mx.length === 0) {
      mailStatus = 'NULL_MX';
    } else if (mx.length > 0) {
      mailStatus = 'MAIL_ENABLED';
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
      recommendedAction
    };
  });
}

export function summarize(results) {
  const summary = {
    totalDomains: results.length,
    dnsActive: 0,
    dnsFailed: 0,
    unknown: 0,
    mailEnabled: 0,
    noMx: 0,
    nullMx: 0
  };

  for (const row of results) {
    if (row.dnsStatus === 'DNS_ACTIVE') summary.dnsActive += 1;
    else if (row.dnsStatus === 'DNS_FAILED') summary.dnsFailed += 1;
    else summary.unknown += 1;

    if (row.mailStatus === 'MAIL_ENABLED') summary.mailEnabled += 1;
    else if (row.mailStatus === 'NO_MX') summary.noMx += 1;
    else if (row.mailStatus === 'NULL_MX') summary.nullMx += 1;
  }

  return summary;
}
