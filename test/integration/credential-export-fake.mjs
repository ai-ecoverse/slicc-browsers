import { credentialOrigins } from '../../protected.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const originOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return null;
  }
};
const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
};

export function credentialBrowser() {
  const tabs = new Map();
  const sessions = new Map();
  const cookies = [];
  const localStores = new Map();
  const idb = new Map();
  const caches = new Map();
  const connections = [];
  let next = 0;

  const info = (tab) => ({
    targetId: tab.targetId,
    type: 'page',
    url: tab.url,
    title: tab.title,
    attached: [...sessions.values()].some((s) => s.targetId === tab.targetId),
    browserContextId: 'B1',
  });
  const emit = (conn, method, params, sessionId) => {
    conn.events.push({ method, params, ...(sessionId ? { sessionId } : {}) });
  };
  const onTab = (tab, method, params) => {
    for (const [sessionId, s] of sessions)
      if (s.targetId === tab.targetId) emit(s.conn, method, params, sessionId);
  };
  const discovered = (method, tab) => {
    for (const conn of connections)
      if (conn.discover) emit(conn, method, { targetInfo: info(tab) });
  };

  const matchCookie = (cookie, url) => {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const domain = String(cookie.domain || host)
      .toLowerCase()
      .replace(/^\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  };

  const setCookie = (params) => {
    const url = params.url ?? (params.domain ? `https://${params.domain}/` : null);
    if (!url) return { success: false };
    const host = hostOf(url);
    const cookie = {
      name: params.name,
      value: params.value,
      domain: params.domain ?? host,
      path: params.path ?? '/',
      httpOnly: Boolean(params.httpOnly),
      url,
    };
    const idx = cookies.findIndex(
      (c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path
    );
    if (idx >= 0) cookies[idx] = cookie;
    else cookies.push(cookie);
    return { success: true };
  };

  const commit = (tab, url) => {
    const origin = originOf(url) ?? '://';
    tab.url = url;
    tab.title = url.includes('/credential') ? 'credential' : 'doc';
    tab.frame = {
      id: tab.targetId,
      loaderId: `L${++next}`,
      url,
      securityOrigin: origin,
    };
    onTab(tab, 'Page.frameNavigated', { frame: tab.frame });
    onTab(tab, 'Network.requestWillBeSent', {
      requestId: `R${next}`,
      request: { url, headers: {} },
    });
    onTab(tab, 'Network.responseReceived', {
      requestId: `R${next}`,
      response: { url, headers: { 'set-cookie': 'ignored=1' }, status: 200 },
    });
    onTab(tab, 'Network.requestWillBeSentExtraInfo', {
      requestId: `R${next}`,
      headers: {
        cookie: cookies
          .filter((c) => matchCookie(c, url))
          .map((c) => `${c.name}=${c.value}`)
          .join('; '),
      },
      associatedCookies: cookies.filter((c) => matchCookie(c, url)).map((c) => ({ cookie: c })),
    });
    onTab(tab, 'Network.responseReceivedExtraInfo', {
      requestId: `R${next}`,
      headers: { 'set-cookie': 'session=1' },
    });
    onTab(tab, 'Page.loadEventFired', { timestamp: next });
    discovered('Target.targetInfoChanged', tab);
    return { frameId: tab.targetId, loaderId: tab.frame.loaderId };
  };

  const evaluate = (tab, expression) => {
    const origin = tab.frame?.securityOrigin ?? originOf(tab.url);
    if (expression === 'document.title') return { result: { type: 'string', value: tab.title } };
    if (expression.includes('localStorage.setItem') || expression.includes('indexedDB.open')) {
      const store = localStores.get(origin) ?? new Map();
      const lsMatch = /localStorage\.setItem\((['"])(.*?)\1,\s*(['"])(.*?)\3\)/.exec(expression);
      if (lsMatch) store.set(lsMatch[2], lsMatch[4]);
      localStores.set(origin, store);
      const dbMatch = /indexedDB\.open\((['"])(.*?)\1/.exec(expression);
      if (dbMatch) idb.set(`${origin}::${dbMatch[2]}`, true);
      const cacheMatch = /caches\.open\((['"])(.*?)\1/.exec(expression);
      if (cacheMatch) {
        const list = caches.get(origin) ?? new Set();
        list.add(cacheMatch[2]);
        caches.set(origin, list);
      }
      return {
        result: {
          type: 'object',
          value: { localStorage: true, idb: true, cache: true },
        },
      };
    }
    if (expression.includes('document.querySelector') && expression.includes('input')) {
      return { result: { type: 'string', value: tab.title } };
    }
    if (expression.includes('document.cookie')) {
      const jar = cookies
        .filter((c) => matchCookie(c, tab.url) && !c.httpOnly)
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      const lsKey = /localStorage\.getItem\((['"])(.*?)\1\)/.exec(expression)?.[2];
      const ls = lsKey ? (localStores.get(origin)?.get(lsKey) ?? null) : null;
      return { result: { type: 'object', value: { cookie: jar, ls } } };
    }
    return { result: { type: 'undefined' } };
  };

  const tabOf = (sessionId, targetId) =>
    sessionId ? tabs.get(sessions.get(sessionId)?.targetId) : tabs.get(targetId);

  async function handle(conn, method, params = {}, sessionId) {
    await tick();
    if (sessionId && !sessions.has(sessionId))
      throw new Error(`Session with given id not found: ${sessionId}`);
    const tab = tabOf(sessionId, params.targetId);
    if (method === 'Target.createTarget') {
      const created = {
        targetId: `T${++next}`,
        url: 'about:blank',
        title: 'about:blank',
        frame: { id: `T${next}`, url: 'about:blank', securityOrigin: '://' },
      };
      tabs.set(created.targetId, created);
      discovered('Target.targetCreated', created);
      commit(created, params.url ?? 'about:blank');
      return { targetId: created.targetId };
    }
    if (method === 'Target.getTargets') return { targetInfos: [...tabs.values()].map(info) };
    if (method === 'Target.setDiscoverTargets') {
      conn.discover = params.discover;
      return {};
    }
    if (method === 'Target.getTargetInfo') return { targetInfo: info(tab) };
    if (method === 'Target.attachToTarget') {
      const id = `S${++next}`;
      sessions.set(id, { targetId: tab.targetId, conn });
      emit(conn, 'Target.attachedToTarget', {
        sessionId: id,
        targetInfo: info(tab),
        waitingForDebugger: false,
      });
      return { sessionId: id };
    }
    if (method === 'Target.closeTarget') {
      tabs.delete(tab.targetId);
      for (const [id, s] of [...sessions])
        if (s.targetId === tab.targetId) {
          sessions.delete(id);
          emit(s.conn, 'Target.detachedFromTarget', { sessionId: id, targetId: tab.targetId });
        }
      return { success: true };
    }
    if (method === 'Target.detachFromTarget') {
      sessions.delete(params.sessionId);
      return {};
    }
    if (method === 'Page.enable' || method === 'Runtime.enable' || method === 'Network.enable')
      return {};
    if (method === 'Page.navigate') return commit(tab, params.url);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: tab.frame } };
    if (method === 'Runtime.evaluate') return evaluate(tab, params.expression);
    if (method === 'Network.setCookie') return setCookie(params);
    if (method === 'Network.setCookies') {
      for (const cookie of params.cookies ?? []) setCookie(cookie);
      return {};
    }
    if (method === 'Network.getCookies') {
      const urls = params.urls?.length ? params.urls : [...tabs.values()].map((t) => t.url);
      return {
        cookies: cookies.filter((c) => urls.some((url) => matchCookie(c, url))),
      };
    }
    if (method === 'Network.getAllCookies') return { cookies: [...cookies] };
    if (method === 'Storage.getCookies') return { cookies: [...cookies] };
    if (method === 'Page.getCookies') {
      return { cookies: cookies.filter((c) => matchCookie(c, tab.url)) };
    }
    if (method === 'Network.deleteCookies' || method === 'Page.deleteCookie') {
      const name = params.name ?? params.cookieName;
      const url = params.url ?? tab?.url;
      for (let i = cookies.length - 1; i >= 0; i--)
        if (cookies[i].name === name && (!url || matchCookie(cookies[i], url)))
          cookies.splice(i, 1);
      return {};
    }
    if (method === 'Storage.setCookies') {
      for (const cookie of params.cookies ?? []) setCookie(cookie);
      return {};
    }
    if (method === 'DOMStorage.getDOMStorageItems') {
      const origin = params.storageId?.securityOrigin;
      const store = localStores.get(origin) ?? new Map();
      return { entries: [...store.entries()].map(([k, v]) => [k, v]) };
    }
    if (method === 'IndexedDB.requestDatabaseNames') {
      const origin = params.securityOrigin;
      return {
        databaseNames: [...idb.keys()]
          .filter((key) => key.startsWith(`${origin}::`))
          .map((key) => key.slice(origin.length + 2)),
      };
    }
    if (method === 'CacheStorage.requestCacheNames') {
      const origin = params.securityOrigin;
      return {
        caches: [...(caches.get(origin) ?? [])].map((cacheName) => ({ cacheName })),
      };
    }
    return {};
  }

  const connect = () => {
    const conn = { events: [], discover: false };
    conn.send = (method, params = {}, sessionId) => handle(conn, method, params, sessionId);
    connections.push(conn);
    return conn;
  };

  return { connect, cookies, localStores };
}

export function credentialGuard(browser, options = {}) {
  const raw = browser.connect();
  const matcher = options.credentialOrigins ? credentialOrigins(options.credentialOrigins) : null;
  const refusal =
    options.credentialOrigins?.refusal ?? 'slicc: refused: this origin holds sign-in credentials';
  const mutants = options.mutants ?? {};

  const cookieCredential = (cookie) => {
    if (!matcher) return false;
    if (cookie.domain && matcher.cookieDomain(cookie.domain)) return true;
    if (cookie.url && matcher.url(cookie.url)) return true;
    return false;
  };
  const urlCredential = (url) => matcher?.url(url);

  const client = {
    events: raw.events,
    send: async (method, params = {}, sessionId) => {
      if (!matcher || mutants.disabled) return raw.send(method, params, sessionId);

      if (
        ['Network.setCookie', 'Network.setCookies', 'Storage.setCookies'].includes(method) &&
        !mutants.allowSetCookie
      ) {
        const list = method === 'Network.setCookie' ? [params] : (params.cookies ?? []);
        if (list.some((cookie) => cookieCredential(cookie) || urlCredential(cookie.url)))
          throw new Error(refusal);
      }
      if (
        (method === 'Network.deleteCookies' || method === 'Page.deleteCookie') &&
        !mutants.allowDeleteCookie
      ) {
        const url = params.url;
        const name = params.name ?? params.cookieName;
        if (
          urlCredential(url) ||
          browser.cookies.some((c) => c.name === name && cookieCredential(c))
        )
          throw new Error(refusal);
      }
      if (
        method === 'DOMStorage.getDOMStorageItems' &&
        !mutants.leakDomStorage &&
        urlCredential(params.storageId?.securityOrigin)
      )
        throw new Error(refusal);
      if (
        method === 'IndexedDB.requestDatabaseNames' &&
        !mutants.leakIndexedDB &&
        urlCredential(params.securityOrigin)
      )
        throw new Error(refusal);
      if (
        method === 'CacheStorage.requestCacheNames' &&
        !mutants.leakCacheStorage &&
        urlCredential(params.securityOrigin)
      )
        throw new Error(refusal);

      const out = await raw.send(method, params, sessionId);

      if (
        [
          'Network.getCookies',
          'Network.getAllCookies',
          'Storage.getCookies',
          'Page.getCookies',
        ].includes(method) &&
        !mutants.leakCookies
      ) {
        return {
          ...out,
          cookies: (out.cookies ?? []).filter((cookie) => !cookieCredential(cookie)),
        };
      }
      return out;
    },
  };

  const wrapEvents = () => {
    if (!matcher || mutants.leakHeaders) return;
    const strip = (event) => {
      if (
        !['Network.responseReceivedExtraInfo', 'Network.requestWillBeSentExtraInfo'].includes(
          event.method
        )
      )
        return event;
      const headers = { ...(event.params?.headers ?? {}) };
      for (const key of Object.keys(headers))
        if (['cookie', 'set-cookie'].includes(key.toLowerCase())) delete headers[key];
      return {
        ...event,
        params: {
          ...event.params,
          headers,
          associatedCookies: [],
        },
      };
    };
    const events = raw.events;
    raw.events = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === 'slice') return (...args) => target.slice(...args).map(strip);
        if (prop === Symbol.iterator)
          return function* () {
            for (const event of target) yield strip(event);
          };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    client.events = raw.events;
  };
  wrapEvents();

  if (mutants.blockOrdinaryCookies) {
    const inner = client.send;
    client.send = async (method, params = {}, sessionId) => {
      const out = await inner(method, params, sessionId);
      if (
        [
          'Network.getCookies',
          'Network.getAllCookies',
          'Storage.getCookies',
          'Page.getCookies',
        ].includes(method)
      )
        return { cookies: [] };
      return out;
    };
  }
  if (mutants.refuseIdpAttach) {
    const inner = client.send;
    client.send = async (method, params = {}, sessionId) => {
      if (method === 'Target.attachToTarget') {
        const { targetInfo } = await raw.send('Target.getTargetInfo', {
          targetId: params.targetId,
        });
        if (urlCredential(targetInfo.url)) throw new Error(refusal);
      }
      return inner(method, params, sessionId);
    };
  }

  return { client, unguarded: browser.connect() };
}
