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

const PLANT_NAME = 'cplant';
const ORDINARY_NAME = 'oord';
const ADOBE_NAME = 'oadobe';
const DELETE_NAME = 'sid';

function answered(out) {
  if (!out) return false;
  if (out.ok) return true;
  const err = out.error;
  if (err && typeof err.code === 'number') return true;
  return /^slicc: refused:/.test(String(err?.message ?? err ?? ''));
}

function refused(out) {
  if (!out || out.ok) return false;
  return /^slicc: refused:/.test(String(out.error?.message ?? out.error ?? ''));
}

function note(notes, label, evidence) {
  notes.push(`${label}: ${JSON.stringify(evidence)}`);
}

function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function cookieHeader(name, value, domain, extra = '') {
  const parts = [`${name}=${value}`];
  if (domain) parts.push(`Domain=${domain}`);
  parts.push('Path=/');
  if (extra) parts.push(extra);
  return parts.join('; ');
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
  const fetchEnable = await outcome(
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
  );
  if (fetchEnable.ok) {
    note(notes, 'cookie-plant.transport', { kind: 'fetch' });
    return { kind: 'fetch', fetch: true, legacy: false };
  }
  const legacyEnable = await outcome(
    client.send('Network.setRequestInterception', { patterns: [{ urlPattern: '*' }] }, sessionId)
  );
  if (legacyEnable.ok) {
    note(notes, 'cookie-plant.transport', { kind: 'legacy' });
    return { kind: 'legacy', fetch: false, legacy: true };
  }
  const legacyFetch = await outcome(
    client.send('Network.setRequestInterception', { patterns: [{ urlPattern: '*' }] }, sessionId)
  );
  note(notes, 'cookie-plant.transport', {
    kind: null,
    fetchError: String(fetchEnable.error?.message ?? fetchEnable.error),
    legacyError: String(
      legacyEnable.error?.message ?? legacyFetch.error?.message ?? legacyEnable.error
    ),
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

async function settleTrigger(promise, budget) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, error: { message: 'trigger settle timeout' } }),
          budget
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function releasePause(client, paused) {
  if (!paused) return;
  if (paused.method === 'Fetch.requestPaused' && paused.params?.requestId) {
    await outcome(
      client.send(
        'Fetch.failRequest',
        { requestId: paused.params.requestId, errorReason: 'Aborted' },
        paused.sessionId
      )
    );
    return;
  }
  if (paused.method === 'Network.requestIntercepted' && paused.params?.interceptionId) {
    await outcome(
      client.send(
        'Network.continueInterceptedRequest',
        { interceptionId: paused.params.interceptionId, errorReason: 'Aborted' },
        paused.sessionId
      )
    );
  }
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

async function restorePage(client, pageSession, homeUrl, transport) {
  if (!homeUrl || !pageSession) return;
  const wasFetch = Boolean(transport?.fetch);
  const wasLegacy = Boolean(transport?.legacy);
  if (wasFetch || wasLegacy) await disableInterception(client, pageSession, transport);
  await outcome(client.send('Page.navigate', { url: homeUrl }, pageSession));
  if (wasFetch) {
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
  } else if (wasLegacy) {
    await enableLegacy(client, pageSession);
  }
}

async function finishPlant({
  client,
  reader,
  readerSession,
  pageSession,
  homeUrl,
  transport,
  triggerPromise,
  paused,
  out,
  cookie,
  budget,
  notes,
  label,
}) {
  if (refused(out) || !out.ok) await releasePause(client, paused);
  await settleTrigger(triggerPromise, budget);
  const jar = await readJar(reader, readerSession, cookie);
  const planted = plantedOf(jar);
  note(notes, `cookie-plant.${label}`, {
    answered: answered(out),
    refused: refused(out),
    planted,
    via: jar?.via,
    jarIncomplete: jar?.incomplete,
  });
  await restorePage(client, pageSession, homeUrl, transport);
  return attemptRecord(out, planted);
}

async function runPlant({
  client,
  reader,
  pageSession,
  readerSession,
  url,
  cookie,
  build,
  transport,
  budget,
  notes,
  label,
  stage = 'Request',
  homeUrl,
  topLevel = true,
}) {
  await clearCookie(reader, readerSession, cookie);
  const from = client.events.length;
  const methods =
    transport.kind === 'legacy'
      ? ['Network.requestIntercepted']
      : stage === 'Response'
        ? ['Fetch.requestPaused']
        : ['Fetch.requestPaused'];
  const triggerPromise = topLevel
    ? triggerNavigate(client, pageSession, url)
    : triggerFetch(client, pageSession, url);
  const paused = await waitPause(client, from, url, methods, budget);
  if (!paused) {
    await settleTrigger(triggerPromise, budget);
    await restorePage(client, pageSession, homeUrl, transport);
    note(notes, `cookie-plant.${label}`, { incomplete: 'no pause', url });
    return attemptRecord({ ok: false, error: { message: 'timeout: no pause' } }, 'incomplete');
  }
  if (
    transport.kind === 'fetch' &&
    stage === 'Response' &&
    paused.params?.responseStatusCode === undefined &&
    paused.params?.responseErrorReason === undefined
  ) {
    const responseFrom = client.events.length;
    await outcome(
      client.send('Fetch.continueRequest', { requestId: paused.params.requestId }, paused.sessionId)
    );
    const again = await waitPause(client, responseFrom, url, methods, budget);
    if (!again) {
      await releasePause(client, paused);
      await settleTrigger(triggerPromise, budget);
      await restorePage(client, pageSession, homeUrl, transport);
      note(notes, `cookie-plant.${label}`, { incomplete: 'no response pause', url });
      return attemptRecord(
        { ok: false, error: { message: 'timeout: no response pause' } },
        'incomplete'
      );
    }
    const built = build(again);
    const out = await built.send(client, again);
    return finishPlant({
      client,
      reader,
      readerSession,
      pageSession,
      homeUrl,
      transport,
      triggerPromise,
      paused: again,
      out,
      cookie,
      budget,
      notes,
      label,
    });
  }
  const built = build(paused);
  const out = await built.send(client, paused);
  return finishPlant({
    client,
    reader,
    readerSession,
    pageSession,
    homeUrl,
    transport,
    triggerPromise,
    paused,
    out,
    cookie,
    budget,
    notes,
    label,
  });
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
  return {
    [`${prefix}Answered`]: attempt.answered,
    [`${prefix}Refused`]: attempt.refused,
    [`${prefix}Planted`]: attempt.planted,
  };
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
}) {
  const host = hostOf(protectedOrigin);
  const domain = `.${host}`;
  const url = `${protectedOrigin}/data?n=door-${tag}`;
  const cookie = { name: PLANT_NAME, value: `door-${tag}`, domain, url: `${protectedOrigin}/` };
  await clearCookie(reader, sessionId, cookie);
  const from = reader.events.length;
  if (transport.kind === 'fetch') {
    await outcome(
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
    );
  } else {
    await enableLegacy(reader, sessionId);
  }
  const triggerPromise = triggerNavigate(reader, sessionId, url);
  const methods =
    transport.kind === 'legacy' ? ['Network.requestIntercepted'] : ['Fetch.requestPaused'];
  const paused = await waitPause(reader, from, url, methods, budget);
  if (!paused) {
    await settleTrigger(triggerPromise, budget);
    await disableInterception(reader, sessionId, transport);
    await restorePage(reader, sessionId, homeUrl);
    return { live: false, incomplete: 'raw leg: no pause for top-level plant navigation' };
  }
  const setCookie = cookieHeader(PLANT_NAME, cookie.value, domain);
  const out = await fulfillPaused(reader, paused, {
    responseCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'text/plain' },
      { name: 'Set-Cookie', value: setCookie },
    ],
    body: b64text(`door-${tag}`),
  });
  if (refused(out) || !out.ok) await releasePause(reader, paused);
  await settleTrigger(triggerPromise, budget);
  const jar = await readJar(reader, sessionId, cookie);
  const planted = plantedOf(jar);
  note(notes, 'cookie-plant.door', {
    answered: answered(out),
    planted,
    via: jar?.via,
    domain,
  });
  await clearCookie(reader, sessionId, cookie);
  await disableInterception(reader, sessionId, transport);
  await restorePage(reader, sessionId, homeUrl);
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
];

const ALL_PATH_NAMES = [
  ...FETCH_PATH_NAMES,
  'legacyHeaders',
  'legacyRaw',
  'ordinary',
  'deletion',
  'adobe',
];

function incompletePaths() {
  return Object.fromEntries(
    ALL_PATH_NAMES.flatMap((name) => [
      [`${name}Answered`, 'incomplete'],
      [`${name}Refused`, 'incomplete'],
      [`${name}Planted`, 'incomplete'],
    ])
  );
}

function plantCtx({
  client,
  reader,
  pageSession,
  readerSession,
  plantUrl,
  plantCookie,
  domain,
  tag,
  protectedOrigin,
  ordinary,
  homeUrl,
  transport,
  budget,
  notes,
}) {
  return {
    client,
    reader,
    pageSession,
    readerSession,
    plantUrl,
    plantCookie,
    domain,
    tag,
    protectedOrigin,
    ordinary,
    homeUrl,
    transport,
    budget,
    notes,
  };
}

function fetchAttacks(ctx) {
  if (!ctx.transport.fetch) return null;
  const base = {
    client: ctx.client,
    reader: ctx.reader,
    pageSession: ctx.pageSession,
    readerSession: ctx.readerSession,
    url: ctx.plantUrl,
    transport: ctx.transport,
    budget: ctx.budget,
    notes: ctx.notes,
    homeUrl: ctx.homeUrl,
    topLevel: true,
  };
  const cookie = (value) => ({ ...ctx.plantCookie, value });
  const header = (value) => cookieHeader(PLANT_NAME, value, ctx.domain);
  return {
    fulfillArray: () =>
      runPlant({
        ...base,
        cookie: ctx.plantCookie,
        label: 'fulfillArray',
        build: () =>
          fetchFulfill({
            responseHeaders: [
              { name: 'content-type', value: 'text/plain' },
              { name: 'Set-Cookie', value: header(ctx.plantCookie.value) },
            ],
            body: b64text('ok'),
          }),
      }),
    fulfillObject: () =>
      runPlant({
        ...base,
        cookie: cookie(`obj-${ctx.tag}`),
        label: 'fulfillObject',
        build: () =>
          fetchFulfill({
            responseHeaders: {
              'content-type': 'text/plain',
              'Set-Cookie': header(`obj-${ctx.tag}`),
            },
            body: b64text('ok'),
          }),
      }),
    fulfillLower: () =>
      runPlant({
        ...base,
        cookie: cookie(`low-${ctx.tag}`),
        label: 'fulfillLower',
        build: () =>
          fetchFulfill({
            responseHeaders: [
              { name: 'content-type', value: 'text/plain' },
              { name: 'set-cookie', value: header(`low-${ctx.tag}`) },
            ],
            body: b64text('ok'),
          }),
      }),
    fulfillSetCookie2: () =>
      runPlant({
        ...base,
        cookie: cookie(`sc2-${ctx.tag}`),
        label: 'fulfillSetCookie2',
        build: () =>
          fetchFulfill({
            responseHeaders: [
              { name: 'content-type', value: 'text/plain' },
              { name: 'Set-Cookie2', value: header(`sc2-${ctx.tag}`) },
            ],
            body: b64text('ok'),
          }),
      }),
    fulfillNewline: () =>
      runPlant({
        ...base,
        cookie: cookie(`nl-${ctx.tag}`),
        label: 'fulfillNewline',
        build: () =>
          fetchFulfill({
            responseHeaders: [
              { name: 'content-type', value: 'text/plain' },
              {
                name: 'Set-Cookie',
                value: `${header(`nl-${ctx.tag}`)}\n${cookieHeader('other', '1', ctx.domain)}`,
              },
            ],
            body: b64text('ok'),
          }),
      }),
    fulfillBinary: () =>
      runPlant({
        ...base,
        cookie: cookie(`bin-${ctx.tag}`),
        label: 'fulfillBinary',
        build: () =>
          fetchFulfill({
            binaryResponseHeaders: binaryHeaders([
              { name: 'content-type', value: 'text/plain' },
              { name: 'Set-Cookie', value: header(`bin-${ctx.tag}`) },
            ]),
            body: b64text('ok'),
          }),
      }),
    continueResponse: () =>
      runPlant({
        ...base,
        cookie: cookie(`cr-${ctx.tag}`),
        label: 'continueResponse',
        stage: 'Response',
        build: () =>
          fetchContinueResponse({
            responseHeaders: [
              { name: 'content-type', value: 'text/plain' },
              { name: 'Set-Cookie', value: header(`cr-${ctx.tag}`) },
            ],
          }),
      }),
    redirect3xx: () =>
      runPlant({
        ...base,
        cookie: cookie(`rx-${ctx.tag}`),
        label: 'redirect3xx',
        build: () =>
          fetchFulfill({
            responseCode: 302,
            responseHeaders: [
              { name: 'Location', value: `${ctx.protectedOrigin}/doc?n=redir-${ctx.tag}` },
              { name: 'Set-Cookie', value: header(`rx-${ctx.tag}`) },
            ],
            body: b64text(''),
          }),
      }),
  };
}

async function withLegacyOnly(client, pageSession, transport, run) {
  if (transport.fetch) await outcome(client.send('Fetch.disable', {}, pageSession));
  await enableLegacy(client, pageSession);
  try {
    return await run();
  } finally {
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
  }
}

function legacyAttacks(ctx, legacyReady) {
  if (!legacyReady) return null;
  const legacyTransport = { kind: 'legacy', fetch: false, legacy: true };
  const base = {
    client: ctx.client,
    reader: ctx.reader,
    pageSession: ctx.pageSession,
    readerSession: ctx.readerSession,
    url: ctx.plantUrl,
    transport: legacyTransport,
    budget: ctx.budget,
    notes: ctx.notes,
    homeUrl: ctx.homeUrl,
    topLevel: true,
  };
  return {
    legacyHeaders: () =>
      withLegacyOnly(ctx.client, ctx.pageSession, ctx.transport, () =>
        runPlant({
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
                    value: cookieHeader(PLANT_NAME, `lh-${ctx.tag}`, ctx.domain),
                  },
                ],
                body: 'ok',
              }),
            }),
        })
      ),
    legacyRaw: () =>
      withLegacyOnly(ctx.client, ctx.pageSession, ctx.transport, () =>
        runPlant({
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
                    value: cookieHeader(PLANT_NAME, `lr-${ctx.tag}`, ctx.domain),
                  },
                ],
                body: 'ok',
              }),
            }),
        })
      ),
  };
}

async function allowedHeaderAttempt({
  client,
  pageSession,
  reader,
  readerSession,
  url,
  transport,
  budget,
  notes,
  label,
  header,
  fetchReady,
  homeUrl,
  topLevel = false,
}) {
  const from = client.events.length;
  const methods =
    transport.kind === 'legacy' ? ['Network.requestIntercepted'] : ['Fetch.requestPaused'];
  const triggerPromise = topLevel
    ? triggerNavigate(client, pageSession, url)
    : triggerFetch(client, pageSession, url);
  const paused = await waitPause(client, from, url, methods, budget);
  if (!paused) {
    await settleTrigger(triggerPromise, budget);
    await restorePage(client, pageSession, homeUrl, transport);
    return attemptRecord({ ok: false, error: { message: 'timeout: no pause' } }, 'incomplete');
  }
  const out = fetchReady
    ? await fetchFulfill({
        responseHeaders: [
          { name: 'content-type', value: 'text/plain' },
          { name: 'Set-Cookie', value: header },
        ],
        body: b64text('ok'),
      }).send(client, paused)
    : await legacyContinue({
        rawResponse: rawHttpResponse({
          code: 200,
          phrase: 'OK',
          headers: [{ name: 'Set-Cookie', value: header }],
          body: 'ok',
        }),
      }).send(client, paused);
  if (refused(out) || !out.ok) await releasePause(client, paused);
  await settleTrigger(triggerPromise, budget);
  await restorePage(client, pageSession, homeUrl, transport);
  note(notes, `cookie-plant.${label}`, { answered: answered(out), refused: refused(out) });
  return {
    answered: answered(out) ? true : 'incomplete',
    refused: answered(out) ? refused(out) : 'incomplete',
    planted: false,
  };
}

function controlAttacks(ctx) {
  const ordinaryCookie = {
    name: ORDINARY_NAME,
    value: `o-${ctx.tag}`,
    domain: hostOf(ctx.ordinary),
    url: `${ctx.ordinary}/`,
  };
  const ordinaryUrl = `${ctx.ordinary}/data?n=ctrl-${ctx.tag}`;
  const controlTransport = ctx.transport.fetch
    ? ctx.transport
    : { kind: 'legacy', fetch: false, legacy: true };
  const fetchReady = Boolean(ctx.transport.fetch);
  return {
    ordinary: () =>
      runPlant({
        client: ctx.client,
        reader: ctx.reader,
        pageSession: ctx.pageSession,
        readerSession: ctx.readerSession,
        url: ordinaryUrl,
        cookie: ordinaryCookie,
        transport: controlTransport,
        budget: ctx.budget,
        notes: ctx.notes,
        label: 'ordinary',
        homeUrl: ctx.homeUrl,
        topLevel: false,
        build: () =>
          fetchReady
            ? fetchFulfill({
                responseHeaders: [
                  { name: 'content-type', value: 'text/plain' },
                  {
                    name: 'Set-Cookie',
                    value: cookieHeader(ORDINARY_NAME, ordinaryCookie.value, null),
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
                      value: cookieHeader(ORDINARY_NAME, ordinaryCookie.value, null),
                    },
                  ],
                  body: 'ok',
                }),
              }),
      }),
    deletion: async () => {
      await clearCookie(ctx.reader, ctx.readerSession, {
        name: DELETE_NAME,
        domain: ctx.domain,
        url: `${ctx.protectedOrigin}/`,
      });
      return allowedHeaderAttempt({
        client: ctx.client,
        pageSession: ctx.pageSession,
        reader: ctx.reader,
        readerSession: ctx.readerSession,
        url: ctx.plantUrl,
        transport: controlTransport,
        budget: ctx.budget,
        notes: ctx.notes,
        label: 'deletion',
        header: cookieHeader(DELETE_NAME, '', ctx.domain, 'Max-Age=0'),
        fetchReady,
        homeUrl: ctx.homeUrl,
        topLevel: false,
      });
    },
    adobe: () =>
      allowedHeaderAttempt({
        client: ctx.client,
        pageSession: ctx.pageSession,
        reader: ctx.reader,
        readerSession: ctx.readerSession,
        url: ordinaryUrl,
        transport: controlTransport,
        budget: ctx.budget,
        notes: ctx.notes,
        label: 'adobe',
        header: cookieHeader(ADOBE_NAME, `a-${ctx.tag}`, '.adobe.com'),
        fetchReady,
        homeUrl: ctx.homeUrl,
        topLevel: false,
      }),
  };
}

async function runAttempts(groups) {
  const results = {};
  for (const group of groups) {
    for (const [name, run] of Object.entries(group ?? {})) results[name] = await run();
  }
  for (const name of ALL_PATH_NAMES) if (!results[name]) results[name] = EMPTY_ATTEMPT;
  return results;
}

async function attachClientPage(client, pageTarget, internalSessions) {
  const attached = await outcome(
    client.send('Target.attachToTarget', { targetId: pageTarget, flatten: true })
  );
  if (!attached.ok && !refused(attached))
    return {
      incomplete: `client attach failed: ${attached.error?.message ?? attached.error}`,
    };
  const pageSession = attached.result?.sessionId;
  if (pageSession) {
    internalSessions.add(pageSession);
    await outcome(client.send('Page.enable', {}, pageSession));
    await outcome(client.send('Runtime.enable', {}, pageSession));
    await outcome(client.send('Network.enable', {}, pageSession));
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
    const legacy = await enableLegacy(client, pageSession);
    legacyReady = legacy.ok;
    if (legacyReady) transport.legacy = true;
  }
  return { transport, legacyReady };
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
}) {
  if (!reader) return { incomplete: 'missing unguarded reader' };
  if (!protectedOrigin) return { incomplete: 'missing protected origin' };
  if (!ordinary) return { incomplete: 'missing ordinary origin' };

  const domain = `.${hostOf(protectedOrigin)}`;
  const homeUrl = `${ordinary}/doc?n=cookie-plant-${tag}`;
  const page = await openPage(reader, homeUrl, notes, internalSessions);
  if (!page.ok) return { incomplete: `open failed: ${page.error?.message ?? page.error}` };
  if (page.result?.incomplete) return { incomplete: page.result.incomplete };
  const readerSession = page.result.sessionId;
  const pageTarget = page.result.targetId;

  const attached = await attachClientPage(client, pageTarget, internalSessions);
  if (attached.incomplete) return { incomplete: attached.incomplete, live: false };
  const pageSession = attached.pageSession;

  const readerTransport = await detectTransport(reader, readerSession, notes);
  if (!readerTransport.kind)
    return {
      incomplete:
        'neither Fetch.enable nor Network.setRequestInterception is available on the unguarded session',
      live: false,
    };

  const door = await proveDoor({
    reader,
    sessionId: readerSession,
    protectedOrigin,
    homeUrl,
    tag,
    budget,
    notes,
    transport: readerTransport,
  });
  if (!door.live) {
    await outcome(reader.send('Target.closeTarget', { targetId: pageTarget }));
    return { ...door, live: false };
  }

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

  const ctx = plantCtx({
    client,
    reader,
    pageSession,
    readerSession,
    plantUrl: `${protectedOrigin}/data?n=plant-${tag}`,
    plantCookie: {
      name: PLANT_NAME,
      value: `p-${tag}`,
      domain,
      url: `${protectedOrigin}/`,
    },
    domain,
    tag,
    protectedOrigin,
    ordinary,
    homeUrl,
    transport: enabled.transport,
    budget,
    notes,
  });

  const results = await runAttempts([
    fetchAttacks(ctx),
    legacyAttacks(ctx, enabled.legacyReady),
    controlAttacks(ctx),
  ]);

  await disableInterception(client, pageSession, enabled.transport);
  await outcome(reader.send('Target.closeTarget', { targetId: pageTarget }));
  return Object.assign(
    {
      live: true,
      control: Boolean(control),
      fetch: enabled.transport.fetch,
      legacy: enabled.legacyReady,
    },
    ...Object.entries(results).map(([name, attempt]) => flattenAttempt(name, attempt))
  );
}

export const COOKIE_PLANT_NAME = PLANT_NAME;
export const COOKIE_PLANT_ORDINARY = ORDINARY_NAME;
export const COOKIE_PLANT_ADOBE = ADOBE_NAME;
