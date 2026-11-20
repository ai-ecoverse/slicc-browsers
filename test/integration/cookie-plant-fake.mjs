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
    const key = String(name).trim().toLowerCase();
    if (key === 'set-cookie2') continue;
    if (key !== 'set-cookie') continue;
    if (/[\t]/.test(String(name))) continue;
    if (/[\r\n]/.test(String(value))) continue;
    const trimmed = String(value).trim();
    if (trimmed) lines.push(trimmed);
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
  let reject = false;
  for (const attr of attrs) {
    const match = /^Domain\s*=\s*(.*)$/i.exec(attr);
    if (match) {
      const next = match[1].trim();
      if (
        (next.startsWith('"') && next.endsWith('"')) ||
        (next.startsWith("'") && next.endsWith("'"))
      ) {
        reject = true;
        continue;
      }
      if (next.endsWith('.')) {
        reject = true;
        continue;
      }
      domain = next;
    }
    const age = /^Max-Age\s*=\s*(.*)$/i.exec(attr);
    if (age) maxAge = Number(age[1]);
  }
  return { name, value, domain, maxAge, reject };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function siteOf(host) {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return host.toLowerCase();
  return parts.slice(-2).join('.');
}

function sameSite(pageUrl, requestUrl) {
  const pageHost = hostOf(pageUrl);
  const requestHost = hostOf(requestUrl);
  if (!pageHost || !requestHost) return false;
  return siteOf(pageHost) === siteOf(requestHost);
}

function domainAllowed(requestHost, domain) {
  if (!domain) return true;
  const d = domain.replace(/^\./, '').toLowerCase();
  const h = requestHost.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

export function cookiePlantFake(options = {}) {
  const tabs = new Map();
  const sessions = new Map();
  const sessionConns = new Map();
  const cookies = [];
  const connections = [];
  let next = 0;
  const paused = new Map();
  let sawCplantJar = false;
  let fetchDead = false;
  let deadFetchHits = 0;
  let contextId = 1;
  const cutSessions = new Set();
  const rejectCplantJarAfterFirst = options.rejectCplantJarAfterFirst === true;
  const deadFetchAfter = options.deadFetchAfter ? String(options.deadFetchAfter) : '';
  const deadFetchOnNth = Number(options.deadFetchOnNth ?? 1) || 1;
  const cutSessionAfter = options.cutSessionAfter ? String(options.cutSessionAfter) : '';
  const cutSessionOnNth = Number(options.cutSessionOnNth ?? 1) || 1;
  let cutSessionHits = 0;
  const cutBlocksReattach = options.cutBlocksReattach === true;
  const cutTargets = new Set();
  const protectedHosts = (options.protectedHosts ?? []).map((h) => String(h).toLowerCase());
  const guardedUrl = (url) => {
    const host = hostOf(url);
    if (!host || !protectedHosts.length) return false;
    return protectedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  };
  const emitContexts = options.emitContexts !== false;

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

  const emitContext = (conn, sessionId, url) => {
    if (!emitContexts || !sessionId || !url || !/^https?:/i.test(url)) return;
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    emit(
      conn,
      'Runtime.executionContextCreated',
      {
        context: {
          id: contextId++,
          origin,
          name: '',
          uniqueId: `ctx-${contextId}`,
          auxData: { isDefault: true },
        },
      },
      sessionId
    );
  };

  const setTabUrl = (conn, sessionId, tab, url) => {
    if (!tab || !url) return;
    tab.url = url;
    tab.title = url;
    emitContext(conn, sessionId, url);
  };

  const plantFromHeaders = (tab, requestUrl, headers, topLevel) => {
    const requestHost = hostOf(requestUrl);
    if (!topLevel && !sameSite(tab?.url ?? '', requestUrl)) return;
    for (const line of cookieLines(headers)) {
      const parsed = parseSetCookie(line);
      if (!parsed.name || parsed.reject) continue;
      const domain = parsed.domain ?? requestHost;
      if (!domainAllowed(requestHost, domain)) continue;
      const normalized = domain.startsWith('.') ? domain : `.${domain.replace(/^\./, '')}`;
      const storeDomain = parsed.domain ? normalized : domain;
      const existing = cookies.findIndex(
        (cookie) =>
          cookie.name === parsed.name &&
          cookie.domain.replace(/^\./, '') === storeDomain.replace(/^\./, '')
      );
      if (parsed.maxAge === 0) {
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

  const sessionIntercepts = (tab, sessionId) => {
    const fetchOn = Boolean(tab.fetchSessions?.has(sessionId));
    const legacyOn = Boolean(tab.legacySessions?.has(sessionId));
    return { fetchOn, legacyOn, any: fetchOn || legacyOn };
  };

  const emitPause = (conn, tab, sessionId, url, topLevel) => {
    const requestId = `R${++next}`;
    const interceptionId = `I${++next}`;
    const { fetchOn, legacyOn } = sessionIntercepts(tab, sessionId);
    const guardSessions = [...(tab.fetchSessions ?? [])].filter((id) => id !== sessionId);
    if (guardSessions.length > 0 && guardedUrl(url)) {
      return new Promise((resolve) => {
        paused.set(requestId, {
          url,
          sessionId: guardSessions[0],
          kind: 'fetch',
          topLevel,
          tab,
          resolve,
        });
        for (const sid of guardSessions) {
          const owner = sessionConns.get(sid);
          if (!owner) continue;
          emit(
            owner,
            'Fetch.requestPaused',
            {
              requestId,
              request: { url, method: 'GET' },
              resourceType: topLevel ? 'Document' : 'XHR',
              networkId: requestId,
            },
            sid
          );
        }
      });
    }
    if (legacyOn && !fetchOn) {
      paused.set(interceptionId, { url, sessionId, kind: 'legacy', topLevel, tab });
      emit(
        conn,
        'Network.requestIntercepted',
        {
          interceptionId,
          request: { url, method: 'GET' },
          resourceType: topLevel ? 'Document' : 'XHR',
        },
        sessionId
      );
      return new Promise((resolve) => {
        paused.get(interceptionId).resolve = resolve;
      });
    }
    if (fetchOn) {
      paused.set(requestId, { url, sessionId, kind: 'fetch', topLevel, tab });
      emit(
        conn,
        'Fetch.requestPaused',
        {
          requestId,
          request: { url, method: 'GET' },
          resourceType: topLevel ? 'Document' : 'XHR',
          networkId: requestId,
        },
        sessionId
      );
      return new Promise((resolve) => {
        paused.get(requestId).resolve = resolve;
      });
    }
    return Promise.resolve(topLevel ? '200 ok' : '200 ok');
  };

  async function handle(conn, method, params = {}, sessionId) {
    await tick();
    if (sessionId && !sessions.has(sessionId))
      throw new Error(`Session with given id not found: ${sessionId}`);
    if (sessionId && cutSessions.has(sessionId))
      throw new Error('slicc: refused: session cut on protected execution context');
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
      if (cutBlocksReattach && cutTargets.has(params.targetId))
        throw new Error('slicc: refused: session cut on protected execution context');
      const id = `S${++next}`;
      sessions.set(id, tab.targetId);
      sessionConns.set(id, conn);
      emit(conn, 'Target.attachedToTarget', {
        sessionId: id,
        targetInfo: infoOf(tab),
        waitingForDebugger: false,
      });
      return { sessionId: id };
    }
    if (method === 'Target.detachFromTarget') {
      sessions.delete(params.sessionId);
      sessionConns.delete(params.sessionId);
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
      if (tab) {
        tab.fetchSessions ??= new Set();
        tab.fetchSessions.delete(sessionId);
        tab.fetch = tab.fetchSessions.size > 0;
      }
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
      if (fetchDead) return {};
      const tab = tabs.get(sessions.get(sessionId));
      if (tab) {
        tab.fetchSessions ??= new Set();
        tab.fetchSessions.add(sessionId);
        tab.fetch = true;
      }
      return {};
    }
    if (method === 'Network.setRequestInterception') {
      const tab = tabs.get(sessions.get(sessionId));
      if (tab) {
        tab.legacySessions ??= new Set();
        if ((params.patterns ?? []).length > 0) tab.legacySessions.add(sessionId);
        else tab.legacySessions.delete(sessionId);
        tab.legacy = tab.legacySessions.size > 0;
      }
      return {};
    }
    if (method === 'Network.setCookie') {
      const domain = params.domain ?? (params.url ? hostOf(params.url) : '');
      const storeDomain = domain
        ? domain.startsWith('.')
          ? domain
          : `.${domain.replace(/^\./, '')}`
        : hostOf(params.url);
      const entry = {
        name: params.name,
        value: params.value ?? '',
        domain: storeDomain,
        path: params.path ?? '/',
      };
      const existing = cookies.findIndex(
        (cookie) =>
          cookie.name === entry.name &&
          cookie.domain.replace(/^\./, '') === entry.domain.replace(/^\./, '')
      );
      if (existing >= 0) cookies[existing] = entry;
      else cookies.push(entry);
      return { success: true };
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
    if (
      method === 'Storage.getCookies' ||
      method === 'Network.getAllCookies' ||
      method === 'Network.getCookies'
    ) {
      const hasCplant = cookies.some((cookie) => String(cookie.name).startsWith('cplant'));
      if (rejectCplantJarAfterFirst && hasCplant && sawCplantJar)
        throw new Error('jar read rejected');
      if (hasCplant) sawCplantJar = true;
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
      return { cookies: [...cookies] };
    }
    if (method === 'Storage.setCookies') {
      for (const incoming of params.cookies ?? []) {
        const domain = incoming.domain ?? (incoming.url ? hostOf(incoming.url) : '');
        const storeDomain = domain
          ? domain.startsWith('.')
            ? domain
            : `.${domain.replace(/^\./, '')}`
          : hostOf(incoming.url);
        const entry = {
          name: incoming.name,
          value: incoming.value ?? '',
          domain: storeDomain,
          path: incoming.path ?? '/',
        };
        const existing = cookies.findIndex(
          (cookie) =>
            cookie.name === entry.name &&
            cookie.domain.replace(/^\./, '') === entry.domain.replace(/^\./, '')
        );
        if (existing >= 0) cookies[existing] = entry;
        else cookies.push(entry);
      }
      return {};
    }
    if (method === 'Page.navigate') {
      const tab = tabs.get(sessions.get(sessionId));
      if (!tab) return { frameId: sessions.get(sessionId) };
      const guardOwns =
        [...(tab.fetchSessions ?? [])].some((id) => id !== sessionId) && guardedUrl(params.url);
      if (sessionIntercepts(tab, sessionId).any || guardOwns) {
        const settled = await emitPause(conn, tab, sessionId, params.url, true);
        if (String(settled).startsWith('error:')) return { frameId: sessions.get(sessionId) };
        setTabUrl(conn, sessionId, tab, params.url);
        return { frameId: sessions.get(sessionId) };
      }
      setTabUrl(conn, sessionId, tab, params.url);
      return { frameId: sessions.get(sessionId) };
    }
    if (method === 'Runtime.evaluate') {
      const expression = params.expression ?? '';
      if (expression === 'document.readyState')
        return { result: { type: 'string', value: 'complete' } };
      const assign = /location\.assign\(("([^"]+)"|'([^']+)')\)/.exec(expression);
      if (assign) {
        const url = assign[2] ?? assign[3];
        const tab = tabs.get(sessions.get(sessionId));
        if (!url || !tab) return { result: { type: 'string', value: 'error' } };
        const guardOwns =
          [...(tab.fetchSessions ?? [])].some((id) => id !== sessionId) && guardedUrl(url);
        if (sessionIntercepts(tab, sessionId).any || guardOwns) {
          const settled = await emitPause(conn, tab, sessionId, url, true);
          if (!String(settled).startsWith('error:') && tab) setTabUrl(conn, sessionId, tab, url);
          return { result: { type: 'undefined' } };
        }
        setTabUrl(conn, sessionId, tab, url);
        return { result: { type: 'undefined' } };
      }
      if (expression.includes('fetch(')) {
        const match = /fetch\(("([^"]+)"|'([^']+)')/.exec(expression);
        const url = match?.[2] ?? match?.[3];
        const tab = tabs.get(sessions.get(sessionId));
        if (!url || !tab) return { result: { type: 'string', value: 'error' } };
        if (sessionIntercepts(tab, sessionId).any) {
          const settled = await emitPause(conn, tab, sessionId, url, false);
          return { result: { type: 'string', value: settled } };
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
      if (
        method === 'Fetch.fulfillRequest' &&
        params.responseHeaders &&
        !Array.isArray(params.responseHeaders)
      ) {
        entry.resolve?.('error:InvalidParams');
        paused.delete(params.requestId);
        const err = new Error('Invalid parameters');
        err.code = -32602;
        throw err;
      }
      if (method === 'Fetch.continueResponse' && entry.kind === 'fetch' && !entry.response) {
        entry.resolve?.('error:InvalidParams');
        paused.delete(params.requestId);
        const err = new Error('Invalid parameters: continueResponse at Request stage');
        err.code = -32602;
        throw err;
      }
      const headers = params.binaryResponseHeaders
        ? decodeBinaryHeaders(params.binaryResponseHeaders)
        : headerPairs(params.responseHeaders);
      const smuggled = headers.some(
        (h) => /[\r\n]/.test(String(h.name)) || /[\r\n]/.test(String(h.value))
      );
      if (method === 'Fetch.fulfillRequest') {
        if (!smuggled) plantFromHeaders(entry.tab, entry.url, headers, entry.topLevel);
        else if (options.storeBinaryLf) {
          const expanded = [];
          for (const { name, value } of headers) {
            if (!/[\r\n]/.test(String(value))) {
              expanded.push({ name, value });
              continue;
            }
            for (const part of String(value).split(/\r?\n/)) {
              const match = /^\s*Set-Cookie:\s*(.*)$/i.exec(part);
              if (match) expanded.push({ name: 'Set-Cookie', value: match[1] });
            }
          }
          plantFromHeaders(entry.tab, entry.url, expanded, entry.topLevel);
        }
      }
      if (entry.topLevel && entry.tab) setTabUrl(conn, entry.sessionId, entry.tab, entry.url);
      const blob = params.binaryResponseHeaders
        ? Buffer.from(params.binaryResponseHeaders, 'base64').toString('utf8')
        : `${params.responsePhrase ?? ''}${JSON.stringify(params ?? {})}`;
      if (cutSessionAfter && blob.includes(cutSessionAfter) && entry.sessionId) {
        cutSessionHits += 1;
        if (cutSessionHits >= cutSessionOnNth) {
          cutSessions.add(entry.sessionId);
          const targetId = sessions.get(entry.sessionId);
          if (targetId) cutTargets.add(targetId);
        }
      }
      if (deadFetchAfter && !fetchDead) {
        if (blob.includes(deadFetchAfter)) {
          deadFetchHits += 1;
          if (deadFetchHits >= deadFetchOnNth) {
            fetchDead = true;
            for (const tab of tabs.values()) {
              tab.fetchSessions = new Set();
              tab.fetch = false;
            }
          }
        }
      }
      entry.resolve?.(`${params.responseCode ?? 200} ok`);
      paused.delete(params.requestId);
      return {};
    }
    if (method === 'Fetch.continueRequest') {
      const entry = paused.get(params.requestId);
      if (!entry) throw new Error('Invalid request id');
      entry.response = true;
      emit(
        conn,
        'Fetch.requestPaused',
        {
          requestId: params.requestId,
          request: { url: entry.url, method: 'GET' },
          responseStatusCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/plain' }],
          resourceType: entry.topLevel ? 'Document' : 'XHR',
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
      if (params.rawResponse) {
        const headers = decodeRawHeaders(params.rawResponse);
        plantFromHeaders(entry.tab, entry.url, headers, entry.topLevel);
        if (entry.topLevel && entry.tab) {
          entry.tab.url = entry.url;
          entry.tab.title = entry.url;
        }
      }
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
