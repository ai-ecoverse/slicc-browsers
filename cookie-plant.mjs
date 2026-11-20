import { outcome, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const bytesOf = (text) => new TextEncoder().encode(text);
const b64 = (bytes) => {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
};
const b64text = (text) => b64(bytesOf(text));
const fromB64 = (text) =>
  new TextDecoder().decode(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));

function cookieNames(tag) {
  const id = String(tag ?? '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-20);
  const suffix = id || 'x';
  return {
    plant: `cplant${suffix}`,
    ordinary: `oord${suffix}`,
    adobe: `oadobe${suffix}`,
    delete: `sid${suffix}`,
  };
}

function answered(out) {
  if (!out) return false;
  if (out.ok) return true;
  const err = out.error;
  if (err && typeof err.code === 'number') return true;
  const message = String(err?.message ?? err ?? '');
  if (/^slicc: refused:/.test(message)) return true;
  if (/Invalid (parameters|Params)|Invalid request id|continueResponse at Request/i.test(message))
    return true;
  return false;
}

function refused(out) {
  if (!out || out.ok) return false;
  return /^slicc: refused:/.test(String(out.error?.message ?? out.error ?? ''));
}

function sessionCut(out) {
  if (!out || out.ok) return false;
  return /slicc: refused: session cut on protected execution context/i.test(
    String(out.error?.message ?? out.error ?? '')
  );
}

function note(notes, label, evidence) {
  notes.push(`${label}: ${JSON.stringify(evidence)}`);
}

async function pageSnapshot(client, pageSession) {
  if (!pageSession) return { ready: false };
  const ready = await capped(
    outcome(
      client.send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        pageSession
      )
    ),
    800,
    'pageSnapshot'
  );
  const href = await capped(
    outcome(
      client.send(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
        pageSession
      )
    ),
    800,
    'pageSnapshot'
  );
  return {
    ready: ready.ok,
    readyState: ready.result?.result?.value ?? null,
    href: href.ok ? (href.result?.result?.value ?? null) : null,
    readyError: ready.ok ? undefined : String(ready.error?.message ?? ready.error),
    hrefError: href.ok ? undefined : String(href.error?.message ?? href.error),
  };
}

async function serverHitsFor(fixtureLog, url, since) {
  if (typeof fixtureLog !== 'function') return null;
  let entries;
  try {
    entries = await fixtureLog();
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
  if (!Array.isArray(entries)) return { error: 'fixture log not an array' };
  const matched = entries.filter(
    (entry) =>
      Number(entry?.time ?? 0) >= since &&
      (entry?.url === url || String(entry?.url ?? '').startsWith(url))
  );
  const byPath = {};
  for (const entry of entries) {
    if (Number(entry?.time ?? 0) < since) continue;
    let path = entry?.url ?? '';
    try {
      path = new URL(entry.url).pathname;
    } catch {}
    byPath[path] = (byPath[path] ?? 0) + 1;
  }
  return { hits: matched.length, urls: matched.map((e) => e.url), byPath };
}

async function diagnoseIncomplete({
  notes,
  label,
  incomplete,
  url,
  client,
  pageSession,
  from,
  methods,
  pauseMs,
  startedAt,
  legStartedAt,
  fixtureLog,
  ensure,
  trigger,
  firstIncomplete,
}) {
  const elapsedMs = Date.now() - startedAt;
  const legElapsedMs = Date.now() - legStartedAt;
  const page = await pageSnapshot(client, pageSession);
  const since = client.events.slice(from);
  const pauses = pauseEvents(since, 0, url, methods);
  const anyPaused = since.filter((event) => methods.includes(event.method)).length;
  const server = await serverHitsFor(fixtureLog, url, startedAt);
  const evidence = {
    incomplete,
    path: label,
    url,
    elapsedMs,
    legElapsedMs,
    pauseMs,
    ensure: ensure ?? null,
    triggerOk: trigger?.ok ?? null,
    triggerError: trigger?.ok ? undefined : String(trigger?.error?.message ?? trigger?.error ?? ''),
    page,
    pauseHits: pauses.length,
    anyPaused,
    server,
  };
  note(notes, `cookie-plant.${label}`, evidence);
  if (firstIncomplete && !firstIncomplete.noted) {
    firstIncomplete.noted = true;
    note(notes, 'cookie-plant.firstIncomplete', evidence);
  }
  return evidence;
}

function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function cookieHeader(name, value, domain, extra = '', domainAttr = null) {
  const parts = [`${name}=${value}`];
  if (domainAttr) parts.push(domainAttr);
  else if (domain) parts.push(`Domain=${domain}`);
  parts.push('Path=/');
  if (extra) parts.push(extra);
  return parts.join('; ');
}

const hstsPreloaded = (host) => {
  const name = String(host ?? '')
    .toLowerCase()
    .replace(/\.$/, '');
  return (
    name === 'adobe.com' ||
    name.endsWith('.adobe.com') ||
    name === 'adobelogin.com' ||
    name.endsWith('.adobelogin.com')
  );
};

function fixtureOriginFor(templateUrl, host, { insecurePreloaded = false } = {}) {
  try {
    const parsed = new URL(templateUrl);
    const name = host ?? parsed.hostname;
    const port = parsed.port ? `:${parsed.port}` : '';
    const scheme =
      !insecurePreloaded && hstsPreloaded(name) ? 'https:' : (parsed?.protocol ?? 'http:');
    return `${scheme}//${name}${port}`;
  } catch {
    return null;
  }
}

function siteHost(host) {
  const parts = String(host ?? '')
    .toLowerCase()
    .split('.')
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : String(host ?? '').toLowerCase();
}

function binaryHeaders(pairs) {
  const chunks = [];
  for (const { name, value } of pairs) {
    chunks.push(`${name}: ${value}`);
  }
  return b64text(`${chunks.join('\0')}\0`);
}

function rawHttpResponse({ code, phrase, headers, body = '' }) {
  const lines = [`HTTP/1.1 ${code} ${phrase}`];
  for (const { name, value } of headers) lines.push(`${name}: ${value}`);
  lines.push('', body);
  return b64text(lines.join('\r\n'));
}

async function until(check, ms, step = 25) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await pause(step);
  }
}

async function openPage(reader, url, notes, internalSessions) {
  const created = await outcome(
    createObserverTarget(reader, { url }, notes).then(async (result) => {
      const { sessionId } = await reader.send('Target.attachToTarget', {
        targetId: result.targetId,
        flatten: true,
      });
      await reader.send('Page.enable', {}, sessionId);
      await reader.send('Runtime.enable', {}, sessionId);
      await reader.send('Network.enable', {}, sessionId);
      return { targetId: result.targetId, sessionId };
    })
  );
  if (!created.ok) return created;
  internalSessions.add(created.result.sessionId);
  const ready = await waitFor(async () => {
    const read = await outcome(
      reader.send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        created.result.sessionId
      )
    );
    return read.ok && ['interactive', 'complete'].includes(read.result?.result?.value);
  }, 4000);
  note(notes, 'cookie-plant.open', {
    targetId: created.result.targetId,
    url,
    ready: Boolean(ready),
  });
  if (!ready)
    return {
      ok: true,
      result: { incomplete: 'opener page did not become ready', ...created.result },
    };
  return created;
}

async function detectTransport(client, sessionId, notes) {
  const fetchEnable = await capped(
    outcome(
      client.send(
        'Fetch.enable',
        {
          patterns: [
            { urlPattern: '*', requestStage: 'Request' },
            { urlPattern: '*', requestStage: 'Response' },
          ],
        },
        sessionId
      )
    ),
    800,
    'detectTransport'
  );
  if (fetchEnable.ok) {
    note(notes, 'cookie-plant.transport', { kind: 'fetch' });
    return { kind: 'fetch', fetch: true, legacy: false };
  }
  const legacyEnable = await capped(
    outcome(
      client.send('Network.setRequestInterception', { patterns: [{ urlPattern: '*' }] }, sessionId)
    ),
    800,
    'detectTransport'
  );
  if (legacyEnable.ok) {
    note(notes, 'cookie-plant.transport', { kind: 'legacy' });
    return { kind: 'legacy', fetch: false, legacy: true };
  }
  note(notes, 'cookie-plant.transport', {
    kind: null,
    fetchError: String(fetchEnable.error?.message ?? fetchEnable.error),
    legacyError: String(legacyEnable.error?.message ?? legacyEnable.error),
  });
  return { kind: null, fetch: false, legacy: false };
}

async function enableLegacy(client, sessionId) {
  return outcome(
    client.send('Network.setRequestInterception', { patterns: [{ urlPattern: '*' }] }, sessionId)
  );
}

async function disableInterception(client, sessionId, transport) {
  if (transport.fetch) await outcome(client.send('Fetch.disable', {}, sessionId));
  if (transport.legacy)
    await outcome(client.send('Network.setRequestInterception', { patterns: [] }, sessionId));
}

function pauseEvents(events, from, url, methods) {
  return events.slice(from).filter((event) => {
    if (!methods.includes(event.method)) return false;
    const requestUrl = event.params?.request?.url ?? event.params?.request?.urlFragment;
    return requestUrl === url || String(requestUrl ?? '').startsWith(url);
  });
}

async function waitPause(client, from, url, methods, budget) {
  return until(() => {
    const hits = pauseEvents(client.events, from, url, methods);
    return hits.at(-1) ?? null;
  }, budget);
}

async function clearCookie(reader, sessionId, { name, url, domain }) {
  await outcome(
    reader.send(
      'Network.deleteCookies',
      {
        name,
        ...(url ? { url } : {}),
        ...(domain ? { domain } : {}),
      },
      sessionId
    )
  );
  await outcome(
    reader.send('Storage.getCookies', {}).then(async (all) => {
      const cookies = (all?.cookies ?? []).filter(
        (cookie) =>
          cookie.name === name &&
          (!domain ||
            cookie.domain.replace(/^\./, '') === domain.replace(/^\./, '') ||
            cookie.domain === domain)
      );
      if (!cookies.length) return;
      await reader.send('Storage.setCookies', {
        cookies: (all.cookies ?? []).filter((cookie) => !cookies.includes(cookie)),
      });
    })
  );
}

async function readJar(reader, sessionId, { name, domain, value }) {
  const wantDomain = domain.replace(/^\./, '').toLowerCase();
  const match = (cookie) => {
    if (cookie.name !== name) return false;
    const got = String(cookie.domain ?? '')
      .replace(/^\./, '')
      .toLowerCase();
    if (got !== wantDomain && !wantDomain.endsWith(`.${got}`) && !got.endsWith(`.${wantDomain}`))
      return false;
    if (value !== undefined && cookie.value !== value) return false;
    return true;
  };
  let measured = false;
  const storage = await outcome(reader.send('Storage.getCookies', {}));
  if (storage.ok && Array.isArray(storage.result?.cookies)) {
    measured = true;
    const hit = storage.result.cookies.find(match);
    if (hit) return { via: 'Storage.getCookies', cookie: hit };
  }
  const all = await outcome(reader.send('Network.getAllCookies', {}, sessionId));
  if (all.ok && Array.isArray(all.result?.cookies)) {
    measured = true;
    const hit = all.result.cookies.find(match);
    if (hit) return { via: 'Network.getAllCookies', cookie: hit };
  }
  const byUrl = await outcome(
    reader.send(
      'Network.getCookies',
      { urls: [`https://${wantDomain}/`, `http://${wantDomain}/`] },
      sessionId
    )
  );
  if (byUrl.ok && Array.isArray(byUrl.result?.cookies)) {
    measured = true;
    const hit = byUrl.result.cookies.find(match);
    if (hit) return { via: 'Network.getCookies', cookie: hit };
  }
  if (!measured) return { incomplete: 'cookie jar unreadable' };
  return { missing: true };
}

function plantedOf(jar) {
  if (!jar || jar.incomplete) return 'incomplete';
  if (jar.missing) return false;
  return true;
}

async function triggerFetch(client, sessionId, url) {
  return outcome(
    client.send(
      'Runtime.evaluate',
      {
        expression: `fetch(${JSON.stringify(url)},{credentials:'include'}).then(r=>r.status+' '+r.url,e=>'error:'+e)`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId
    )
  );
}

async function triggerNavigate(client, sessionId, url) {
  return outcome(
    client.send(
      'Runtime.evaluate',
      {
        expression: `location.assign(${JSON.stringify(url)})`,
        returnByValue: true,
      },
      sessionId
    )
  );
}

async function capped(promise, ms, label = 'cdp') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, error: { message: `${label} timeout` } }),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function settleTrigger(promise, budget) {
  return capped(
    promise.then(
      (value) => value,
      (error) => ({ ok: false, error: { message: String(error?.message ?? error) } })
    ),
    budget,
    'trigger settle'
  );
}

async function releasePause(client, paused) {
  if (!paused) return { ok: true };
  if (paused.method === 'Fetch.requestPaused' && paused.params?.requestId) {
    return capped(
      outcome(
        client.send(
          'Fetch.failRequest',
          { requestId: paused.params.requestId, errorReason: 'Aborted' },
          paused.sessionId
        )
      ),
      800,
      'releasePause'
    );
  }
  if (paused.method === 'Network.requestIntercepted' && paused.params?.interceptionId) {
    return capped(
      outcome(
        client.send(
          'Network.continueInterceptedRequest',
          { interceptionId: paused.params.interceptionId, errorReason: 'Aborted' },
          paused.sessionId
        )
      ),
      800,
      'releasePause'
    );
  }
  return { ok: true };
}

async function drainPauses(client, from = 0) {
  const seen = new Set();
  for (const event of client.events.slice(from)) {
    if (event.method === 'Fetch.requestPaused' && event.params?.requestId) {
      const key = `fetch:${event.params.requestId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await releasePause(client, event);
    }
    if (event.method === 'Network.requestIntercepted' && event.params?.interceptionId) {
      const key = `legacy:${event.params.interceptionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await releasePause(client, event);
    }
  }
}

async function withPathBudget(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`path timeout: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function pathCeiling(budget) {
  return Math.min(Math.max(budget * 2, 4000), 6000);
}

function cleanupCeiling() {
  return 6000;
}

async function enableFetch(client, pageSession) {
  return capped(
    outcome(
      client.send(
        'Fetch.enable',
        {
          patterns: [
            { urlPattern: '*', requestStage: 'Request' },
            { urlPattern: '*', requestStage: 'Response' },
          ],
        },
        pageSession
      )
    ),
    800,
    'enableFetch'
  );
}

async function ensureInterception(client, pageSession, transport) {
  if (!pageSession || !transport?.kind) return { ok: true };
  if (transport.fetch) return enableFetch(client, pageSession);
  if (transport.legacy) return capped(enableLegacy(client, pageSession), 800, 'enableLegacy');
  return { ok: true };
}

async function reattachClient(handle) {
  const { client, reader, pageTarget, homeUrl, transport, internalSessions, notes } = handle;
  if (!pageTarget) return { ok: false, error: { message: 'missing page target for reattach' } };
  if (reader && handle.readerSession && homeUrl) {
    await capped(
      outcome(reader.send('Page.navigate', { url: homeUrl }, handle.readerSession)),
      800,
      'recover-navigate'
    );
    await pageReady(reader, handle.readerSession, 1000);
  }
  if (handle.pageSession)
    await capped(
      outcome(client.send('Target.detachFromTarget', { sessionId: handle.pageSession })),
      800,
      'recover-detach'
    );
  const attached = await attachClientPage(client, pageTarget, internalSessions);
  if (!attached.pageSession)
    return { ok: false, error: { message: attached.incomplete ?? 'reattach failed' } };
  handle.pageSession = attached.pageSession;
  let enabled = { ok: true };
  if (transport?.fetch) enabled = await enableFetch(client, handle.pageSession);
  else if (transport?.legacy)
    enabled = await capped(enableLegacy(client, handle.pageSession), 800, 'recover-legacy');
  note(notes, 'cookie-plant.recover', {
    pageSession: handle.pageSession,
    enabled: enabled.ok,
    cut: sessionCut(enabled),
  });
  if (sessionCut(enabled)) return enabled;
  return enabled.ok ? { ok: true, pageSession: handle.pageSession } : enabled;
}

async function ensureLiveSession(handle) {
  if (!handle?.pageSession) return { ok: false, error: { message: 'missing page session' } };
  const probe = await capped(
    outcome(
      handle.client.send(
        'Runtime.evaluate',
        { expression: '1', returnByValue: true },
        handle.pageSession
      )
    ),
    800,
    'session-probe'
  );
  if (probe.ok) return { ok: true, pageSession: handle.pageSession };
  return reattachClient(handle);
}

async function ensureInterceptionLive(handle) {
  const live = await ensureLiveSession(handle);
  if (!live.ok) return live;
  const ensure = await ensureInterception(handle.client, handle.pageSession, handle.transport);
  if (ensure.ok) return ensure;
  if (
    !sessionCut(ensure) &&
    !/session with given id not found/i.test(String(ensure.error?.message))
  )
    return ensure;
  const recovered = await reattachClient(handle);
  if (!recovered.ok) return ensure;
  return ensureInterception(handle.client, handle.pageSession, handle.transport);
}

async function cleanupPath({ handle, paused, from, triggerPromise, budget }) {
  const { client, reader, homeUrl, transport, readerSession } = handle;
  await releasePause(client, paused);
  await drainPauses(client, from);
  await settleTrigger(triggerPromise, Math.min(budget, 500));
  await restorePage(client, handle.pageSession, homeUrl, transport, reader, readerSession);
  await ensureLiveSession(handle);
}

function attemptRecord(out, planted) {
  if (!answered(out))
    return {
      answered: 'incomplete',
      refused: 'incomplete',
      planted: 'incomplete',
    };
  return {
    answered: true,
    refused: refused(out),
    planted: planted === 'incomplete' ? 'incomplete' : Boolean(planted),
  };
}

async function fulfillPaused(client, paused, params) {
  const requestId = paused.params.requestId;
  const interceptionId = paused.params.interceptionId;
  if (paused.method === 'Fetch.requestPaused') {
    return outcome(
      client.send(
        'Fetch.fulfillRequest',
        { requestId, responseCode: 200, ...params },
        paused.sessionId
      )
    );
  }
  if (paused.method === 'Network.requestIntercepted') {
    const raw =
      params.rawResponse ??
      rawHttpResponse({
        code: params.responseCode ?? 200,
        phrase: 'OK',
        headers: Array.isArray(params.responseHeaders)
          ? params.responseHeaders
          : Object.entries(params.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
        body: params.body ? fromB64(params.body) : 'planted',
      });
    return outcome(
      client.send(
        'Network.continueInterceptedRequest',
        { interceptionId, rawResponse: raw },
        paused.sessionId
      )
    );
  }
  return { ok: false, error: { message: `unsupported pause ${paused.method}` } };
}

async function pageReady(client, pageSession, ms = 4000) {
  return waitFor(
    async () => {
      const read = await outcome(
        client.send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          pageSession
        )
      );
      return read.ok && ['interactive', 'complete'].includes(read.result?.result?.value);
    },
    ms,
    25,
    true
  );
}

async function restorePage(client, pageSession, homeUrl, transport, reader, readerSession) {
  if (!homeUrl) return { ok: true };
  const wasFetch = Boolean(transport?.fetch);
  const wasLegacy = Boolean(transport?.legacy);
  try {
    if (pageSession)
      await capped(
        disableInterception(client, pageSession, { fetch: true, legacy: true }),
        800,
        'disable'
      );
    if (reader && readerSession)
      await capped(
        disableInterception(reader, readerSession, { fetch: true, legacy: true }),
        800,
        'disable'
      );
    const navClient = reader ?? client;
    const navSession = readerSession ?? pageSession;
    if (!navSession) return { ok: true };
    await capped(
      outcome(navClient.send('Page.navigate', { url: homeUrl }, navSession)),
      800,
      'navigate'
    );
    await pageReady(navClient, navSession, 1000);
  } finally {
    if (pageSession && wasFetch) await enableFetch(client, pageSession);
    else if (pageSession && wasLegacy)
      await capped(enableLegacy(client, pageSession), 800, 'reenable');
  }
  return { ok: true };
}

async function finishPlant({ reader, readerSession, out, cookie, notes, label }) {
  const jar = await capped(readJar(reader, readerSession, cookie), 1500, 'readJar');
  const planted = plantedOf(
    jar?.error?.message?.includes('timeout') ? { incomplete: 'cookie jar unreadable' } : jar
  );
  const evidence = {
    answered: answered(out),
    refused: refused(out),
    planted,
    via: jar?.via,
    jarIncomplete: jar?.incomplete,
  };
  if (planted === false && answered(out) && !refused(out) && CHROME_NO_STORE.has(label))
    evidence.note = 'Chrome does not store it: not a plant path';
  else if (planted === true && CHROME_NO_STORE.has(label))
    evidence.note = 'raw leg stored it: plant path';
  note(notes, `cookie-plant.${label}`, evidence);
  return attemptRecord(out, planted);
}

function scoreProtectedPlant({ pauseCount, fixtureHits, planted, pageHref, notes, label }) {
  const href = pageHref == null ? null : String(pageHref);
  const errorPage =
    typeof href === 'string' &&
    (/^chrome-error:/i.test(href) ||
      /chromewebdata/i.test(href) ||
      /data:text\/html.*blocked/i.test(href));
  const loadBlocked =
    fixtureHits === 'incomplete' ? 'incomplete' : fixtureHits === 0 || errorPage === true;
  const evidence = {
    pauseCount,
    fixtureHits,
    planted,
    pageHref: href,
    loadBlocked,
  };
  if (
    planted === 'incomplete' ||
    pauseCount === 'incomplete' ||
    fixtureHits === 'incomplete' ||
    loadBlocked === 'incomplete'
  ) {
    note(notes, `cookie-plant.${label}`, {
      ...evidence,
      incomplete: 'protected plant evidence incomplete',
    });
    return {
      answered: 'incomplete',
      refused: 'incomplete',
      planted: 'incomplete',
    };
  }
  if (planted === true) {
    note(notes, `cookie-plant.${label}`, {
      ...evidence,
      answered: true,
      refused: pauseCount > 0,
    });
    return { answered: true, refused: pauseCount > 0, planted: true };
  }
  if (pauseCount === 0 && loadBlocked === true && planted === false) {
    note(notes, `cookie-plant.${label}`, {
      ...evidence,
      answered: true,
      refused: true,
    });
    return { answered: true, refused: true, planted: false };
  }
  note(notes, `cookie-plant.${label}`, {
    ...evidence,
    incomplete: 'protected plant evidence incomplete',
  });
  return {
    answered: 'incomplete',
    refused: 'incomplete',
    planted: 'incomplete',
  };
}

async function fixtureHitsFor(fixtureLog, url, since, tag) {
  if (typeof fixtureLog !== 'function') return 'incomplete';
  let entries;
  try {
    entries = await fixtureLog();
  } catch {
    return 'incomplete';
  }
  if (!Array.isArray(entries)) return 'incomplete';
  const needle = tag ? String(tag) : '';
  const matched = entries.filter((entry) => {
    if (Number(entry?.time ?? 0) < since) return false;
    const hit = String(entry?.url ?? '');
    if (!(hit === url || hit.startsWith(url) || (url && hit.startsWith(String(url).split('?')[0]))))
      return false;
    if (!needle) return true;
    return hit.includes(needle);
  });
  return matched.length;
}

async function recordSessionCut({ reader, readerSession, cookie, notes, label }) {
  return finishPlant({
    reader,
    readerSession,
    out: {
      ok: false,
      error: { message: 'slicc: refused: session cut on protected execution context' },
    },
    cookie,
    notes,
    label,
  });
}

async function runPlantBody({
  handle,
  url,
  cookie,
  build,
  budget,
  notes,
  label,
  stage,
  topLevel,
  fixtureLog,
  legAt,
  firstIncomplete,
  from,
  pauseMs,
  startedAt,
  state,
}) {
  const { client, reader, readerSession, transport } = handle;
  await capped(clearCookie(reader, readerSession, cookie), 800, 'clearCookie');
  const ensure = await ensureInterceptionLive(handle);
  const pageSession = handle.pageSession;
  if (sessionCut(ensure)) return recordSessionCut({ reader, readerSession, cookie, notes, label });
  if (!ensure.ok) {
    await diagnoseIncomplete({
      notes,
      label,
      incomplete: String(ensure.error?.message ?? 'ensure failed'),
      url,
      client,
      pageSession,
      from,
      methods:
        transport.kind === 'legacy' ? ['Network.requestIntercepted'] : ['Fetch.requestPaused'],
      pauseMs,
      startedAt,
      legStartedAt: legAt,
      fixtureLog,
      ensure,
      trigger: null,
      firstIncomplete,
    });
    return attemptRecord(
      { ok: false, error: ensure.error ?? { message: 'ensure failed' } },
      'incomplete'
    );
  }
  const methods =
    transport.kind === 'legacy' ? ['Network.requestIntercepted'] : ['Fetch.requestPaused'];
  state.triggerPromise = topLevel
    ? triggerNavigate(client, pageSession, url)
    : triggerFetch(client, pageSession, url);
  state.paused = await waitPause(client, from, url, methods, pauseMs);
  if (!state.paused) {
    const trigger = await settleTrigger(state.triggerPromise, Math.min(budget, 500));
    state.triggerPromise = Promise.resolve(trigger);
    await diagnoseIncomplete({
      notes,
      label,
      incomplete: 'no pause',
      url,
      client,
      pageSession,
      from,
      methods,
      pauseMs,
      startedAt,
      legStartedAt: legAt,
      fixtureLog,
      ensure,
      trigger,
      firstIncomplete,
    });
    return attemptRecord({ ok: false, error: { message: 'timeout: no pause' } }, 'incomplete');
  }
  if (
    transport.kind === 'fetch' &&
    stage === 'Response' &&
    state.paused.params?.responseStatusCode === undefined &&
    state.paused.params?.responseErrorReason === undefined
  ) {
    const responseFrom = client.events.length;
    await capped(
      outcome(
        client.send(
          'Fetch.continueRequest',
          { requestId: state.paused.params.requestId },
          state.paused.sessionId
        )
      ),
      800,
      'continueRequest'
    );
    const again = await waitPause(client, responseFrom, url, methods, pauseMs);
    if (!again) {
      const trigger = await settleTrigger(state.triggerPromise, Math.min(budget, 500));
      state.triggerPromise = Promise.resolve(trigger);
      await diagnoseIncomplete({
        notes,
        label,
        incomplete: 'no response pause',
        url,
        client,
        pageSession,
        from: responseFrom,
        methods,
        pauseMs,
        startedAt,
        legStartedAt: legAt,
        fixtureLog,
        ensure,
        trigger,
        firstIncomplete,
      });
      return attemptRecord(
        { ok: false, error: { message: 'timeout: no response pause' } },
        'incomplete'
      );
    }
    state.paused = again;
  }
  const out = await capped(build(state.paused).send(client, state.paused), 1500, 'plant-send');
  if (sessionCut(out)) return recordSessionCut({ reader, readerSession, cookie, notes, label });
  return finishPlant({ reader, readerSession, out, cookie, notes, label });
}

async function runGuardedProtectedPlantBody({
  handle,
  url,
  cookie,
  build,
  budget,
  notes,
  label,
  topLevel,
  fixtureLog,
  tag,
  from,
  pauseMs,
  startedAt,
  state,
}) {
  const { client, reader, readerSession, transport } = handle;
  await capped(clearCookie(reader, readerSession, cookie), 800, 'clearCookie');
  const methods =
    transport.kind === 'legacy' ? ['Network.requestIntercepted'] : ['Fetch.requestPaused'];
  state.triggerPromise = topLevel
    ? triggerNavigate(client, handle.pageSession, url)
    : triggerFetch(client, handle.pageSession, url);
  state.paused = await waitPause(client, from, url, methods, pauseMs);
  if (state.paused) {
    const out = await capped(build(state.paused).send(client, state.paused), 1500, 'plant-send');
    if (sessionCut(out)) return recordSessionCut({ reader, readerSession, cookie, notes, label });
    const plantedAttempt = await finishPlant({
      reader,
      readerSession,
      out,
      cookie,
      notes,
      label,
    });
    if (plantedAttempt.planted === true) return plantedAttempt;
    const page = await pageSnapshot(client, handle.pageSession);
    const fixtureHits = await fixtureHitsFor(fixtureLog, url, startedAt, tag);
    return scoreProtectedPlant({
      pauseCount: pauseEvents(client.events, from, url, methods).length,
      fixtureHits,
      planted: plantedAttempt.planted,
      pageHref: page.href,
      notes,
      label,
    });
  }
  const settled = await settleTrigger(state.triggerPromise, Math.min(budget, 500));
  const hung =
    settled &&
    settled.ok === false &&
    /trigger settle timeout/i.test(String(settled.error?.message ?? ''));
  if (hung) handle.evidenceIncomplete = true;
  const page = await pageSnapshot(client, handle.pageSession);
  const fixtureHits = await fixtureHitsFor(fixtureLog, url, startedAt, tag);
  const jar = await capped(readJar(reader, readerSession, cookie), 1500, 'readJar');
  const planted = plantedOf(
    jar?.error?.message?.includes('timeout') ? { incomplete: 'cookie jar unreadable' } : jar
  );
  if (planted === 'incomplete') handle.evidenceIncomplete = true;
  return scoreProtectedPlant({
    pauseCount: hung ? 'incomplete' : pauseEvents(client.events, from, url, methods).length,
    fixtureHits: hung ? 'incomplete' : fixtureHits,
    planted: hung ? 'incomplete' : planted,
    pageHref: page.href,
    notes,
    label,
  });
}

async function runPlant({
  handle,
  url,
  cookie,
  build,
  budget,
  notes,
  label,
  stage = 'Request',
  topLevel = true,
  fixtureLog,
  legStartedAt,
  firstIncomplete,
  protectedBlock = false,
  tag,
}) {
  const { client, transport } = handle;
  const state = { paused: null, triggerPromise: Promise.resolve() };
  const from = client.events.length;
  const pauseMs = Math.min(budget, protectedBlock ? 1200 : 2000);
  const startedAt = Date.now();
  const legAt = legStartedAt ?? startedAt;
  try {
    return await withPathBudget(
      protectedBlock
        ? runGuardedProtectedPlantBody({
            handle,
            url,
            cookie,
            build,
            budget,
            notes,
            label,
            topLevel,
            fixtureLog,
            tag,
            from,
            pauseMs,
            startedAt,
            state,
          })
        : runPlantBody({
            handle,
            url,
            cookie,
            build,
            budget,
            notes,
            label,
            stage,
            topLevel,
            fixtureLog,
            legAt,
            firstIncomplete,
            from,
            pauseMs,
            startedAt,
            state,
          }),
      pathCeiling(budget),
      label
    );
  } catch (error) {
    if (sessionCut({ ok: false, error }))
      return recordSessionCut({
        reader: handle.reader,
        readerSession: handle.readerSession,
        cookie,
        notes,
        label,
      });
    if (protectedBlock) {
      const page = await pageSnapshot(client, handle.pageSession);
      const fixtureHits = await fixtureHitsFor(fixtureLog, url, startedAt, tag);
      const jar = await capped(
        readJar(handle.reader, handle.readerSession, cookie),
        1500,
        'readJar'
      );
      const planted = plantedOf(
        jar?.error?.message?.includes('timeout') ? { incomplete: 'cookie jar unreadable' } : jar
      );
      return scoreProtectedPlant({
        pauseCount: 'incomplete',
        fixtureHits,
        planted,
        pageHref: page.href,
        notes,
        label,
      });
    }
    await diagnoseIncomplete({
      notes,
      label,
      incomplete: String(error?.message ?? error),
      url,
      client,
      pageSession: handle.pageSession,
      from,
      methods:
        transport?.kind === 'legacy' ? ['Network.requestIntercepted'] : ['Fetch.requestPaused'],
      pauseMs,
      startedAt,
      legStartedAt: legAt,
      fixtureLog,
      ensure: null,
      trigger: null,
      firstIncomplete,
    });
    return attemptRecord(
      { ok: false, error: { message: String(error?.message ?? error) } },
      'incomplete'
    );
  } finally {
    try {
      await withPathBudget(
        cleanupPath({
          handle,
          paused: state.paused,
          from,
          triggerPromise: state.triggerPromise,
          budget,
        }),
        cleanupCeiling(),
        `${label}:cleanup`
      );
    } catch (error) {
      note(notes, `cookie-plant.${label}`, {
        cleanup: String(error?.message ?? error),
      });
    }
  }
}

function fetchFulfill(params) {
  return {
    send: (client, paused) =>
      outcome(
        client.send(
          'Fetch.fulfillRequest',
          {
            requestId: paused.params.requestId,
            responseCode: params.responseCode ?? 200,
            ...params,
          },
          paused.sessionId
        )
      ),
  };
}

function fetchContinueResponse(params) {
  return {
    send: (client, paused) =>
      outcome(
        client.send(
          'Fetch.continueResponse',
          {
            requestId: paused.params.requestId,
            responseCode: params.responseCode ?? paused.params.responseStatusCode ?? 200,
            ...params,
          },
          paused.sessionId
        )
      ),
  };
}

function legacyContinue(params) {
  return {
    send: (client, paused) =>
      outcome(
        client.send(
          'Network.continueInterceptedRequest',
          {
            interceptionId: paused.params.interceptionId,
            ...params,
          },
          paused.sessionId
        )
      ),
  };
}

function flattenAttempt(prefix, attempt) {
  const out = {
    [`${prefix}Answered`]: attempt.answered,
    [`${prefix}Refused`]: attempt.refused,
    [`${prefix}Planted`]: attempt.planted,
  };
  if (attempt.cleared !== undefined) out[`${prefix}Cleared`] = attempt.cleared;
  return out;
}

async function proveDoor({
  reader,
  sessionId,
  protectedOrigin,
  homeUrl,
  tag,
  budget,
  notes,
  transport,
  plantName,
}) {
  let paused = null;
  let triggerPromise = Promise.resolve();
  const from = reader.events.length;
  const host = hostOf(protectedOrigin);
  const domain = `.${host}`;
  const url = `${protectedOrigin}/data?n=door-${tag}`;
  const cookie = {
    name: plantName,
    value: `door-${tag}`,
    domain,
    url: `${protectedOrigin}/`,
  };
  try {
    return await withPathBudget(
      (async () => {
        await capped(clearCookie(reader, sessionId, cookie), 800, 'door-clear');
        if (transport.kind === 'fetch') {
          await capped(
            outcome(
              reader.send(
                'Fetch.enable',
                {
                  patterns: [
                    { urlPattern: '*', requestStage: 'Request' },
                    { urlPattern: '*', requestStage: 'Response' },
                  ],
                },
                sessionId
              )
            ),
            800,
            'door-enable'
          );
        } else {
          await capped(enableLegacy(reader, sessionId), 800, 'door-enable');
        }
        triggerPromise = triggerNavigate(reader, sessionId, url);
        const methods =
          transport.kind === 'legacy' ? ['Network.requestIntercepted'] : ['Fetch.requestPaused'];
        paused = await waitPause(reader, from, url, methods, Math.min(budget, 2000));
        if (!paused) {
          return { live: false, incomplete: 'raw leg: no pause for top-level plant navigation' };
        }
        const setCookie = cookieHeader(plantName, cookie.value, domain);
        const out = await capped(
          fulfillPaused(reader, paused, {
            responseCode: 200,
            responseHeaders: [
              { name: 'content-type', value: 'text/plain' },
              { name: 'Set-Cookie', value: setCookie },
            ],
            body: b64text(`door-${tag}`),
          }),
          1500,
          'door-fulfill'
        );
        if (refused(out) || !out.ok) await releasePause(reader, paused);
        await settleTrigger(triggerPromise, Math.min(budget, 500));
        const jar = await capped(readJar(reader, sessionId, cookie), 1500, 'door-jar');
        const planted = plantedOf(
          jar?.error?.message?.includes('timeout') ? { incomplete: 'cookie jar unreadable' } : jar
        );
        note(notes, 'cookie-plant.door', {
          answered: answered(out),
          planted,
          via: jar?.via,
          domain,
        });
        await capped(clearCookie(reader, sessionId, cookie), 800, 'door-clear');
        if (!answered(out))
          return { live: false, incomplete: `raw leg: fulfill unanswered: ${out.error?.message}` };
        if (planted === 'incomplete')
          return { live: false, incomplete: 'raw leg: cookie jar unreadable after plant' };
        if (!planted)
          return {
            live: false,
            incomplete: 'raw leg: Chrome did not store Domain=.<protected host> Set-Cookie',
          };
        return { live: true, doorVia: jar.via };
      })(),
      Math.min(Math.max(budget * 3, 8000), 12000),
      'door'
    );
  } catch (error) {
    note(notes, 'cookie-plant.door', { incomplete: String(error?.message ?? error) });
    return { live: false, incomplete: `raw leg: ${String(error?.message ?? error)}` };
  } finally {
    try {
      await withPathBudget(
        (async () => {
          await releasePause(reader, paused);
          await drainPauses(reader, from);
          await settleTrigger(triggerPromise, Math.min(budget, 500));
          await capped(disableInterception(reader, sessionId, transport), 800, 'door-disable');
          await capped(restorePage(reader, sessionId, homeUrl), 1500, 'door-restore');
        })(),
        cleanupCeiling(),
        'door:cleanup'
      );
    } catch (error) {
      note(notes, 'cookie-plant.door', { cleanup: String(error?.message ?? error) });
    }
  }
}

const EMPTY_ATTEMPT = {
  answered: 'incomplete',
  refused: 'incomplete',
  planted: 'incomplete',
};

const FETCH_PATH_NAMES = [
  'fulfillArray',
  'fulfillObject',
  'fulfillLower',
  'fulfillSetCookie2',
  'fulfillNewline',
  'fulfillBinary',
  'continueResponse',
  'redirect3xx',
  'binaryLf',
  'binaryObsFold',
  'domainQuoted',
  'domainUpper',
  'domainTrailDot',
  'domainRepeated',
  'domainWs',
  'headerPadded',
  'setCookieSecond',
  'responsePhrase',
  'continueAtRequest',
];

const CREDENTIAL_PATH_NAMES = ['hostOnly', 'domainCover', 'subHost'];

const ALL_PATH_NAMES = [
  ...FETCH_PATH_NAMES,
  ...CREDENTIAL_PATH_NAMES,
  'legacyHeaders',
  'legacyRaw',
  'ordinary',
  'deletion',
  'adobe',
];

const CHROME_NO_STORE = new Set([
  'fulfillObject',
  'fulfillSetCookie2',
  'fulfillNewline',
  'continueResponse',
  'binaryLf',
  'binaryObsFold',
  'domainQuoted',
  'domainUpper',
  'domainTrailDot',
  'domainRepeated',
  'domainWs',
  'headerPadded',
  'setCookieSecond',
  'responsePhrase',
  'continueAtRequest',
  'hostOnly',
]);

function incompletePaths() {
  return Object.fromEntries(
    ALL_PATH_NAMES.flatMap((name) => [
      [`${name}Answered`, 'incomplete'],
      [`${name}Refused`, 'incomplete'],
      [`${name}Planted`, 'incomplete'],
    ])
  );
}

function plantCtx(fields) {
  return { ...fields };
}

function fetchAttackSpecs(ctx, header, bareDomain) {
  const v = (prefix) => `${prefix}-${ctx.tag}`;
  const set = (name, value) => [
    { name: 'content-type', value: 'text/plain' },
    { name, value },
  ];
  return [
    {
      label: 'fulfillArray',
      value: ctx.plantCookie.value,
      build: () =>
        fetchFulfill({
          responseHeaders: set('Set-Cookie', header(ctx.plantCookie.value)),
          body: b64text('ok'),
        }),
    },
    {
      label: 'fulfillObject',
      value: v('obj'),
      build: () =>
        fetchFulfill({
          responseHeaders: { 'content-type': 'text/plain', 'Set-Cookie': header(v('obj')) },
          body: b64text('ok'),
        }),
    },
    {
      label: 'fulfillLower',
      value: v('low'),
      build: () =>
        fetchFulfill({
          responseHeaders: set('set-cookie', header(v('low'))),
          body: b64text('ok'),
        }),
    },
    {
      label: 'fulfillSetCookie2',
      value: v('sc2'),
      build: () =>
        fetchFulfill({
          responseHeaders: set('Set-Cookie2', header(v('sc2'))),
          body: b64text('ok'),
        }),
    },
    {
      label: 'fulfillNewline',
      value: v('nl'),
      build: () =>
        fetchFulfill({
          responseHeaders: set(
            'Set-Cookie',
            `${header(v('nl'))}\n${cookieHeader(`${ctx.names.plant}o`, '1', ctx.domain)}`
          ),
          body: b64text('ok'),
        }),
    },
    {
      label: 'fulfillBinary',
      value: v('bin'),
      build: () =>
        fetchFulfill({
          binaryResponseHeaders: binaryHeaders(set('Set-Cookie', header(v('bin')))),
          body: b64text('ok'),
        }),
    },
    {
      label: 'continueResponse',
      value: v('cr'),
      stage: 'Response',
      build: () =>
        fetchContinueResponse({
          responseHeaders: set('Set-Cookie', header(v('cr'))),
        }),
    },
    {
      label: 'redirect3xx',
      value: v('rx'),
      build: () =>
        fetchFulfill({
          responseCode: 302,
          responseHeaders: [
            { name: 'Location', value: `${ctx.plantOrigin}/doc?n=redir-${ctx.tag}` },
            { name: 'Set-Cookie', value: header(v('rx')) },
          ],
          body: b64text(''),
        }),
    },
    {
      label: 'binaryLf',
      value: v('blf'),
      build: () =>
        fetchFulfill({
          binaryResponseHeaders: binaryHeaders([
            { name: 'X-A', value: `1\nSet-Cookie: ${header(v('blf'))}` },
            { name: 'content-type', value: 'text/plain' },
          ]),
          body: b64text('ok'),
        }),
    },
    {
      label: 'binaryObsFold',
      value: v('bof'),
      build: () =>
        fetchFulfill({
          binaryResponseHeaders: b64text(
            `content-type: text/plain\0Set-Cookie: ${ctx.names.plant}=${v('bof')}\r\n Domain=${ctx.domain}; Path=/\0`
          ),
          body: b64text('ok'),
        }),
    },
    {
      label: 'domainQuoted',
      value: v('dq'),
      build: () =>
        fetchFulfill({
          responseHeaders: set('Set-Cookie', header(v('dq'), ctx.domain, `Domain="${bareDomain}"`)),
          body: b64text('ok'),
        }),
    },
    {
      label: 'domainUpper',
      value: v('du'),
      build: () =>
        fetchFulfill({
          responseHeaders: set('Set-Cookie', header(v('du'), ctx.domain, `DOMAIN=${ctx.domain}`)),
          body: b64text('ok'),
        }),
    },
    {
      label: 'domainTrailDot',
      value: v('dtd'),
      build: () =>
        fetchFulfill({
          responseHeaders: set('Set-Cookie', header(v('dtd'), ctx.domain, `Domain=${bareDomain}.`)),
          body: b64text('ok'),
        }),
    },
    {
      label: 'domainRepeated',
      value: v('dr'),
      build: () =>
        fetchFulfill({
          responseHeaders: set(
            'Set-Cookie',
            `${ctx.names.plant}=${v('dr')}; Domain=example.invalid; Domain=${ctx.domain}; Path=/`
          ),
          body: b64text('ok'),
        }),
    },
    {
      label: 'domainWs',
      value: v('dws'),
      build: () =>
        fetchFulfill({
          responseHeaders: set(
            'Set-Cookie',
            header(v('dws'), ctx.domain, `Domain = ${ctx.domain}`)
          ),
          body: b64text('ok'),
        }),
    },
    {
      label: 'headerPadded',
      value: v('hp'),
      build: () =>
        fetchFulfill({
          responseHeaders: set('Set-Cookie\t', header(v('hp'))),
          body: b64text('ok'),
        }),
    },
    {
      label: 'setCookieSecond',
      value: v('sc2nd'),
      build: () =>
        fetchFulfill({
          responseHeaders: [
            { name: 'content-type', value: 'text/plain' },
            { name: 'X-Other', value: '1' },
            { name: 'Set-Cookie', value: header(v('sc2nd')) },
          ],
          body: b64text('ok'),
        }),
    },
    {
      label: 'responsePhrase',
      value: v('rp'),
      build: () =>
        fetchFulfill({
          responseCode: 200,
          responsePhrase: `OK\r\nSet-Cookie: ${header(v('rp'))}`,
          responseHeaders: [{ name: 'content-type', value: 'text/plain' }],
          body: b64text('ok'),
        }),
    },
    {
      label: 'continueAtRequest',
      value: v('car'),
      stage: 'Request',
      build: () =>
        fetchContinueResponse({
          responseCode: 200,
          responseHeaders: set('Set-Cookie', header(v('car'))),
        }),
    },
  ];
}

function fetchAttacks(ctx) {
  if (!ctx.transport.fetch) return null;
  const base = {
    handle: ctx.handle,
    url: ctx.plantUrl,
    budget: ctx.budget,
    notes: ctx.notes,
    topLevel: true,
    fixtureLog: ctx.fixtureLog,
    legStartedAt: ctx.legStartedAt,
    firstIncomplete: ctx.firstIncomplete,
    protectedBlock: Boolean(ctx.guardedProtected),
    tag: ctx.tag,
  };
  const header = (value, domain = ctx.domain, domainAttr = null) =>
    cookieHeader(ctx.names.plant, value, domain, '', domainAttr);
  const bareDomain = ctx.domain.replace(/^\./, '');
  const out = {};
  for (const spec of fetchAttackSpecs(ctx, header, bareDomain)) {
    out[spec.label] = () =>
      runPlant({
        ...base,
        cookie: {
          ...ctx.plantCookie,
          value: spec.value,
          ...(spec.label === 'fulfillArray' ? {} : {}),
        },
        label: spec.label,
        stage: spec.stage ?? 'Request',
        build: spec.build,
      });
  }
  return out;
}

async function withLegacyOnly(handle, transport, run) {
  const session = () => handle.pageSession;
  if (transport.fetch) await outcome(handle.client.send('Fetch.disable', {}, session()));
  await enableLegacy(handle.client, session());
  try {
    return await run();
  } finally {
    if (transport.fetch) {
      await outcome(
        handle.client.send(
          'Fetch.enable',
          {
            patterns: [
              { urlPattern: '*', requestStage: 'Request' },
              { urlPattern: '*', requestStage: 'Response' },
            ],
          },
          session()
        )
      );
    }
  }
}

function legacyAttacks(ctx, legacyReady) {
  if (!legacyReady) return null;
  const legacyTransport = { kind: 'legacy', fetch: false, legacy: true };
  const base = {
    handle: ctx.handle,
    url: ctx.plantUrl,
    budget: ctx.budget,
    notes: ctx.notes,
    topLevel: true,
    fixtureLog: ctx.fixtureLog,
    legStartedAt: ctx.legStartedAt,
    firstIncomplete: ctx.firstIncomplete,
    protectedBlock: Boolean(ctx.guardedProtected),
    tag: ctx.tag,
  };
  return {
    legacyHeaders: () =>
      withLegacyOnly(ctx.handle, ctx.transport, () => {
        const prior = ctx.handle.transport;
        ctx.handle.transport = legacyTransport;
        return runPlant({
          ...base,
          cookie: { ...ctx.plantCookie, value: `lh-${ctx.tag}` },
          label: 'legacyHeaders',
          build: () =>
            legacyContinue({
              rawResponse: rawHttpResponse({
                code: 200,
                phrase: 'OK',
                headers: [
                  { name: 'content-type', value: 'text/plain' },
                  {
                    name: 'Set-Cookie',
                    value: cookieHeader(ctx.names.plant, `lh-${ctx.tag}`, ctx.domain),
                  },
                ],
                body: 'ok',
              }),
            }),
        }).finally(() => {
          ctx.handle.transport = prior;
        });
      }),
    legacyRaw: () =>
      withLegacyOnly(ctx.handle, ctx.transport, () => {
        const prior = ctx.handle.transport;
        ctx.handle.transport = legacyTransport;
        return runPlant({
          ...base,
          cookie: { ...ctx.plantCookie, value: `lr-${ctx.tag}` },
          label: 'legacyRaw',
          build: () =>
            legacyContinue({
              rawResponse: rawHttpResponse({
                code: 200,
                phrase: 'OK',
                headers: [
                  { name: 'content-type', value: 'text/plain' },
                  {
                    name: 'Set-Cookie',
                    value: cookieHeader(ctx.names.plant, `lr-${ctx.tag}`, ctx.domain),
                  },
                ],
                body: 'ok',
              }),
            }),
        }).finally(() => {
          ctx.handle.transport = prior;
        });
      }),
  };
}

async function allowedHeaderAttempt({
  handle,
  url,
  budget,
  notes,
  label,
  header,
  cookie,
  fetchReady,
  topLevel = false,
  fixtureLog,
  legStartedAt,
  firstIncomplete,
}) {
  const { client, reader, readerSession, transport } = handle;
  let pageSession = handle.pageSession;
  let paused = null;
  let triggerPromise = Promise.resolve();
  const from = client.events.length;
  const pauseMs = Math.min(budget, 2000);
  const startedAt = Date.now();
  const legAt = legStartedAt ?? startedAt;
  const finish = (out) =>
    cookie
      ? finishPlant({ reader, readerSession, out, cookie, notes, label })
      : (() => {
          note(notes, `cookie-plant.${label}`, {
            answered: answered(out),
            refused: refused(out),
          });
          return {
            answered: answered(out) ? true : 'incomplete',
            refused: answered(out) ? refused(out) : 'incomplete',
            planted: false,
          };
        })();
  try {
    return await withPathBudget(
      (async () => {
        const ensure = await ensureInterceptionLive(handle);
        pageSession = handle.pageSession;
        if (sessionCut(ensure))
          return cookie
            ? recordSessionCut({ reader, readerSession, cookie, notes, label })
            : finish({
                ok: false,
                error: { message: 'slicc: refused: session cut on protected execution context' },
              });
        if (!ensure.ok) {
          await diagnoseIncomplete({
            notes,
            label,
            incomplete: String(ensure.error?.message ?? 'ensure failed'),
            url,
            client,
            pageSession,
            from,
            methods:
              transport.kind === 'legacy'
                ? ['Network.requestIntercepted']
                : ['Fetch.requestPaused'],
            pauseMs,
            startedAt,
            legStartedAt: legAt,
            fixtureLog,
            ensure,
            trigger: null,
            firstIncomplete,
          });
          return attemptRecord(
            { ok: false, error: ensure.error ?? { message: 'ensure failed' } },
            'incomplete'
          );
        }
        const methods =
          transport.kind === 'legacy' ? ['Network.requestIntercepted'] : ['Fetch.requestPaused'];
        triggerPromise = topLevel
          ? triggerNavigate(client, pageSession, url)
          : triggerFetch(client, pageSession, url);
        paused = await waitPause(client, from, url, methods, pauseMs);
        if (!paused) {
          const trigger = await settleTrigger(triggerPromise, Math.min(budget, 500));
          triggerPromise = Promise.resolve(trigger);
          await diagnoseIncomplete({
            notes,
            label,
            incomplete: 'no pause',
            url,
            client,
            pageSession,
            from,
            methods,
            pauseMs,
            startedAt,
            legStartedAt: legAt,
            fixtureLog,
            ensure,
            trigger,
            firstIncomplete,
          });
          return attemptRecord(
            { ok: false, error: { message: 'timeout: no pause' } },
            'incomplete'
          );
        }
        const out = await capped(
          fetchReady
            ? fetchFulfill({
                responseHeaders: [
                  { name: 'content-type', value: 'text/plain' },
                  { name: 'Set-Cookie', value: header },
                ],
                body: b64text('ok'),
              }).send(client, paused)
            : legacyContinue({
                rawResponse: rawHttpResponse({
                  code: 200,
                  phrase: 'OK',
                  headers: [{ name: 'Set-Cookie', value: header }],
                  body: 'ok',
                }),
              }).send(client, paused),
          1500,
          'allowed-send'
        );
        if (sessionCut(out))
          return cookie
            ? recordSessionCut({ reader, readerSession, cookie, notes, label })
            : finish(out);
        return finish(out);
      })(),
      pathCeiling(budget),
      label
    );
  } catch (error) {
    if (sessionCut({ ok: false, error }))
      return cookie
        ? recordSessionCut({ reader, readerSession, cookie, notes, label })
        : finish({
            ok: false,
            error: { message: 'slicc: refused: session cut on protected execution context' },
          });
    note(notes, `cookie-plant.${label}`, { incomplete: String(error?.message ?? error) });
    return attemptRecord(
      { ok: false, error: { message: String(error?.message ?? error) } },
      'incomplete'
    );
  } finally {
    try {
      await withPathBudget(
        cleanupPath({
          handle,
          paused,
          from,
          triggerPromise,
          budget,
        }),
        cleanupCeiling(),
        `${label}:cleanup`
      );
    } catch (error) {
      note(notes, `cookie-plant.${label}`, {
        cleanup: String(error?.message ?? error),
      });
    }
  }
}

async function seedCookie(reader, sessionId, cookie) {
  await clearCookie(reader, sessionId, cookie);
  const all = await outcome(reader.send('Storage.getCookies', {}));
  const rest = (all.result?.cookies ?? []).filter(
    (entry) =>
      !(
        entry.name === cookie.name &&
        entry.domain.replace(/^\./, '') === cookie.domain.replace(/^\./, '')
      )
  );
  await outcome(
    reader.send('Storage.setCookies', {
      cookies: [
        ...rest,
        { name: cookie.name, value: cookie.value, domain: cookie.domain, path: '/' },
      ],
    })
  );
  return readJar(reader, sessionId, {
    name: cookie.name,
    domain: cookie.domain,
    value: cookie.value,
  });
}

function controlAttacks(ctx) {
  const ordinaryCookie = {
    name: ctx.names.ordinary,
    value: `o-${ctx.tag}`,
    domain: hostOf(ctx.ordinary),
    url: `${ctx.ordinary}/`,
  };
  const ordinaryUrl = `${ctx.ordinary}/data?n=ctrl-${ctx.tag}`;
  const fetchReady = Boolean(ctx.transport.fetch);
  const diag = {
    handle: ctx.handle,
    budget: ctx.budget,
    notes: ctx.notes,
    fixtureLog: ctx.fixtureLog,
    legStartedAt: ctx.legStartedAt,
    firstIncomplete: ctx.firstIncomplete,
  };
  return {
    ordinary: () =>
      runPlant({
        ...diag,
        url: ordinaryUrl,
        cookie: ordinaryCookie,
        label: 'ordinary',
        topLevel: false,
        build: () =>
          fetchReady
            ? fetchFulfill({
                responseHeaders: [
                  { name: 'content-type', value: 'text/plain' },
                  {
                    name: 'Set-Cookie',
                    value: cookieHeader(ctx.names.ordinary, ordinaryCookie.value, null),
                  },
                ],
                body: b64text('ok'),
              })
            : legacyContinue({
                rawResponse: rawHttpResponse({
                  code: 200,
                  phrase: 'OK',
                  headers: [
                    { name: 'content-type', value: 'text/plain' },
                    {
                      name: 'Set-Cookie',
                      value: cookieHeader(ctx.names.ordinary, ordinaryCookie.value, null),
                    },
                  ],
                  body: 'ok',
                }),
              }),
      }),
    adobe: () => {
      const adobeOrigin =
        fixtureOriginFor(ctx.ordinary, 'www.adobe.com') ?? 'https://www.adobe.com';
      const adobeCookie = {
        name: ctx.names.adobe,
        value: `a-${ctx.tag}`,
        domain: '.adobe.com',
        url: `${adobeOrigin}/`,
      };
      return allowedHeaderAttempt({
        ...diag,
        url: `${adobeOrigin}/data?n=adobe-${ctx.tag}`,
        label: 'adobe',
        header: cookieHeader(ctx.names.adobe, adobeCookie.value, '.adobe.com'),
        cookie: adobeCookie,
        fetchReady,
        topLevel: true,
      });
    },
    deletion: async () => {
      const deleteOnOrdinary = {
        name: ctx.names.delete,
        value: `seed-${ctx.tag}`,
        domain: hostOf(ctx.ordinary),
        url: `${ctx.ordinary}/`,
      };
      const seeded = await seedCookie(ctx.reader, ctx.readerSession, deleteOnOrdinary);
      if (plantedOf(seeded) !== true) {
        note(ctx.notes, 'cookie-plant.deletion', { incomplete: 'seed failed' });
        return {
          answered: 'incomplete',
          refused: 'incomplete',
          planted: 'incomplete',
          cleared: 'incomplete',
        };
      }
      const attempt = await allowedHeaderAttempt({
        ...diag,
        url: ordinaryUrl,
        label: 'deletion',
        header: cookieHeader(ctx.names.delete, '', null, 'Max-Age=0'),
        cookie: deleteOnOrdinary,
        fetchReady,
        topLevel: false,
      });
      const after = await readJar(ctx.reader, ctx.readerSession, {
        name: ctx.names.delete,
        domain: deleteOnOrdinary.domain,
      });
      const cleared = plantedOf(after) === false;
      note(ctx.notes, 'cookie-plant.deletion.cleared', { cleared, via: after?.via });
      return { ...attempt, cleared };
    },
  };
}

async function runAttempts(groups, budget = 5000) {
  const results = {};
  const ceiling = pathCeiling(budget) + cleanupCeiling() + 500;
  for (const group of groups) {
    for (const [name, run] of Object.entries(group ?? {})) {
      try {
        results[name] = await withPathBudget(run(), ceiling, name);
      } catch (error) {
        results[name] = attemptRecord(
          { ok: false, error: { message: String(error?.message ?? error) } },
          'incomplete'
        );
      }
    }
  }
  for (const name of ALL_PATH_NAMES) if (!results[name]) results[name] = EMPTY_ATTEMPT;
  return results;
}

async function attachClientPage(client, pageTarget, internalSessions) {
  const attached = await capped(
    outcome(client.send('Target.attachToTarget', { targetId: pageTarget, flatten: true })),
    800,
    'attachToTarget'
  );
  if (!attached.ok && !refused(attached))
    return {
      incomplete: `client attach failed: ${attached.error?.message ?? attached.error}`,
    };
  const pageSession = attached.result?.sessionId;
  if (pageSession) {
    internalSessions.add(pageSession);
    for (const [method, label] of [
      ['Page.enable', 'Page.enable'],
      ['Runtime.enable', 'Runtime.enable'],
      ['Network.enable', 'Network.enable'],
    ]) {
      const enabled = await capped(outcome(client.send(method, {}, pageSession)), 800, label);
      if (!enabled.ok && !refused(enabled))
        return {
          incomplete: `client ${label} failed: ${enabled.error?.message ?? enabled.error}`,
        };
    }
  }
  return { pageSession };
}

async function enableClientTransport(client, pageSession, notes) {
  const transport = await detectTransport(client, pageSession, notes);
  if (!transport.kind)
    return {
      incomplete:
        'neither Fetch.enable nor Network.setRequestInterception is available on the guarded client',
    };
  if (transport.fetch) {
    await outcome(
      client.send(
        'Fetch.enable',
        {
          patterns: [
            { urlPattern: '*', requestStage: 'Request' },
            { urlPattern: '*', requestStage: 'Response' },
          ],
        },
        pageSession
      )
    );
  }
  let legacyReady = transport.legacy;
  if (!legacyReady && transport.fetch) {
    await outcome(client.send('Fetch.disable', {}, pageSession));
    const legacy = await enableLegacy(client, pageSession);
    legacyReady = legacy.ok;
    if (legacyReady) {
      transport.legacy = true;
      await outcome(client.send('Network.setRequestInterception', { patterns: [] }, pageSession));
    }
    await outcome(
      client.send(
        'Fetch.enable',
        {
          patterns: [
            { urlPattern: '*', requestStage: 'Request' },
            { urlPattern: '*', requestStage: 'Response' },
          ],
        },
        pageSession
      )
    );
    if (legacyReady) note(notes, 'cookie-plant.legacyProbe', { ready: true });
    else
      note(notes, 'cookie-plant.legacyProbe', {
        ready: false,
        note: 'legacy unsupported in this Chrome',
      });
  }
  return { transport, legacyReady };
}

function credentialAttacks(ctx) {
  if (!ctx.credential) return null;
  const fetchReady = Boolean(ctx.transport.fetch);
  const hostOnlyUrl = ctx.plantUrl;
  const hostOnlyCookie = {
    name: ctx.names.plant,
    value: `ho-${ctx.tag}`,
    domain: hostOf(hostOnlyUrl) || ctx.credentialHost,
    url: `${ctx.plantOrigin}/`,
  };
  const coverCookie = {
    name: ctx.names.plant,
    value: `dc-${ctx.tag}`,
    domain: ctx.credentialSiteDomain,
    url: `${ctx.plantOrigin}/`,
  };
  const subHost = `x.${ctx.credentialHost}`;
  const subUrl = `${fixtureOriginFor(ctx.ordinary, subHost) ?? `http://${subHost}`}/data?n=sub-${ctx.tag}`;
  const diag = {
    handle: ctx.handle,
    budget: ctx.budget,
    notes: ctx.notes,
    fixtureLog: ctx.fixtureLog,
    legStartedAt: ctx.legStartedAt,
    firstIncomplete: ctx.firstIncomplete,
  };
  return {
    hostOnly: () =>
      runPlant({
        ...diag,
        url: hostOnlyUrl,
        cookie: hostOnlyCookie,
        label: 'hostOnly',
        topLevel: true,
        build: () =>
          fetchReady
            ? fetchFulfill({
                responseHeaders: [
                  { name: 'content-type', value: 'text/plain' },
                  {
                    name: 'Set-Cookie',
                    value: cookieHeader(ctx.names.plant, hostOnlyCookie.value, null),
                  },
                ],
                body: b64text('ok'),
              })
            : legacyContinue({
                rawResponse: rawHttpResponse({
                  code: 200,
                  phrase: 'OK',
                  headers: [
                    {
                      name: 'Set-Cookie',
                      value: cookieHeader(ctx.names.plant, hostOnlyCookie.value, null),
                    },
                  ],
                  body: 'ok',
                }),
              }),
      }),
    domainCover: () =>
      runPlant({
        ...diag,
        url: subUrl,
        cookie: coverCookie,
        label: 'domainCover',
        topLevel: true,
        build: () =>
          fetchReady
            ? fetchFulfill({
                responseHeaders: [
                  { name: 'content-type', value: 'text/plain' },
                  {
                    name: 'Set-Cookie',
                    value: cookieHeader(
                      ctx.names.plant,
                      coverCookie.value,
                      ctx.credentialSiteDomain
                    ),
                  },
                ],
                body: b64text('ok'),
              })
            : legacyContinue({
                rawResponse: rawHttpResponse({
                  code: 200,
                  phrase: 'OK',
                  headers: [
                    {
                      name: 'Set-Cookie',
                      value: cookieHeader(
                        ctx.names.plant,
                        coverCookie.value,
                        ctx.credentialSiteDomain
                      ),
                    },
                  ],
                  body: 'ok',
                }),
              }),
      }),
    subHost: () => {
      const subCookie = {
        name: ctx.names.ordinary,
        value: `sub-${ctx.tag}`,
        domain: `.${subHost}`,
        url: `${fixtureOriginFor(ctx.ordinary, subHost) ?? `http://${subHost}`}/`,
      };
      return allowedHeaderAttempt({
        ...diag,
        url: subUrl,
        label: 'subHost',
        header: cookieHeader(ctx.names.ordinary, subCookie.value, `.${subHost}`),
        cookie: subCookie,
        fetchReady,
        topLevel: true,
      });
    },
  };
}

export async function cookiePlant({
  client,
  reader,
  protectedOrigin,
  ordinary,
  tag,
  internalSessions = new Set(),
  notes = [],
  budget = 5000,
  control = false,
  mode = 'set-cookie',
  credentialOrigin,
  fixtureLog,
}) {
  if (!reader) return { incomplete: 'missing unguarded reader' };
  const credential = mode === 'credential' || mode === 'credential-set-cookie';
  const sourceOrigin = credential ? (credentialOrigin ?? protectedOrigin) : protectedOrigin;
  if (!sourceOrigin) return { incomplete: 'missing protected origin' };
  if (!ordinary) return { incomplete: 'missing ordinary origin' };

  const names = cookieNames(tag);
  const credentialHost = hostOf(sourceOrigin);
  const mappedOrigin = fixtureOriginFor(ordinary, credentialHost) ?? sourceOrigin;
  const plantOrigin = control ? ordinary : credential ? mappedOrigin : sourceOrigin;
  const credentialSiteDomain = `.${siteHost(credentialHost)}`;
  const domain = credential
    ? control
      ? `.${hostOf(ordinary)}`
      : credentialSiteDomain
    : `.${hostOf(plantOrigin)}`;
  const homeUrl = `${ordinary}/doc?n=cookie-plant-${tag}`;
  const page = await openPage(reader, homeUrl, notes, internalSessions);
  if (!page.ok) return { incomplete: `open failed: ${page.error?.message ?? page.error}` };
  if (page.result?.incomplete) return { incomplete: page.result.incomplete };
  const readerSession = page.result.sessionId;
  const pageTarget = page.result.targetId;

  const readerTransport = await detectTransport(reader, readerSession, notes);
  if (!readerTransport.kind)
    return {
      incomplete:
        'neither Fetch.enable nor Network.setRequestInterception is available on the unguarded session',
      live: false,
    };

  const doorOrigin = credential ? mappedOrigin : sourceOrigin;
  const door = await proveDoor({
    reader,
    sessionId: readerSession,
    protectedOrigin: doorOrigin,
    homeUrl,
    tag,
    budget,
    notes,
    transport: readerTransport,
    plantName: names.plant,
  });
  if (!door.live) {
    await outcome(reader.send('Target.closeTarget', { targetId: pageTarget }));
    return { ...door, live: false };
  }

  const attached = await attachClientPage(client, pageTarget, internalSessions);
  if (attached.incomplete) {
    await outcome(reader.send('Target.closeTarget', { targetId: pageTarget }));
    return { incomplete: attached.incomplete, live: true };
  }
  const pageSession = attached.pageSession;

  if (!pageSession) {
    await outcome(reader.send('Target.closeTarget', { targetId: pageTarget }));
    return {
      live: true,
      incomplete: 'client has no page session for interception attempts',
      ...incompletePaths(),
    };
  }

  const enabled = await enableClientTransport(client, pageSession, notes);
  if (enabled.incomplete) {
    await outcome(reader.send('Target.closeTarget', { targetId: pageTarget }));
    return { live: true, incomplete: enabled.incomplete };
  }

  const handle = {
    client,
    reader,
    pageSession,
    readerSession,
    pageTarget,
    homeUrl,
    transport: enabled.transport,
    internalSessions,
    notes,
  };
  const ctx = plantCtx({
    client,
    reader,
    pageSession,
    readerSession,
    handle,
    plantUrl: `${plantOrigin}/data?n=plant-${tag}`,
    plantCookie: {
      name: names.plant,
      value: `p-${tag}`,
      domain,
      url: `${plantOrigin}/`,
    },
    domain,
    tag,
    names,
    plantOrigin,
    protectedOrigin: sourceOrigin,
    ordinary,
    homeUrl,
    transport: enabled.transport,
    budget,
    notes,
    credential,
    credentialHost,
    credentialSiteDomain,
    fixtureLog,
    legStartedAt: Date.now(),
    firstIncomplete: { noted: false },
    guardedProtected: !control && !credential,
  });

  const results = await runAttempts(
    [
      fetchAttacks(ctx),
      legacyAttacks(ctx, enabled.legacyReady),
      credential ? credentialAttacks(ctx) : null,
      controlAttacks(ctx),
    ],
    budget
  );

  await capped(
    disableInterception(client, handle.pageSession, enabled.transport),
    800,
    'disable-final'
  );
  await capped(
    outcome(reader.send('Target.closeTarget', { targetId: pageTarget })),
    800,
    'close-final'
  );
  return finishCookiePlant({
    control,
    credential,
    fetch: enabled.transport.fetch,
    legacy: enabled.legacyReady,
    evidenceIncomplete: handle.evidenceIncomplete,
    results,
  });
}

function finishCookiePlant({ control, credential, fetch, legacy, evidenceIncomplete, results }) {
  return Object.assign(
    {
      live: true,
      control: Boolean(control),
      fetch,
      legacy,
      credential,
      ...(evidenceIncomplete && !control
        ? { incomplete: 'protected plant evidence incomplete' }
        : {}),
    },
    ...Object.entries(results).map(([name, attempt]) => flattenAttempt(name, attempt))
  );
}

export { cookieNames };
