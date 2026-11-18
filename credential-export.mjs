import { outcome, parseURL, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

const refused = (out) => !out.ok && /^slicc: refused:/.test(out.error?.message ?? '');
const unsupported = (out) =>
  !out.ok &&
  /(?:Method|method) (?:not found|doesn't exist)|wasn't found|Unknown method|not supported|Not supported/i.test(
    String(out.error?.message ?? out.error ?? '')
  );

const hostOf = (text) => {
  const u = typeof text === 'string' ? parseURL(text) : text;
  const host = (u?.hostname ?? '').toLowerCase();
  return host.endsWith('.') ? host.slice(0, -1) : host;
};

const originOf = (text) => {
  const u = parseURL(text);
  if (!u?.host) return null;
  const host = hostOf(u);
  if (!host) return null;
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
};

const siteHost = (host) => {
  const parts = host.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
};

function siteOf(url) {
  const parsed = parseURL(url);
  if (!parsed?.hostname) return null;
  return `${parsed.protocol}//${siteHost(hostOf(parsed))}`;
}

const partitionSite = (cookie) => {
  const key = cookie?.partitionKey;
  return typeof key === 'string' ? key : (key?.topLevelSite ?? null);
};

const partitionedUnder = (cookie, site) => {
  const key = partitionSite(cookie);
  return Boolean(key) && hostOf(key) === hostOf(site);
};

function cookieHit(cookies, { name, host, value }) {
  return (cookies ?? []).some((cookie) => {
    if (cookie?.name !== name) return false;
    if (value !== undefined && cookie.value !== value) return false;
    const domain = String(cookie.domain ?? '')
      .toLowerCase()
      .replace(/^\./, '')
      .replace(/\.$/, '');
    return !host || domain === host || host.endsWith(`.${domain}`) || domain === '' || !domain;
  });
}

const hasEntry = (entries, key, value) =>
  (entries ?? []).some(
    (entry) => entry?.[0] === key && (value === undefined || entry?.[1] === value)
  );

async function pageReady(reader, sessionId, accept) {
  const ev = await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression: `({href:location.href,ready:document.readyState,title:document.title})`,
        returnByValue: true,
      },
      sessionId
    )
  );
  const value = ev.result?.result?.value;
  return Boolean(
    ev.ok && value?.ready === 'complete' && typeof value.href === 'string' && accept(value)
  );
}

async function openPage(reader, url, notes, internalSessions) {
  const opened = await outcome(
    createObserverTarget(reader, { url }, notes).then(async (created) => {
      const { sessionId } = await reader.send('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      });
      await reader.send('Page.enable', {}, sessionId);
      await reader.send('Runtime.enable', {}, sessionId);
      await reader.send('Network.enable', {}, sessionId);
      const ready = await waitFor(
        () =>
          pageReady(
            reader,
            sessionId,
            (value) => value.href.includes('/credential') && value.title === 'credential'
          ),
        5000
      );
      if (!ready) throw new Error('credential page did not become ready');
      return { targetId: created.targetId, sessionId };
    })
  );
  if (!opened.ok) return opened;
  internalSessions.add(opened.result.sessionId);
  return opened;
}

const credentialCookieParams = (planted, origin, tag) => [
  [
    'HttpOnly',
    { name: planted.httpOnly, value: tag, url: `${origin}/`, httpOnly: true, path: '/' },
  ],
  ['open', { name: planted.open, value: tag, url: `${origin}/`, httpOnly: false, path: '/' }],
  ['parent-domain', { name: planted.parent, value: tag, domain: planted.parentDomain, path: '/' }],
];

async function setCookies(reader, sessionId, list) {
  for (const [label, params] of list) {
    const set = await outcome(reader.send('Network.setCookie', params, sessionId));
    if (!set.ok || set.result?.success === false)
      return `plant ${label} cookie failed: ${set.error?.message ?? 'no success'}`;
  }
  return null;
}

async function plantState(reader, { origin, host, tag, sessionId }) {
  const names = {
    httpOnly: `cred-http-${tag}`,
    open: `cred-open-${tag}`,
    parent: `cred-parent-${tag}`,
    parentDomain: `.${siteHost(host)}`,
  };
  const failed = await setCookies(reader, sessionId, credentialCookieParams(names, origin, tag));
  if (failed) return { incomplete: failed };
  const lsKey = `cred-ls-${tag}`;
  const dbName = `cred-db-${tag}`;
  const cacheName = `cred-cache-${tag}`;
  const cacheUrl = `${origin}/cred-cache-${tag}`;
  const q = JSON.stringify;
  const planted = await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression: `(async()=>{
const secure=self.isSecureContext===true;
const localStorageOk=(()=>{try{localStorage.setItem(${q(lsKey)},${q(tag)});return localStorage.getItem(${q(lsKey)})===${q(tag)};}catch(e){return 'err:'+e.message;}})();
const idb=await (async()=>{try{const open=indexedDB.open(${q(dbName)},1);const db=await new Promise((ok,err)=>{open.onupgradeneeded=()=>open.result.createObjectStore('s');open.onsuccess=()=>ok(open.result);open.onerror=()=>err(open.error);});const tx=db.transaction('s','readwrite');tx.objectStore('s').put(${q(tag)},'k');await new Promise((ok,err)=>{tx.oncomplete=()=>ok(true);tx.onerror=()=>err(tx.error);tx.onabort=()=>err(tx.error);});db.close();return true;}catch(e){return 'err:'+e.message;}})();
const cache=await (async()=>{if(!secure)return 'insecure-context';try{const c=await caches.open(${q(cacheName)});await c.put(${q(cacheUrl)},new Response(${q(tag)}));const m=await c.match(${q(cacheUrl)});return m?await m.text():false;}catch(e){return 'err:'+e.message;}})();
return {secure,localStorage:localStorageOk,idb,cache};
})()`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId
    )
  );
  const value = planted.result?.result?.value;
  if (!planted.ok || !value || value.localStorage !== true || value.idb !== true)
    return {
      incomplete: `plant storage failed: ${planted.error?.message ?? JSON.stringify(value)}`,
    };
  const secure = value.secure === true;
  const cachePlanted = secure && value.cache === tag;
  if (secure && !cachePlanted)
    return {
      incomplete: `plant cache failed: ${typeof value.cache === 'string' ? value.cache : JSON.stringify(value.cache)}`,
    };
  const proved = await provePlanted(reader, sessionId, {
    ...names,
    origin,
    host,
    tag,
    lsKey,
    dbName,
    cacheName,
    cachePlanted,
  });
  if (proved.incomplete) return proved;
  return {
    ...names,
    lsKey,
    dbName,
    secure,
    cacheName: cachePlanted ? cacheName : null,
    cacheUrl: cachePlanted ? cacheUrl : null,
    cachePlanted,
  };
}

async function readerEntries(reader, sessions, storageId) {
  for (const session of sessions) {
    const read = await outcome(
      reader.send('DOMStorage.getDOMStorageItems', { storageId }, session)
    );
    if (read.ok && Array.isArray(read.result?.entries)) return read.result.entries;
  }
  return null;
}

async function readerDatabases(reader, sessionId, origin) {
  const read = await outcome(
    reader.send('IndexedDB.requestDatabaseNames', { securityOrigin: origin }, sessionId)
  );
  return read.ok ? (read.result?.databaseNames ?? []) : null;
}

async function readerCaches(reader, sessionId, origin) {
  const read = await outcome(
    reader.send('CacheStorage.requestCacheNames', { securityOrigin: origin }, sessionId)
  );
  return read.ok ? (read.result?.caches ?? []) : null;
}

const cacheNameOf = (cache) => cache?.cacheName ?? cache;

const survivingCookies = (cookies, planted, host, tag) =>
  cookieHit(cookies, { name: planted.httpOnly, host, value: tag }) &&
  cookieHit(cookies, { name: planted.parent, host, value: tag });

async function provePlanted(reader, sessionId, planted) {
  const { origin, host, tag, lsKey, dbName, cacheName, cachePlanted } = planted;
  const entries = await readerEntries(reader, [sessionId], {
    securityOrigin: origin,
    isLocalStorage: true,
  });
  if (!hasEntry(entries, lsKey, tag))
    return { incomplete: 'unguarded localStorage not readable after plant' };
  if (!(await readerDatabases(reader, sessionId, origin))?.includes(dbName))
    return { incomplete: 'unguarded IndexedDB not readable after plant' };
  if (cachePlanted) {
    const caches = await readerCaches(reader, sessionId, origin);
    if (!caches?.map(cacheNameOf).includes(cacheName))
      return { incomplete: 'unguarded CacheStorage not readable after plant' };
  }
  const all = await outcome(reader.send('Network.getAllCookies', {}, sessionId));
  if (!all.ok)
    return { incomplete: `unguarded getAllCookies failed: ${all.error?.message ?? 'unknown'}` };
  const cookies = all.result?.cookies;
  if (!cookieHit(cookies, { name: planted.httpOnly, host, value: tag }))
    return { incomplete: 'unguarded HttpOnly cookie not readable after plant' };
  if (!cookieHit(cookies, { name: planted.open, host, value: tag }))
    return { incomplete: 'unguarded open cookie not readable after plant' };
  if (!cookieHit(cookies, { name: planted.parent, host, value: tag }))
    return { incomplete: 'unguarded parent-domain cookie not readable after plant' };
  return {};
}

async function readerCookies(reader, sessionId) {
  const browser = await outcome(reader.send('Storage.getCookies', {}));
  const network = await outcome(reader.send('Network.getAllCookies', {}, sessionId));
  return [...(browser.result?.cookies ?? []), ...(network.result?.cookies ?? [])];
}

async function plantPartitionedCookie(reader, sessionId, { url, name, tag, site }) {
  const base = { name, value: tag, url, path: '/', secure: true, sameSite: 'None' };
  for (const partitionKey of [
    { topLevelSite: site, hasCrossSiteAncestor: true },
    { topLevelSite: site, hasCrossSiteAncestor: false },
    site,
  ]) {
    await outcome(reader.send('Network.setCookie', { ...base, partitionKey }, sessionId));
    const cookies = await readerCookies(reader, sessionId);
    if (
      cookies.some(
        (cookie) => cookie?.name === name && cookie.value === tag && partitionedUnder(cookie, site)
      )
    )
      return true;
  }
  return false;
}

async function plantPartitionedCookies(reader, sessionId, { ordinaryOrigin, host, tag }) {
  const credentialSite = `https://${siteHost(host)}`;
  const partitionedCredential = `cred-part-cookie-${tag}`;
  const partitionedAdobeCom = `adobecom-part-cookie-${tag}`;
  const url = `${ordinaryOrigin}/`;
  return {
    partitionedCredential,
    partitionedCredentialSite: credentialSite,
    partitionedCredentialProven: await plantPartitionedCookie(reader, sessionId, {
      url,
      name: partitionedCredential,
      tag,
      site: credentialSite,
    }),
    partitionedAdobeCom,
    partitionedAdobeComProven: await plantPartitionedCookie(reader, sessionId, {
      url,
      name: partitionedAdobeCom,
      tag,
      site: 'https://adobe.com',
    }),
  };
}

async function tryMethod(client, method, params, session) {
  const out = await outcome(client.send(method, params, session));
  if (unsupported(out)) return { skip: `not-supported:${method}`, out };
  return { out };
}

function cookiesFrom(out) {
  return out?.result?.cookies ?? out?.result ?? [];
}

function emptyCredentialResult() {
  return {
    live: false,
    cookiesPlanted: false,
    storagePlanted: false,
    getCookiesFiltered: false,
    getAllCookiesFiltered: false,
    storageGetCookiesFiltered: false,
    pageGetCookiesFiltered: false,
    partitionedCookieFiltered: false,
    setCookieRefused: false,
    setCookiesRefused: false,
    deleteCookiesRefused: false,
    pageDeleteCookieRefused: false,
    storageSetCookiesRefused: false,
    clearBrowserCookiesSurvived: false,
    storageClearCookiesSurvived: false,
    clearDataForOriginSurvived: false,
    headersStripped: false,
    associatedCookiesStripped: false,
    domStorageRefused: false,
    domStorageSetRefused: false,
    domStorageRemoveRefused: false,
    indexedDBRefused: false,
    indexedDBDeleteRefused: false,
    cacheStorageRefused: false,
    cacheStorageDeleteRefused: false,
    ordinaryCookiesExportable: false,
    adobeComCookiesExportable: false,
    adobeComPartitionedCookieExportable: false,
    partitionedStorageKeyFiltered: false,
    adobeComStorageKeyExportable: false,
    pageDrivable: false,
    evaluateOk: false,
    subHostNotCredential: false,
    residualEvaluateCookie: false,
    skips: [],
  };
}

function unmeasurable(ctx, key, reason, controlWants = false) {
  if (ctx.control && !controlWants) {
    ctx.result[key] = false;
    return;
  }
  ctx.result[key] = 'incomplete';
  ctx.result.skips.push(`${key}: ${reason}`);
}

async function measureDrivability(ctx) {
  const { client, clientSession, planted, tag, result, note } = ctx;
  await outcome(client.send('Page.enable', {}, clientSession));
  await outcome(client.send('Runtime.enable', {}, clientSession));
  await outcome(client.send('Network.enable', {}, clientSession));
  const evalOk = await outcome(
    client.send(
      'Runtime.evaluate',
      {
        expression: `(() => { const i=document.querySelector('input'); const b=document.querySelector('button'); if(i){i.value=${JSON.stringify(tag)}; i.dispatchEvent(new Event('input',{bubbles:true}));} if(b) b.click(); return document.title; })()`,
        returnByValue: true,
      },
      clientSession
    )
  );
  result.evaluateOk = evalOk.ok && typeof evalOk.result?.result?.value === 'string';
  result.pageDrivable = result.evaluateOk && !refused(evalOk);
  const residual = await outcome(
    client.send(
      'Runtime.evaluate',
      {
        expression: `({cookie:document.cookie,ls:(()=>{try{return localStorage.getItem(${JSON.stringify(planted.lsKey)});}catch(e){return null;}})()})`,
        returnByValue: true,
      },
      clientSession
    )
  );
  const residualValue = residual.result?.result?.value;
  result.residualEvaluateCookie =
    residual.ok &&
    typeof residualValue?.cookie === 'string' &&
    residualValue.cookie.includes(planted.open);
  note('drive', {
    evaluateOk: result.evaluateOk,
    pageDrivable: result.pageDrivable,
    residualEvaluateCookie: result.residualEvaluateCookie,
  });
}

function credentialCookieLeaked(cookies, planted, host) {
  return (
    cookieHit(cookies, { name: planted.httpOnly, host }) ||
    cookieHit(cookies, { name: planted.open, host }) ||
    cookieHit(cookies, { name: planted.parent, host }) ||
    (planted.partitionedCredentialProven === true &&
      cookieHit(cookies, { name: planted.partitionedCredential }))
  );
}

async function measureHeaders(ctx) {
  const { client, clientSession, origin, host, tag, planted, until, result } = ctx;
  const start = client.events?.length ?? 0;
  await outcome(
    client.send(
      'Page.navigate',
      { url: `${origin}/credential?n=${encodeURIComponent(tag)}&reload=1` },
      clientSession
    )
  );
  await until(async () => {
    const slice = (client.events ?? []).slice(start);
    return slice.some(
      (event) =>
        event.sessionId === clientSession &&
        (event.method === 'Network.responseReceivedExtraInfo' ||
          event.method === 'Network.requestWillBeSentExtraInfo')
    );
  });
  const events = (client.events ?? [])
    .slice(start)
    .filter((event) => event.sessionId === clientSession);
  const headerLeak = events.some((event) => {
    const headers = event.params?.headers;
    if (headers && typeof headers === 'object') {
      const names = Object.keys(headers).map((name) => name.toLowerCase());
      if (names.includes('cookie') || names.includes('set-cookie')) return true;
    }
    const text = event.params?.headersText;
    return typeof text === 'string' && /^(cookie|set-cookie)\s*:/im.test(text);
  });
  const associatedLeak = events.some((event) =>
    (event.params?.associatedCookies ?? []).some((entry) =>
      credentialCookieLeaked([entry.cookie ?? entry], planted, host)
    )
  );
  const sawExtra = events.some((event) =>
    ['Network.responseReceivedExtraInfo', 'Network.requestWillBeSentExtraInfo'].includes(
      event.method
    )
  );
  if (!sawExtra) {
    unmeasurable(ctx, 'headersStripped', 'Network ExtraInfo events not seen');
    unmeasurable(ctx, 'associatedCookiesStripped', 'Network ExtraInfo events not seen');
    return;
  }
  result.headersStripped = !headerLeak;
  result.associatedCookiesStripped = !associatedLeak;
}

function applyFilteredCookieRead(ctx, key, out) {
  const { result, planted, host } = ctx;
  const cookies = cookiesFrom(out);
  if (refused(out)) result[key] = true;
  else if (out.ok) result[key] = !credentialCookieLeaked(cookies, planted, host);
  else result[key] = false;
  return out.ok ? cookies : [];
}

function storageRefused(out, leaked) {
  if (refused(out)) return true;
  if (!out.ok) return false;
  return !leaked;
}

async function measureCookieReads(ctx) {
  const {
    client,
    clientSession,
    origin,
    ordinaryOrigin,
    ordinaryHost,
    ordinaryCookie,
    adobeComCookie,
    tag,
    planted,
    refusalPrefix,
    result,
    note,
  } = ctx;
  const seen = { measured: 0, credential: false, adobeCom: false };
  const track = (cookies) => {
    seen.measured += 1;
    if (
      planted.partitionedCredentialProven &&
      cookieHit(cookies, { name: planted.partitionedCredential })
    )
      seen.credential = true;
    if (
      planted.partitionedAdobeComProven &&
      cookieHit(cookies, { name: planted.partitionedAdobeCom, value: tag })
    )
      seen.adobeCom = true;
  };
  const markControls = (cookies) => {
    track(cookies);
    if (cookieHit(cookies, { name: ordinaryCookie, host: ordinaryHost, value: tag }))
      result.ordinaryCookiesExportable = true;
    if (cookieHit(cookies, { name: adobeComCookie, host: 'adobe.com', value: tag }))
      result.adobeComCookiesExportable = true;
  };

  const getCookies = await tryMethod(
    client,
    'Network.getCookies',
    { urls: [`${origin}/`, `${ordinaryOrigin}/`, 'https://www.adobe.com/'] },
    clientSession
  );
  if (getCookies.skip) result.skips.push(getCookies.skip);
  else {
    markControls(applyFilteredCookieRead(ctx, 'getCookiesFiltered', getCookies.out));
    if (
      refused(getCookies.out) &&
      !String(getCookies.out.error?.message ?? '').startsWith(refusalPrefix)
    )
      note('getCookies-refusal', getCookies.out.error?.message);
  }

  const getAll = await tryMethod(client, 'Network.getAllCookies', {}, clientSession);
  if (getAll.skip) result.skips.push(getAll.skip);
  else markControls(applyFilteredCookieRead(ctx, 'getAllCookiesFiltered', getAll.out));

  const storageGet = await tryMethod(client, 'Storage.getCookies', {}, undefined);
  if (storageGet.skip) result.skips.push(storageGet.skip);
  else markControls(applyFilteredCookieRead(ctx, 'storageGetCookiesFiltered', storageGet.out));

  const pageGet = await tryMethod(client, 'Page.getCookies', {}, clientSession);
  if (pageGet.skip) result.skips.push(pageGet.skip);
  else track(applyFilteredCookieRead(ctx, 'pageGetCookiesFiltered', pageGet.out));

  if (!result.ordinaryCookiesExportable) {
    const plainOnly = await tryMethod(
      client,
      'Network.getCookies',
      { urls: [`${ordinaryOrigin}/`] },
      clientSession
    );
    if (!plainOnly.skip && plainOnly.out.ok) markControls(cookiesFrom(plainOnly.out));
  }
  if (!result.adobeComCookiesExportable) {
    const adobeOnly = await tryMethod(
      client,
      'Network.getCookies',
      { urls: ['https://www.adobe.com/'] },
      clientSession
    );
    if (!adobeOnly.skip && adobeOnly.out.ok) markControls(cookiesFrom(adobeOnly.out));
  }

  if (!planted.partitionedCredentialProven)
    unmeasurable(
      ctx,
      'partitionedCookieFiltered',
      'cookie partitioned under the credential site not readable on raw leg'
    );
  else if (!seen.measured)
    unmeasurable(ctx, 'partitionedCookieFiltered', 'no cookie read was supported');
  else result.partitionedCookieFiltered = !seen.credential;

  if (!planted.partitionedAdobeComProven)
    unmeasurable(
      ctx,
      'adobeComPartitionedCookieExportable',
      'cookie partitioned under adobe.com not readable on raw leg',
      true
    );
  else result.adobeComPartitionedCookieExportable = seen.adobeCom;
}

async function measureCookieWrites(ctx) {
  const { client, clientSession, origin, tag, planted, result } = ctx;
  const setCookie = await tryMethod(
    client,
    'Network.setCookie',
    { name: `probe-${tag}`, value: 'x', url: `${origin}/`, path: '/' },
    clientSession
  );
  if (setCookie.skip) result.skips.push(setCookie.skip);
  else result.setCookieRefused = refused(setCookie.out) || setCookie.out.result?.success === false;

  const setCookies = await tryMethod(
    client,
    'Network.setCookies',
    { cookies: [{ name: `probe2-${tag}`, value: 'x', url: `${origin}/`, path: '/' }] },
    clientSession
  );
  if (setCookies.skip) result.skips.push(setCookies.skip);
  else result.setCookiesRefused = refused(setCookies.out);

  const del = await tryMethod(
    client,
    'Network.deleteCookies',
    { name: planted.open, url: `${origin}/` },
    clientSession
  );
  const delParent = await tryMethod(
    client,
    'Network.deleteCookies',
    { name: planted.parent, domain: planted.parentDomain, path: '/' },
    clientSession
  );
  if (del.skip || delParent.skip) result.skips.push(del.skip ?? delParent.skip);
  else result.deleteCookiesRefused = refused(del.out) && refused(delParent.out);

  const pageDel = await tryMethod(
    client,
    'Page.deleteCookie',
    { cookieName: planted.open, url: `${origin}/` },
    clientSession
  );
  if (pageDel.skip) result.skips.push(pageDel.skip);
  else result.pageDeleteCookieRefused = refused(pageDel.out);

  const storageSet = await tryMethod(
    client,
    'Storage.setCookies',
    { cookies: [{ name: `probe3-${tag}`, value: 'x', url: `${origin}/`, path: '/' }] },
    undefined
  );
  if (storageSet.skip) result.skips.push(storageSet.skip);
  else result.storageSetCookiesRefused = refused(storageSet.out);
}

async function measureStorageReads(ctx) {
  const { client, clientSession, origin, planted, result } = ctx;
  const dom = await tryMethod(
    client,
    'DOMStorage.getDOMStorageItems',
    { storageId: { securityOrigin: origin, isLocalStorage: true } },
    clientSession
  );
  if (dom.skip) result.skips.push(dom.skip);
  else
    result.domStorageRefused = storageRefused(
      dom.out,
      hasEntry(dom.out.result?.entries, planted.lsKey)
    );

  const idbNames = await tryMethod(
    client,
    'IndexedDB.requestDatabaseNames',
    { securityOrigin: origin },
    clientSession
  );
  if (idbNames.skip) result.skips.push(idbNames.skip);
  else {
    const names = idbNames.out.result?.databaseNames ?? [];
    result.indexedDBRefused = storageRefused(idbNames.out, names.includes(planted.dbName));
  }

  if (!planted.cachePlanted) {
    unmeasurable(
      ctx,
      'cacheStorageRefused',
      'Cache API plant unavailable (secure context required)'
    );
    return;
  }
  const caches = await tryMethod(
    client,
    'CacheStorage.requestCacheNames',
    { securityOrigin: origin },
    clientSession
  );
  if (caches.skip) unmeasurable(ctx, 'cacheStorageRefused', caches.skip);
  else {
    const names = (caches.out.result?.caches ?? []).map(cacheNameOf);
    result.cacheStorageRefused = storageRefused(caches.out, names.includes(planted.cacheName));
  }
}

async function frameSession(ctx, targetId) {
  ctx.frameSessions ??= new Map();
  if (ctx.frameSessions.has(targetId)) return ctx.frameSessions.get(targetId);
  const attach = await outcome(
    ctx.client.send('Target.attachToTarget', { targetId, flatten: true })
  );
  const entry = refused(attach)
    ? { refused: true, out: attach }
    : { id: attach.result?.sessionId ?? null };
  if (entry.id) ctx.internalSessions.add(entry.id);
  ctx.frameSessions.set(targetId, entry);
  return entry;
}

async function partitionSend(ctx, frameTarget, method, params) {
  const first = await tryMethod(ctx.client, method, params, ctx.clientSession);
  if (first.skip || first.out.ok || refused(first.out) || !frameTarget) return first;
  const session = await frameSession(ctx, frameTarget);
  if (session.refused) return { out: session.out };
  if (!session.id) return first;
  return tryMethod(ctx.client, method, params, session.id);
}

async function measurePartitionedStorageKeys(ctx) {
  const { tag, planted, result } = ctx;
  const lsKey = planted.partitionedKey;
  const read = (storageKey, frameTarget) =>
    partitionSend(ctx, frameTarget, 'DOMStorage.getDOMStorageItems', {
      storageId: { storageKey, isLocalStorage: true },
    });

  if (!planted.adobeloginPartitionProven)
    unmeasurable(
      ctx,
      'partitionedStorageKeyFiltered',
      'partitioned storageKey plant not readable on raw leg'
    );
  else {
    const adobelogin = await read(planted.adobeloginStorageKey, planted.adobeloginFrameTarget);
    if (adobelogin.skip) unmeasurable(ctx, 'partitionedStorageKeyFiltered', adobelogin.skip);
    else
      result.partitionedStorageKeyFiltered = storageRefused(
        adobelogin.out,
        hasEntry(adobelogin.out.result?.entries, lsKey)
      );
  }

  if (!planted.adobeComPartitionProven)
    unmeasurable(
      ctx,
      'adobeComStorageKeyExportable',
      'adobe.com partitioned storageKey plant not readable on raw leg',
      true
    );
  else {
    const adobeCom = await read(planted.adobeComStorageKey, planted.adobeComFrameTarget);
    if (adobeCom.skip) unmeasurable(ctx, 'adobeComStorageKeyExportable', adobeCom.skip, true);
    else
      result.adobeComStorageKeyExportable =
        adobeCom.out.ok && hasEntry(adobeCom.out.result?.entries, lsKey, tag);
  }
}

async function measureSubHost(ctx) {
  const { client, clientSession, origin, host, tag, result } = ctx;
  const base = parseURL(origin);
  if (!base) return;
  const subHost = `x.${host}`;
  const subOrigin = `${base.protocol}//${subHost}${base.port ? `:${base.port}` : ''}`;
  const name = `sub-${tag}`;
  const set = await tryMethod(
    client,
    'Network.setCookie',
    { name, value: tag, url: `${subOrigin}/`, path: '/' },
    clientSession
  );
  if (set.skip) {
    result.skips.push(set.skip);
    return;
  }
  if (refused(set.out)) return;
  const get = await tryMethod(
    client,
    'Network.getCookies',
    { urls: [`${subOrigin}/`] },
    clientSession
  );
  if (get.skip) {
    result.skips.push(get.skip);
    return;
  }
  if (refused(get.out) || !get.out.ok) return;
  result.subHostNotCredential = cookieHit(cookiesFrom(get.out), {
    name,
    host: subHost,
    value: tag,
  });
}

async function mutationRefused(attempt, unchanged) {
  if (refused(attempt.out)) return true;
  if (!attempt.out.ok) return false;
  return (await unchanged()) === true;
}

async function measureDomStorageMutations(ctx) {
  const { client, clientSession, reader, readerSession, origin, tag, planted, result } = ctx;
  const originId = { securityOrigin: origin, isLocalStorage: true };
  const probeKey = `cred-probe-${tag}`;
  const originEntries = () => readerEntries(reader, [readerSession], originId);
  const partitioned = planted.adobeloginPartitionProven
    ? {
        storageId: { storageKey: planted.adobeloginStorageKey, isLocalStorage: true },
        frameTarget: planted.adobeloginFrameTarget,
        entries: () =>
          readerEntries(reader, planted.adobeloginReadSessions ?? [undefined], {
            storageKey: planted.adobeloginStorageKey,
            isLocalStorage: true,
          }),
      }
    : null;
  if (!partitioned)
    result.skips.push('domStorageSetRefused: partitioned credential storageKey not proven');

  const originSet = await tryMethod(
    client,
    'DOMStorage.setDOMStorageItem',
    { storageId: originId, key: probeKey, value: tag },
    clientSession
  );
  if (originSet.skip) unmeasurable(ctx, 'domStorageSetRefused', originSet.skip);
  else {
    let setRefused = await mutationRefused(originSet, async () => {
      const entries = await originEntries();
      return entries !== null && !hasEntry(entries, probeKey);
    });
    if (setRefused && partitioned) {
      const keySet = await partitionSend(
        ctx,
        partitioned.frameTarget,
        'DOMStorage.setDOMStorageItem',
        {
          storageId: partitioned.storageId,
          key: probeKey,
          value: tag,
        }
      );
      setRefused =
        !keySet.skip &&
        (await mutationRefused(keySet, async () => {
          const entries = await partitioned.entries();
          return entries !== null && !hasEntry(entries, probeKey);
        }));
    }
    result.domStorageSetRefused = setRefused;
  }

  const originRemove = await tryMethod(
    client,
    'DOMStorage.removeDOMStorageItem',
    { storageId: originId, key: planted.lsKey },
    clientSession
  );
  if (originRemove.skip) unmeasurable(ctx, 'domStorageRemoveRefused', originRemove.skip);
  else {
    let removeRefused = await mutationRefused(originRemove, async () =>
      hasEntry(await originEntries(), planted.lsKey, tag)
    );
    if (removeRefused && partitioned) {
      const keyRemove = await partitionSend(
        ctx,
        partitioned.frameTarget,
        'DOMStorage.removeDOMStorageItem',
        { storageId: partitioned.storageId, key: planted.partitionedKey }
      );
      removeRefused =
        !keyRemove.skip &&
        (await mutationRefused(keyRemove, async () =>
          hasEntry(await partitioned.entries(), planted.partitionedKey, tag)
        ));
    }
    result.domStorageRemoveRefused = removeRefused;
  }
}

async function measureStorageMutations(ctx) {
  const { client, clientSession, reader, readerSession, origin, planted, result } = ctx;
  await measureDomStorageMutations(ctx);

  const idbDelete = await tryMethod(
    client,
    'IndexedDB.deleteDatabase',
    { securityOrigin: origin, databaseName: planted.dbName },
    clientSession
  );
  if (idbDelete.skip) unmeasurable(ctx, 'indexedDBDeleteRefused', idbDelete.skip);
  else
    result.indexedDBDeleteRefused = await mutationRefused(idbDelete, async () =>
      (await readerDatabases(reader, readerSession, origin))?.includes(planted.dbName)
    );

  if (!planted.cachePlanted) {
    unmeasurable(
      ctx,
      'cacheStorageDeleteRefused',
      'Cache API plant unavailable (secure context required)'
    );
    return;
  }
  const listed = await readerCaches(reader, readerSession, origin);
  const cacheId = listed?.find((cache) => cacheNameOf(cache) === planted.cacheName)?.cacheId;
  if (!cacheId) {
    unmeasurable(ctx, 'cacheStorageDeleteRefused', 'planted cache has no cacheId on raw leg');
    return;
  }
  const cacheDelete = await tryMethod(
    client,
    'CacheStorage.deleteCache',
    { cacheId },
    clientSession
  );
  if (cacheDelete.skip) unmeasurable(ctx, 'cacheStorageDeleteRefused', cacheDelete.skip);
  else
    result.cacheStorageDeleteRefused = await mutationRefused(cacheDelete, async () =>
      (await readerCaches(reader, readerSession, origin))
        ?.map(cacheNameOf)
        .includes(planted.cacheName)
    );
}

async function measureGlobalClears(ctx) {
  const { client, clientSession, reader, readerSession, origin, host, tag, planted, result } = ctx;
  for (const [key, method, session] of [
    ['clearBrowserCookiesSurvived', 'Network.clearBrowserCookies', clientSession],
    ['storageClearCookiesSurvived', 'Storage.clearCookies', undefined],
  ]) {
    const replanted = await setCookies(
      reader,
      readerSession,
      credentialCookieParams(planted, origin, tag).filter(([label]) => label !== 'open')
    );
    if (replanted) {
      unmeasurable(ctx, key, `re-plant before clear: ${replanted}`);
      continue;
    }
    const cleared = await tryMethod(client, method, {}, session);
    if (cleared.skip) {
      unmeasurable(ctx, key, cleared.skip);
      continue;
    }
    const all = await outcome(reader.send('Network.getAllCookies', {}, readerSession));
    if (!all.ok) {
      unmeasurable(ctx, key, `unguarded getAllCookies failed: ${all.error?.message ?? 'unknown'}`);
      continue;
    }
    result[key] = survivingCookies(all.result?.cookies, planted, host, tag);
  }
}

async function measureClearDataForOrigin(ctx) {
  const { client, reader, readerSession, origin, host, tag, planted, result } = ctx;
  const replanted = await setCookies(
    reader,
    readerSession,
    credentialCookieParams(planted, origin, tag)
  );
  if (replanted) {
    unmeasurable(ctx, 'clearDataForOriginSurvived', `re-plant cookies before clear: ${replanted}`);
    return;
  }
  const store = await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression: `(async()=>{try{localStorage.setItem(${JSON.stringify(planted.lsKey)},${JSON.stringify(tag)});const open=indexedDB.open(${JSON.stringify(planted.dbName)},1);const db=await new Promise((ok,err)=>{open.onupgradeneeded=()=>open.result.createObjectStore('s');open.onsuccess=()=>ok(open.result);open.onerror=()=>err(open.error);});const tx=db.transaction('s','readwrite');tx.objectStore('s').put(${JSON.stringify(tag)},'k');await new Promise((ok,err)=>{tx.oncomplete=()=>ok(true);tx.onerror=()=>err(tx.error);});db.close();return true;}catch(e){return 'err:'+e.message;}})()`,
        awaitPromise: true,
        returnByValue: true,
      },
      readerSession
    )
  );
  if (!store.ok || store.result?.result?.value !== true) {
    unmeasurable(
      ctx,
      'clearDataForOriginSurvived',
      `re-plant storage before clear: ${store.error?.message ?? JSON.stringify(store.result?.result?.value)}`
    );
    return;
  }
  const cleared = await tryMethod(
    client,
    'Storage.clearDataForOrigin',
    {
      origin,
      storageTypes: 'cookies,local_storage,indexeddb,cache_storage',
    },
    undefined
  );
  if (cleared.skip) {
    unmeasurable(ctx, 'clearDataForOriginSurvived', cleared.skip);
    return;
  }
  if (refused(cleared.out)) {
    result.clearDataForOriginSurvived = true;
    return;
  }
  const all = await outcome(reader.send('Network.getAllCookies', {}, readerSession));
  const cookiesOk = all.ok && survivingCookies(all.result?.cookies, planted, host, tag);
  const lsOk = hasEntry(
    await readerEntries(reader, [readerSession], {
      securityOrigin: origin,
      isLocalStorage: true,
    }),
    planted.lsKey
  );
  const idbOk = (await readerDatabases(reader, readerSession, origin))?.includes(planted.dbName);
  result.clearDataForOriginSurvived = Boolean(cookiesOk && lsOk && idbOk);
}

async function readPartitionedKey(reader, sessions, storageKey, lsKey, tag) {
  return hasEntry(
    await readerEntries(reader, sessions, { storageKey, isLocalStorage: true }),
    lsKey,
    tag
  );
}

async function plantLocalStorage(reader, sessionId, lsKey, tag, contextId) {
  const set = await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression: `(()=>{try{localStorage.setItem(${JSON.stringify(lsKey)},${JSON.stringify(tag)});return localStorage.getItem(${JSON.stringify(lsKey)})===${JSON.stringify(tag)};}catch(e){return 'err:'+e.message;}})()`,
        returnByValue: true,
        ...(contextId ? { contextId } : {}),
      },
      sessionId
    )
  );
  return set.result?.result?.value === true;
}

async function reportedStorageKey(reader, sessions, frameId) {
  for (const session of sessions)
    for (const method of ['Storage.getStorageKeyForFrame', 'Storage.getStorageKey']) {
      const out = await outcome(reader.send(method, { frameId }, session));
      if (typeof out.result?.storageKey === 'string' && out.result.storageKey)
        return out.result.storageKey;
    }
  return null;
}

function partitionCandidates(iframeOrigin, topSite) {
  if (!topSite) return [];
  const sites = [...new Set([topSite, topSite.replace(/^http:/, 'https:')])];
  return sites.flatMap((site) => [
    `${iframeOrigin}/^0${site}^31`,
    `${iframeOrigin}^0${site}^31`,
    `${iframeOrigin}/^0${site}`,
    `${iframeOrigin}^0${site}`,
  ]);
}

async function iframeTarget(reader, before, topId, marker) {
  const matches = (info) =>
    info && info.targetId !== topId && typeof info.url === 'string' && info.url.includes(marker);
  const fromEvents = (reader.events ?? [])
    .slice(before)
    .map((event) => event.params?.targetInfo)
    .find(matches);
  if (fromEvents) return fromEvents;
  const listed = await outcome(reader.send('Target.getTargets', {}));
  return (listed.result?.targetInfos ?? []).find(matches) ?? null;
}

async function plantInChildTarget(reader, target, { lsKey, tag, marker, until }) {
  const childAttach = await outcome(
    reader.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  );
  const childSession = childAttach.result?.sessionId;
  if (!childSession) return { planted: false };
  await outcome(reader.send('Page.enable', {}, childSession));
  await outcome(reader.send('Runtime.enable', {}, childSession));
  await until(() => pageReady(reader, childSession, (value) => value.href.includes(marker)));
  const planted = await plantLocalStorage(reader, childSession, lsKey, tag);
  const tree = await outcome(reader.send('Page.getFrameTree', {}, childSession));
  const frameId = tree.result?.frameTree?.frame?.id ?? target.targetId;
  return {
    planted,
    reportedKey: await reportedStorageKey(reader, [childSession, undefined], frameId),
    sessions: [childSession, undefined],
    frameTarget: target.targetId,
  };
}

async function plantInLocalFrame(reader, topSession, topId, frameId, { lsKey, tag }) {
  const world = await outcome(
    reader.send(
      'Page.createIsolatedWorld',
      { frameId, worldName: `cred-part-${tag}`, grantUniveralAccess: true },
      topSession
    )
  );
  const contextId = world.result?.executionContextId;
  if (!contextId) return { planted: false };
  return {
    planted: await plantLocalStorage(reader, topSession, lsKey, tag, contextId),
    reportedKey: await reportedStorageKey(reader, [topSession, undefined], frameId),
    sessions: [undefined],
    frameTarget: topId,
  };
}

async function plantPartitionedInTop(reader, { topUrl, iframeOrigin, lsKey, tag, until }) {
  await outcome(reader.send('Target.setDiscoverTargets', { discover: true }));
  const created = await outcome(reader.send('Target.createTarget', { url: topUrl }));
  const topId = created.result?.targetId;
  if (!topId) return { ok: false, storageKey: null, reportedKey: null };
  const attach = await outcome(
    reader.send('Target.attachToTarget', { targetId: topId, flatten: true })
  );
  const topSession = attach.result?.sessionId;
  if (!topSession) return { ok: false, storageKey: null, reportedKey: null, topId };
  await outcome(reader.send('Page.enable', {}, topSession));
  await outcome(reader.send('Runtime.enable', {}, topSession));
  const topOrigin = new URL(topUrl).origin;
  await until(() => pageReady(reader, topSession, (value) => value.href.startsWith(topOrigin)));
  const marker = `cred-frame=${encodeURIComponent(tag)}`;
  const src = `${iframeOrigin}/blank?${marker}`;
  const before = reader.events?.length ?? 0;
  await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression: `(()=>{const id='cred-part-frame';let f=document.getElementById(id);if(f)f.remove();f=document.createElement('iframe');f.id=id;f.src=${JSON.stringify(src)};document.body.appendChild(f);return true;})()`,
        returnByValue: true,
      },
      topSession
    )
  );
  let found = null;
  await until(async () => {
    const target = await iframeTarget(reader, before, topId, marker);
    if (target) found = { target };
    else {
      const tree = await outcome(reader.send('Page.getFrameTree', {}, topSession));
      const child = (tree.result?.frameTree?.childFrames ?? []).find((entry) =>
        String(entry.frame?.url ?? '').includes(marker)
      );
      if (child?.frame?.id) found = { frameId: child.frame.id };
    }
    return found !== null;
  });
  let plant = { planted: false };
  if (found?.target)
    plant = await plantInChildTarget(reader, found.target, { lsKey, tag, marker, until });
  else if (found?.frameId) {
    plant = await plantInLocalFrame(reader, topSession, topId, found.frameId, { lsKey, tag });
    if (!plant.planted) {
      let late = null;
      await until(async () => {
        late = await iframeTarget(reader, before, topId, marker);
        return late !== null;
      });
      if (late) plant = await plantInChildTarget(reader, late, { lsKey, tag, marker, until });
    }
  }
  const reportedKey = plant.reportedKey ?? null;
  const fail = { ok: false, storageKey: null, reportedKey, topId };
  if (!plant.planted) return fail;
  const sessions = [...plant.sessions, topSession];
  const proven = { reportedKey, topId, frameTarget: plant.frameTarget, sessions };
  if (reportedKey && (await readPartitionedKey(reader, sessions, reportedKey, lsKey, tag)))
    return { ok: true, storageKey: reportedKey, ...proven };
  for (const storageKey of partitionCandidates(iframeOrigin, siteOf(topUrl))) {
    if (storageKey === reportedKey) continue;
    if (await readPartitionedKey(reader, sessions, storageKey, lsKey, tag))
      return { ok: true, storageKey, ...proven };
  }
  return fail;
}

async function plantPartitionedDirect(reader, sessions, { iframeOrigin, topSite, lsKey, tag }) {
  for (const storageKey of partitionCandidates(iframeOrigin, topSite)) {
    for (const session of sessions)
      await outcome(
        reader.send(
          'DOMStorage.setDOMStorageItem',
          { storageId: { storageKey, isLocalStorage: true }, key: lsKey, value: tag },
          session
        )
      );
    if (await readPartitionedKey(reader, sessions, storageKey, lsKey, tag))
      return { ok: true, storageKey, sessions };
  }
  return { ok: false };
}

async function plantPartitionedStorage(reader, sessionId, { origin, ordinaryOrigin, tag }) {
  const lsKey = `cred-part-${tag}`;
  const until = (check) => waitFor(check, 5000);
  const base = parseURL(ordinaryOrigin);
  const adobeOrigin = `${base.protocol}//adobe.com${base.port ? `:${base.port}` : ''}`;
  const proven = { partitionedKey: lsKey, cleanup: [] };
  for (const [name, topUrl] of [
    ['adobelogin', `${origin}/credential?n=${encodeURIComponent(tag)}&part=1`],
    ['adobeCom', `${adobeOrigin}/blank?n=${encodeURIComponent(tag)}`],
  ]) {
    let planted = await plantPartitionedInTop(reader, {
      topUrl,
      iframeOrigin: ordinaryOrigin,
      lsKey,
      tag,
      until,
    });
    if (planted.topId) proven.cleanup.push(planted.topId);
    if (!planted.ok) {
      const direct = await plantPartitionedDirect(reader, [sessionId, undefined], {
        iframeOrigin: ordinaryOrigin,
        topSite: siteOf(topUrl),
        lsKey,
        tag,
      });
      if (direct.ok) planted = { ...direct, reportedKey: planted.reportedKey, frameTarget: null };
    }
    proven[`${name}PartitionProven`] = planted.ok === true;
    proven[`${name}StorageKey`] = planted.ok ? planted.storageKey : null;
    proven[`${name}ReportedKey`] = planted.reportedKey ?? null;
    proven[`${name}FrameTarget`] = planted.ok ? (planted.frameTarget ?? null) : null;
    proven[`${name}ReadSessions`] = planted.ok ? planted.sessions : [];
  }
  return proven;
}

async function probeCredentialClient(ctx) {
  const { client, internalSessions, targetId, result, note } = ctx;
  const attach = await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }));
  const clientSession = attach.result?.sessionId;
  if (!clientSession || refused(attach)) {
    result.pageDrivable = false;
    note('attach', { refused: refused(attach), error: attach.error?.message });
    return;
  }
  internalSessions.add(clientSession);
  ctx.clientSession = clientSession;
  await measureDrivability(ctx);
  await measureHeaders(ctx);
  await measureCookieReads(ctx);
  await measureCookieWrites(ctx);
  await measureStorageReads(ctx);
  await measurePartitionedStorageKeys(ctx);
  await measureSubHost(ctx);
  if (ctx.control) return;
  await measureStorageMutations(ctx);
  await measureGlobalClears(ctx);
  await measureClearDataForOrigin(ctx);
}

async function closeAll(reader, targetIds) {
  for (const targetId of targetIds) await outcome(reader.send('Target.closeTarget', { targetId }));
}

export async function credentialExport({
  client,
  reader,
  credentialOrigin,
  ordinary,
  tag,
  internalSessions = new Set(),
  notes = [],
  budget = 8000,
  refusalPrefix = 'slicc: refused:',
}) {
  const until = (check) => waitFor(check, budget);
  const result = emptyCredentialResult();
  const note = (label, evidence) => notes.push(`${label}: ${JSON.stringify(evidence)}`);
  if (!reader) return { ...result, incomplete: 'missing unguarded reader' };
  const origin = originOf(credentialOrigin);
  const host = hostOf(credentialOrigin);
  const ordinaryOrigin = originOf(ordinary);
  const ordinaryHost = hostOf(ordinary);
  if (!origin || !host || !ordinaryOrigin)
    return { ...result, incomplete: 'credentialOrigin or ordinary is not a URL' };

  const page = await openPage(
    reader,
    `${origin}/credential?n=${encodeURIComponent(tag)}`,
    notes,
    internalSessions
  );
  if (!page.ok)
    return {
      ...result,
      incomplete: `open credential page: ${page.error?.message ?? 'failed'}`,
    };
  const { targetId, sessionId } = page.result;
  const planted = await plantState(reader, { origin, host, tag, sessionId });
  if (planted.incomplete) {
    await closeAll(reader, [targetId]);
    return { ...result, incomplete: planted.incomplete };
  }
  result.cookiesPlanted = true;
  result.storagePlanted = true;
  result.live = true;
  note('planted', { origin, host, ...planted });

  const ordinaryCookie = `plain-${tag}`;
  await outcome(
    reader.send(
      'Network.setCookie',
      { name: ordinaryCookie, value: tag, url: `${ordinaryOrigin}/`, path: '/' },
      sessionId
    )
  );
  const adobeComCookie = `adobecom-${tag}`;
  await outcome(
    reader.send(
      'Network.setCookie',
      { name: adobeComCookie, value: tag, domain: '.adobe.com', path: '/' },
      sessionId
    )
  );
  Object.assign(
    planted,
    await plantPartitionedCookies(reader, sessionId, { ordinaryOrigin, host, tag })
  );
  Object.assign(
    planted,
    await plantPartitionedStorage(reader, sessionId, { origin, ordinaryOrigin, tag })
  );
  note('partitioned', {
    partitionedCredentialProven: planted.partitionedCredentialProven,
    partitionedAdobeComProven: planted.partitionedAdobeComProven,
    adobeloginPartitionProven: planted.adobeloginPartitionProven,
    adobeloginStorageKey: planted.adobeloginStorageKey,
    adobeloginReportedKey: planted.adobeloginReportedKey,
    adobeComPartitionProven: planted.adobeComPartitionProven,
    adobeComStorageKey: planted.adobeComStorageKey,
    adobeComReportedKey: planted.adobeComReportedKey,
  });

  const ctx = {
    client,
    reader,
    readerSession: sessionId,
    control: client === reader,
    internalSessions,
    targetId,
    origin,
    host,
    ordinaryOrigin,
    ordinaryHost,
    ordinaryCookie,
    adobeComCookie,
    tag,
    planted,
    until,
    refusalPrefix,
    result,
    note,
  };
  try {
    await probeCredentialClient(ctx);
  } finally {
    await closeAll(reader, [...planted.cleanup, targetId]);
  }

  note('result', {
    getCookiesFiltered: result.getCookiesFiltered,
    getAllCookiesFiltered: result.getAllCookiesFiltered,
    partitionedCookieFiltered: result.partitionedCookieFiltered,
    ordinaryCookiesExportable: result.ordinaryCookiesExportable,
    adobeComCookiesExportable: result.adobeComCookiesExportable,
    adobeComPartitionedCookieExportable: result.adobeComPartitionedCookieExportable,
    partitionedStorageKeyFiltered: result.partitionedStorageKeyFiltered,
    adobeComStorageKeyExportable: result.adobeComStorageKeyExportable,
    clearBrowserCookiesSurvived: result.clearBrowserCookiesSurvived,
    storageClearCookiesSurvived: result.storageClearCookiesSurvived,
    clearDataForOriginSurvived: result.clearDataForOriginSurvived,
    pageDrivable: result.pageDrivable,
    skips: result.skips,
  });
  return result;
}
