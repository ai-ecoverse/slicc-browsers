import { protectedOrigins } from '../../protected.mjs';

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
    const key = name.toLowerCase();
    if (key !== 'set-cookie' && key !== 'set-cookie2') continue;
    for (const part of String(value).split(/\n/)) {
      const trimmed = part.trim();
      if (trimmed) lines.push(trimmed);
    }
  }
  return lines;
}

function parseDomain(line) {
  const match = /(?:^|;\s*)Domain=([^;]+)/i.exec(line);
  return match ? match[1].trim() : null;
}

function isDeletion(line) {
  return /(?:^|;\s*)Max-Age=0(?:;|$)/i.test(line) || /=\s*(?:;|$)/.test(line.split(';')[0] ?? '');
}

function pathKind(method, params) {
  if (method === 'Fetch.continueResponse') return 'continueResponse';
  if (method === 'Network.continueInterceptedRequest') {
    if (params?.rawResponse) {
      const raw = decodeRawResponse(params.rawResponse);
      const lines = cookieLines(raw);
      if (lines.some((line) => /(?:^|;\s*)cplant=lh-/i.test(line) || /^cplant=lh-/.test(line)))
        return 'legacyHeaders';
      return 'legacyRaw';
    }
    return 'legacyHeaders';
  }
  if (method !== 'Fetch.fulfillRequest') return null;
  if (params?.binaryResponseHeaders) return 'fulfillBinary';
  const headers = params?.responseHeaders;
  if (headers && !Array.isArray(headers) && typeof headers === 'object') return 'fulfillObject';
  const pairs = headerPairs(headers);
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

export function cookiePlantBlocked(method, params, catalog, options = {}) {
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
  for (const line of lines) {
    if (isDeletion(line)) continue;
    const domain = parseDomain(line);
    if (!domain) continue;
    if (domain.toLowerCase() === '.adobe.com' || domain.toLowerCase() === 'adobe.com') continue;
    if (catalog?.cookieDomain?.(domain)) return 'protected cookie Domain in Set-Cookie';
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
      const blocked = cookiePlantBlocked(method, params ?? {}, catalog, options);
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
