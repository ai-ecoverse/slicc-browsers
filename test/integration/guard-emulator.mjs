import { protectedOrigins } from '../../protected.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function emulatedGuard(browser, options = {}) {
  const { client, unguarded } = browser;
  const hosts = options.protectedHosts ?? [];
  const catalog = options.protectedOrigins ? protectedOrigins(options.protectedOrigins) : null;
  const pages = new Set();
  const shielded = new Set();
  const foreign = new Set();
  const children = new Set();
  const closed = new Set();
  const shields = new Map();
  const contexts = new Set();
  const extensionContexts = new Map();
  const cutSessions = new Set();
  const foreignWorld = (context) => catalog?.url(context.origin) && !context.auxData?.isDefault;
  const learnWorlds = () => {
    for (const event of client.events) {
      if (event.method !== 'Runtime.executionContextCreated') continue;
      const context = event.params.context;
      if (foreignWorld(context)) {
        extensionContexts.set(`${event.sessionId}:${context.id}`, context);
        if (options.cutExtensionWorlds) cutSessions.add(event.sessionId);
      } else if (catalog?.url(context.origin) && context.auxData?.isDefault) {
        cutSessions.add(event.sessionId);
      }
    }
  };
  const hidden = (event) => {
    if (!catalog || options.exposeExtensionWorlds) return false;
    learnWorlds();
    const worlds = [...extensionContexts.entries()]
      .filter(([key]) => key.startsWith(`${event.sessionId}:`))
      .map(([, context]) => context);
    return (
      (event.method === 'Runtime.executionContextCreated' && foreignWorld(event.params.context)) ||
      (/^(Runtime|Debugger)\./.test(event.method) &&
        worlds.some(
          (world) =>
            event.params.executionContextId === world.id ||
            event.params.executionContextUniqueId === world.uniqueId ||
            JSON.stringify(event.params).includes(world.uniqueId)
        )) ||
      (event.method.startsWith('Debugger.') && worlds.length > 0)
    );
  };
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
      await pause(options.documentLatency?.(request.url) ?? 0);
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
        options.trace?.push({ at: Date.now(), event });
        if (
          options.hideOpened &&
          event.method === 'Target.attachedToTarget' &&
          pages.has(event.params.targetInfo?.openerId)
        ) {
          const child = event.params.sessionId;
          const { targetId } = event.params.targetInfo;
          if (event.params.waitingForDebugger)
            await client.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
          const until = Date.now() + 1500;
          let landed = false;
          while (!landed && Date.now() < until) {
            const info = await unguarded
              .send('Target.getTargetInfo', { targetId })
              .then((answer) => answer.targetInfo)
              .catch(() => undefined);
            landed = Boolean(info?.url && mentions(info.url));
            if (!landed) await pause(25);
          }
          if (landed) {
            await client.send('Target.detachFromTarget', { sessionId: child }).catch(() => {});
            continue;
          }
          events.push({ ...event, params: { ...event.params, waitingForDebugger: false } });
          continue;
        }
        if (!mentions(event) && !hidden(event)) {
          events.push(event);
          for (const waiter of waiters)
            if (waiter.pred(event)) {
              waiters.delete(waiter);
              waiter.resolve(event);
            }
        }
        if (event.method !== 'Target.attachedToTarget') continue;
        const info = event.params.targetInfo;
        if (event.params.waitingForDebugger) children.add(event.params.sessionId);
        if (!pages.has(info.targetId) && !pages.has(info.openerId))
          foreign.add(event.params.sessionId);
        if (info.type !== 'page' || shielded.has(info.targetId)) continue;
        shielded.add(info.targetId);
        pages.add(info.targetId);
        if (event.params.waitingForDebugger) children.add(event.params.sessionId);
        if (!pages.has(info.targetId) && !pages.has(info.openerId))
          foreign.add(event.params.sessionId);
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
        learnWorlds();
        if (cutSessions.has(sessionId)) throw refusal('session cut on protected execution context');
        if (catalog && !options.exposeExtensionWorlds && sessionId) {
          const worlds = [...extensionContexts.entries()]
            .filter(([key]) => key.startsWith(`${sessionId}:`))
            .map(([, context]) => context);
          if (
            worlds.some(
              (world) =>
                params?.contextId === world.id ||
                params?.uniqueContextId === world.uniqueId ||
                params?.executionContextId === world.id ||
                (method === 'Runtime.addBinding' && params?.executionContextName === world.name)
            ) ||
            (method === 'Debugger.enable' && worlds.length > 0)
          )
            throw refusal('that execution context belongs to a browser extension');
          if (
            (params?.contextId !== undefined ||
              params?.uniqueContextId !== undefined ||
              params?.executionContextId !== undefined) &&
            !client.events.some(
              (event) =>
                event.sessionId === sessionId &&
                event.method === 'Runtime.executionContextCreated' &&
                (event.params.context.id === (params.contextId ?? params.executionContextId) ||
                  event.params.context.uniqueId === params.uniqueContextId)
            )
          )
            throw refusal('that execution context is not exposed');
          const ids = [
            params?.objectId,
            params?.promiseObjectId,
            ...(params?.arguments ?? []).map((argument) => argument.objectId),
          ].filter(Boolean);
          for (const objectId of ids) {
            const origin = await client
              .send(
                'Runtime.callFunctionOn',
                {
                  objectId,
                  functionDeclaration: 'function(){return self.chrome?.runtime?.id ?? null}',
                  returnByValue: true,
                },
                sessionId
              )
              .catch(() => null);
            if (!origin) throw refusal('that object is not exposed');
            if (origin?.result?.value)
              throw refusal('that execution context belongs to a browser extension');
          }
        }
        if (
          catalog &&
          !options.catalogAttachOnly &&
          (method === 'Page.navigate' || method === 'Target.createTarget') &&
          catalog.url(params?.url)
        )
          throw refusal('protected URL');
        if (catalog && method === 'Target.attachToTarget') {
          const { targetInfo } = await unguarded.send('Target.getTargetInfo', {
            targetId: params.targetId,
          });
          if (catalog.target(targetInfo)) throw refusal('protected target');
          const attached = await unguarded.send('Target.attachToTarget', {
            targetId: params.targetId,
            flatten: true,
          });
          try {
            const { frameTree } = await unguarded.send('Page.getFrameTree', {}, attached.sessionId);
            const protectedFrame = (tree) =>
              catalog.url(tree.frame.url) || (tree.childFrames ?? []).some(protectedFrame);
            if (protectedFrame(frameTree)) throw refusal('protected frame');
            const start = unguarded.events.length;
            await unguarded.send(
              'Target.setAutoAttach',
              { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
              attached.sessionId
            );
            const frames = unguarded.events
              .slice(start)
              .filter(
                (event) =>
                  event.method === 'Target.attachedToTarget' &&
                  event.sessionId === attached.sessionId &&
                  event.params.targetInfo.type === 'iframe'
              );
            if (frames.some((event) => catalog.url(event.params.targetInfo.url)))
              throw refusal('protected out-of-process frame');
          } finally {
            await unguarded.send(
              'Target.setAutoAttach',
              { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
              attached.sessionId
            );
            await unguarded.send('Target.detachFromTarget', { sessionId: attached.sessionId });
          }
        }
        const failure = options.fail?.(method, params ?? {}, children.has(sessionId));
        if (failure) throw new Error(failure);
        if (options.refuse?.(method, params ?? {}, children.has(sessionId))) {
          await pause(options.refuseLatencyMs ?? 0);
          throw refusal('browser-wide call');
        }
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
        if (options.refuseForeign && sessionId && foreign.has(sessionId)) {
          await pause(options.foreignLatencyMs ?? 0);
          throw refusal('slicc only drives the tabs it opened');
        }
        if (
          options.ownContextsOnly &&
          method === 'Storage.clearCookies' &&
          !contexts.has(params?.browserContextId)
        )
          throw refusal('cookies in a context slicc did not create');
        options.trace?.push({ at: Date.now(), method, params, sessionId });
        if (options.swallow?.(method, params ?? {}, children.has(sessionId))) return {};
        const result = await client.send(method, params, sessionId);
        learnWorlds();
        await pause(options.replyLatency?.(method, params ?? {}) ?? 0);
        if (
          method === 'Page.navigate' &&
          sessionId &&
          options.staleLoad?.(sessionId, children.has(sessionId))
        )
          events.push({ method: 'Page.loadEventFired', sessionId, params: { timestamp: 0 } });
        if (method === 'Target.createTarget' && result?.targetId) pages.add(result.targetId);
        if (method === 'Target.createBrowserContext' && result?.browserContextId)
          contexts.add(result.browserContextId);
        if (method === 'Target.getTargets' && Array.isArray(result?.targetInfos))
          return {
            ...result,
            targetInfos: result.targetInfos.filter(
              (info) =>
                !mentions(info) &&
                !catalog?.target(info) &&
                !(options.hideTypes ?? []).includes(info.type)
            ),
          };
        return result;
      },
    },
    stop: async () => {
      stopped = true;
      await watch;
    },
  };
}
