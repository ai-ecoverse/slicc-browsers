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
      const ready = await waitFor(async () => {
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
        return (
          ev.ok &&
          value?.ready &&
          value.ready !== 'loading' &&
          typeof value.href === 'string' &&
          value.href.includes('/credential') &&
          value.title === 'credential'
        );
      }, 5000);
      if (!ready) throw new Error('credential page did not become ready');
      return { targetId: created.targetId, sessionId };
    })
  );
  if (!opened.ok) return opened;
  internalSessions.add(opened.result.sessionId);
  return opened;
}

async function plantState(reader, { origin, host, tag, sessionId }) {
  const httpOnly = `cred-http-${tag}`;
  const open = `cred-open-${tag}`;
  const setHttp = await outcome(
    reader.send(
      'Network.setCookie',
      {
        name: httpOnly,
        value: tag,
        url: `${origin}/`,
        httpOnly: true,
        path: '/',
      },
      sessionId
    )
  );
  const setOpen = await outcome(
    reader.send(
      'Network.setCookie',
      {
        name: open,
        value: tag,
        url: `${origin}/`,
        httpOnly: false,
        path: '/',
      },
      sessionId
    )
  );
  if (!setHttp.ok || setHttp.result?.success === false)
    return {
      incomplete: `plant HttpOnly cookie failed: ${setHttp.error?.message ?? 'no success'}`,
    };
  if (!setOpen.ok || setOpen.result?.success === false)
    return { incomplete: `plant open cookie failed: ${setOpen.error?.message ?? 'no success'}` };
  const lsKey = `cred-ls-${tag}`;
  const dbName = `cred-db-${tag}`;
  const cacheName = `cred-cache-${tag}`;
  const cacheUrl = `${origin}/cred-cache-${tag}`;
  const planted = await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression: `(async()=>{const localStorageOk=(()=>{try{localStorage.setItem(${JSON.stringify(lsKey)},${JSON.stringify(tag)});return localStorage.getItem(${JSON.stringify(lsKey)})===${JSON.stringify(tag)};}catch(e){return 'err:'+e.message;}})();let idb=false;try{const open=indexedDB.open(${JSON.stringify(dbName)},1);const db=await new Promise((ok,err)=>{open.onupgradeneeded=()=>open.result.createObjectStore('s');open.onsuccess=()=>ok(open.result);open.onerror=()=>err(open.error);});const tx=db.transaction('s','readwrite');tx.objectStore('s').put(${JSON.stringify(tag)},'k');await new Promise((ok,err)=>{tx.oncomplete=()=>ok(true);tx.onerror=()=>err(tx.error);});db.close();idb=true;}catch(e){idb='err:'+e.message;}let cache=false;try{const c=await caches.open(${JSON.stringify(cacheName)});await c.put(${JSON.stringify(cacheUrl)},new Response(${JSON.stringify(tag)}));const m=await c.match(${JSON.stringify(cacheUrl)});cache=m?await m.text():false;}catch(e){cache='err:'+e.message;}return {localStorage:localStorageOk,idb,cache};})()`,
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
  const cachePlanted = value.cache === tag;
  const cacheUnavailable =
    !cachePlanted &&
    (value.cache === false ||
      (typeof value.cache === 'string' &&
        /caches is not defined|Secure contexts|secure context/i.test(value.cache)));
  if (!cachePlanted && !cacheUnavailable)
    return {
      incomplete: `plant cache failed: ${typeof value.cache === 'string' ? value.cache : JSON.stringify(value.cache)}`,
    };
  const all = await outcome(reader.send('Network.getAllCookies', {}, sessionId));
  if (!all.ok)
    return { incomplete: `unguarded getAllCookies failed: ${all.error?.message ?? 'unknown'}` };
  if (!cookieHit(all.result?.cookies, { name: httpOnly, host, value: tag }))
    return { incomplete: 'unguarded HttpOnly cookie not readable after plant' };
  if (!cookieHit(all.result?.cookies, { name: open, host, value: tag }))
    return { incomplete: 'unguarded open cookie not readable after plant' };
  return {
    httpOnly,
    open,
    lsKey,
    dbName,
    cacheName: cachePlanted ? cacheName : null,
    cacheUrl: cachePlanted ? cacheUrl : null,
    cachePlanted,
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
    setCookieRefused: false,
    setCookiesRefused: false,
    deleteCookiesRefused: false,
    pageDeleteCookieRefused: false,
    storageSetCookiesRefused: false,
    headersStripped: false,
    associatedCookiesStripped: false,
    domStorageRefused: false,
    indexedDBRefused: false,
    cacheStorageRefused: false,
    ordinaryCookiesExportable: false,
    adobeComCookiesExportable: false,
    partitionedStorageKeyFiltered: false,
    adobeComStorageKeyExportable: false,
    pageDrivable: false,
    evaluateOk: false,
    subHostNotCredential: false,
    residualEvaluateCookie: false,
    skips: [],
  };
}

async function measureDrivability(client, clientSession, planted, tag, result, note) {
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

async function measureHeaders(
  client,
  clientSession,
  { origin, host, tag, planted, until, result }
) {
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
          event.method === 'Network.requestWillBeSentExtraInfo' ||
          event.method === 'Network.responseReceived')
    );
  });
  const events = (client.events ?? [])
    .slice(start)
    .filter((event) => event.sessionId === clientSession);
  const headerLeak = events.some((event) => {
    const headers = event.params?.headers;
    if (!headers || typeof headers !== 'object') return false;
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    if (!names.includes('cookie') && !names.includes('set-cookie')) return false;
    return true;
  });
  const associatedLeak = events.some((event) =>
    (event.params?.associatedCookies ?? []).some((entry) =>
      cookieHit([entry.cookie ?? entry], { name: planted.httpOnly, host, value: tag })
    )
  );
  const sawExtra = events.some((event) =>
    ['Network.responseReceivedExtraInfo', 'Network.requestWillBeSentExtraInfo'].includes(
      event.method
    )
  );
  result.headersStripped = sawExtra ? !headerLeak : true;
  result.associatedCookiesStripped = sawExtra ? !associatedLeak : true;
  if (!sawExtra) result.skips.push('not-supported:Network.extraInfo');
}

function credentialCookieLeaked(cookies, planted, host, tag) {
  return (
    cookieHit(cookies, { name: planted.httpOnly, host, value: tag }) ||
    cookieHit(cookies, { name: planted.open, host, value: tag })
  );
}

function markOrdinaryExportable(result, cookies, ordinaryCookie, ordinaryHost, tag) {
  if (cookieHit(cookies, { name: ordinaryCookie, host: ordinaryHost, value: tag }))
    result.ordinaryCookiesExportable = true;
}

function markAdobeComExportable(result, cookies, adobeComCookie, tag) {
  if (cookieHit(cookies, { name: adobeComCookie, host: 'adobe.com', value: tag }))
    result.adobeComCookiesExportable = true;
}

function applyFilteredCookieRead(result, key, out, planted, host, tag) {
  const cookies = cookiesFrom(out);
  if (refused(out)) result[key] = true;
  else if (out.ok) result[key] = !credentialCookieLeaked(cookies, planted, host, tag);
  else result[key] = false;
  return cookies;
}

function storageRefused(out, leaked) {
  if (refused(out)) return true;
  if (!out.ok) return false;
  return !leaked;
}

async function measureCookieReads(
  client,
  clientSession,
  {
    origin,
    ordinaryOrigin,
    ordinaryHost,
    ordinaryCookie,
    adobeComCookie,
    host,
    tag,
    planted,
    refusalPrefix,
    result,
    note,
  }
) {
  const markControls = (cookies) => {
    markOrdinaryExportable(result, cookies, ordinaryCookie, ordinaryHost, tag);
    markAdobeComExportable(result, cookies, adobeComCookie, tag);
  };

  const getCookies = await tryMethod(
    client,
    'Network.getCookies',
    { urls: [`${origin}/`, `${ordinaryOrigin}/`, 'https://www.adobe.com/'] },
    clientSession
  );
  if (getCookies.skip) result.skips.push(getCookies.skip);
  else {
    const cookies = applyFilteredCookieRead(
      result,
      'getCookiesFiltered',
      getCookies.out,
      planted,
      host,
      tag
    );
    markControls(cookies);
    if (
      refused(getCookies.out) &&
      !String(getCookies.out.error?.message ?? '').startsWith(refusalPrefix)
    )
      note('getCookies-refusal', getCookies.out.error?.message);
  }

  const getAll = await tryMethod(client, 'Network.getAllCookies', {}, clientSession);
  if (getAll.skip) result.skips.push(getAll.skip);
  else {
    const cookies = applyFilteredCookieRead(
      result,
      'getAllCookiesFiltered',
      getAll.out,
      planted,
      host,
      tag
    );
    markControls(cookies);
  }

  const storageGet = await tryMethod(client, 'Storage.getCookies', {}, undefined);
  if (storageGet.skip) result.skips.push(storageGet.skip);
  else {
    const cookies = applyFilteredCookieRead(
      result,
      'storageGetCookiesFiltered',
      storageGet.out,
      planted,
      host,
      tag
    );
    markControls(cookies);
  }

  const pageGet = await tryMethod(client, 'Page.getCookies', {}, clientSession);
  if (pageGet.skip) result.skips.push(pageGet.skip);
  else applyFilteredCookieRead(result, 'pageGetCookiesFiltered', pageGet.out, planted, host, tag);

  if (!result.ordinaryCookiesExportable) {
    const plainOnly = await tryMethod(
      client,
      'Network.getCookies',
      { urls: [`${ordinaryOrigin}/`] },
      clientSession
    );
    if (!plainOnly.skip && plainOnly.out.ok)
      result.ordinaryCookiesExportable = cookieHit(cookiesFrom(plainOnly.out), {
        name: ordinaryCookie,
        host: ordinaryHost,
        value: tag,
      });
  }
  if (!result.adobeComCookiesExportable) {
    const adobeOnly = await tryMethod(
      client,
      'Network.getCookies',
      { urls: ['https://www.adobe.com/'] },
      clientSession
    );
    if (!adobeOnly.skip && adobeOnly.out.ok)
      markAdobeComExportable(result, cookiesFrom(adobeOnly.out), adobeComCookie, tag);
  }
}

async function measurePartitionedStorageKeys(
  client,
  clientSession,
  { ordinaryOrigin, tag, result }
) {
  const lsKey = `cred-part-${tag}`;
  const adobeloginKey = `${ordinaryOrigin}/^0https://adobelogin.com`;
  const adobeComKey = `${ordinaryOrigin}/^0https://adobe.com`;

  const read = async (storageKey) =>
    tryMethod(
      client,
      'DOMStorage.getDOMStorageItems',
      { storageId: { storageKey, isLocalStorage: true } },
      clientSession
    );

  const adobelogin = await read(adobeloginKey);
  if (adobelogin.skip) result.skips.push(adobelogin.skip);
  else {
    const entries = adobelogin.out.result?.entries ?? [];
    const leaked = entries.some((entry) => entry?.[0] === lsKey && entry?.[1] === tag);
    result.partitionedStorageKeyFiltered = storageRefused(adobelogin.out, leaked);
  }

  const adobeCom = await read(adobeComKey);
  if (adobeCom.skip) result.skips.push(adobeCom.skip);
  else {
    const entries = adobeCom.out.result?.entries ?? [];
    result.adobeComStorageKeyExportable =
      adobeCom.out.ok && entries.some((entry) => entry?.[0] === lsKey && entry?.[1] === tag);
  }
}

async function measureCookieWrites(client, clientSession, { origin, tag, planted, result }) {
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
  if (del.skip) result.skips.push(del.skip);
  else result.deleteCookiesRefused = refused(del.out);

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

async function measureStorageReads(client, clientSession, { origin, tag, planted, result }) {
  const dom = await tryMethod(
    client,
    'DOMStorage.getDOMStorageItems',
    { storageId: { securityOrigin: origin, isLocalStorage: true } },
    clientSession
  );
  if (dom.skip) result.skips.push(dom.skip);
  else {
    const entries = dom.out.result?.entries ?? [];
    const leaked = entries.some((entry) => entry?.[0] === planted.lsKey && entry?.[1] === tag);
    result.domStorageRefused = storageRefused(dom.out, leaked);
  }

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
    result.skips.push('not-supported:CacheStorage');
    result.cacheStorageRefused = true;
    return;
  }
  const caches = await tryMethod(
    client,
    'CacheStorage.requestCacheNames',
    { securityOrigin: origin },
    clientSession
  );
  if (caches.skip) result.skips.push(caches.skip);
  else {
    const names = caches.out.result?.caches?.map((cache) => cache.cacheName ?? cache) ?? [];
    result.cacheStorageRefused = storageRefused(caches.out, names.includes(planted.cacheName));
  }
}

async function measureSubHost(client, clientSession, { origin, host, tag, result }) {
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

async function probeCredentialClient(ctx) {
  const {
    client,
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
  } = ctx;
  const attach = await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }));
  const clientSession = attach.result?.sessionId;
  if (!clientSession || refused(attach)) {
    result.pageDrivable = false;
    note('attach', { refused: refused(attach), error: attach.error?.message });
    return;
  }
  internalSessions.add(clientSession);
  await measureDrivability(client, clientSession, planted, tag, result, note);
  await measureHeaders(client, clientSession, { origin, host, tag, planted, until, result });
  await measureCookieReads(client, clientSession, {
    origin,
    ordinaryOrigin,
    ordinaryHost,
    ordinaryCookie,
    adobeComCookie,
    host,
    tag,
    planted,
    refusalPrefix,
    result,
    note,
  });
  await measureCookieWrites(client, clientSession, { origin, tag, planted, result });
  await measureStorageReads(client, clientSession, { origin, tag, planted, result });
  await measurePartitionedStorageKeys(client, clientSession, { ordinaryOrigin, tag, result });
  await measureSubHost(client, clientSession, { origin, host, tag, result });
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
    await outcome(reader.send('Target.closeTarget', { targetId }));
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
      {
        name: ordinaryCookie,
        value: tag,
        url: `${ordinaryOrigin}/`,
        path: '/',
      },
      sessionId
    )
  );
  const adobeComCookie = `adobecom-${tag}`;
  await outcome(
    reader.send(
      'Network.setCookie',
      {
        name: adobeComCookie,
        value: tag,
        domain: '.adobe.com',
        path: '/',
      },
      sessionId
    )
  );
  const lsKey = `cred-part-${tag}`;
  for (const site of ['https://adobelogin.com', 'https://adobe.com']) {
    await outcome(
      reader.send(
        'DOMStorage.setDOMStorageItem',
        {
          storageId: {
            storageKey: `${ordinaryOrigin}/^0${site}`,
            isLocalStorage: true,
          },
          key: lsKey,
          value: tag,
        },
        sessionId
      )
    );
  }

  await probeCredentialClient({
    client,
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
  });

  note('result', {
    getCookiesFiltered: result.getCookiesFiltered,
    getAllCookiesFiltered: result.getAllCookiesFiltered,
    ordinaryCookiesExportable: result.ordinaryCookiesExportable,
    adobeComCookiesExportable: result.adobeComCookiesExportable,
    partitionedStorageKeyFiltered: result.partitionedStorageKeyFiltered,
    adobeComStorageKeyExportable: result.adobeComStorageKeyExportable,
    pageDrivable: result.pageDrivable,
    skips: result.skips,
  });
  await outcome(reader.send('Target.closeTarget', { targetId }));
  return result;
}
