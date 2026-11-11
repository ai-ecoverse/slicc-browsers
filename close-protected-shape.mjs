import { outcome, parseURL, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refused = (out) => !out.ok && /^slicc: refused:/.test(out.error?.message ?? '');

const peel = (text) => {
  let u = parseURL(text);
  for (
    let i = 0;
    u && ['blob', 'filesystem', 'view-source'].includes(u.protocol.slice(0, -1)) && i < 8;
    i++
  )
    u = parseURL(u.href.slice(u.protocol.length));
  return u;
};

const hostOf = (u) => {
  const host = (u?.hostname ?? '').toLowerCase();
  return host.endsWith('.') ? host.slice(0, -1) : host;
};

export function keptDocument(text) {
  const u = peel(text);
  if (!u || !['http:', 'https:'].includes(u.protocol)) return false;
  const host = hostOf(u);
  if (host === 'vault.sliccy.ai' || (host.startsWith('vault-') && host.endsWith('.sliccy.ai')))
    return true;
  const path = u.pathname || '/';
  return host === 'seven.sliccy.ai' && path.startsWith('/os/') && path !== '/os/callback.html';
}

export function keptSecurityOrigin(url, origin) {
  if (keptDocument(origin)) return true;
  const u = parseURL(url);
  const opaque =
    u?.protocol === 'about:' && ['blank', 'srcdoc'].includes((u.pathname || '').toLowerCase());
  if (!opaque) return false;
  const o = peel(origin);
  if (!o || !['http:', 'https:'].includes(o.protocol)) return false;
  const host = hostOf(o);
  return (
    host === 'seven.sliccy.ai' ||
    host === 'vault.sliccy.ai' ||
    (host.startsWith('vault-') && host.endsWith('.sliccy.ai'))
  );
}

export function unclosableShape({ url, documentURL, securityOrigin, navigating, navigationURL }) {
  if (navigating && (!navigationURL || keptDocument(navigationURL))) return true;
  const error =
    documentURL === 'chrome-error://chromewebdata/' ||
    (typeof documentURL === 'string' && documentURL.startsWith('chrome-error:'));
  const keptNow =
    keptDocument(url) ||
    keptDocument(documentURL) ||
    keptSecurityOrigin(documentURL ?? url, securityOrigin ?? '');
  if (!keptNow) return false;
  if (!error) return true;
  return keptDocument(documentURL) || keptSecurityOrigin(documentURL, securityOrigin ?? '');
}

async function lockChecks({
  client,
  reader,
  session,
  targetId,
  result,
  until,
  closeOnly,
  skipEvaluate,
}) {
  if (!closeOnly) {
    if (session && !skipEvaluate) {
      result.evaluateRefused = refused(
        await outcome(
          client.send(
            'Runtime.evaluate',
            { expression: 'document.title', returnByValue: true },
            session
          )
        )
      );
    }
    result.attachRefused = refused(
      await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }))
    );
  }
  const close = await outcome(client.send('Target.closeTarget', { targetId }));
  result.closeRefused = refused(close);
  result.closed =
    close.result?.success === true &&
    (await until(
      async () =>
        !(await reader.send('Target.getTargets')).targetInfos.some((i) => i.targetId === targetId)
    ));
}

async function attachClient(client, targetId) {
  const attached = await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }));
  const session = attached.result?.sessionId;
  if (session) {
    await outcome(client.send('Page.enable', {}, session));
    await outcome(client.send('Runtime.enable', {}, session));
  }
  return { session, attachRefused: refused(attached) };
}

async function observerPage(reader, url, notes, internalSessions) {
  const opened = await outcome(
    createObserverTarget(reader, { url }, notes).then(async (created) => {
      const { sessionId } = await reader.send('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      });
      await reader.send('Page.enable', {}, sessionId);
      await reader.send('Runtime.enable', {}, sessionId);
      return { targetId: created.targetId, sessionId };
    })
  );
  if (!opened.ok) return opened;
  internalSessions.add(opened.result.sessionId);
  return opened;
}

function noteShape(notes, label, evidence) {
  notes.push(`${label}: ${JSON.stringify(evidence)}`);
}

async function shapeViewSource({ reader, shapedURL, notes, internalSessions, until }) {
  const opened = await observerPage(reader, 'about:blank', notes, internalSessions);
  if (!opened.ok) return opened;
  const { targetId, sessionId } = opened.result;
  await reader.send('Page.navigate', { url: shapedURL }, sessionId);
  let info;
  const live = await until(async () => {
    ({ targetInfo: info } = await reader.send('Target.getTargetInfo', { targetId }));
    return info.url === shapedURL || info.url.startsWith('view-source:');
  });
  noteShape(notes, 'view-source', {
    targetId,
    type: info?.type,
    url: info?.url,
  });
  return { ok: true, result: { targetId, sessionId, live, shaped: live } };
}

async function shapeBlob({ reader, origin, tag, notes, internalSessions, until }) {
  const page = `${origin}/blob-nav?n=${encodeURIComponent(tag)}`;
  const opened = await observerPage(reader, page, notes, internalSessions);
  if (!opened.ok) return opened;
  const { targetId, sessionId } = opened.result;
  let info;
  const live = await until(async () => {
    ({ targetInfo: info } = await reader.send('Target.getTargetInfo', { targetId }));
    return info.url.startsWith('blob:');
  });
  noteShape(notes, 'blob', { targetId, type: info?.type, url: info?.url });
  return { ok: true, result: { targetId, sessionId, live, shaped: live } };
}

async function shapeUserinfo({ reader, shapedURL, notes, internalSessions, until }) {
  const opened = await observerPage(reader, 'about:blank', notes, internalSessions);
  if (!opened.ok) return opened;
  const { targetId, sessionId } = opened.result;
  await reader.send('Page.navigate', { url: shapedURL }, sessionId);
  let info;
  let frame;
  const live = await until(async () => {
    ({
      frameTree: { frame },
    } = await reader.send('Page.getFrameTree', {}, sessionId));
    ({ targetInfo: info } = await reader.send('Target.getTargetInfo', { targetId }));
    return (
      info.url.includes('@') &&
      info.url.includes('/os/') &&
      frame.url.includes('@') &&
      !frame.unreachableUrl
    );
  });
  noteShape(notes, 'userinfo', {
    targetId,
    type: info?.type,
    url: info?.url,
    frameUrl: frame?.url,
    hasUserinfo: Boolean(info?.url?.includes('@')),
  });
  if (!live && info?.url?.includes('/os/') && !info.url.includes('@'))
    return {
      ok: true,
      result: {
        targetId,
        sessionId,
        live: false,
        shaped: false,
        incomplete: 'userinfo stripped from top-level target URL',
      },
    };
  return { ok: true, result: { targetId, sessionId, live, shaped: live } };
}

async function shapeNavigating({
  reader,
  ordinary,
  destination,
  notes,
  internalSessions,
  hold,
  budget,
}) {
  const start = `${ordinary}/blank?n=close-nav-start`;
  const opened = await observerPage(reader, start, notes, internalSessions);
  if (!opened.ok) return opened;
  const { targetId, sessionId } = opened.result;
  const sequence = [];
  let paused;
  const waiter = new Promise((resolve) => {
    paused = resolve;
  });
  const matchPause = (event) => {
    if (event.method !== 'Fetch.requestPaused') return false;
    if (event.params.resourceType !== 'Document') return false;
    const url = event.params.request?.url ?? '';
    return url === destination || /(?:\?|&)hold=1(?:&|$)/.test(url) || keptDocument(url);
  };
  let cursor = reader.events.length;
  let stopped = false;
  const pump = (async () => {
    while (!stopped) {
      for (const event of reader.events.slice(cursor)) {
        cursor++;
        if (
          event.method === 'Fetch.requestPaused' ||
          event.method === 'Page.frameStartedNavigating' ||
          event.method === 'Page.frameNavigated'
        )
          sequence.push({
            method: event.method,
            sessionId: event.sessionId,
            url: event.params.request?.url ?? event.params.url ?? event.params.frame?.url,
            resourceType: event.params.resourceType,
          });
        if (matchPause(event)) {
          paused({
            requestId: event.params.requestId,
            sessionId: event.sessionId,
            url: event.params.request?.url,
          });
          return;
        }
      }
      await pause(5);
    }
  })();
  await reader.send(
    'Fetch.enable',
    {
      patterns: [
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Request' },
      ],
    },
    sessionId
  );
  const nav = outcome(reader.send('Page.navigate', { url: destination }, sessionId));
  const waitBudget = Math.min(budget, 4000);
  const held = await Promise.race([waiter, pause(waitBudget).then(() => undefined)]);
  const { targetInfo } = await reader.send('Target.getTargetInfo', { targetId });
  const stillStart =
    targetInfo.url === start || targetInfo.url === 'about:blank' || !keptDocument(targetInfo.url);
  const shaped = Boolean(held?.requestId) && stillStart;
  noteShape(notes, 'navigating', {
    targetId,
    type: targetInfo.type,
    url: targetInfo.url,
    openerId: targetInfo.openerId,
    pendingUrl: destination,
    fetchPaused: Boolean(held?.requestId),
    pausedUrl: held?.url,
    pausedSession: held?.sessionId,
    observerSession: sessionId,
    heldMs: waitBudget,
    releasedAfterClose: true,
    sequence,
  });
  hold.release = async () => {
    stopped = true;
    if (held?.requestId)
      await outcome(
        reader.send('Fetch.continueRequest', { requestId: held.requestId }, held.sessionId)
      );
    await Promise.race([Promise.allSettled([pump, nav]), pause(50)]);
  };
  return {
    ok: true,
    result: {
      targetId,
      sessionId,
      live: shaped,
      shaped,
      navigating: true,
      navigationURL: destination,
      closeOnly: true,
    },
  };
}

async function shapeBlankInherited({ reader, origin, tag, notes, internalSessions, until }) {
  const page = `${origin}/blank-open?n=${encodeURIComponent(tag)}`;
  const opened = await observerPage(reader, page, notes, internalSessions);
  if (!opened.ok) return opened;
  const parent = opened.result;
  const before = new Set(
    (await reader.send('Target.getTargets')).targetInfos.map((info) => info.targetId)
  );
  const openedBlank = await outcome(
    reader.send(
      'Runtime.evaluate',
      { expression: "window.open('')", returnByValue: true, userGesture: true },
      parent.sessionId
    )
  );
  if (!openedBlank.ok)
    return {
      ok: true,
      result: {
        targetId: parent.targetId,
        sessionId: parent.sessionId,
        live: false,
        shaped: false,
        incomplete: `window.open failed: ${openedBlank.error?.message ?? openedBlank.error}`,
      },
    };
  let child;
  const found = await until(async () => {
    const listed = await reader.send('Target.getTargets');
    child = listed.targetInfos.find(
      (info) =>
        !before.has(info.targetId) &&
        info.type === 'page' &&
        (info.url === 'about:blank' || info.url === '') &&
        info.openerId === parent.targetId
    );
    return Boolean(child);
  });
  if (!found) {
    noteShape(notes, 'blank-inherited', {
      parentId: parent.targetId,
      popup: null,
      reason: 'no about:blank page target with opener',
    });
    return {
      ok: true,
      result: {
        targetId: parent.targetId,
        sessionId: parent.sessionId,
        live: false,
        shaped: false,
        incomplete: 'about:blank popup with opener was not created',
      },
    };
  }
  const { sessionId } = await reader.send('Target.attachToTarget', {
    targetId: child.targetId,
    flatten: true,
  });
  internalSessions.add(sessionId);
  await reader.send('Page.enable', {}, sessionId);
  let securityOrigin;
  try {
    const { frameTree } = await reader.send('Page.getFrameTree', {}, sessionId);
    securityOrigin = frameTree.frame.securityOrigin;
  } catch {
    securityOrigin = undefined;
  }
  const originMatch =
    securityOrigin === origin ||
    securityOrigin === parseURL(origin)?.origin ||
    child.openerId === parent.targetId;
  noteShape(notes, 'blank-inherited', {
    targetId: child.targetId,
    type: child.type,
    url: child.url,
    openerId: child.openerId,
    parentId: parent.targetId,
    securityOrigin,
  });
  return {
    ok: true,
    result: {
      targetId: child.targetId,
      sessionId,
      parentId: parent.targetId,
      live: originMatch,
      shaped: originMatch,
      securityOrigin,
    },
  };
}

export async function closeProtectedShape({
  client,
  reader,
  ordinary,
  protectedOrigin,
  shape,
  tag,
  internalSessions = new Set(),
  notes = [],
  budget = 5000,
}) {
  const until = (check) => waitFor(check, budget);
  const result = {};
  const missing = (reason) => ({ ...result, incomplete: `close-protected-shape: ${reason}` });
  const origin = protectedOrigin;
  const hold = {};
  let shaped;
  if (shape === 'view-source') {
    shaped = await shapeViewSource({
      reader,
      shapedURL: `view-source:${origin}/doc?n=${encodeURIComponent(tag)}`,
      notes,
      internalSessions,
      until,
    });
  } else if (shape === 'blob') {
    shaped = await shapeBlob({ reader, origin, tag, notes, internalSessions, until });
  } else if (shape === 'userinfo') {
    const host = parseURL(origin)?.host;
    const shapedURL = `${parseURL(origin)?.protocol}//user:pass@${host}/os/index.html?n=${encodeURIComponent(tag)}`;
    shaped = await shapeUserinfo({ reader, shapedURL, notes, internalSessions, until });
  } else if (shape === 'navigating') {
    shaped = await shapeNavigating({
      reader,
      ordinary,
      destination: `${origin}/doc?n=${encodeURIComponent(tag)}&hold=1`,
      notes,
      internalSessions,
      hold,
      budget,
    });
  } else if (shape === 'blank-inherited') {
    shaped = await shapeBlankInherited({ reader, origin, tag, notes, internalSessions, until });
  } else {
    return missing(`unknown shape ${shape}`);
  }
  if (!shaped.ok) return missing(`observer setup failed: ${shaped.error?.message ?? shaped.error}`);
  if (shaped.result.incomplete) return missing(shaped.result.incomplete);
  Object.assign(result, {
    shaped: shaped.result.shaped,
    live: shaped.result.live,
  });
  if (!shaped.result.live) return missing(`shape ${shape} did not appear`);
  const { targetId } = shaped.result;
  const closeOnly = shaped.result.closeOnly === true;
  const skipEvaluate = shape === 'blank-inherited';
  const { session, attachRefused } = await attachClient(client, targetId);
  if (!session) {
    if (!closeOnly) {
      result.attachRefused = attachRefused;
      if (!skipEvaluate) result.evaluateRefused = attachRefused;
    }
    const close = await outcome(client.send('Target.closeTarget', { targetId }));
    result.closeRefused = refused(close);
    result.closed =
      close.result?.success === true &&
      (await until(
        async () =>
          !(await reader.send('Target.getTargets')).targetInfos.some((i) => i.targetId === targetId)
      ));
    await hold.release?.();
    await outcome(reader.send('Target.closeTarget', { targetId }));
    if (shaped.result.parentId)
      await outcome(reader.send('Target.closeTarget', { targetId: shaped.result.parentId }));
    return result;
  }
  try {
    await lockChecks({
      client,
      reader,
      session,
      targetId,
      result,
      until,
      closeOnly,
      skipEvaluate,
    });
    return result;
  } finally {
    await hold.release?.();
    await outcome(reader.send('Target.closeTarget', { targetId }));
    if (shaped.result.parentId)
      await outcome(reader.send('Target.closeTarget', { targetId: shaped.result.parentId }));
  }
}
