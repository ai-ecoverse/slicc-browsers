const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function emulatedGuard(browser, options = {}) {
  const { client, unguarded } = browser;
  const hosts = options.protectedHosts ?? [];
  const pages = new Set();
  const shielded = new Set();
  const children = new Set();
  const closed = new Set();
  const shields = new Map();
  const contexts = new Set();
  const events = [];
  const waiters = new Set();
  const mentions = (value) => hosts.some((host) => JSON.stringify(value).includes(host));
  const refusal = (what) => new Error(`slicc: refused: ${what}`);
  let cursor = 0;
  let guardCursor = 0;
  let stopped = false;
  const shield = async (targetId, child, waiting) => {
    const { sessionId } = await unguarded.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    shields.set(sessionId, { targetId, child });
    await unguarded.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] },
      sessionId
    );
    if (waiting) await unguarded.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  };
  const decide = async (event) => {
    const owner = shields.get(event.sessionId);
    if (!owner) return;
    const { requestId, request } = event.params;
    if (!hosts.includes(new URL(request.url).host)) {
      await unguarded.send('Fetch.continueRequest', { requestId }, event.sessionId).catch(() => {});
      return;
    }
    await unguarded
      .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId)
      .catch(() => {});
    if (owner.child && options.closeChildOnBlock) {
      closed.add(owner.child);
      await unguarded.send('Target.closeTarget', { targetId: owner.targetId }).catch(() => {});
    } else if (options.replaceWith) {
      await pause(200);
      await unguarded
        .send('Page.navigate', { url: options.replaceWith }, event.sessionId)
        .catch(() => {});
    }
  };
  const watch = (async () => {
    while (!stopped) {
      for (const event of client.events.slice(cursor)) {
        cursor++;
        if (!mentions(event)) {
          events.push(event);
          for (const waiter of waiters)
            if (waiter.pred(event)) {
              waiters.delete(waiter);
              waiter.resolve(event);
            }
        }
        if (event.method !== 'Target.attachedToTarget') continue;
        const info = event.params.targetInfo;
        if (info.type !== 'page' || shielded.has(info.targetId)) continue;
        shielded.add(info.targetId);
        pages.add(info.targetId);
        if (event.params.waitingForDebugger) children.add(event.params.sessionId);
        await shield(
          info.targetId,
          event.params.waitingForDebugger ? event.params.sessionId : undefined,
          event.params.waitingForDebugger
        ).catch(() => {});
      }
      for (const event of unguarded.events.slice(guardCursor)) {
        guardCursor++;
        if (event.method === 'Fetch.requestPaused') await decide(event);
      }
      await pause(5);
    }
  })();
  return {
    client: {
      ...client,
      events,
      waitEvent: (pred, ms) =>
        new Promise((resolve, reject) => {
          const found = events.find(pred);
          if (found) return resolve(found);
          const waiter = { pred, resolve };
          waiters.add(waiter);
          setTimeout(() => {
            if (waiters.delete(waiter)) reject(new Error('CDP event timed out'));
          }, ms ?? 10000);
        }),
      send: async (method, params, sessionId) => {
        if (options.refuse?.(method, params ?? {}, sessionId)) throw refusal('browser-wide call');
        if (
          options.refuseFrameAttach &&
          method === 'Target.attachToTarget' &&
          !pages.has(params?.targetId)
        )
          throw refusal('slicc only attaches to tabs it knows');
        if (
          sessionId &&
          children.has(sessionId) &&
          options.childPageLatencyMs &&
          method.startsWith('Page.')
        )
          await pause(options.childPageLatencyMs);
        if (sessionId && closed.has(sessionId)) throw refusal("target is on seven's origin");
        if (
          options.ownContextsOnly &&
          method === 'Storage.clearCookies' &&
          !contexts.has(params?.browserContextId)
        )
          throw refusal('cookies in a context slicc did not create');
        const result = await client.send(method, params, sessionId);
        if (method === 'Target.createTarget' && result?.targetId) pages.add(result.targetId);
        if (method === 'Target.createBrowserContext' && result?.browserContextId)
          contexts.add(result.browserContextId);
        if (method === 'Target.getTargets' && Array.isArray(result?.targetInfos))
          return { ...result, targetInfos: result.targetInfos.filter((info) => !mentions(info)) };
        return result;
      },
    },
    stop: async () => {
      stopped = true;
      await watch;
    },
  };
}
