const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

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

function decodeRawHeaders(encoded) {
  if (typeof encoded !== 'string' || !encoded) return [];
  try {
    const text = Buffer.from(encoded, 'base64').toString('utf8');
    const head = text.split('\r\n\r\n')[0] ?? text;
    return head
      .split(/\r?\n/)
      .slice(1)
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

function parseSetCookie(line) {
  const [pair, ...attrs] = line.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  const name = eq < 0 ? pair : pair.slice(0, eq);
  const value = eq < 0 ? '' : pair.slice(eq + 1);
  let domain = null;
  let maxAge = null;
  for (const attr of attrs) {
    const match = /^Domain=(.*)$/i.exec(attr);
    if (match) domain = match[1].trim();
    const age = /^Max-Age=(.*)$/i.exec(attr);
    if (age) maxAge = Number(age[1]);
  }
  return { name, value, domain, maxAge };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function domainAllowed(requestHost, domain) {
  if (!domain) return true;
  const d = domain.replace(/^\./, '').toLowerCase();
  const h = requestHost.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

export function cookiePlantFake() {
  const tabs = new Map();
  const sessions = new Map();
  const cookies = [];
  const connections = [];
  let next = 0;
  const paused = new Map();

  const infoOf = (tab) => ({
    targetId: tab.targetId,
    type: 'page',
    url: tab.url,
    title: tab.title ?? tab.url,
    browserContextId: 'B1',
  });

  const emit = (conn, method, params, sessionId) => {
    conn.events.push({ method, params, ...(sessionId ? { sessionId } : {}) });
  };

  const plantFromHeaders = (requestUrl, headers) => {
    const requestHost = hostOf(requestUrl);
    for (const line of cookieLines(headers)) {
      const parsed = parseSetCookie(line);
      if (!parsed.name) continue;
      const domain = parsed.domain ?? requestHost;
      if (!domainAllowed(requestHost, domain)) continue;
      const normalized = domain.startsWith('.') ? domain : `.${domain.replace(/^\./, '')}`;
      const storeDomain = parsed.domain ? normalized : domain;
      const existing = cookies.findIndex(
        (cookie) =>
          cookie.name === parsed.name &&
          cookie.domain.replace(/^\./, '') === storeDomain.replace(/^\./, '')
      );
      if (parsed.maxAge === 0 || parsed.value === '') {
        if (existing >= 0) cookies.splice(existing, 1);
        continue;
      }
      const entry = {
        name: parsed.name,
        value: parsed.value,
        domain: storeDomain,
        path: '/',
      };
      if (existing >= 0) cookies[existing] = entry;
      else cookies.push(entry);
    }
  };

  async function handle(conn, method, params = {}, sessionId) {
    await tick();
    if (sessionId && !sessions.has(sessionId))
      throw new Error(`Session with given id not found: ${sessionId}`);
    if (method === 'Browser.getVersion') return { product: 'Fake/1', protocolVersion: '1.3' };
    if (method === 'Target.createTarget') {
      const tab = {
        targetId: `T${++next}`,
        url: params.url ?? 'about:blank',
        title: params.url ?? 'about:blank',
        fetch: false,
        legacy: false,
      };
      tabs.set(tab.targetId, tab);
      return { targetId: tab.targetId };
    }
    if (method === 'Target.attachToTarget') {
      const tab = tabs.get(params.targetId);
      if (!tab) throw new Error('No target with given id');
      const id = `S${++next}`;
      sessions.set(id, tab.targetId);
      emit(conn, 'Target.attachedToTarget', {
        sessionId: id,
        targetInfo: infoOf(tab),
        waitingForDebugger: false,
      });
      return { sessionId: id };
    }
    if (method === 'Target.detachFromTarget') {
      sessions.delete(params.sessionId);
      return {};
    }
    if (method === 'Target.closeTarget') {
      tabs.delete(params.targetId);
      return { success: true };
    }
    if (method === 'Target.getTargets')
      return { targetInfos: [...tabs.values()].map((tab) => infoOf(tab)) };
    if (method === 'Target.getTargetInfo') {
      const tab = tabs.get(params.targetId) ?? tabs.get(sessions.get(sessionId));
      if (!tab) throw new Error('No target with given id');
      return { targetInfo: infoOf(tab) };
    }
    if (
      method === 'Page.enable' ||
      method === 'Runtime.enable' ||
      method === 'Network.enable' ||
      method === 'Target.setDiscoverTargets' ||
      method === 'Target.setAutoAttach'
    )
      return {};
    if (method === 'Fetch.disable') {
      const tab = tabs.get(sessions.get(sessionId));
      if (tab) tab.fetch = false;
      return {};
    }
    if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') {
      const targetId = sessions.get(sessionId);
      const tab = tabs.get(targetId);
      let securityOrigin = '';
      try {
        if (tab?.url && /^https?:/i.test(tab.url)) securityOrigin = new URL(tab.url).origin;
      } catch {}
      const frame = {
        id: targetId ?? 'F0',
        url: tab?.url ?? '',
        securityOrigin,
      };
      return method === 'Page.getResourceTree'
        ? { frameTree: { frame, resources: [] } }
        : { frameTree: { frame } };
    }
    if (method === 'Fetch.enable') {
      const tab = tabs.get(sessions.get(sessionId));
      if (tab) tab.fetch = true;
      return {};
    }
    if (method === 'Network.setRequestInterception') {
      const tab = tabs.get(sessions.get(sessionId));
      if (tab) tab.legacy = (params.patterns ?? []).length > 0;
      return {};
    }
    if (method === 'Network.deleteCookies') {
      const host = params.url ? hostOf(params.url) : (params.domain ?? '').replace(/^\./, '');
      for (let i = cookies.length - 1; i >= 0; i -= 1) {
        const cookie = cookies[i];
        if (cookie.name !== params.name) continue;
        if (
          host &&
          cookie.domain.replace(/^\./, '') !== host &&
          !host.endsWith(`.${cookie.domain.replace(/^\./, '')}`)
        )
          continue;
        cookies.splice(i, 1);
      }
      return {};
    }
    if (method === 'Storage.getCookies' || method === 'Network.getAllCookies')
      return { cookies: [...cookies] };
    if (method === 'Network.getCookies') {
      const hosts = (params.urls ?? []).map(hostOf);
      return {
        cookies: cookies.filter((cookie) =>
          hosts.some(
            (host) =>
              cookie.domain.replace(/^\./, '') === host ||
              host.endsWith(`.${cookie.domain.replace(/^\./, '')}`)
          )
        ),
      };
    }
    if (method === 'Storage.setCookies') {
      cookies.length = 0;
      cookies.push(...(params.cookies ?? []));
      return {};
    }
    if (method === 'Page.navigate') {
      const tab = tabs.get(sessions.get(sessionId));
      if (tab) {
        tab.url = params.url;
        tab.title = params.url;
      }
      return { frameId: sessions.get(sessionId) };
    }
    if (method === 'Runtime.evaluate') {
      const expression = params.expression ?? '';
      if (expression === 'document.readyState')
        return { result: { type: 'string', value: 'complete' } };
      if (expression.includes('fetch(')) {
        const match = /fetch\(("([^"]+)"|'([^']+)')/.exec(expression);
        const url = match?.[2] ?? match?.[3];
        const tab = tabs.get(sessions.get(sessionId));
        if (!url || !tab) return { result: { type: 'string', value: 'error' } };
        const requestId = `R${++next}`;
        const interceptionId = `I${++next}`;
        if (tab.legacy && !tab.fetch) {
          paused.set(interceptionId, { url, sessionId, kind: 'legacy' });
          emit(
            conn,
            'Network.requestIntercepted',
            {
              interceptionId,
              request: { url, method: 'GET' },
              resourceType: 'XHR',
            },
            sessionId
          );
          return {
            result: {
              type: 'string',
              value: await new Promise((resolve) => {
                paused.get(interceptionId).resolve = resolve;
                setTimeout(() => resolve('timeout'), 500);
              }),
            },
          };
        }
        if (tab.fetch) {
          paused.set(requestId, { url, sessionId, kind: 'fetch' });
          emit(
            conn,
            'Fetch.requestPaused',
            {
              requestId,
              request: { url, method: 'GET' },
              resourceType: 'XHR',
              networkId: requestId,
            },
            sessionId
          );
          return {
            result: {
              type: 'string',
              value: await new Promise((resolve) => {
                paused.get(requestId).resolve = resolve;
                setTimeout(() => resolve('timeout'), 500);
              }),
            },
          };
        }
        return { result: { type: 'string', value: '200 ok' } };
      }
      return { result: { type: 'undefined' } };
    }
    if (method === 'Fetch.failRequest') {
      const entry = paused.get(params.requestId);
      if (entry) {
        entry.resolve?.('error:Aborted');
        paused.delete(params.requestId);
      }
      return {};
    }
    if (method === 'Fetch.fulfillRequest' || method === 'Fetch.continueResponse') {
      const entry = paused.get(params.requestId);
      if (!entry) throw new Error('Invalid request id');
      const headers = params.binaryResponseHeaders
        ? decodeBinaryHeaders(params.binaryResponseHeaders)
        : headerPairs(params.responseHeaders);
      plantFromHeaders(entry.url, headers);
      entry.resolve?.(`${params.responseCode ?? 200} ok`);
      paused.delete(params.requestId);
      return {};
    }
    if (method === 'Fetch.continueRequest') {
      const entry = paused.get(params.requestId);
      if (!entry) throw new Error('Invalid request id');
      emit(
        conn,
        'Fetch.requestPaused',
        {
          requestId: params.requestId,
          request: { url: entry.url, method: 'GET' },
          responseStatusCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/plain' }],
          resourceType: 'XHR',
        },
        sessionId
      );
      return {};
    }
    if (method === 'Network.continueInterceptedRequest') {
      const entry = paused.get(params.interceptionId);
      if (!entry) throw new Error('Invalid interception id');
      if (params.errorReason) {
        entry.resolve?.(`error:${params.errorReason}`);
        paused.delete(params.interceptionId);
        return {};
      }
      const headers = params.rawResponse
        ? decodeRawHeaders(params.rawResponse)
        : headerPairs(params.headers);
      plantFromHeaders(entry.url, headers);
      entry.resolve?.('200 ok');
      paused.delete(params.interceptionId);
      return {};
    }
    return {};
  }

  const connect = () => {
    const conn = { events: [], close: async () => {} };
    conn.send = (method, params, sessionId) => handle(conn, method, params, sessionId);
    connections.push(conn);
    return conn;
  };

  return {
    connect,
    client: connect(),
    unguarded: connect(),
    cookies,
  };
}
