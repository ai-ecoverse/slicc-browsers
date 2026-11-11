import { outcome, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

async function until(check, ms, step = 25) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

const kinds = {
  dedicated: {
    type: 'worker',
    path: '/worker.js',
    expression: (url) =>
      `(() => { window.__sliccW = new Worker(${JSON.stringify(url)}); return 'spawned'; })()`,
    exists: `typeof window.__sliccW === 'object' && window.__sliccW !== null`,
  },
  shared: {
    type: 'shared_worker',
    path: '/shared-worker.js',
    expression: (url) =>
      `(() => { window.__sliccW = new SharedWorker(${JSON.stringify(url)}); return 'spawned'; })()`,
    exists: `typeof window.__sliccW === 'object' && window.__sliccW !== null`,
  },
  service: {
    type: 'service_worker',
    path: '/sw.js',
    expression: (url) =>
      `(async()=>{ try { await navigator.serviceWorker.register(${JSON.stringify(url)},{scope:'/'}); return 'registered'; } catch(e){ return 'err:'+e.message; } })()`,
    exists: `(async()=>{ try { const r=await navigator.serviceWorker.getRegistration(); return !!(r&&String(r.scope||'').length); } catch { return false; } })()`,
  },
};

async function frameContext(reader, sessionId, frameId, budget) {
  const found = await until(
    () => {
      for (const event of reader.events) {
        if (event.sessionId !== sessionId) continue;
        if (event.method !== 'Runtime.executionContextCreated') continue;
        const context = event.params?.context;
        if (context?.auxData?.frameId === frameId && context.auxData?.isDefault) return context.id;
      }
      return null;
    },
    Math.min(budget, 1500)
  );
  if (found) return found;
  const worlds = await outcome(
    reader.send(
      'Page.createIsolatedWorld',
      { frameId, worldName: `slicc-pw-${frameId}` },
      sessionId
    )
  );
  if (!worlds.ok) return null;
  return worlds.result?.executionContextId ?? null;
}

async function framedEvaluate(reader, sessionId, pageUrl, budget, sessions) {
  const prefix = pageUrl.split('?')[0];
  const framed = await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression: `(() => { const f=document.createElement('iframe'); f.src=${JSON.stringify(pageUrl)}; document.body.append(f); return true; })()`,
        returnByValue: true,
      },
      sessionId
    )
  );
  if (!framed.ok || framed.result?.result?.value !== true)
    throw new Error(`protected worker iframe insert failed: ${framed.error?.message ?? 'unknown'}`);
  const iframeTarget = await until(async () => {
    const listed = await outcome(reader.send('Target.getTargets', {}));
    if (!listed.ok) return null;
    return (
      listed.result.targetInfos?.find(
        (info) =>
          info.type === 'iframe' &&
          typeof info.url === 'string' &&
          info.url.startsWith(prefix) &&
          info.targetId
      ) ?? null
    );
  }, budget);
  if (iframeTarget) {
    const attached = await outcome(
      reader.send('Target.attachToTarget', {
        targetId: iframeTarget.targetId,
        flatten: true,
      })
    );
    if (!attached.ok || !attached.result?.sessionId)
      throw new Error(
        `protected worker iframe attach failed: ${attached.error?.message ?? 'no session'}`
      );
    const iframeSession = attached.result.sessionId;
    sessions.push(iframeSession);
    await outcome(reader.send('Runtime.runIfWaitingForDebugger', {}, iframeSession));
    await outcome(reader.send('Page.enable', {}, iframeSession));
    await outcome(reader.send('Runtime.enable', {}, iframeSession));
    const ready = await waitFor(async () => {
      const read = await outcome(
        reader.send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          iframeSession
        )
      );
      return read.ok && ['interactive', 'complete'].includes(read.result?.result?.value);
    }, budget);
    if (!ready) throw new Error('protected worker iframe document did not become ready');
    return {
      frameTargetId: iframeTarget.targetId,
      frameId: iframeTarget.targetId,
      evaluate: (expression) =>
        reader.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          iframeSession
        ),
    };
  }
  const child = await until(async () => {
    const tree = await pageFrameTree(reader, sessionId, 'host page');
    if (!tree) return null;
    return (
      (tree.childFrames ?? []).find((node) => String(node.frame?.url ?? '').startsWith(prefix)) ??
      null
    );
  }, budget);
  if (!child) throw new Error('protected worker iframe frame did not appear');
  const contextId = await frameContext(reader, sessionId, child.frame.id, budget);
  if (!contextId) throw new Error('protected worker iframe context missing');
  return {
    frameTargetId: undefined,
    frameId: child.frame.id,
    evaluate: (expression) =>
      reader.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, contextId },
        sessionId
      ),
  };
}

async function pageFrameTree(reader, sessionId, label) {
  const read = await outcome(reader.send('Page.getFrameTree', {}, sessionId));
  if (!read.ok)
    throw new Error(
      `Page.getFrameTree timed out on ${label} session ${sessionId}: ${read.error?.message ?? 'unknown'}`
    );
  return read.result?.frameTree;
}

export function workerProbeExpression(path, tag) {
  const tagged = `[?&]n=${String(tag).replace(/[.*+?^$${}()|[\]\\]/g, '\\$&')}`;
  return `(() => { try { const href = String(self.location && self.location.href || ''); const tagged = new RegExp(${JSON.stringify(tagged)}).test(href); return (typeof WorkerGlobalScope === 'function' || tagged) && href.includes(${JSON.stringify(path)}); } catch { return false; } })()`;
}

const harnessProbeError = (error) => {
  const message = String(error?.message ?? error ?? '');
  if (
    /wasn't found|not allowed|refused|cannot find context|no target with given id|session closed|detached/i.test(
      message
    )
  )
    return false;
  return /timed out|timeout|ECONN|ENOTFOUND|EPIPE|socket hang up|fetch failed/i.test(message);
};

export const persistentWorkerTypes = new Set(['shared_worker', 'service_worker']);
export const attachedWorkerTypes = new Set(['shared_worker', 'service_worker', 'worker']);

export function workerTypeForKind(kind) {
  return kinds[kind]?.type;
}

export async function releasePersistentWorkerSessions({
  client,
  reader,
  events,
  from = 0,
  tag,
  targets = [],
  attachSessions = [],
  types = attachedWorkerTypes,
}) {
  const closer = reader ?? client;
  const seen = new Map();
  for (const event of events.slice(from)) {
    if (event.method !== 'Target.attachedToTarget') continue;
    const info = event.params?.targetInfo;
    if (!types.has(info?.type)) continue;
    const sessionId = event.params?.sessionId;
    if (!sessionId || seen.has(sessionId)) continue;
    seen.set(sessionId, info?.targetId);
  }
  for (const [sessionId] of seen) {
    await outcome(client.send('Runtime.runIfWaitingForDebugger', {}, sessionId));
    await outcome(client.send('Target.detachFromTarget', { sessionId }));
  }
  const listed = await outcome(closer.send('Target.getTargets', {}));
  const byId = new Map((listed.result?.targetInfos ?? []).map((info) => [info.targetId, info]));
  for (const targetId of new Set(targets)) {
    if (byId.get(targetId)?.type === 'iframe') continue;
    await outcome(closer.send('Target.closeTarget', { targetId }));
  }
  for (const info of listed.result?.targetInfos ?? []) {
    if (types.has(info.type) && typeof info.url === 'string' && tag && info.url.includes(tag))
      await outcome(closer.send('Target.closeTarget', { targetId: info.targetId }));
  }
  for (const session of attachSessions)
    await outcome(
      client.send(
        'Target.setAutoAttach',
        { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
        session
      )
    );
}

export async function leftoverPersistentWorker(reader, { type, url, targetId } = {}) {
  if (!type && !url && !targetId) return undefined;
  const listed = await outcome(reader.send('Target.getTargets', {}));
  if (!listed.ok) return undefined;
  return (listed.result?.targetInfos ?? []).find((info) => {
    if (type && info.type !== type) return false;
    if (!url && !targetId) return true;
    if (targetId && info.targetId === targetId) return true;
    if (url && info.url === url) return true;
    return false;
  });
}

export async function probeWorkerSessions({ client, sessions, path, tag, detached = () => false }) {
  const ids = [...new Set(sessions.filter(Boolean))];
  if (!ids.length) return { reachable: false, probed: 0, sessions: [], probedIds: [] };
  let reachable = false;
  let probed = 0;
  let harnessErrors = 0;
  const probedIds = [];
  for (const sessionId of ids) {
    if (detached(sessionId)) {
      probedIds.push(sessionId);
      continue;
    }
    probed++;
    let out;
    try {
      out = await outcome(
        client.send(
          'Runtime.evaluate',
          { expression: workerProbeExpression(path, tag), returnByValue: true },
          sessionId
        )
      );
    } catch (error) {
      probedIds.push(sessionId);
      if (harnessProbeError(error)) harnessErrors++;
      continue;
    }
    probedIds.push(sessionId);
    if (!out.ok) {
      if (harnessProbeError(out.error)) harnessErrors++;
      continue;
    }
    if (out.result?.result?.value === true) reachable = true;
  }
  if (reachable) return { reachable: true, probed, sessions: ids, probedIds };
  if (harnessErrors > 0)
    return {
      reachable: false,
      probed,
      sessions: ids,
      probedIds,
      incomplete: 'probeSessions harness error without a reachable worker',
    };
  return { reachable: false, probed, sessions: ids, probedIds };
}

async function spawnContext(reader, kind) {
  if (!(kind === 'shared' || kind === 'service'))
    return { browserContextId: undefined, ownsContext: false };
  const opened = await outcome(reader.send('Target.createBrowserContext', {}));
  if (!opened.ok || !opened.result?.browserContextId)
    throw new Error(
      `protected worker context failed: ${opened.error?.message ?? 'no browserContextId'}`
    );
  return { browserContextId: opened.result.browserContextId, ownsContext: true };
}

async function readyEvaluate(reader, sessionId, pageUrl, hostUrl, budget, sessions) {
  await reader.send('Page.enable', {}, sessionId);
  await reader.send('Runtime.enable', {}, sessionId);
  const nav = await outcome(reader.send('Page.navigate', { url: hostUrl ?? pageUrl }, sessionId));
  if (!nav.ok || nav.result?.errorText)
    throw new Error(
      `protected worker page navigate failed: ${nav.error?.message ?? nav.result?.errorText ?? 'unknown'}`
    );
  const loaded = await waitFor(async () => {
    const read = await outcome(
      reader.send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        sessionId
      )
    );
    return read.ok && ['interactive', 'complete'].includes(read.result?.result?.value);
  }, budget);
  if (!loaded) throw new Error('protected worker page did not become ready');
  if (hostUrl) return framedEvaluate(reader, sessionId, pageUrl, budget, sessions);
  return {
    frameTargetId: undefined,
    frameId: undefined,
    evaluate: (expression) =>
      reader.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      ),
  };
}

function describeTargets(infos) {
  return (infos ?? [])
    .map((info) => {
      const parts = [
        info.type,
        `url=${String(info.url ?? '')}`,
        info.openerId ? `openerId=${info.openerId}` : 'openerId=',
        info.parentId ? `parentId=${info.parentId}` : 'parentId=',
        info.openerFrameId ? `openerFrameId=${info.openerFrameId}` : null,
      ].filter((part) => part !== null);
      return parts.join(',');
    })
    .join(' | ');
}

function urlMatches(info, spec, tag) {
  return (
    typeof info.url === 'string' &&
    info.url.length > 0 &&
    info.url.includes(spec.path) &&
    info.url.includes(tag)
  );
}

function relatedTo(info, owners) {
  if (!owners?.size) return false;
  if (info.openerId && owners.has(info.openerId)) return true;
  if (info.parentId && owners.has(info.parentId)) return true;
  if (info.openerFrameId && owners.has(info.openerFrameId)) return true;
  return false;
}

export function pickSpawnedWorker(infos, { type, path, tag, beforeIds, owners }) {
  const newcomers = (infos ?? []).filter(
    (info) => info.type === type && info.targetId && !beforeIds.has(info.targetId)
  );
  if (!newcomers.length) return null;
  const related = newcomers.filter((info) => relatedTo(info, owners));
  const pool = related.length ? related : newcomers;
  return pool.find((info) => urlMatches(info, { path }, tag)) ?? pool[0];
}

async function findWorker(reader, spec, tag, budget, beforeIds, owners) {
  return until(async () => {
    const listed = await outcome(reader.send('Target.getTargets', {}));
    if (!listed.ok) return null;
    return pickSpawnedWorker(listed.result.targetInfos ?? [], {
      type: spec.type,
      path: spec.path,
      tag,
      beforeIds,
      owners,
    });
  }, budget);
}

async function spawnAndFind(reader, spec, kind, pageUrl, tag, budget, notes, owners, evaluate) {
  const beforeListed = await outcome(reader.send('Target.getTargets', {}));
  const beforeInfos = beforeListed.ok ? (beforeListed.result?.targetInfos ?? []) : [];
  const beforeIds = new Set(beforeInfos.map((info) => info.targetId).filter(Boolean));
  const script = new URL(spec.path, pageUrl);
  script.searchParams.set('n', tag);
  const spawn = await outcome(evaluate(spec.expression(script.href)));
  const value = spawn.result?.result?.value;
  if (!spawn.ok || (kind === 'service' ? value !== 'registered' : value !== 'spawned'))
    throw new Error(`protected worker spawn failed: ${spawn.error?.message ?? value ?? 'unknown'}`);
  const found = await findWorker(reader, spec, tag, budget, beforeIds, owners);
  if (found) return found;
  const afterListed = await outcome(reader.send('Target.getTargets', {}));
  notes.push(
    `protected worker ${kind} getTargets before: ${describeTargets(beforeInfos) || '(none)'}`
  );
  notes.push(
    `protected worker ${kind} getTargets after: ${describeTargets(afterListed.result?.targetInfos) || '(none)'}`
  );
  throw new Error(`protected ${kind} worker target did not appear`);
}

export async function protectedWorker({
  reader,
  kind,
  pageUrl,
  hostUrl,
  tag,
  notes = [],
  budget = 5000,
}) {
  const spec = kinds[kind];
  if (!spec) throw new Error(`unknown protected worker kind ${kind}`);
  if (!reader) throw new Error('protected worker needs an unguarded observer');
  const { browserContextId, ownsContext } = await spawnContext(reader, kind);
  let pageTargetId;
  let sessionId;
  const sessions = [];
  try {
    const created = await createObserverTarget(
      reader,
      {
        url: 'about:blank',
        background: true,
        ...(browserContextId ? { browserContextId } : {}),
      },
      notes
    );
    pageTargetId = created.targetId;
    ({ sessionId } = await reader.send('Target.attachToTarget', {
      targetId: pageTargetId,
      flatten: true,
    }));
    await outcome(
      reader.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId
      )
    );
    const { evaluate, frameTargetId, frameId } = await readyEvaluate(
      reader,
      sessionId,
      pageUrl,
      hostUrl,
      budget,
      sessions
    );
    const owners = new Set([pageTargetId, frameTargetId, frameId].filter(Boolean));
    const found = await spawnAndFind(
      reader,
      spec,
      kind,
      pageUrl,
      tag,
      budget,
      notes,
      owners,
      evaluate
    );
    const exists = await outcome(evaluate(spec.exists));
    if (!exists.ok || exists.result?.result?.value !== true)
      throw new Error(`protected ${kind} worker existence check failed`);
    notes.push(
      `protected worker ${kind}${hostUrl ? ' framed' : ''}: page ${pageTargetId}, worker ${found.targetId}, url ${found.url ?? ''}`
    );
    return {
      exists: true,
      pageTargetId,
      workerTargetId: found.targetId,
      workerUrl: found.url,
      type: spec.type,
      framed: Boolean(hostUrl),
      ...(ownsContext ? { browserContextId } : {}),
    };
  } catch (error) {
    if (ownsContext)
      await outcome(reader.send('Target.disposeBrowserContext', { browserContextId }));
    throw error;
  } finally {
    for (const sid of sessions)
      await outcome(reader.send('Target.detachFromTarget', { sessionId: sid }));
    if (sessionId) await outcome(reader.send('Target.detachFromTarget', { sessionId }));
  }
}
