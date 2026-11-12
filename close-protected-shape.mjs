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
  attachRefused,
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
    result.attachRefused = attachRefused;
  }
  await measureClose({ client, reader, targetId, result, until });
}

async function measureClose({ client, reader, targetId, result, until }) {
  const close = await outcome(client.send('Target.closeTarget', { targetId }));
  const gone = await until(
    async () =>
      !(await reader.send('Target.getTargets')).targetInfos.some((i) => i.targetId === targetId)
  );
  result.closed = gone;
  result.closeRefused = refused(close) && !gone;
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
      result: { incomplete: 'userinfo stripped from top-level target URL' },
    };
  return { ok: true, result: { targetId, sessionId, live, shaped: live } };
}

const raced = (promise, ms) => Promise.race([promise, pause(ms).then(() => undefined)]);

async function shapeNavigating({
  reader,
  ordinary,
  destination,
  notes,
  internalSessions,
  hold,
  releaseSlow,
  tag,
}) {
  const started = Date.now();
  const waitBudget = 8000;
  const start = `${ordinary}/blank?n=close-nav-start`;
  notes.push(`navigating.start: destination=${destination} budgetMs=${waitBudget}`);
  notes.push('navigating.fetch: skipped; fixture /slow holds Document (no Fetch.enable)');
  const opened = await raced(observerPage(reader, start, notes, internalSessions), 3000);
  if (!opened?.ok)
    return {
      ok: true,
      result: {
        incomplete: `navigating shape did not appear: observer setup ${opened?.error?.message ?? 'timed out'}`,
      },
    };
  const { targetId, sessionId } = opened.result;
  hold.targetId = targetId;
  const sequence = [];
  let cursor = reader.events.length;
  let stopped = false;
  const elapsed = () => Date.now() - started;
  const readInfo = async () => {
    const info = await raced(reader.send('Target.getTargetInfo', { targetId }), 400);
    const listed = await raced(reader.send('Target.getTargets'), 400);
    const row = listed?.targetInfos?.find((i) => i.targetId === targetId);
    return info?.targetInfo ?? row;
  };
  const snap = async (label) => {
    const targetInfo = await readInfo();
    notes.push(
      `navigating.${label}: ${JSON.stringify({
        atMs: elapsed(),
        targetId,
        type: targetInfo?.type,
        url: targetInfo?.url,
        title: targetInfo?.title,
        attached: targetInfo?.attached,
        openerId: targetInfo?.openerId,
        pendingUrl: destination,
        observerSession: sessionId,
        sequence: sequence.slice(-12),
      })}`
    );
    return targetInfo;
  };
  hold.release = async () => {
    stopped = true;
    releaseSlow?.(tag);
    await pause(20);
  };
  hold.abort = hold.release;
  await snap('0s');
  const pump = (async () => {
    while (!stopped) {
      for (const event of reader.events.slice(cursor)) {
        cursor++;
        if (
          event.method === 'Fetch.requestPaused' ||
          event.method === 'Page.frameStartedNavigating' ||
          event.method === 'Page.frameRequestedNavigation' ||
          event.method === 'Page.frameNavigated'
        ) {
          const row = {
            atMs: elapsed(),
            method: event.method,
            sessionId: event.sessionId,
            url: event.params.request?.url ?? event.params.url ?? event.params.frame?.url,
            resourceType: event.params.resourceType,
            requestStage: event.params.requestStage,
            frameId: event.params.frameId ?? event.params.frame?.id,
          };
          sequence.push(row);
          notes.push(`navigating.event: ${JSON.stringify(row)}`);
        }
      }
      await pause(5);
    }
  })();
  await raced(reader.send('Page.enable', {}, sessionId), 500);
  notes.push(`navigating.navigate: not-awaited url=${destination} session=${sessionId}`);
  reader
    .send('Page.navigate', { url: destination }, sessionId)
    .then((result) => {
      notes.push(
        `navigating.navigateResult: ${JSON.stringify({
          atMs: elapsed(),
          frameId: result?.frameId,
          loaderId: result?.loaderId,
          errorText: result?.errorText,
        })}`
      );
    })
    .catch((error) => {
      notes.push(`navigating.navigateSettled: ${error?.message ?? error}`);
    });
  const marks = [1000, 2000, 5000];
  let mark = 0;
  let targetInfo;
  let pending = false;
  const deadline = started + waitBudget;
  while (Date.now() < deadline && !pending) {
    pending = sequence.some(
      (event) =>
        (event.method === 'Page.frameStartedNavigating' ||
          event.method === 'Page.frameRequestedNavigation' ||
          event.method === 'Fetch.requestPaused') &&
        (event.url === destination || String(event.url ?? '').includes('/slow'))
    );
    if (!pending) {
      targetInfo = await readInfo();
      pending = targetInfo?.url === destination || String(targetInfo?.url ?? '').includes('/slow');
    }
    while (mark < marks.length && elapsed() >= marks[mark]) {
      await snap(`${marks[mark] / 1000}s`);
      mark++;
    }
    if (!pending) await pause(25);
  }
  stopped = true;
  await Promise.race([pump, pause(20)]);
  targetInfo = targetInfo ?? (await readInfo());
  const shaped = pending;
  notes.push(
    `navigating.done: ${JSON.stringify({
      atMs: elapsed(),
      shaped,
      url: targetInfo?.url,
      title: targetInfo?.title,
      attached: targetInfo?.attached,
      pendingUrl: destination,
      sequence: sequence.slice(-20),
    })}`
  );
  if (!shaped) {
    notes.push(`navigating.giveUp: no pending /slow within ${waitBudget}ms`);
    return {
      ok: true,
      result: {
        incomplete: `navigating shape did not appear: no pending /slow within ${waitBudget}ms`,
        targetId,
        sessionId,
      },
    };
  }
  return {
    ok: true,
    result: {
      targetId,
      sessionId,
      live: true,
      shaped: true,
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
      { expression: "window.open(''); undefined", returnByValue: true, userGesture: true },
      parent.sessionId
    )
  );
  if (!openedBlank.ok)
    return {
      ok: true,
      result: {
        incomplete: `window.open failed: ${openedBlank.error?.message ?? openedBlank.error}`,
        parentId: parent.targetId,
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
        incomplete: 'about:blank popup with opener was not created',
        parentId: parent.targetId,
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
      live: true,
      shaped: true,
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
  releaseSlow,
}) {
  const until = (check) => waitFor(check, budget);
  const result = {};
  const hold = {};
  let shaped;
  const missing = async (reason) => {
    hold.abort?.();
    await hold.release?.();
    const targetId = shaped?.result?.targetId ?? hold.targetId;
    const parentId = shaped?.result?.parentId ?? hold.parentId;
    if (targetId) await outcome(reader.send('Target.closeTarget', { targetId }));
    if (parentId) await outcome(reader.send('Target.closeTarget', { targetId: parentId }));
    return { ...result, incomplete: `close-protected-shape: ${reason}` };
  };
  if (!reader) return missing('missing unguarded reader');
  const origin = protectedOrigin;
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
    const navigating = shapeNavigating({
      reader,
      ordinary,
      destination: `${origin}/slow?n=${encodeURIComponent(tag)}&ms=15000`,
      notes,
      internalSessions,
      hold,
      releaseSlow,
      tag,
    }).then((value) => ({ timedOut: false, value }));
    let hardTimer;
    const hard = new Promise((resolve) => {
      hardTimer = setTimeout(() => resolve({ timedOut: true }), 9000);
    });
    const winner = await Promise.race([navigating, hard]);
    clearTimeout(hardTimer);
    if (winner.timedOut) {
      notes.push('navigating.giveUp: hard 9s shape budget');
      hold.abort?.();
      await hold.release?.();
      shaped = {
        ok: true,
        result: {
          incomplete: 'navigating shape did not appear: hard 9s shape budget',
          targetId: hold.targetId,
        },
      };
    } else shaped = winner.value;
  } else if (shape === 'blank-inherited') {
    shaped = await shapeBlankInherited({ reader, origin, tag, notes, internalSessions, until });
  } else {
    return await missing(`unknown shape ${shape}`);
  }
  if (!shaped.ok)
    return await missing(`observer setup failed: ${shaped.error?.message ?? shaped.error}`);
  if (shaped.result.incomplete) return await missing(shaped.result.incomplete);
  if (!shaped.result.live) return await missing(`shape ${shape} did not appear`);
  Object.assign(result, {
    shaped: shaped.result.shaped,
    live: shaped.result.live,
  });
  const { targetId } = shaped.result;
  const closeOnly = shaped.result.closeOnly === true;
  const { session, attachRefused } = await attachClient(client, targetId);
  if (!session) {
    if (!closeOnly) result.attachRefused = attachRefused;
    await measureClose({ client, reader, targetId, result, until });
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
      skipEvaluate: true,
      attachRefused,
    });
    return result;
  } finally {
    await hold.release?.();
    await outcome(reader.send('Target.closeTarget', { targetId }));
    if (shaped.result.parentId)
      await outcome(reader.send('Target.closeTarget', { targetId: shaped.result.parentId }));
  }
}
