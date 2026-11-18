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
const siteOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${hostOf(url).split('.').slice(-2).join('.')}`;
  } catch {
    return null;
  }
};
const partitionSite = (cookie) => {
  const key = cookie?.partitionKey;
  return typeof key === 'string' ? key : (key?.topLevelSite ?? null);
};

export function credentialBrowser({ secure = true } = {}) {
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
    type: tab.type ?? 'page',
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
    const url =
      params.url ?? (params.domain ? `https://${params.domain.replace(/^\./, '')}/` : null);
    if (!url) return { success: false };
    const host = hostOf(url);
    const cookie = {
      name: params.name,
      value: params.value,
      domain: params.domain ?? host,
      path: params.path ?? '/',
      httpOnly: Boolean(params.httpOnly),
      secure: Boolean(params.secure),
      url,
      ...(params.partitionKey ? { partitionKey: params.partitionKey } : {}),
    };
    const idx = cookies.findIndex(
      (c) =>
        c.name === cookie.name &&
        c.domain === cookie.domain &&
        c.path === cookie.path &&
        partitionSite(c) === partitionSite(cookie)
    );
    if (idx >= 0) cookies[idx] = cookie;
    else cookies.push(cookie);
    return { success: true };
  };

  const storageKeyOf = (tab) => tab.storageKey ?? tab.frame?.securityOrigin ?? originOf(tab.url);

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

  const addFrame = (parent, src) => {
    const child = {
      targetId: `T${++next}`,
      type: 'iframe',
      parentId: parent.targetId,
      url: 'about:blank',
      title: '',
      frame: { id: `T${next}`, url: 'about:blank', securityOrigin: '://' },
    };
    tabs.set(child.targetId, child);
    discovered('Target.targetCreated', child);
    commit(child, src);
    child.storageKey = `${originOf(src)}/^0${siteOf(parent.url)}^31`;
  };

  const evaluate = (tab, expression) => {
    const origin = tab.frame?.securityOrigin ?? originOf(tab.url);
    if (expression === 'document.title') return { result: { type: 'string', value: tab.title } };
    if (expression.includes('location.href') && expression.includes('document.readyState'))
      return {
        result: {
          type: 'object',
          value: { href: tab.url, ready: 'complete', title: tab.title },
        },
      };
    if (expression.includes("createElement('iframe')")) {
      const src = /f\.src=(["'])(.*?)\1/.exec(expression)?.[2];
      if (src) addFrame(tab, src);
      return { result: { type: 'boolean', value: true } };
    }
    if (expression.includes('indexedDB.open')) {
      const store = localStores.get(origin) ?? new Map();
      const lsMatch = /localStorage\.setItem\((['"])(.*?)\1,\s*(['"])(.*?)\3\)/.exec(expression);
      if (lsMatch) store.set(lsMatch[2], lsMatch[4]);
      localStores.set(origin, store);
      const dbMatch = /indexedDB\.open\((['"])(.*?)\1/.exec(expression);
      if (dbMatch) idb.set(`${origin}::${dbMatch[2]}`, true);
      const cacheMatch = /caches\.open\((['"])(.*?)\1/.exec(expression);
      if (cacheMatch && secure) {
        const list = caches.get(origin) ?? new Set();
        list.add(cacheMatch[2]);
        caches.set(origin, list);
      }
      const cacheValue = /new Response\((['"])(.*?)\1\)/.exec(expression)?.[2];
      return {
        result: {
          type: 'object',
          value: {
            secure,
            localStorage: true,
            idb: true,
            cache: secure ? (cacheValue ?? lsMatch?.[4]) : 'insecure-context',
          },
        },
      };
    }
    if (expression.includes('localStorage.setItem')) {
      const lsMatch = /localStorage\.setItem\((['"])(.*?)\1,\s*(['"])(.*?)\3\)/.exec(expression);
      if (!lsMatch) return { result: { type: 'boolean', value: false } };
      const key = storageKeyOf(tab);
      const store = localStores.get(key) ?? new Map();
      store.set(lsMatch[2], lsMatch[4]);
      localStores.set(key, store);
      return { result: { type: 'boolean', value: true } };
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
  const storeKey = (storageId = {}) => storageId.storageKey ?? storageId.securityOrigin ?? '';

  const closeTab = (targetId) => {
    for (const child of [...tabs.values()])
      if (child.parentId === targetId) closeTab(child.targetId);
    tabs.delete(targetId);
    for (const [id, s] of [...sessions])
      if (s.targetId === targetId) {
        sessions.delete(id);
        emit(s.conn, 'Target.detachedFromTarget', { sessionId: id, targetId });
      }
  };

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
      closeTab(tab.targetId);
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
    if (method === 'Storage.getStorageKeyForFrame' || method === 'Storage.getStorageKey') {
      const frameTab = tabs.get(params.frameId) ?? tab;
      if (!frameTab) throw new Error('Frame tree node for given frame not found');
      return { storageKey: storageKeyOf(frameTab) };
    }
    if (method === 'Network.setCookie') return setCookie(params);
    if (method === 'Network.setCookies' || method === 'Storage.setCookies') {
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
      const url = params.url ?? (params.domain ? null : tab?.url);
      const domain = params.domain?.toLowerCase().replace(/^\./, '');
      for (let i = cookies.length - 1; i >= 0; i--) {
        if (cookies[i].name !== name) continue;
        if (url && !matchCookie(cookies[i], url)) continue;
        if (domain && cookies[i].domain.toLowerCase().replace(/^\./, '') !== domain) continue;
        cookies.splice(i, 1);
      }
      return {};
    }
    if (method === 'Network.clearBrowserCookies' || method === 'Storage.clearCookies') {
      cookies.length = 0;
      return {};
    }
    if (method === 'DOMStorage.setDOMStorageItem') {
      const key = storeKey(params.storageId);
      const store = localStores.get(key) ?? new Map();
      store.set(params.key, params.value);
      localStores.set(key, store);
      return {};
    }
    if (method === 'DOMStorage.removeDOMStorageItem') {
      localStores.get(storeKey(params.storageId))?.delete(params.key);
      return {};
    }
    if (method === 'DOMStorage.getDOMStorageItems') {
      const store = localStores.get(storeKey(params.storageId)) ?? new Map();
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
    if (method === 'IndexedDB.deleteDatabase') {
      idb.delete(`${params.securityOrigin}::${params.databaseName}`);
      return {};
    }
    if (method === 'CacheStorage.requestCacheNames') {
      const origin = params.securityOrigin;
      return {
        caches: [...(caches.get(origin) ?? [])].map((cacheName) => ({
          cacheId: `${origin}::${cacheName}`,
          securityOrigin: origin,
          cacheName,
        })),
      };
    }
    if (method === 'CacheStorage.deleteCache') {
      const at = String(params.cacheId).lastIndexOf('::');
      caches.get(params.cacheId.slice(0, at))?.delete(params.cacheId.slice(at + 2));
      return {};
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

  const ignorePartition = Boolean(mutants.leakPartitionedCookie || mutants.forgedTopLevelSite);
  const cookieCredential = (cookie) => {
    if (!matcher) return false;
    if (cookie.domain && matcher.cookieDomain(cookie.domain)) return true;
    if (cookie.url && matcher.url(cookie.url)) return true;
    if (ignorePartition) return false;
    const site = partitionSite(cookie);
    if (site && matcher.topLevelSite(site)) return true;
    return false;
  };
  const urlCredential = (url) => matcher?.url(url);
  const storageCredential = (storageId = {}) => {
    if (urlCredential(storageId.securityOrigin)) return true;
    if (mutants.leakPartitionedStorageKey) return false;
    return Boolean(storageId.storageKey && matcher.storageKey(storageId.storageKey));
  };
  const cacheCredential = (cacheId) => {
    const text = String(cacheId ?? '');
    return urlCredential(text.slice(0, text.lastIndexOf('::')));
  };
  const forgeCookie = (cookie) => {
    const site = partitionSite(cookie);
    if (site && matcher.topLevelSite(site))
      return {
        ...cookie,
        partitionKey: { topLevelSite: 'https://adobelogin.com.forged.test' },
      };
    return cookie;
  };
  const partitionCredential = (cookie) => {
    const site = partitionSite(cookie);
    return Boolean(site && matcher.topLevelSite(site));
  };

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
          (params.domain && matcher.cookieDomain(params.domain)) ||
          browser.cookies.some((c) => c.name === name && cookieCredential(c))
        )
          throw new Error(refusal);
      }
      if (
        ['Network.clearBrowserCookies', 'Storage.clearCookies'].includes(method) &&
        !mutants.allowClear
      )
        throw new Error(refusal);
      if (
        method === 'DOMStorage.getDOMStorageItems' &&
        storageCredential(params.storageId) &&
        !mutants.leakDomStorage
      ) {
        if (mutants.redactValuesKeepEntry) {
          const out = await raw.send(method, params, sessionId);
          return {
            ...out,
            entries: (out.entries ?? []).map((entry) => [entry?.[0], '']),
          };
        }
        throw new Error(refusal);
      }
      if (
        ['DOMStorage.setDOMStorageItem', 'DOMStorage.removeDOMStorageItem'].includes(method) &&
        !mutants.allowStorageMutation &&
        storageCredential(params.storageId)
      )
        throw new Error(refusal);
      if (
        method === 'IndexedDB.requestDatabaseNames' &&
        !mutants.leakIndexedDB &&
        urlCredential(params.securityOrigin)
      )
        throw new Error(refusal);
      if (
        method === 'IndexedDB.deleteDatabase' &&
        !mutants.allowStorageMutation &&
        urlCredential(params.securityOrigin)
      )
        throw new Error(refusal);
      if (
        method === 'CacheStorage.requestCacheNames' &&
        !mutants.leakCacheStorage &&
        urlCredential(params.securityOrigin)
      )
        throw new Error(refusal);
      if (
        method === 'CacheStorage.deleteCache' &&
        !mutants.allowStorageMutation &&
        cacheCredential(params.cacheId)
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
        if (
          mutants.leakBrowserStorageGetCookies &&
          method === 'Storage.getCookies' &&
          sessionId === undefined
        )
          return out;
        let cookies = out.cookies ?? [];
        if (mutants.forgedTopLevelSite) cookies = cookies.map(forgeCookie);
        if (mutants.redactValuesKeepEntry)
          return {
            ...out,
            cookies: cookies.map((cookie) =>
              cookieCredential(cookie) || partitionCredential(cookie)
                ? { ...cookie, value: '' }
                : cookie
            ),
          };
        return {
          ...out,
          cookies: cookies.filter((cookie) => !cookieCredential(cookie)),
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
      if (mutants.redactValuesKeepEntry) {
        const headers = { ...(event.params?.headers ?? {}) };
        for (const key of Object.keys(headers))
          if (['cookie', 'set-cookie'].includes(key.toLowerCase())) headers[key] = '';
        const associated = (event.params?.associatedCookies ?? []).map((entry) => {
          const cookie = entry.cookie ?? entry;
          return {
            ...entry,
            cookie: cookieCredential(cookie)
              ? { ...cookie, value: '' }
              : mutants.forgedTopLevelSite
                ? forgeCookie(cookie)
                : cookie,
          };
        });
        return {
          ...event,
          params: { ...event.params, headers, associatedCookies: associated },
        };
      }
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
