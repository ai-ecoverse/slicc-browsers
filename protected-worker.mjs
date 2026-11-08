import { outcome, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

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
  const found = await waitFor(
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

async function framedEvaluate(reader, sessionId, pageUrl, budget) {
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
  const child = await waitFor(async () => {
    const tree = await outcome(reader.send('Page.getFrameTree', {}, sessionId));
    if (!tree.ok) return null;
    return (
      (tree.result.frameTree.childFrames ?? []).find((node) =>
        String(node.frame?.url ?? '').startsWith(pageUrl.split('?')[0])
      ) ?? null
    );
  }, budget);
  if (!child) throw new Error('protected worker iframe frame did not appear');
  const contextId = await frameContext(reader, sessionId, child.frame.id, budget);
  if (!contextId) throw new Error('protected worker iframe context missing');
  return (expression) =>
    reader.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, contextId },
      sessionId
    );
}

export function workerProbeExpression(path, tag) {
  const tagged = `[?&]n=${String(tag).replace(/[.*+?^$${}()|[\]\\]/g, '\\$&')}`;
  return `(() => { try { const href = String(self.location && self.location.href || ''); const tagged = new RegExp(${JSON.stringify(tagged)}).test(href); return (typeof WorkerGlobalScope === 'function' || tagged) && href.includes(${JSON.stringify(path)}); } catch { return false; } })()`;
}

const harnessProbeError = (error) => {
  const message = String(error?.message ?? error ?? '');
  if (
    /refused|not allowed|cannot find context|no target with given id|session closed|detached/i.test(
      message
    )
  )
    return false;
  return /timed out|timeout|ECONN|ENOTFOUND|EPIPE|socket hang up|fetch failed|not implemented/i.test(
    message
  );
};

export async function probeWorkerSessions({ client, sessions, path, tag, detached = () => false }) {
  const ids = [...new Set(sessions.filter(Boolean))];
  if (!ids.length) return { reachable: false, probed: 0, sessions: [], probedIds: [] };
  let reachable = false;
  let probed = 0;
  let attempted = 0;
  let harnessFailures = 0;
  const probedIds = [];
  for (const sessionId of ids) {
    if (detached(sessionId)) {
      probedIds.push(sessionId);
      continue;
    }
    attempted++;
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
    } catch {
      harnessFailures++;
      probedIds.push(sessionId);
      continue;
    }
    probedIds.push(sessionId);
    if (!out.ok) {
      if (harnessProbeError(out.error)) harnessFailures++;
      continue;
    }
    if (out.result?.result?.value === true) reachable = true;
  }
  if (attempted > 0 && harnessFailures === attempted && !reachable)
    return {
      reachable: false,
      probed,
      sessions: ids,
      probedIds,
      incomplete: 'probeSessions harness error on every session',
    };
  return { reachable, probed, sessions: ids, probedIds };
}

export async function protectedWorker({
  reader,
  kind,
  pageUrl,
  hostUrl,
  tag,
  context,
  notes = [],
  budget = 5000,
}) {
  const spec = kinds[kind];
  if (!spec) throw new Error(`unknown protected worker kind ${kind}`);
  if (!reader) throw new Error('protected worker needs an unguarded observer');
  const created = await createObserverTarget(
    reader,
    {
      url: 'about:blank',
      background: true,
      ...(context ? { browserContextId: context } : {}),
    },
    notes
  );
  const pageTargetId = created.targetId;
  const { sessionId } = await reader.send('Target.attachToTarget', {
    targetId: pageTargetId,
    flatten: true,
  });
  try {
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
    const evaluate = hostUrl
      ? await framedEvaluate(reader, sessionId, pageUrl, budget)
      : (expression) =>
          reader.send(
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true },
            sessionId
          );
    const script = new URL(spec.path, pageUrl);
    script.searchParams.set('n', tag);
    const spawn = await outcome(evaluate(spec.expression(script.href)));
    const value = spawn.result?.result?.value;
    if (!spawn.ok || (kind === 'service' ? value !== 'registered' : value !== 'spawned'))
      throw new Error(
        `protected worker spawn failed: ${spawn.error?.message ?? value ?? 'unknown'}`
      );
    const found = await waitFor(async () => {
      const listed = await outcome(reader.send('Target.getTargets', {}));
      if (!listed.ok) return null;
      return (
        listed.result.targetInfos?.find(
          (info) =>
            info.type === spec.type &&
            typeof info.url === 'string' &&
            info.url.includes(spec.path) &&
            info.url.includes(tag)
        ) ?? null
      );
    }, budget);
    if (!found) throw new Error(`protected ${kind} worker target did not appear`);
    const exists = await outcome(evaluate(spec.exists));
    if (!exists.ok || exists.result?.result?.value !== true)
      throw new Error(`protected ${kind} worker existence check failed`);
    notes.push(
      `protected worker ${kind}${hostUrl ? ' framed' : ''}: page ${pageTargetId}, worker ${found.targetId}, url ${found.url}`
    );
    return {
      exists: true,
      pageTargetId,
      workerTargetId: found.targetId,
      workerUrl: found.url,
      type: spec.type,
      framed: Boolean(hostUrl),
    };
  } finally {
    await outcome(reader.send('Target.detachFromTarget', { sessionId }));
  }
}
