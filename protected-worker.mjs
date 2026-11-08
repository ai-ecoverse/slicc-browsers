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

export async function protectedWorker({
  reader,
  kind,
  pageUrl,
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
    const nav = await outcome(reader.send('Page.navigate', { url: pageUrl }, sessionId));
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
    const script = new URL(spec.path, pageUrl);
    script.searchParams.set('n', tag);
    const spawn = await outcome(
      reader.send(
        'Runtime.evaluate',
        {
          expression: spec.expression(script.href),
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId
      )
    );
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
    const exists = await outcome(
      reader.send(
        'Runtime.evaluate',
        {
          expression: spec.exists,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId
      )
    );
    if (!exists.ok || exists.result?.result?.value !== true)
      throw new Error(`protected ${kind} worker existence check failed`);
    notes.push(
      `protected worker ${kind}: page ${pageTargetId}, worker ${found.targetId}, url ${found.url}`
    );
    return {
      exists: true,
      pageTargetId,
      workerTargetId: found.targetId,
      workerUrl: found.url,
      type: spec.type,
    };
  } finally {
    await outcome(reader.send('Target.detachFromTarget', { sessionId }));
  }
}
