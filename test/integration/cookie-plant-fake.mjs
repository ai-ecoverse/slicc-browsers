const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

const NETWORK_COOKIE_METHODS = [
  'Network.setCookie',
  'Network.deleteCookies',
  'Network.getCookies',
  'Network.getAllCookies',
];

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
  const cookiesByContext = new Map([['B1', []]]);
  const jarOf = (browserContextId) => {
    const id = browserContextId || 'B1';
    if (!cookiesByContext.has(id)) cookiesByContext.set(id, []);
    return cookiesByContext.get(id);
  };
  const foreignTargets = new Map();
  const targetOf = (sessionId) => {
    const targetId = sessions.get(sessionId);
    return tabs.get(targetId) ?? foreignTargets.get(targetId);
  };
  const contextOfSession = (sessionId) => targetOf(sessionId)?.browserContextId || 'B1';
  const cookies = jarOf('B1');
  const connections = [];
  let next = 0;
  const paused = new Map();
  let sawCplantJar = false;
  let fetchDead = false;
  let deadFetchHits = 0;
  let contextId = 1;
  const cutSessions = new Set();
  const rejectCplantJarAfterFirst = options.rejectCplantJarAfterFirst === true;
  const rejectJarAfterDoorProof = options.rejectJarAfterDoorProof === true;
  let doorJarProofs = 0;
  let rejectJarReads = false;
  const deadFetchAfter = options.deadFetchAfter ? String(options.deadFetchAfter) : '';
  const deadFetchOnNth = Number(options.deadFetchOnNth ?? 1) || 1;
  const cutSessionAfter = options.cutSessionAfter ? String(options.cutSessionAfter) : '';
  const cutSessionOnNth = Number(options.cutSessionOnNth ?? 1) || 1;
  let cutSessionHits = 0;
  const cutBlocksReattach = options.cutBlocksReattach === true;
  const cutTargets = new Set();
  const protectedHosts = (options.protectedHosts ?? []).map((h) => String(h).toLowerCase());
  const blockedMarkers = (options.blockedMarkers ?? []).map(String).filter(Boolean);
  const defaultBlockedMarker = blockedMarkers[0] || 'chrome-error://chromewebdata/';
  const blockWithoutMarker = options.blockWithoutMarker === true;
  const failSilentKeepHome = options.failSilentKeepHome === true;
  const keepHomeAfterFirstBlock = options.keepHomeAfterFirstBlock === true;
  let blockedWithMarker = 0;
  const injectOrphanLoadingFailed = options.injectOrphanLoadingFailed === true;
  const injectNeighbourBlocked = options.injectNeighbourBlocked === true;
  const nullGuardHref = options.nullGuardHref === true;
  const storageJarIgnoresBrowserContext = options.storageJarIgnoresBrowserContext === true;
  const storageGetIgnoresBrowserContext = options.storageGetIgnoresBrowserContext === true;
  const storageGetCookiesFails = options.storageGetCookiesFails === true;
  const networkGetAllCookiesFails = options.networkGetAllCookiesFails === true;
  const networkOmitsCanary = options.networkOmitsCanary === true;
  const getCookiesPlantDomainOnly = options.getCookiesPlantDomainOnly === true;
  const canarySetIgnoresBrowserContext = options.canarySetIgnoresBrowserContext === true;
  const dropCanary = options.dropCanary === true;
  let ignoredContextCreates = 0;
  const ignoreContextCreates = Number(options.ignoreContextCreates ?? 0) || 0;
  const staggerContexts = options.staggerContexts === true;
  let contextCreateCount = 0;
  const supersedeAbort = options.supersedeAbort === true;
  const deadPageSession = options.deadPageSession === true;
  const settleAssignOk = options.settleAssignOk === true;
  const finalHref = options.finalHref ? String(options.finalHref) : '';
  const continueItself = options.continueItself === true;
  const continueItselfNoHit = options.continueItselfNoHit === true;
  const continueItselfPlant = options.continueItselfPlant === true;
  const continueItselfNoHitAfter = Number(options.continueItselfNoHitAfter);
  let continueItselfHitCount = 0;
  const preTriggerPlantHit = options.preTriggerPlantHit === true;
  const preTriggerHitTabs = new Set();
  const leakCloseCount = Math.max(0, Number(options.leakCloseCount ?? 0) || 0);
  let leakedCloses = 0;
  const contexts = new Map();
  const assertStorageCookieContext = (method, params) => {
    if (staggerContexts) return;
    if (storageGetIgnoresBrowserContext || storageJarIgnoresBrowserContext) return;
    if (canarySetIgnoresBrowserContext && method === 'Storage.setCookies') {
      const canaryOnly = (params?.cookies ?? []).every((c) =>
        String(c.name).startsWith('cplantcanary')
      );
      if (canaryOnly) return;
    }
    const attemptTabs = [...tabs.values()].filter(
      (tab) => tab.browserContextId && tab.browserContextId !== 'B1'
    );
    if (!attemptTabs.length) return;
    const want = [...new Set(attemptTabs.map((tab) => tab.browserContextId))];
    const got = params?.browserContextId;
    if (!got || !want.includes(got))
      throw new Error(
        `cookie-plant-fake: ${method} context ${got ?? 'missing'} !== attempt tab context(s) ${want.join(',')}`
      );
  };
  const networkCookieWrongSession = options.networkCookieWrongSession ?? null;
  const networkCookieMisroutes = [];
  const networkCookieRejects = [];
  const guardSessionOn = (conn, sessionId) => {
    if (!sessionId || conn === connections[0] || !sessions.has(sessionId)) return null;
    const targetId = sessions.get(sessionId);
    for (const [sid, owner] of sessionConns) {
      if (sid !== sessionId && owner !== conn && sessions.get(sid) === targetId) return sid;
    }
    return null;
  };
  const foreignSessionOn = (conn) => {
    for (const [sid, targetId] of sessions)
      if (foreignTargets.has(targetId) && sessionConns.get(sid) === conn) return sid;
    const targetId = `TX${++next}`;
    foreignTargets.set(targetId, { targetId, url: 'about:blank', browserContextId: 'X0' });
    const sid = `SX${++next}`;
    sessions.set(sid, targetId);
    sessionConns.set(sid, conn);
    return sid;
  };
  const misrouteNetworkCookie = (conn, method, sessionId) => {
    const guardSession = networkCookieWrongSession ? guardSessionOn(conn, sessionId) : null;
    if (!guardSession) return sessionId;
    const to = networkCookieWrongSession === 'guard' ? guardSession : foreignSessionOn(conn);
    networkCookieMisroutes.push({
      method,
      mode: networkCookieWrongSession,
      from: sessionId,
      to,
      fromTarget: sessions.get(sessionId),
      toTarget: sessions.get(to),
      fromContext: contextOfSession(sessionId),
      toContext: contextOfSession(to),
    });
    return to;
  };
  const assertNetworkCookieSession = (conn, method, sessionId) => {
    const reject = (why) => {
      networkCookieRejects.push({ method, sessionId: sessionId ?? null });
      throw new Error(`cookie-plant-fake: ${method} ${why}`);
    };
    if (!sessionId) reject('requires attempt tab session');
    if (!sessions.has(sessionId) || !targetOf(sessionId) || sessionConns.get(sessionId) !== conn)
      reject(`session ${sessionId} !== attempt tab session`);
  };
  const recordPreTriggerPlantHit = (tab) => {
    if (!preTriggerPlantHit || !tab || preTriggerHitTabs.has(tab.targetId)) return;
    const m = /cookie-plant-([^&/?#]+)/.exec(String(tab.url ?? ''));
    if (!m || !protectedHosts[0]) return;
    preTriggerHitTabs.add(tab.targetId);
    let port = '';
    try {
      port = new URL(tab.url).port;
    } catch {}
    const host = port ? `${protectedHosts[0]}:${port}` : protectedHosts[0];
    options.onNavigate?.(`http://${host}/data?n=plant-${m[1]}`);
  };
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
    browserContextId: tab.browserContextId ?? 'B1',
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
    if (/^https?:/i.test(url)) options.onNavigate?.(url);
  };

  const plantFromHeaders = (tab, requestUrl, headers, topLevel) => {
    const requestHost = hostOf(requestUrl);
    if (!topLevel && !sameSite(tab?.url ?? '', requestUrl)) return;
    const jar = jarOf(tab?.browserContextId);
    for (const line of cookieLines(headers)) {
      const parsed = parseSetCookie(line);
      if (!parsed.name || parsed.reject) continue;
      const domain = parsed.domain ?? requestHost;
      if (!domainAllowed(requestHost, domain)) continue;
      const normalized = domain.startsWith('.') ? domain : `.${domain.replace(/^\./, '')}`;
      const storeDomain = parsed.domain ? normalized : domain;
      const existing = jar.findIndex(
        (cookie) =>
          cookie.name === parsed.name &&
          cookie.domain.replace(/^\./, '') === storeDomain.replace(/^\./, '') &&
          (cookie.path ?? '/') === '/'
      );
      if (parsed.maxAge === 0) {
        if (existing >= 0) jar.splice(existing, 1);
        continue;
      }
      const entry = {
        name: parsed.name,
        value: parsed.value,
        domain: storeDomain,
        path: '/',
      };
      if (existing >= 0) jar[existing] = entry;
      else jar.push(entry);
    }
  };

  const sessionIntercepts = (tab, sessionId) => {
    const fetchOn = Boolean(tab.fetchSessions?.has(sessionId));
    const legacyOn = Boolean(tab.legacySessions?.has(sessionId));
    return { fetchOn, legacyOn, any: fetchOn || legacyOn };
  };

  const plantFromContinueItself = (url, tab = null) => {
    const plantTag = /[?&]n=plant-([^&]+)/.exec(url ?? '')?.[1];
    const host = hostOf(url);
    if (!plantTag || !host) return;
    const id = String(plantTag)
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-20);
    const jar = jarOf(tab?.browserContextId);
    const name = `cplant${id || 'x'}`;
    const values = [`p-${plantTag}`, `ho-${plantTag}`, `dc-${plantTag}`];
    const domains = [`.${host}`, host];
    for (const domain of domains) {
      for (const value of values) {
        const entry = { name, value, domain, path: '/' };
        const existing = jar.findIndex(
          (cookie) =>
            cookie.name === entry.name &&
            cookie.domain.replace(/^\./, '') === entry.domain.replace(/^\./, '') &&
            cookie.value === entry.value
        );
        if (existing >= 0) jar[existing] = entry;
        else jar.push(entry);
      }
    }
  };

  const continueItselfSkipHit = () =>
    continueItselfNoHit ||
    (Number.isFinite(continueItselfNoHitAfter) &&
      continueItselfHitCount >= continueItselfNoHitAfter);

  const continueItselfSettle = (conn, sessionId, tab, url) => {
    if (
      !(
        continueItself ||
        continueItselfNoHit ||
        continueItselfPlant ||
        Number.isFinite(continueItselfNoHitAfter)
      ) ||
      !guardedUrl(url)
    )
      return null;
    if (connections[0] && conn !== connections[0]) return null;
    if (continueItselfPlant) {
      plantFromContinueItself(url, tab);
      options.onNavigate?.(url);
      const marker = options.blockedMarker || defaultBlockedMarker;
      if (marker) setTabUrl(conn, sessionId, tab, marker);
      else setTabUrl(conn, sessionId, tab, url);
      continueItselfHitCount += 1;
      return '200 ok';
    }
    const skipHit = continueItselfSkipHit();
    if (!skipHit) {
      continueItselfHitCount += 1;
      setTabUrl(conn, sessionId, tab, url);
    }
    return skipHit ? '200 ok:nohit' : '200 ok';
  };

  const readerSessionsFor = (tab) => {
    const out = [];
    if (!tab) return out;
    for (const [sid, targetId] of sessions.entries()) {
      if (targetId !== tab.targetId) continue;
      const owner = sessionConns.get(sid);
      if (!owner || owner === connections[0]) continue;
      out.push({ sid, owner });
    }
    return out;
  };

  const emitBlockedToReader = (tab, url) => {
    if (!tab) return;
    const requestId = `NR${++next}`;
    for (const { sid, owner } of readerSessionsFor(tab)) {
      emit(
        owner,
        'Network.requestWillBeSent',
        { requestId, request: { url, method: 'GET' }, type: 'Document' },
        sid
      );
      emit(
        owner,
        'Network.loadingFailed',
        {
          requestId,
          errorText: 'net::ERR_BLOCKED_BY_CLIENT',
          blockedReason: 'inspector',
          type: 'Document',
        },
        sid
      );
    }
  };

  const emitOrphanAndNeighbourNoise = (tab, url) => {
    if (!tab || !url) return;
    for (const { sid, owner } of readerSessionsFor(tab)) {
      if (injectOrphanLoadingFailed) {
        emit(
          owner,
          'Network.loadingFailed',
          {
            errorText: 'net::ERR_BLOCKED_BY_CLIENT',
            blockedReason: 'inspector',
            type: 'Document',
          },
          sid
        );
        emit(
          owner,
          'Network.loadingFailed',
          {
            requestId: `orphan-${++next}`,
            errorText: 'net::ERR_BLOCKED_BY_CLIENT',
            blockedReason: 'inspector',
            type: 'Document',
          },
          sid
        );
      }
      if (injectNeighbourBlocked) {
        const neighbour = String(url).replace(/([?&]n=plant-)[^&]+/, '$1neighbour-other-tag');
        const requestId = `NN${++next}`;
        emit(
          owner,
          'Network.requestWillBeSent',
          { requestId, request: { url: neighbour, method: 'GET' }, type: 'Document' },
          sid
        );
        emit(
          owner,
          'Network.loadingFailed',
          {
            requestId,
            errorText: 'net::ERR_BLOCKED_BY_CLIENT',
            blockedReason: 'inspector',
            type: 'Document',
          },
          sid
        );
      }
    }
  };

  const emitPause = (conn, tab, sessionId, url, topLevel) => {
    const continued = continueItselfSettle(conn, sessionId, tab, url);
    if (continued != null) return Promise.resolve(continued);
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
    if (NETWORK_COOKIE_METHODS.includes(method)) {
      sessionId = misrouteNetworkCookie(conn, method, sessionId);
      assertNetworkCookieSession(conn, method, sessionId);
    } else if (sessionId && !sessions.has(sessionId))
      throw new Error(`Session with given id not found: ${sessionId}`);
    if (sessionId && cutSessions.has(sessionId))
      throw new Error('slicc: refused: session cut on protected execution context');
    if (method === 'Browser.getVersion') return { product: 'Fake/1', protocolVersion: '1.3' };
    if (method === 'Target.createBrowserContext') {
      const id = `C${++next}`;
      contexts.set(id, true);
      jarOf(id);
      return { browserContextId: id };
    }
    if (method === 'Target.disposeBrowserContext') {
      contexts.delete(params.browserContextId);
      for (const [targetId, tab] of [...tabs.entries()]) {
        if (tab.browserContextId === params.browserContextId) tabs.delete(targetId);
      }
      return {};
    }
    if (method === 'Target.createTarget') {
      let browserContextId = params.browserContextId ?? 'B1';
      if (params.browserContextId && ignoredContextCreates < ignoreContextCreates) {
        ignoredContextCreates += 1;
        browserContextId = 'B1';
      } else if (params.browserContextId && staggerContexts) {
        contextCreateCount += 1;
        if (contextCreateCount % 2 === 0) browserContextId = 'B1';
      }
      const tab = {
        targetId: `T${++next}`,
        url: params.url ?? 'about:blank',
        title: params.url ?? 'about:blank',
        fetch: false,
        legacy: false,
        browserContextId,
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
      if (leakedCloses < leakCloseCount) {
        leakedCloses += 1;
        return { success: true };
      }
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
      const jar = jarOf(contextOfSession(sessionId));
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
      const existing = jar.findIndex(
        (cookie) =>
          cookie.name === entry.name &&
          cookie.domain.replace(/^\./, '') === entry.domain.replace(/^\./, '') &&
          (cookie.path ?? '/') === entry.path
      );
      if (existing >= 0) jar[existing] = entry;
      else jar.push(entry);
      return { success: true };
    }
    if (method === 'Network.deleteCookies') {
      const tab = tabs.get(sessions.get(sessionId));
      recordPreTriggerPlantHit(tab);
      if (preTriggerPlantHit) await tick();
      const jar = jarOf(contextOfSession(sessionId));
      const host = params.url ? hostOf(params.url) : (params.domain ?? '').replace(/^\./, '');
      for (let i = jar.length - 1; i >= 0; i -= 1) {
        const cookie = jar[i];
        if (cookie.name !== params.name) continue;
        if (
          host &&
          cookie.domain.replace(/^\./, '') !== host &&
          !host.endsWith(`.${cookie.domain.replace(/^\./, '')}`)
        )
          continue;
        jar.splice(i, 1);
      }
      return {};
    }
    if (
      method === 'Storage.getCookies' ||
      method === 'Network.getAllCookies' ||
      method === 'Network.getCookies'
    ) {
      if (method === 'Storage.getCookies') assertStorageCookieContext(method, params);
      if (method === 'Storage.getCookies' && storageGetCookiesFails)
        throw new Error('Storage.getCookies failed');
      if (method === 'Network.getAllCookies' && networkGetAllCookiesFails)
        throw new Error('Network.getAllCookies failed');
      const jar =
        method === 'Storage.getCookies'
          ? jarOf(
              storageGetIgnoresBrowserContext || storageJarIgnoresBrowserContext
                ? 'B1'
                : params?.browserContextId
            )
          : jarOf(contextOfSession(sessionId));
      const hasPlant = jar.some(
        (cookie) =>
          String(cookie.name).startsWith('cplant') &&
          !String(cookie.name).startsWith('cplantcanary')
      );
      if (rejectJarAfterDoorProof && rejectJarReads && !hasPlant)
        throw new Error('jar read rejected');
      if (rejectCplantJarAfterFirst && hasPlant && sawCplantJar)
        throw new Error('jar read rejected');
      if (hasPlant) sawCplantJar = true;
      if (rejectJarAfterDoorProof && hasPlant) {
        doorJarProofs += 1;
        if (doorJarProofs >= 1) rejectJarReads = true;
      }
      const visible =
        method !== 'Storage.getCookies' && networkOmitsCanary
          ? jar.filter((cookie) => !String(cookie.name).startsWith('cplantcanary'))
          : jar;
      if (method === 'Network.getCookies') {
        let hosts = (params.urls ?? []).map(hostOf);
        if (getCookiesPlantDomainOnly)
          hosts = hosts.filter(
            (host) =>
              host.includes('sliccy') ||
              host.includes('adobe') ||
              host.includes('adobelogin') ||
              host.includes('vault')
          );
        return {
          cookies: visible.filter((cookie) =>
            hosts.some(
              (host) =>
                cookie.domain.replace(/^\./, '') === host ||
                host.endsWith(`.${cookie.domain.replace(/^\./, '')}`)
            )
          ),
        };
      }
      return { cookies: [...visible] };
    }
    if (method === 'Storage.setCookies') {
      assertStorageCookieContext(method, params);
      const canaryOnly = (params.cookies ?? []).every((c) =>
        String(c.name).startsWith('cplantcanary')
      );
      const jar = jarOf(
        storageJarIgnoresBrowserContext || (canarySetIgnoresBrowserContext && canaryOnly)
          ? 'B1'
          : params?.browserContextId
      );
      const incomingCookies = dropCanary
        ? (params.cookies ?? []).filter((c) => !String(c.name).startsWith('cplantcanary'))
        : (params.cookies ?? []);
      for (const incoming of incomingCookies) {
        const domain = incoming.domain ?? (incoming.url ? hostOf(incoming.url) : '');
        const storeDomain = domain
          ? domain.startsWith('.')
            ? domain
            : domain.includes('.')
              ? domain
              : `.${domain}`
          : hostOf(incoming.url);
        const entry = {
          name: incoming.name,
          value: incoming.value ?? '',
          domain: storeDomain,
          path: incoming.path ?? '/',
        };
        const existing = jar.findIndex(
          (cookie) =>
            cookie.name === entry.name &&
            cookie.domain.replace(/^\./, '') === entry.domain.replace(/^\./, '') &&
            (cookie.path ?? '/') === entry.path
        );
        if (existing >= 0) jar[existing] = entry;
        else jar.push(entry);
      }
      return {};
    }
    if (method === 'Page.navigate') {
      const tab = tabs.get(sessions.get(sessionId));
      if (!tab) return { frameId: sessions.get(sessionId) };
      const guardOwns =
        [...(tab.fetchSessions ?? [])].some((id) => id !== sessionId) && guardedUrl(params.url);
      if (sessionIntercepts(tab, sessionId).any || guardOwns) {
        const before = tab.url;
        const settled = await emitPause(conn, tab, sessionId, params.url, true);
        if (String(settled).startsWith('error:')) return { frameId: sessions.get(sessionId) };
        if (
          tab.url === before &&
          settled !== '200 ok:nohit' &&
          !(continueItselfNoHit && guardedUrl(params.url) && conn === connections[0])
        )
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
      if (expression === 'location.href') {
        if (nullGuardHref && conn === connections[0])
          throw new Error('slicc: refused: protected origin execution context');
        const tab = tabs.get(sessions.get(sessionId));
        return { result: { type: 'string', value: tab?.url ?? '' } };
      }
      const assign = /location\.assign\(("([^"]+)"|'([^']+)')\)/.exec(expression);
      if (assign) {
        const url = assign[2] ?? assign[3];
        const tab = tabs.get(sessions.get(sessionId));
        if (!url || !tab) return { result: { type: 'string', value: 'error' } };
        if (deadPageSession && guardedUrl(url) && conn === connections[0])
          return new Promise(() => {});
        const guardOwns =
          [...(tab.fetchSessions ?? [])].some((id) => id !== sessionId) && guardedUrl(url);
        if (sessionIntercepts(tab, sessionId).any || guardOwns) {
          const before = tab.url;
          const settled = await emitPause(conn, tab, sessionId, url, true);
          if (String(settled).startsWith('error:'))
            return { result: { type: 'string', value: settled } };
          if (
            tab &&
            tab.url === before &&
            settled !== '200 ok:nohit' &&
            !(continueItselfNoHit && guardedUrl(url) && conn === connections[0])
          )
            setTabUrl(conn, sessionId, tab, url);
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
        if (deadPageSession && guardedUrl(url) && conn === connections[0])
          return new Promise(() => {});
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
        const owner = sessionConns.get(entry.sessionId) ?? conn;
        if (failSilentKeepHome || (keepHomeAfterFirstBlock && blockedWithMarker >= 1)) {
          if (entry.tab) emitOrphanAndNeighbourNoise(entry.tab, entry.url);
          entry.resolve?.('200 ok:nohit');
        } else if (settleAssignOk) {
          if (entry.tab && finalHref) setTabUrl(owner, entry.sessionId, entry.tab, finalHref);
          entry.resolve?.('200 ok');
        } else if (supersedeAbort) {
          if (entry.tab && finalHref) setTabUrl(owner, entry.sessionId, entry.tab, finalHref);
          entry.resolve?.('error:Aborted');
        } else {
          const marker = options.blockedMarker || defaultBlockedMarker;
          if (entry.topLevel && entry.tab && marker && !blockWithoutMarker) {
            setTabUrl(owner, entry.sessionId, entry.tab, marker);
          }
          if (entry.tab) emitBlockedToReader(entry.tab, entry.url);
          if (keepHomeAfterFirstBlock) blockedWithMarker += 1;
          entry.resolve?.(
            `error:${params.errorReason === 'BlockedByClient' ? 'BlockedByClient' : (params.errorReason ?? 'Aborted')}`
          );
        }
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
    cookies: jarOf('B1'),
    jarOf,
    networkCookieMisroutes: () => [...networkCookieMisroutes],
    networkCookieRejects: () => [...networkCookieRejects],
    openPageTargets: () => [...tabs.keys()],
    pageTargetCount: () => tabs.size,
  };
}
