import { credentialOrigins, protectedOrigins } from '../../protected.mjs';

function headerPairs(value) {
  if (!value) return [];
  if (Array.isArray(value))
    return value
      .map((entry) =>
        entry && typeof entry === 'object'
          ? { name: String(entry.name ?? ''), value: String(entry.value ?? '') }
          : null
      )
      .filter(Boolean);
  if (typeof value === 'object')
    return Object.entries(value).map(([name, entry]) => ({
      name: String(name),
      value: String(entry ?? ''),
    }));
  return [];
}

function decodeBinaryHeaders(encoded) {
  if (typeof encoded !== 'string' || !encoded) return [];
  try {
    const text = Buffer.from(encoded, 'base64').toString('utf8');
    return text
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(':');
        if (index < 0) return { name: line, value: '' };
        return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
      });
  } catch {
    return [];
  }
}

function decodeRawResponse(encoded) {
  if (typeof encoded !== 'string' || !encoded) return [];
  try {
    const text = Buffer.from(encoded, 'base64').toString('utf8');
    const head = text.split('\r\n\r\n')[0] ?? text;
    const lines = head.split(/\r?\n/).slice(1);
    return lines
      .map((line) => {
        const index = line.indexOf(':');
        if (index < 0) return null;
        return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function cookieLines(headers) {
  const lines = [];
  for (const { name, value } of headers) {
    const key = String(name).trim().toLowerCase();
    const text = String(value ?? '');
    if (key === 'set-cookie' || key === 'set-cookie2') {
      for (const part of text.split(/\n/)) {
        const trimmed = part.trim();
        if (trimmed) lines.push(trimmed);
      }
      continue;
    }
    if (!/[\r\n]/.test(text)) continue;
    for (const part of text.split(/\r?\n/)) {
      const match = /^\s*Set-Cookie2?:\s*(.*)$/i.exec(part);
      if (match?.[1]?.trim()) lines.push(match[1].trim());
    }
  }
  return lines;
}

function parseDomain(line) {
  let domain = null;
  const normalized = String(line).replace(/\r?\n[ \t]+/g, '; ');
  for (const attr of normalized.split(';').slice(1)) {
    const match = /^\s*Domain\s*=\s*(.*)$/i.exec(attr);
    if (match) domain = match[1].trim().replace(/^["']|["']$/g, '');
  }
  return domain;
}

function isDeletion(line) {
  if (/(?:^|;\s*)Max-Age=0(?:;|$)/i.test(line)) return true;
  const expires = /(?:^|;\s*)Expires=([^;]+)/i.exec(line);
  if (expires) {
    const when = Date.parse(expires[1].trim());
    if (Number.isFinite(when) && when <= Date.now()) return true;
  }
  return false;
}

function pathKind(method, params) {
  const tagOf = (lines) => {
    const joined = lines.join('\n');
    if (/=car-/.test(joined)) return 'continueAtRequest';
    if (/=cr-/.test(joined)) return 'continueResponse';
    if (/=blf-/.test(joined)) return 'binaryLf';
    if (/=bof-/.test(joined)) return 'binaryObsFold';
    if (/=dq-/.test(joined)) return 'domainQuoted';
    if (/=du-/.test(joined)) return 'domainUpper';
    if (/=dtd-/.test(joined)) return 'domainTrailDot';
    if (/=dr-/.test(joined)) return 'domainRepeated';
    if (/=dws-/.test(joined)) return 'domainWs';
    if (/=hp-/.test(joined)) return 'headerPadded';
    if (/=sc2nd-/.test(joined)) return 'setCookieSecond';
    if (/=rp-/.test(joined)) return 'responsePhrase';
    if (/=ho-/.test(joined)) return 'hostOnly';
    if (/=dc-/.test(joined)) return 'domainCover';
    if (/=obj-/.test(joined)) return 'fulfillObject';
    if (/=low-/.test(joined)) return 'fulfillLower';
    if (/=sc2-/.test(joined)) return 'fulfillSetCookie2';
    if (/=nl-/.test(joined)) return 'fulfillNewline';
    if (/=bin-/.test(joined)) return 'fulfillBinary';
    if (/=rx-/.test(joined)) return 'redirect3xx';
    if (/=lh-/.test(joined)) return 'legacyHeaders';
    if (/=lr-/.test(joined)) return 'legacyRaw';
    return null;
  };
  if (method === 'Fetch.continueResponse') {
    const pairs = headerPairs(params?.responseHeaders);
    return tagOf(cookieLines(pairs)) ?? 'continueResponse';
  }
  if (method === 'Network.continueInterceptedRequest') {
    if (params?.rawResponse) {
      const raw = decodeRawResponse(params.rawResponse);
      return tagOf(cookieLines(raw)) ?? 'legacyRaw';
    }
    return 'legacyHeaders';
  }
  if (method !== 'Fetch.fulfillRequest') return null;
  if (params?.responsePhrase && /set-cookie/i.test(String(params.responsePhrase)))
    return 'responsePhrase';
  if (params?.binaryResponseHeaders) {
    const text = Buffer.from(params.binaryResponseHeaders, 'base64').toString('utf8');
    const tagged = tagOf([text]);
    if (tagged) return tagged;
    return 'fulfillBinary';
  }
  const headers = params?.responseHeaders;
  if (headers && !Array.isArray(headers) && typeof headers === 'object') return 'fulfillObject';
  const pairs = headerPairs(headers);
  const lines = cookieLines(pairs);
  const tagged = tagOf(lines);
  if (tagged) return tagged;
  if (pairs.some((h) => h.name === 'set-cookie')) return 'fulfillLower';
  if (pairs.some((h) => h.name === 'Set-Cookie2')) return 'fulfillSetCookie2';
  if (pairs.some((h) => h.name === 'Set-Cookie' && String(h.value).includes('\n')))
    return 'fulfillNewline';
  if (
    params?.responseCode >= 300 &&
    params?.responseCode < 400 &&
    pairs.some((h) => h.name.toLowerCase() === 'location')
  )
    return 'redirect3xx';
  return 'fulfillArray';
}

function collectHeaders(method, params) {
  if (method === 'Fetch.fulfillRequest' || method === 'Fetch.continueResponse') {
    if (params?.binaryResponseHeaders) return decodeBinaryHeaders(params.binaryResponseHeaders);
    return headerPairs(params?.responseHeaders);
  }
  if (method === 'Network.continueInterceptedRequest') {
    if (params?.rawResponse) return decodeRawResponse(params.rawResponse);
    return headerPairs(params?.headers);
  }
  return [];
}

function requestUrlOf(client, method, params) {
  const id = params?.requestId ?? params?.interceptionId;
  if (!id || !client?.events) return null;
  for (let i = client.events.length - 1; i >= 0; i -= 1) {
    const event = client.events[i];
    if (
      (event.method === 'Fetch.requestPaused' && event.params?.requestId === id) ||
      (event.method === 'Network.requestIntercepted' && event.params?.interceptionId === id)
    )
      return event.params?.request?.url ?? null;
  }
  return null;
}

export function cookiePlantBlocked(method, params, catalog, options = {}, client = null) {
  if (
    ![
      'Fetch.fulfillRequest',
      'Fetch.continueResponse',
      'Network.continueInterceptedRequest',
    ].includes(method)
  )
    return null;
  if (options.refuseAllInterception) return 'response interception';
  const headers = collectHeaders(method, params);
  const lines = cookieLines(headers);
  if (!lines.length) return null;
  const kind = pathKind(method, params);
  const allow = options.allowPlantPaths ?? [];
  if (kind && allow.includes(kind)) return null;
  const cred = options.credentialOrigins ? credentialOrigins(options.credentialOrigins) : null;
  const requestUrl = requestUrlOf(client, method, params);
  for (const line of lines) {
    if (isDeletion(line)) continue;
    const domain = parseDomain(line);
    if (domain) {
      if (domain.toLowerCase() === '.adobe.com' || domain.toLowerCase() === 'adobe.com') continue;
      if (catalog?.cookieDomain?.(domain)) return 'protected cookie Domain in Set-Cookie';
      if (cred?.cookieDomain?.(domain)) return 'credential cookie Domain in Set-Cookie';
      continue;
    }
    if (cred && requestUrl && cred.url(requestUrl)) return 'credential host-only Set-Cookie';
  }
  return null;
}

export function applyCookiePlant(client, options = {}) {
  if (!options.cookiePlant) return client;
  const catalog = protectedOrigins(options.protectedOrigins, options.extraOrigins ?? []);
  const refusal = (what) => new Error(`slicc: refused: ${what}`);
  return {
    ...client,
    send: async (method, params, sessionId) => {
      const blocked = cookiePlantBlocked(method, params ?? {}, catalog, options, client);
      if (blocked) {
        if (!options.refuseWithoutFail) {
          if (
            (method === 'Fetch.fulfillRequest' || method === 'Fetch.continueResponse') &&
            params?.requestId
          )
            await client
              .send(
                'Fetch.failRequest',
                { requestId: params.requestId, errorReason: 'Aborted' },
                sessionId
              )
              .catch(() => {});
          if (method === 'Network.continueInterceptedRequest' && params?.interceptionId)
            await client
              .send(
                'Network.continueInterceptedRequest',
                { interceptionId: params.interceptionId, errorReason: 'Aborted' },
                sessionId
              )
              .catch(() => {});
        }
        throw refusal(blocked);
      }
      return client.send(method, params, sessionId);
    },
  };
}
