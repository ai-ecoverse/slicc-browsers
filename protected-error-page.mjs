import { outcome } from './guard-driver.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refused = (out) => !out.ok && /^slicc: refused:/.test(out.error?.message ?? '');

async function until(check) {
  const deadline = Date.now() + 5000;
  do {
    if (await check()) return true;
    await pause(25);
  } while (Date.now() < deadline);
  return false;
}

async function loadedDocument(reader, observer, url) {
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

async function redaction({ client, targetId, failedURL, protectedOrigin, start, result }) {
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
        e.params?.targetInfo?.targetId === targetId &&
        e.params.targetInfo.url.includes(new URL(protectedOrigin).host)
    );
  result.eventsRedacted =
    targetEvents.length > 0 && targetEvents.every((e) => only(e.params.targetInfo));
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
}) {
  const initial = `${protectedOrigin}/doc?n=${tag}-history`;
  const failedURL = `${protectedOrigin}${secrets[secret](tag)}`;
  const result = {};
  const start = client.events.length;
  const { targetId } = await reader.send('Target.createTarget', { url: initial, background: true });
  let session;
  let observer;
  let failing = false;
  let cursor = reader.events.length;
  const { sessionId } = await reader.send('Target.attachToTarget', { targetId, flatten: true });
  observer = sessionId;
  internalSessions.add(observer);
  const frame = async () => (await reader.send('Page.getFrameTree', {}, observer)).frameTree.frame;
  const loaded = (url) => loadedDocument(reader, observer, url);
  let stopped = false;
  const fail = (async () => {
    while (!stopped) {
      for (const event of reader.events.slice(cursor)) {
        cursor++;
        if (event.method === 'Fetch.requestPaused' && event.sessionId === observer)
          await outcome(
            reader.send(
              failing ? 'Fetch.failRequest' : 'Fetch.continueRequest',
              failing
                ? { requestId: event.params.requestId, errorReason: 'BlockedByClient' }
                : { requestId: event.params.requestId },
              observer
            )
          );
      }
      await pause(5);
    }
  })();
  try {
    await reader.send('Page.enable', {}, observer);
    if (!(await loaded(initial)))
      throw new Error('protected-error-page: history seed did not commit');
    await reader.send('Page.navigate', { url: `${ordinary}/blank` }, observer);
    if (!(await loaded(`${ordinary}/blank`)))
      throw new Error('protected-error-page: allowed document did not commit');
    const attached = await outcome(
      client.send('Target.attachToTarget', { targetId, flatten: true })
    );
    session = attached.result?.sessionId;
    if (!session) return { live: false, attached: false };
    await client.send('Page.enable', {}, session);
    await client.send('Runtime.enable', {}, session);
    await client.send('Target.setDiscoverTargets', { discover: true });
    if (side === 'control') {
      failing = true;
      await reader.send(
        'Fetch.enable',
        { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] },
        observer
      );
    }
    await client.send(
      'Runtime.evaluate',
      { expression: `setTimeout(()=>location.href=${JSON.stringify(failedURL)},0)` },
      session
    );
    result.live = await until(async () => {
      const f = await frame();
      const { targetInfo } = await reader.send('Target.getTargetInfo', { targetId });
      result.evidence = { frame: f, targetInfo };
      return (
        f.url === 'chrome-error://chromewebdata/' &&
        f.securityOrigin === '://' &&
        f.unreachableUrl === failedURL &&
        targetInfo.url === failedURL
      );
    });
    if (!result.live && side !== 'control') return result;
    if (!result.live)
      throw new Error(
        `protected-error-page: missing error commit ${JSON.stringify(result.evidence)}`
      );
    await redaction({ client, targetId, failedURL, protectedOrigin, start, result });
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
      if (result.blank) {
        await client.send(
          'Runtime.evaluate',
          { expression: `setTimeout(()=>location.href=${JSON.stringify(failedURL)},0)` },
          session
        );
        result.closeError = await until(async () => (await frame()).unreachableUrl === failedURL);
      }
      result.attached &&= !client.events
        .slice(start)
        .some((e) => e.method === 'Target.detachedFromTarget' && e.params.sessionId === session);
      const close = await outcome(client.send('Target.closeTarget', { targetId }));
      result.close = result.closeError === true && close.result?.success === true;
      return result;
    }
    if (side === 'control') await reader.send('Fetch.disable', {}, observer);
    failing = false;
    const { entries, currentIndex } = await reader.send('Page.getNavigationHistory', {}, observer);
    const index = entries.findIndex((e) => e.url === initial);
    if (index < 0) throw new Error('protected-error-page: missing protected history');
    const beforeRestore = reader.events.length;
    await reader.send(
      'Runtime.evaluate',
      { expression: `setTimeout(() => history.go(${index - currentIndex}), 0)` },
      observer
    );
    result.restored = await until(() =>
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
    if (!result.restored)
      throw new Error('protected-error-page: real protected BFCache restore required');
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
      result.stickyError = await until(async () => (await frame()).unreachableUrl === failedURL);
      if (!result.stickyError)
        throw new Error(
          `protected-error-page: missing sticky error ${JSON.stringify(await frame())}`
        );
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
