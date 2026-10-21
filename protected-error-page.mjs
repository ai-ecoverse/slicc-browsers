import { outcome, parseURL, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refused = (out) => !out.ok && /^slicc: refused:/.test(out.error?.message ?? '');

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

async function redaction({
  client,
  targetId,
  failedURL,
  protectedOrigin,
  start,
  result,
  discovery,
}) {
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
  const targetEvents = client.events
    .slice(start)
    .filter(
      (e) =>
        ['Target.targetCreated', 'Target.targetInfoChanged'].includes(e.method) &&
        e.params?.targetInfo?.targetId === targetId &&
        e.params.targetInfo.url.includes(new URL(protectedOrigin).host)
    );
  result.eventsRedacted = discovery
    ? targetEvents.length > 0 && targetEvents.every((e) => only(e.params.targetInfo))
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

const encoded = (url) =>
  Array.from(
    new TextEncoder().encode(url),
    (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  ).join('');

async function scripted(client, session, ordinary, url) {
  const out = await outcome(
    client.send(
      'Page.navigate',
      { url: `${ordinary}/page?k=deferred&defer=0&to=${encoded(url)}` },
      session
    )
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
    if (!session) return { live: false, attached: false };
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
    const unsent = await scripted(client, session, ordinary, failedURL);
    if (unsent) return missing(unsent);
    let evidence;
    const live = await until(async () => {
      const f = await frame();
      const { targetInfo } = await reader.send('Target.getTargetInfo', { targetId });
      evidence = { frame: f, targetInfo };
      return (
        f.url === 'chrome-error://chromewebdata/' &&
        f.securityOrigin === '://' &&
        f.unreachableUrl === failedURL &&
        targetInfo.url === failedURL
      );
    });
    result.evidence = evidence;
    if (!live && side === 'control')
      return missing(`missing error commit ${JSON.stringify(evidence)}`);
    result.live = live;
    if (!live) return result;
    await redaction({ client, targetId, failedURL, protectedOrigin, start, result, discovery });
    const beforeReload = (await frame()).loaderId;
    result.reload = (await outcome(client.send('Page.reload', {}, session))).ok;
    if (result.reload) {
      result.reloadedError = await until(async () => {
        const f = await frame();
        return f.loaderId !== beforeReload && f.unreachableUrl === failedURL;
      });
      result.reload = result.reloadedError;
    }
    result.blank = (
      await outcome(client.send('Page.navigate', { url: 'about:blank' }, session))
    ).ok;
    if (result.blank) result.blank = await loaded('about:blank');
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
