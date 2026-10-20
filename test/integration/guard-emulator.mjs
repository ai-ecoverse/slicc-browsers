import { parseURL } from '../../guard-driver.mjs';
import { protectedOrigins } from '../../protected.mjs';
import { redactProtectedURLs } from '../../redirect-redaction.mjs';

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
  const readyShields = new Map();
  const sessions = new Map();
  const decisions = new Map();
  const frames = new Map();
  const navigating = new Set();
  let frameCursor = 0;
  const learnFrames = () => {
    for (const event of unguarded.events.slice(frameCursor)) {
      frameCursor++;
      const owner = shields.get(event.sessionId);
      if (!owner || !catalog) continue;
      if (event.method === 'Page.frameNavigated' && !event.params.frame.parentId) {
        const f = event.params.frame;
        frames.set(owner.targetId, f);
        navigating.delete(owner.targetId);
        const previous = decisions.get(owner.targetId) ?? false;
        decisions.set(
          owner.targetId,
          f.unreachableUrl && f.url === options.protectedOrigins.errorPage?.url
            ? options.unlockErrorPage
              ? false
              : previous
            : catalog.url(f.url)
        );
      }
      if (
        event.method === 'Page.frameStartedNavigating' &&
        event.params.frameId === frames.get(owner.targetId)?.id &&
        !['sameDocument', 'historySameDocument'].includes(event.params.navigationType)
      )
        navigating.add(owner.targetId);
      if (
        event.method === 'Page.frameStoppedLoading' &&
        event.params.frameId === frames.get(owner.targetId)?.id
      )
        navigating.delete(owner.targetId);
    }
  };
  const redactInfo = (info) => {
    if (!catalog?.url(info.url, { readOnly: true })) return info;
    let origin;
    try {
      origin = new URL(info.url).origin;
    } catch {
      return info;
    }
    return { ...info, url: origin, title: origin };
  };
  const decision = async (targetId) => {
    const { targetInfo } = await unguarded.send('Target.getTargetInfo', { targetId });
    learnFrames();
    const f = frames.get(targetId);
    const documentURL = f?.url;
    const unreachableURL = f?.unreachableUrl;
    const previous = decisions.get(targetId) ?? false;
    const blocked = options.targetURLOnly
      ? catalog.target(targetInfo)
      : catalog.target({
          ...targetInfo,
          documentURL,
          unreachableURL,
          navigating: navigating.has(targetId),
          previous: options.unlockErrorPage ? false : previous,
        });
    return blocked;
  };
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
  const messages = [];
  const protectedBodies = new Set();
  let bodyCursor = 0;
  const sanitize = (event) => {
    if (!catalog || !options.redirectSecrets) return event;
    const response = event.params?.redirectResponse ?? event.params;
    const headers = response?.headers ?? response?.responseHeaders;
    if (
      headers &&
      catalog.url(
        (Array.isArray(headers)
          ? headers.find((h) => h.name.toLowerCase() === 'location')?.value
          : (headers.location ?? headers.Location)) ?? '',
        { readOnly: true }
      )
    )
      protectedBodies.add(`${event.sessionId}:${event.params.requestId}`);
    if (options.parsedHeadersOnly) {
      const copy = structuredClone(event);
      const walk = (value) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, entry] of Object.entries(value)) {
          if (key === 'headers' || key === 'responseHeaders')
            value[key] = redactProtectedURLs(entry, catalog);
          else walk(entry);
        }
      };
      walk(copy);
      return copy;
    }
    return redactProtectedURLs(event, catalog);
  };
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
    await unguarded.send('Page.enable', {}, sessionId);
    const { frameTree } = await unguarded.send('Page.getFrameTree', {}, sessionId);
    frames.set(targetId, frameTree.frame);
    await unguarded.send(
      'Fetch.enable',
      {
        patterns: [
          {
            urlPattern: '*',
            ...(options.redirectSecrets ? {} : { resourceType: 'Document' }),
            requestStage: 'Request',
          },
        ],
      },
      sessionId
    );
    if (waiting) await unguarded.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  };
  const decide = async (event) => {
    const owner = shields.get(event.sessionId);
    if (!owner) return;
    const { requestId, request } = event.params;
    const blocked =
      hosts.includes(parseURL(request.url)?.host) ||
      Boolean(catalog?.url(request.url)) ||
      (options.failDocumentOrigins ?? []).some((origin) => request.url.startsWith(`${origin}/`));
    if (!blocked) {
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
        const exposed = sanitize(
          event.params?.targetInfo && catalog
            ? {
                ...event,
                params: { ...event.params, targetInfo: redactInfo(event.params.targetInfo) },
              }
            : event
        );
        if (!mentions(event) && !hidden(event)) {
          messages.push(JSON.stringify(exposed));
          events.push(exposed);
          for (const waiter of waiters)
            if (waiter.pred(exposed)) {
              waiters.delete(waiter);
              waiter.resolve(exposed);
            }
        }
        if (event.method !== 'Target.attachedToTarget') continue;
        const info = event.params.targetInfo;
        sessions.set(event.params.sessionId, info.targetId);
        if (event.params.waitingForDebugger) children.add(event.params.sessionId);
        if (!pages.has(info.targetId) && !pages.has(info.openerId))
          foreign.add(event.params.sessionId);
        if (info.type !== 'page' || shielded.has(info.targetId)) continue;
        shielded.add(info.targetId);
        pages.add(info.targetId);
        if (event.params.waitingForDebugger) children.add(event.params.sessionId);
        if (!pages.has(info.targetId) && !pages.has(info.openerId))
          foreign.add(event.params.sessionId);
        const ready = shield(
          info.targetId,
          event.params.waitingForDebugger ? event.params.sessionId : undefined,
          event.params.waitingForDebugger
        ).catch(() => {});
        readyShields.set(info.targetId, ready);
        await ready;
      }
      learnFrames();
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
      messages,
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
        const reply = await outcomeSend(method, params, sessionId);
        messages.push(JSON.stringify({ id: messages.length + 1, result: reply, sessionId }));
        return reply;
      },
    },
    stop: async () => {
      stopped = true;
      await watch;
      for (const sessionId of shields.keys())
        await unguarded.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    },
  };
  async function outcomeSend(method, params, sessionId) {
    try {
      return await guardedSend(method, params, sessionId);
    } catch (error) {
      messages.push(
        JSON.stringify({ id: messages.length + 1, error: { message: error.message }, sessionId })
      );
      throw error;
    }
  }
  async function guardedSend(method, params, sessionId) {
    if (options.redirectSecrets && catalog) {
      const requestId = params?.requestId;
      for (const event of client.events.slice(bodyCursor)) {
        bodyCursor++;
        sanitize(event);
      }
      if (
        ['Fetch.getResponseBody', 'Network.getResponseBody', 'Network.replayXHR'].includes(
          method
        ) &&
        protectedBodies.has(`${sessionId}:${requestId}`)
      )
        throw refusal('protected redirect body');
      const destination = options.redirects?.get(parseURL(params?.url)?.pathname)?.to;
      if (
        [
          'Network.loadNetworkResource',
          'Fetch.continueRequest',
          'Network.continueInterceptedRequest',
        ].includes(method) &&
        destination &&
        catalog.url(destination)
      )
        throw refusal('protected redirect destination');
    }
    const targetId = params?.targetId ?? sessions.get(sessionId);
    if (
      catalog &&
      !options.catalogAttachOnly &&
      targetId &&
      (sessionId || ['Target.attachToTarget', 'Target.closeTarget'].includes(method)) &&
      (await decision(targetId))
    )
      throw refusal('protected target');
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
      throw catalog.unparseable(params?.url)
        ? new Error(options.protectedOrigins.unparseableRefusal)
        : refusal('protected URL');
    if (
      catalog &&
      [
        'Network.getCookies',
        'Network.setCookie',
        'Network.deleteCookies',
        'Fetch.continueRequest',
        'Network.continueInterceptedRequest',
        'Network.loadNetworkResource',
        'PWA.install',
        'PWA.launch',
      ].includes(method)
    ) {
      const urls = [
        ...(params?.urls ?? []),
        params?.url,
        params?.cookieUrl,
        params?.installUrlOrOrigin,
      ].filter((url) => url !== undefined);
      const blocked = urls.find((url) => catalog.url(url));
      if (blocked !== undefined)
        throw catalog.unparseable(blocked)
          ? new Error(options.protectedOrigins.unparseableRefusal)
          : refusal('protected URL');
    }
    if (catalog && method === 'Target.attachToTarget') {
      const { targetInfo } = await unguarded.send('Target.getTargetInfo', {
        targetId: params.targetId,
      });
      if (await decision(params.targetId))
        throw catalog.unparseable(targetInfo.url)
          ? new Error(options.protectedOrigins.unparseableRefusal)
          : refusal('protected target');
      const attached = await unguarded.send('Target.attachToTarget', {
        targetId: params.targetId,
        flatten: true,
      });
      try {
        const { frameTree } = await unguarded.send('Page.getFrameTree', {}, attached.sessionId);
        const protectedFrame = (tree) =>
          catalog.url(tree.frame.url) ||
          (tree.frame.securityOrigin && catalog.url(tree.frame.securityOrigin)) ||
          (tree.childFrames ?? []).some(protectedFrame);
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
    if (method === 'Target.attachToTarget' && result?.sessionId) {
      sessions.set(result.sessionId, params.targetId);
      if (!shielded.has(params.targetId)) {
        const { targetInfo } = await unguarded.send('Target.getTargetInfo', {
          targetId: params.targetId,
        });
        if (targetInfo.type === 'page') {
          shielded.add(params.targetId);
          pages.add(params.targetId);
          readyShields.set(
            params.targetId,
            shield(params.targetId).catch(() => {})
          );
        }
      }
      await readyShields.get(params.targetId);
    }
    if (method === 'Target.getTargetInfo' && catalog)
      return { ...result, targetInfo: redactInfo(result.targetInfo) };
    if (method === 'Target.getTargets' && Array.isArray(result?.targetInfos)) {
      const visible = [];
      for (const info of result.targetInfos)
        if (
          !mentions(info) &&
          !(options.hideTypes ?? []).includes(info.type) &&
          (!catalog || !(await decision(info.targetId)))
        )
          visible.push(info);
      return {
        ...result,
        targetInfos: visible.map((info) => (catalog ? redactInfo(info) : info)),
      };
    }
    return options.redirectSecrets && catalog ? redactProtectedURLs(result, catalog) : result;
  }
}
