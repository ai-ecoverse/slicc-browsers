import { keptDocument } from '../../close-protected-shape.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const originOf = (url) => URL.parse(url)?.origin;
const seven = (url) => URL.parse(url)?.hostname === 'seven.sliccy.ai';
const vault = (url) => {
  const host = URL.parse(url)?.hostname?.replace(/\.$/, '');
  return host === 'vault.sliccy.ai' || (host?.startsWith('vault-') && host.endsWith('.sliccy.ai'));
};
const protectedHost = (url) => seven(url) || vault(url) || keptDocument(url);

export function chrome() {
  const tabs = new Map();
  const sessions = new Map();
  const paused = new Map();
  const connections = [];
  const commits = [];
  const interceptors = [];
  let next = 0;
  const info = (tab) => ({
    targetId: tab.targetId,
    type: 'page',
    url: tab.url,
    title: tab.title,
    attached: [...sessions.values()].some((s) => s.targetId === tab.targetId),
    browserContextId: 'B1',
    ...(tab.openerId ? { openerId: tab.openerId } : {}),
  });
  const emit = (conn, method, params, sessionId) => {
    const shown = params.targetInfo ? [conn.redact(params.targetInfo, method)].flat() : [null];
    for (const targetInfo of shown)
      conn.events.push({
        method,
        params: targetInfo ? { ...params, targetInfo } : params,
        ...(sessionId ? { sessionId } : {}),
      });
  };
  const onTab = (tab, method, params) => {
    for (const [sessionId, s] of sessions)
      if (s.targetId === tab.targetId) emit(s.conn, method, params, sessionId);
  };
  const discovered = (method, tab) => {
    for (const conn of connections)
      if (conn.discover) emit(conn, method, { targetInfo: info(tab) });
  };
  const show = (tab, entry, type) => {
    Object.assign(tab, { frame: entry.frame, url: entry.url, title: entry.title });
    for (const hook of commits) hook(tab);
    onTab(tab, 'Page.frameNavigated', { frame: entry.frame, type });
    discovered('Target.targetInfoChanged', tab);
  };
  const intercept = (conn, sessionId, url, targetId) =>
    new Promise((resolve) => {
      const requestId = `R${++next}`;
      paused.set(requestId, { resolve, targetId });
      emit(
        conn,
        'Fetch.requestPaused',
        { requestId, request: { url: url.split('#')[0], method: 'GET' }, resourceType: 'Document' },
        sessionId
      );
    });
  const commit = (tab, url, failed, replace, origin) => {
    const loaderId = `L${++next}`;
    const securityOrigin =
      origin ??
      (url === 'about:blank' || url.startsWith('blob:')
        ? (tab.frame?.securityOrigin ?? originOf(url) ?? '://')
        : (originOf(url) ?? '://'));
    const frame = failed
      ? {
          id: tab.targetId,
          loaderId,
          url: 'chrome-error://chromewebdata/',
          securityOrigin: '://',
          unreachableUrl: url,
        }
      : { id: tab.targetId, loaderId, url, securityOrigin };
    const entry = { id: ++next, url, title: url, frame, cached: !failed };
    if (replace) tab.entries[tab.index] = entry;
    else {
      tab.entries.splice(tab.index + 1, tab.entries.length, entry);
      tab.index = tab.entries.length - 1;
    }
    show(tab, entry, 'Navigation');
    onTab(tab, 'Page.loadEventFired', { timestamp: next });
    const page = URL.parse(url);
    if (!failed && page?.pathname === '/page' && page.searchParams.get('k') === 'deferred')
      setTimeout(
        () => navigate(tab, page.searchParams.get('to'), true),
        Number(page.searchParams.get('defer'))
      );
    if (!failed && page?.pathname === '/blob-nav')
      setTimeout(() => navigate(tab, `blob:${originOf(url)}/${++next}`, true), 0);
    return {
      frameId: tab.targetId,
      loaderId,
      ...(failed ? { errorText: 'net::ERR_BLOCKED_BY_CLIENT' } : {}),
    };
  };
  async function navigate(tab, url, replace = false) {
    if (!tabs.has(tab.targetId)) return {};
    let failed = false;
    const httpish = /^(https?:|view-source:)/.test(url);
    if (httpish) {
      tab.navigating = true;
      tab.navigationURL = url;
      onTab(tab, 'Page.frameStartedNavigating', {
        frameId: tab.targetId,
        url,
        navigationType: 'differentDocument',
      });
      for (const [sessionId, s] of [...sessions])
        if (!failed && s.targetId === tab.targetId && s.fetch)
          failed = (await intercept(s.conn, sessionId, url, tab.targetId)) === 'fail';
      failed ||= interceptors.some((fails) => fails(tab, url));
    }
    try {
      return commit(tab, url, failed, replace);
    } finally {
      tab.navigating = false;
      tab.navigationURL = undefined;
    }
  }
  const traverse = (tab, delta) => {
    const entry = tab.entries[tab.index + delta];
    if (!entry?.cached) return;
    tab.index += delta;
    show(tab, entry, 'BackForwardCacheRestore');
  };
  const openBlank = (parent) => {
    const created = {
      targetId: `T${++next}`,
      entries: [],
      index: -1,
      openerId: parent.targetId,
      url: 'about:blank',
      title: 'about:blank',
    };
    tabs.set(created.targetId, created);
    discovered('Target.targetCreated', created);
    commit(
      created,
      'about:blank',
      false,
      false,
      parent.frame?.securityOrigin ?? originOf(parent.url)
    );
    return created;
  };
  const evaluate = (tab, expression) => {
    if (expression === 'document.readyState')
      return { result: { type: 'string', value: 'complete' } };
    if (expression === 'document.title') return { result: { type: 'string', value: tab.title } };
    if (expression === 'location.href') return { result: { type: 'string', value: tab.frame.url } };
    if (expression === "window.open('')") {
      openBlank(tab);
      return { result: { type: 'undefined' } };
    }
    return { result: { type: 'undefined' } };
  };
  const tabOf = (sessionId, targetId) =>
    sessionId ? tabs.get(sessions.get(sessionId)?.targetId) : tabs.get(targetId);
  const detach = (sessionId) => {
    const s = sessions.get(sessionId);
    sessions.delete(sessionId);
    emit(s.conn, 'Target.detachedFromTarget', { sessionId, targetId: s.targetId });
  };
  async function handle(conn, method, params, sessionId) {
    await tick();
    if (sessionId && !sessions.has(sessionId))
      throw new Error(`Session with given id not found: ${sessionId}`);
    const tab = tabOf(sessionId, params.targetId);
    if (method === 'Target.createTarget') {
      const created = { targetId: `T${++next}`, entries: [], index: -1 };
      Object.assign(created, { url: 'about:blank', title: 'about:blank' });
      tabs.set(created.targetId, created);
      discovered('Target.targetCreated', created);
      await navigate(created, params.url);
      return { targetId: created.targetId };
    }
    if (method === 'Target.getTargets') return { targetInfos: [...tabs.values()].map(info) };
    if (method === 'Target.setDiscoverTargets') {
      conn.discover = params.discover;
      if (conn.discover)
        for (const t of tabs.values()) emit(conn, 'Target.targetCreated', { targetInfo: info(t) });
      return {};
    }
    if (method === 'Target.detachFromTarget') {
      if (!sessions.has(params.sessionId)) throw new Error('No session with given id');
      detach(params.sessionId);
      return {};
    }
    if (method.startsWith('Target.') && !tab) throw new Error('No target with given id found');
    if (method === 'Target.getTargetInfo') return { targetInfo: info(tab) };
    if (method === 'Target.attachToTarget') {
      const id = `S${++next}`;
      sessions.set(id, { targetId: tab.targetId, conn, fetch: false });
      emit(conn, 'Target.attachedToTarget', {
        sessionId: id,
        targetInfo: info(tab),
        waitingForDebugger: false,
      });
      return { sessionId: id };
    }
    if (method === 'Target.closeTarget') {
      for (const [requestId, entry] of [...paused]) {
        if (entry.targetId !== tab.targetId) continue;
        paused.delete(requestId);
        entry.resolve('fail');
      }
      tabs.delete(tab.targetId);
      for (const [id, s] of [...sessions]) if (s.targetId === tab.targetId) detach(id);
      for (const c of connections)
        if (c.discover) emit(c, 'Target.targetDestroyed', { targetId: tab.targetId });
      return { success: true };
    }
    if (method === 'Page.navigate') return navigate(tab, params.url);
    if (method === 'Page.reload') {
      await navigate(tab, tab.url, true);
      return {};
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: tab.frame } };
    if (method === 'Page.getNavigationHistory')
      return {
        currentIndex: tab.index,
        entries: tab.entries.map(({ id, url, title }) => ({ id, url, userTypedURL: url, title })),
      };
    if (method === 'Fetch.enable' || method === 'Fetch.disable') {
      sessions.get(sessionId).fetch = method === 'Fetch.enable';
      return {};
    }
    if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
      const entry = paused.get(params.requestId);
      if (!entry) throw new Error('Invalid InterceptionId.');
      paused.delete(params.requestId);
      entry.resolve(method === 'Fetch.failRequest' ? 'fail' : 'continue');
      return {};
    }
    if (method === 'Page.navigateToHistoryEntry') {
      const index = tab.entries.findIndex((entry) => entry.id === params.entryId);
      if (index < 0) throw new Error('No entry with passed id');
      setTimeout(() => traverse(tab, index - tab.index), 0);
      return {};
    }
    if (method === 'Runtime.evaluate') return evaluate(tab, params.expression);
    return {};
  }
  const connect = (redact = (targetInfo) => targetInfo) => {
    const conn = { events: [], discover: false, redact };
    conn.raw = (method, params = {}, sessionId) => handle(conn, method, params, sessionId);
    conn.send = conn.raw;
    connections.push(conn);
    return conn;
  };
  const attached = (conn, targetId) =>
    [...sessions.values()].some((s) => s.conn === conn && s.targetId === targetId);
  return { connect, commits, interceptors, attached, tabOf };
}

export function quarantining(
  browser,
  {
    refuseNavigation = () => false,
    refuseAttach = () => false,
    refuseURL = () => false,
    unanswered = () => false,
    exposeURL = false,
    discovery,
    evaluate = false,
    block = true,
    closeProtected = false,
    refuseClose = false,
    allowKeptClose = false,
  } = {}
) {
  const locked = new Map();
  const redact = (targetInfo, method) => {
    if (discovery && ['Target.targetCreated', 'Target.targetInfoChanged'].includes(method))
      return discovery(targetInfo);
    if (exposeURL || !protectedHost(targetInfo.url)) return targetInfo;
    return { ...targetInfo, url: originOf(targetInfo.url), title: originOf(targetInfo.url) };
  };
  const conn = browser.connect(redact);
  const quarantined = (tab) =>
    tab.entries.some((entry) => protectedHost(entry.url)) ||
    keptDocument(tab.frame?.securityOrigin ?? '');
  browser.commits.push((tab) =>
    locked.set(
      tab.targetId,
      tab.frame.unreachableUrl
        ? (locked.get(tab.targetId) ?? false)
        : protectedHost(tab.frame.url) ||
            keptDocument(tab.url) ||
            (tab.frame.url === 'about:blank' && keptDocument(tab.frame.securityOrigin))
    )
  );
  browser.interceptors.push(
    (tab, url) => block && protectedHost(url) && browser.attached(conn, tab.targetId)
  );
  const refuse = (why) => {
    throw new Error(`slicc: refused: ${why}`);
  };
  const keepClosed = (tab) => {
    if (!tab || allowKeptClose) return false;
    const blank = tab.url === 'about:blank' || tab.frame?.url === 'about:blank';
    const opener = tab.openerId ? browser.tabOf(undefined, tab.openerId) : undefined;
    const inherited =
      tab.frame?.securityOrigin ||
      opener?.frame?.securityOrigin ||
      (opener ? originOf(opener.url) : undefined);
    return (
      keptDocument(tab.url) ||
      keptDocument(tab.frame?.url) ||
      (blank && keptDocument(inherited)) ||
      (tab.navigating && (!tab.navigationURL || keptDocument(tab.navigationURL)))
    );
  };
  conn.send = async (method, params = {}, sessionId) => {
    const tab = browser.tabOf(sessionId, params.targetId);
    if (
      method === 'Runtime.evaluate' &&
      tab &&
      !evaluate &&
      (quarantined(tab) || (closeProtected && keepClosed(tab)))
    )
      refuse("this tab's history holds a protected page");
    if (method === 'Page.navigate' && protectedHost(params.url)) refuse('protected URL');
    if (method === 'Page.navigate' && refuseURL(params.url)) refuse('inherited origin');
    if (method === 'Page.navigate' && tab && unanswered(params.url))
      return { frameId: tab.targetId, loaderId: 'L0' };
    if (
      ['Page.navigate', 'Page.reload'].includes(method) &&
      tab &&
      refuseNavigation(tab, quarantined)
    )
      refuse('navigation in a quarantined tab');
    if (method === 'Target.attachToTarget' && tab && refuseAttach(tab, quarantined))
      refuse('attach to a quarantined tab');
    if (
      method === 'Target.attachToTarget' &&
      (locked.get(tab?.targetId) || (closeProtected && keepClosed(tab)))
    )
      refuse('protected target');
    if (
      method === 'Target.closeTarget' &&
      ((locked.get(tab?.targetId) && (!closeProtected || refuseClose)) ||
        (closeProtected && !refuseClose && keepClosed(tab)))
    )
      refuse('protected target');
    const result = await conn.raw(method, params, sessionId);
    if (method === 'Target.getTargetInfo') return { targetInfo: redact(result.targetInfo) };
    if (method === 'Target.getTargets') return { targetInfos: result.targetInfos.map(redact) };
    return result;
  };
  return conn;
}
