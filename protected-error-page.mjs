import { outcome, parseURL, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refused = (out) => !out.ok && /^slicc: refused:/.test(out.error?.message ?? '');

function attachOutcome(out) {
  if (out.ok) return { outcome: 'answered', sessionId: Boolean(out.result?.sessionId) };
  return {
    outcome: refused(out) ? 'refused' : 'error',
    error: String(out.error?.message ?? out.error),
  };
}

const attachWhy = ({ outcome: kind, error }) =>
  kind === 'answered'
    ? 'client attach answered without a sessionId'
    : `client attach ${kind === 'refused' ? 'refused' : 'failed'}: ${error}`;

const commitWhy = ({ elapsedMs, budgetMs, frame, targetInfo }) =>
  `error commit not seen after ${elapsedMs}ms (budget ${budgetMs}ms): frame ${frame.url} unreachableUrl ${frame.unreachableUrl ?? 'none'}, target ${targetInfo.url}`;

async function loadedDocument(reader, observer, url, until) {
  return until(async () => {
    const { frameTree } = await reader.send('Page.getFrameTree', {}, observer);
    if (frameTree.frame.url !== url || frameTree.frame.unreachableUrl) return false;
    const ready = await outcome(
      reader.send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        observer
      )
    );
    return ready.result?.result?.value === 'complete';
  });
}

async function lockChecks({ client, session, targetId, result }) {
  result.evaluateRefused = refused(
    await outcome(
      client.send(
        'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true },
        session
      )
    )
  );
  result.attachRefused = refused(
    await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }))
  );
  result.closeRefused = refused(await outcome(client.send('Target.closeTarget', { targetId })));
}

const discoveryMethods = ['Target.targetCreated', 'Target.targetInfoChanged'];
const lower = (value) => String(value ?? '').toLowerCase();
const plain = (value) =>
  lower(
    String(value ?? '').replace(/%([0-9a-f]{2})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
  );
const utf8 = (value) =>
  lower(
    value.replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
      new TextDecoder().decode(
        Uint8Array.from(run.slice(1).split('%'), (hex) => Number.parseInt(hex, 16))
      )
    )
  );
const ignored = (form) => form.replace(/[\t\n\r]/g, '');
const readings = (value) =>
  [
    [(form) => form, plain],
    [ignored, plain],
    [ignored, utf8],
  ].map(([read, decode]) => {
    const out = [read(lower(value))];
    for (let next = read(decode(out[0])); next !== out.at(-1); next = read(decode(next)))
      out.push(next);
    return out;
  });
const layers = (value) => readings(value).flat();
const unschemed = (value) => value.replace(/^[a-z][a-z\d+.-]*:\/\//, '');

const encoded = (url) =>
  Array.from(
    new TextEncoder().encode(url),
    (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  ).join('');

const triggerURL = (ordinary, url) => `${ordinary}/page?k=deferred&defer=0&to=${encoded(url)}`;

const errorPageURL = 'chrome-error://chromewebdata/';
const privateBlankURL = 'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E';

function failureRules({ failedURL, tag }) {
  const failed = new URL(failedURL);
  const { origin, hostname } = failed;
  const parts = [
    failedURL,
    `${failed.pathname}${failed.search}${failed.hash}`,
    failed.pathname,
    failed.search.slice(1),
    failed.hash.slice(1),
    tag,
  ]
    .filter((part) => part && part !== '/')
    .map(plain);
  const leaks = (value) => layers(value).some((form) => parts.some((part) => form.includes(part)));
  const names = (value) =>
    layers(value).some((form) => form.includes(hostname)) || parseURL(value)?.origin === origin;
  const carries = (value) => layers(value).some((form) => form.includes(plain(tag)));
  return { failed, leaks, names, carries };
}

function discoveryRules({ failedURL, tag, trigger }) {
  const { failed, leaks, names, carries } = failureRules({ failedURL, tag });
  const { origin, host, hostname } = failed;
  const named = [hostname, host, origin];
  const cleanTitle = ({ title, url }) =>
    !leaks(title) &&
    (!names(title) ||
      named.includes(lower(title)) ||
      (!layers(url).includes(origin) && referenced(title)));
  const ownTitle = ({ url, title }) =>
    plain(title) !== '' && [plain(url), unschemed(plain(url))].includes(plain(title));
  const inner = (u) => (u && !u.host ? inner(parseURL(u.pathname)) : u);
  const onHost = (u) => u?.hostname.replace(/\.$/, '') === hostname;
  const pattern = /(?:[a-z][a-z\d+.-]*:)+[\\/]*[^\\/?#&\s]*|[\\/]{2}[^\\/?#&\s]*/g;
  const spaced = (form) => Array.from(form, (c) => (c > ' ' ? c : ' ')).join('');
  const resolve = (ref) => inner(parseURL(ref, /^[\\/]/.test(ref) ? origin : undefined));
  const fine = (text) =>
    Array.from(text.matchAll(pattern), ([ref]) => resolve(ref)).every(
      (u) => !onHost(u) || u.origin === origin
    );
  const exact = (form) =>
    form === origin || (!onHost(inner(parseURL(form))) && fine(form) && fine(spaced(form)));
  const bare = (form) =>
    !spaced(form)
      .replace(pattern, (ref) => (onHost(resolve(ref)) ? ref.replace(hostname, ' ') : ref))
      .includes(hostname);
  const referenced = (title) =>
    layers(title).every(exact) && readings(title).every((read) => bare(read.at(-1)));
  const cleanURL = (url) => !leaks(url) && layers(url).every(exact);
  const home = parseURL(trigger)?.href;
  const clean = (info) => {
    if (parseURL(info.url)?.href === home) return ownTitle(info) || cleanTitle(info);
    return cleanURL(info.url) && (cleanTitle(info) || (ownTitle(info) && !leaks(info.title)));
  };
  return { clean, carries };
}

function eventsRedacted({ events, targetId, start, ...failure }) {
  const { clean, carries } = discoveryRules(failure);
  return events
    .slice(start)
    .filter((e) => discoveryMethods.includes(e.method))
    .every((e) =>
      e.params?.targetInfo?.targetId === targetId
        ? clean(e.params.targetInfo)
        : !carries(JSON.stringify(e.params ?? null))
    );
}

async function privateBlank({ frame, reader, observer, targetId, failedURL, tag }) {
  const { leaks, names } = failureRules({ failedURL, tag });
  if (frame.url !== privateBlankURL || frame.unreachableUrl) return false;
  const { targetInfo } = await reader.send('Target.getTargetInfo', { targetId });
  if (targetInfo.url !== privateBlankURL) return false;
  const read = async (expression) => {
    const out = await outcome(
      reader.send('Runtime.evaluate', { expression, returnByValue: true }, observer)
    );
    const value = out.result?.result?.value;
    return out.ok && !out.result.exceptionDetails && typeof value === 'string' ? value : undefined;
  };
  const href = await read('location.href');
  const title = await read('document.title');
  if (href === undefined || title === undefined) return 'incomplete';
  return (
    href === privateBlankURL &&
    ![targetInfo.title, title].some((value) => leaks(value) || names(value))
  );
}

async function redaction({ client, targetId, failedURL, ordinary, tag, start, result, discovery }) {
  const info = await outcome(client.send('Target.getTargetInfo', { targetId }));
  const list = await outcome(client.send('Target.getTargets'));
  const before = client.events.length;
  const again = await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }));
  const origin = new URL(failedURL).origin;
  const only = (i) => i?.url === origin && i.title === origin;
  const listed = list.ok ? list.result.targetInfos.find((i) => i.targetId === targetId) : undefined;
  await pause(100);
  const attachedInfo = client.events
    .slice(before)
    .find(
      (e) =>
        e.method === 'Target.attachedToTarget' && e.params.sessionId === again.result?.sessionId
    )?.params.targetInfo;
  if (again.ok)
    await outcome(client.send('Target.detachFromTarget', { sessionId: again.result.sessionId }));
  result.infoRedacted = info.ok && only(info.result.targetInfo);
  result.listRedacted = only(listed);
  result.attachRedacted = only(attachedInfo);
  result.fullURL =
    info.result?.targetInfo?.url === failedURL &&
    listed?.url === failedURL &&
    attachedInfo?.url === failedURL;
  result.eventsRedacted = discovery
    ? eventsRedacted({
        events: client.events,
        targetId,
        start,
        failedURL,
        tag,
        trigger: triggerURL(ordinary, failedURL),
      })
    : 'not-supported';
}

async function observerTarget(reader, initial, notes) {
  const { targetId } = await createObserverTarget(
    reader,
    { url: initial, background: true },
    notes
  );
  const attached = await outcome(reader.send('Target.attachToTarget', { targetId, flatten: true }));
  if (attached.ok) return { targetId, sessionId: attached.result.sessionId };
  await outcome(reader.send('Target.closeTarget', { targetId }));
  throw new Error(attached.error.message);
}

async function seed(reader, observer, loaded, initial, allowed) {
  const out = await outcome(
    (async () => {
      await reader.send('Page.enable', {}, observer);
      if (!(await loaded(initial))) return 'history seed did not commit';
      await reader.send('Page.navigate', { url: allowed }, observer);
      if (!(await loaded(allowed))) return 'allowed document did not commit';
    })()
  );
  return out.ok ? out.result : `observer setup failed: ${out.error.message}`;
}

async function scripted(client, session, ordinary, url) {
  const out = await outcome(
    client.send('Page.navigate', { url: triggerURL(ordinary, url) }, session)
  );
  return out.ok ? undefined : `client navigation failed: ${out.error.message}`;
}

async function recover({ client, session, targetId, ordinary, failedURL, start, result, reached }) {
  if (result.blank) {
    const unsent = await scripted(client, session, ordinary, failedURL);
    if (unsent) return unsent;
    result.closeError = await reached();
  }
  result.attached &&= !client.events
    .slice(start)
    .some((e) => e.method === 'Target.detachedFromTarget' && e.params.sessionId === session);
  const close = await outcome(client.send('Target.closeTarget', { targetId }));
  result.close = result.closeError === true && close.result?.success === true;
}

function answer(event, failing, origin) {
  const { requestId, request } = event.params;
  return failing && parseURL(request?.url)?.origin === origin
    ? ['Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }]
    : ['Fetch.continueRequest', { requestId }];
}

const secrets = {
  all: (tag) => `/doc/path-secret-${tag}?query-secret=${tag}#fragment-secret-${tag}`,
  query: (tag) => `/doc?query-secret=${tag}`,
  fragment: (tag) => `/doc#fragment-secret-${tag}`,
};

export async function protectedErrorPage({
  client,
  reader,
  ordinary,
  protectedOrigin,
  tag,
  mode,
  side,
  internalSessions = new Set(),
  secret = 'all',
  discovery = true,
  notes = [],
  budget = 5000,
}) {
  const initial = `${protectedOrigin}/doc?n=${tag}-history`;
  const failedURL = `${protectedOrigin}${secrets[secret](tag)}`;
  const origin = parseURL(protectedOrigin)?.origin;
  const result = {};
  const until = (check) => waitFor(check, budget);
  const missing = (reason) => ({ ...result, incomplete: `protected-error-page: ${reason}` });
  if (!discovery) notes.push('eventsRedacted: not-supported:discovery');
  const start = client.events.length;
  let cursor = reader.events.length;
  const opened = await outcome(observerTarget(reader, initial, notes));
  if (!opened.ok) return missing(`observer setup failed: ${opened.error.message}`);
  const { targetId } = opened.result;
  let session;
  let observer = opened.result.sessionId;
  let failing = false;
  internalSessions.add(observer);
  const frame = async () => (await reader.send('Page.getFrameTree', {}, observer)).frameTree.frame;
  const loaded = (url) => loadedDocument(reader, observer, url, until);
  let stopped = false;
  const fail = (async () => {
    while (!stopped) {
      for (const event of reader.events.slice(cursor)) {
        cursor++;
        if (event.method === 'Fetch.requestPaused' && event.sessionId === observer)
          await outcome(reader.send(...answer(event, failing, origin), observer));
      }
      await pause(5);
    }
  })();
  try {
    const unseeded = await seed(reader, observer, loaded, initial, `${ordinary}/blank`);
    if (unseeded) return missing(unseeded);
    const attached = await outcome(
      client.send('Target.attachToTarget', { targetId, flatten: true })
    );
    session = attached.result?.sessionId;
    result.diagnostics = { clientAttach: attachOutcome(attached) };
    if (!session)
      return {
        ...result,
        live: false,
        attached: false,
        liveWhy: attachWhy(result.diagnostics.clientAttach),
      };
    await client.send('Page.enable', {}, session);
    await client.send('Runtime.enable', {}, session);
    if (discovery) await client.send('Target.setDiscoverTargets', { discover: true });
    if (side === 'control') {
      failing = true;
      await reader.send(
        'Fetch.enable',
        { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] },
        observer
      );
    }
    await outcome(reader.send('Page.bringToFront', {}, observer));
    const unsent = await scripted(client, session, ordinary, failedURL);
    if (unsent) return missing(unsent);
    let evidence;
    const waited = Date.now();
    const live = await until(async () => {
      const f = await frame();
      const { targetInfo } = await reader.send('Target.getTargetInfo', { targetId });
      evidence = { frame: f, targetInfo };
      return (
        f.url === errorPageURL &&
        f.securityOrigin === '://' &&
        f.unreachableUrl === failedURL &&
        targetInfo.url === failedURL
      );
    });
    result.evidence = evidence;
    result.diagnostics.errorCommit = {
      seen: live,
      elapsedMs: Date.now() - waited,
      budgetMs: budget,
      ...evidence,
    };
    if (!live && side === 'control')
      return missing(`missing error commit ${JSON.stringify(evidence)}`);
    result.live = live;
    if (!live) return { ...result, liveWhy: commitWhy(result.diagnostics.errorCommit) };
    await redaction({ client, targetId, failedURL, ordinary, tag, start, result, discovery });
    const beforeReload = (await frame()).loaderId;
    result.reload = (await outcome(client.send('Page.reload', {}, session))).ok;
    if (result.reload) {
      result.reload = await until(async () => {
        const f = await frame();
        result.reloadedError =
          f.loaderId !== beforeReload && f.url === errorPageURL && f.unreachableUrl === failedURL;
        result.reloadedBlank =
          !result.reloadedError &&
          side === 'guarded' &&
          (await privateBlank({ frame: f, reader, observer, targetId, failedURL, tag }));
        return result.reloadedError || result.reloadedBlank === true;
      });
      if (!result.reload && result.reloadedBlank === 'incomplete') {
        result.reload = 'incomplete';
        result.incomplete = 'protected-error-page: the private blank page could not be read';
      }
    }
    const recovery = `${ordinary}/blank?n=${tag}-recover`;
    result.blank = (await outcome(client.send('Page.navigate', { url: recovery }, session))).ok;
    if (result.blank) result.blank = await loaded(recovery);
    result.attached = !client.events
      .slice(start)
      .some((e) => e.method === 'Target.detachedFromTarget' && e.params.sessionId === session);
    if (mode === 'recover') {
      const unclosed = await recover({
        client,
        session,
        targetId,
        ordinary,
        failedURL,
        start,
        result,
        reached: () => until(async () => (await frame()).unreachableUrl === failedURL),
      });
      return unclosed ? missing(unclosed) : result;
    }
    if (side === 'control') await reader.send('Fetch.disable', {}, observer);
    failing = false;
    const { entries } = await reader.send('Page.getNavigationHistory', {}, observer);
    const entry = entries.find((e) => e.url === initial);
    if (!entry) return missing('missing protected history');
    const beforeRestore = reader.events.length;
    await outcome(reader.send('Page.navigateToHistoryEntry', { entryId: entry.id }, observer));
    const restored = await until(() =>
      reader.events
        .slice(beforeRestore)
        .some(
          (e) =>
            e.sessionId === observer &&
            e.method === 'Page.frameNavigated' &&
            e.params.type === 'BackForwardCacheRestore' &&
            e.params.frame.url === initial
        )
    );
    if (!restored) return missing('real protected BFCache restore required');
    result.restored = true;
    await pause(100);
    if (mode === 'sticky') {
      await reader.send('Target.detachFromTarget', { sessionId: observer });
      observer = (await reader.send('Target.attachToTarget', { targetId, flatten: true }))
        .sessionId;
      internalSessions.add(observer);
      failing = true;
      await reader.send(
        'Fetch.enable',
        { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] },
        observer
      );
      await reader.send('Page.navigate', { url: failedURL }, observer);
      if (!(await until(async () => (await frame()).unreachableUrl === failedURL)))
        return missing(`missing sticky error ${JSON.stringify(await frame())}`);
      result.stickyError = true;
      await pause(100);
    }
    await lockChecks({ client, session, targetId, result });
    return result;
  } finally {
    stopped = true;
    await fail;
    await outcome(reader.send('Target.closeTarget', { targetId }));
  }
}
