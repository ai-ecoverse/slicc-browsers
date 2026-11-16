import { unclosableShape } from '../../close-protected-shape.mjs';
import { outcome, parseURL } from '../../guard-driver.mjs';
import { protectedOrigins } from '../../protected.mjs';
import { redactProtectedURLs } from '../../redirect-redaction.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function iframeAncestorProtected(unguarded, catalog, info, options, decisions) {
  if (!catalog || info?.type !== 'iframe') return false;
  if (options.iframeOwnUrlOnly) return Boolean(catalog.url(info.url));
  const listed = await unguarded.send('Target.getTargets').catch(() => null);
  const byId = new Map((listed?.targetInfos ?? []).map((entry) => [entry.targetId, entry]));
  let depth = 0;
  let cur = info;
  const seen = new Set();
  while (cur?.parentId) {
    if (seen.has(cur.parentId)) break;
    seen.add(cur.parentId);
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    depth += 1;
    const held = decisions.get(parent.targetId) === true;
    const protectedUrl = Boolean(catalog.url(parent.url));
    if (options.iframeHeldParentOnly) {
      if (held) return true;
    } else if (protectedUrl || held) {
      if (options.leakNestedIframeOnly && depth > 1) return false;
      return true;
    }
    if (parent.type !== 'iframe') break;
    cur = parent;
  }
  return false;
}

function rewriteIframeInfo(info, options) {
  if (options.redactIframeUrlKeepId) return { ...info, url: '', title: '' };
  return info;
}

function collectProtectedDescendantIds(tree, catalog, options) {
  const ids = new Set();
  const urls = new Set();
  const midIds = new Set();
  if (!tree?.frame || !catalog) return { ids, urls, midIds };
  const visit = (node, underProtected, depth) => {
    if (!node?.frame) return;
    const protectedUrl = Boolean(catalog.url(node.frame.url));
    if (protectedUrl || (options.overblockOrdinaryFrames && depth >= 1)) midIds.add(node.frame.id);
    const under = underProtected || protectedUrl;
    const blockedChild = under || (options.overblockOrdinaryFrames && depth >= 1);
    if (underProtected || (options.overblockOrdinaryFrames && depth >= 1)) {
      ids.add(node.frame.id);
      if (node.frame.url) urls.add(node.frame.url);
    }
    for (const child of node.childFrames ?? []) visit(child, blockedChild, depth + 1);
  };
  visit(tree, false, 0);
  return { ids, urls, midIds };
}

function scrubProtectedDescendantTree(tree, catalog, options) {
  if (!tree?.frame || !catalog || options.leakProtectedDescendantFrames) return tree;
  const walk = (node, depth) => {
    const protectedUrl = Boolean(catalog.url(node.frame?.url ?? ''));
    const drop = protectedUrl || (options.overblockOrdinaryFrames && depth >= 1);
    const childFrames = drop ? [] : (node.childFrames ?? []).map((child) => walk(child, depth + 1));
    return { ...node, childFrames };
  };
  return walk(tree, 0);
}

function scrubProtectedResourceTree(result, catalog, options) {
  if (!result?.frameTree || !catalog || options.leakProtectedDescendantFrames) return result;
  return {
    ...result,
    frameTree: scrubProtectedDescendantTree(result.frameTree, catalog, options),
  };
}

function frameIsProtected(frameId, catalog, frameUrls) {
  const url = frameUrls?.get(frameId) ?? '';
  return Boolean(url && catalog?.url(url));
}

function descendantOfProtected(frameId, catalog, frameUrls, frameParents, options) {
  if (!frameId) return false;
  let cur = frameParents?.get(frameId);
  let depth = 1;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (frameIsProtected(cur, catalog, frameUrls)) return true;
    if (options.overblockOrdinaryFrames && depth >= 1 && frameUrls?.has(cur)) return true;
    cur = frameParents?.get(cur);
    depth += 1;
    if (depth > 8) break;
  }
  return false;
}

function pageDescendantEvent(event, blocked, options, catalog, frameUrls, frameParents) {
  if (options.leakProtectedFrameEvents && pageFrameEventName(event.method)) return false;
  if (options.leakProtectedFrameContexts && event.method === 'Runtime.executionContextCreated')
    return false;
  const params = event.params ?? {};
  const frame = params.frame ?? {};
  const frameId = params.frameId ?? frame.id;
  const parentId = params.parentFrameId ?? params.parentId ?? frame.parentId;
  const url = params.url ?? frame.url ?? '';
  if (frameId && url) frameUrls?.set(frameId, url);
  if (frameId && parentId) frameParents?.set(frameId, parentId);
  if (frameId && descendantOfProtected(frameId, catalog, frameUrls, frameParents, options)) {
    blocked?.ids?.add(frameId);
    return true;
  }
  if (parentId && frameIsProtected(parentId, catalog, frameUrls)) {
    if (frameId) blocked?.ids?.add(frameId);
    return true;
  }
  if (parentId && blocked?.midIds?.has(parentId)) {
    if (frameId) blocked?.ids?.add(frameId);
    return true;
  }
  if (options.overblockOrdinaryFrames && parentId && frameParents?.has(parentId)) {
    if (frameId) blocked?.ids?.add(frameId);
    return true;
  }
  if (frameId && blocked?.ids?.has(frameId)) return true;
  if (url && blocked?.urls?.has(url)) return true;
  if (event.method === 'Runtime.executionContextCreated') {
    const context = params.context;
    const contextFrame = context?.auxData?.frameId;
    if (contextFrame && blocked?.ids?.has(contextFrame)) return true;
    if (descendantOfProtected(contextFrame, catalog, frameUrls, frameParents, options)) {
      if (contextFrame) blocked?.ids?.add(contextFrame);
      return true;
    }
  }
  return false;
}

function pageFrameEventName(method) {
  return [
    'Page.frameAttached',
    'Page.frameStartedLoading',
    'Page.frameNavigated',
    'Page.frameRequestedNavigation',
    'Page.lifecycleEvent',
    'Page.navigatedWithinDocument',
  ].includes(method);
}

function emitProtectedParentIframeLeak(event, options, ctx) {
  const info = event.params?.targetInfo;
  const publish = (exposed) => {
    if (ctx.mentions(exposed) || ctx.hidden(exposed)) return;
    ctx.messages.push(JSON.stringify(exposed));
    ctx.events.push(exposed);
    for (const waiter of ctx.waiters)
      if (waiter.pred(exposed)) {
        ctx.waiters.delete(waiter);
        waiter.resolve(exposed);
      }
  };
  if (options.leakTargetDestroyed && info?.targetId) {
    if (!ctx.destroyedIds.has(info.targetId)) {
      ctx.destroyedIds.add(info.targetId);
      publish(
        ctx.sanitize({
          method: 'Target.targetDestroyed',
          params: { targetId: info.targetId },
        })
      );
    }
    return 'skip';
  }
  if (options.leakAttachedToTarget) {
    if (!info?.targetId || ctx.destroyedIds.has(`attached:${info.targetId}`)) return 'skip';
    ctx.destroyedIds.add(`attached:${info.targetId}`);
    publish(
      ctx.sanitize({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: event.params?.sessionId ?? `leak-${info.targetId}`,
          targetInfo: rewriteIframeInfo(info, options),
          waitingForDebugger: false,
        },
      })
    );
    return event.method === 'Target.attachedToTarget' ? 'attached' : 'skip';
  }
  if (!options.leakIframeEvents && !options.redactIframeUrlKeepId) return 'skip';
  publish(
    ctx.sanitize({
      ...event,
      params: {
        ...event.params,
        targetInfo: rewriteIframeInfo(
          options.redactIframeUrlKeepId ? info : ctx.redactInfo(info),
          options
        ),
      },
    })
  );
  return event.method === 'Target.attachedToTarget' ? 'attached' : 'skip';
}

async function leakDescendantIframeEvents(event, options, ctx, unguarded, catalog, decisions) {
  if (!options.leakAttachedToTarget && !options.leakIframeEvents) return;
  const parent = event.params?.targetInfo;
  if (!parent?.targetId || parent.type !== 'iframe') return;
  const listed = await unguarded.send('Target.getTargets').catch(() => null);
  for (const info of listed?.targetInfos ?? []) {
    if (info.type !== 'iframe' || info.parentId !== parent.targetId) continue;
    if (!(await iframeAncestorProtected(unguarded, catalog, info, options, decisions))) continue;
    emitProtectedParentIframeLeak(
      {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: `leak-child-${info.targetId}`,
          targetInfo: info,
          waitingForDebugger: false,
        },
        sessionId: event.params?.sessionId,
      },
      options,
      ctx
    );
    if (options.leakIframeEvents) {
      emitProtectedParentIframeLeak(
        {
          method: 'Target.targetInfoChanged',
          params: { targetInfo: info },
          sessionId: event.params?.sessionId,
        },
        options,
        ctx
      );
    }
  }
}

function emulatedGuardPlain(browser, options = {}) {
  const { client, unguarded } = browser;
  const hosts = options.protectedHosts ?? [];
  const catalog = options.protectedOrigins
    ? protectedOrigins(options.protectedOrigins, options.extraOrigins ?? [])
    : null;
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
  const navigationURLs = new Map();
  const observerSessions = new Map();
  const sessionBlocked = new Map();
  const targetBlocked = new Map();
  const blockedContexts = new Set();
  const frameUrls = new Map();
  const frameParents = new Map();
  let frameCursor = 0;
  let liveResourceTreeReads = 0;
  const ownerOf = (sessionId) =>
    shields.get(sessionId)?.targetId ?? observerSessions.get(sessionId);
  const markPending = (targetId, url) => {
    if (!targetId) return;
    navigating.add(targetId);
    if (url !== undefined) navigationURLs.set(targetId, url);
  };
  const clearPending = (targetId) => {
    navigating.delete(targetId);
    navigationURLs.delete(targetId);
  };
  const learnFrames = () => {
    for (const event of unguarded.events.slice(frameCursor)) {
      frameCursor++;
      if (event.method === 'Target.attachedToTarget') {
        observerSessions.set(event.params.sessionId, event.params.targetInfo.targetId);
        continue;
      }
      if (event.method === 'Target.detachedFromTarget') {
        observerSessions.delete(event.params.sessionId);
        continue;
      }
      const targetId = ownerOf(event.sessionId);
      const owner = shields.get(event.sessionId);
      if (
        event.method === 'Fetch.requestPaused' &&
        event.params.resourceType === 'Document' &&
        targetId
      ) {
        markPending(targetId, event.params.request?.url ?? '');
        continue;
      }
      if (
        event.method === 'Page.frameStartedNavigating' &&
        targetId &&
        !['sameDocument', 'historySameDocument'].includes(event.params.navigationType)
      ) {
        const frame = frames.get(targetId);
        if (!frame || event.params.frameId === frame.id)
          markPending(targetId, event.params.url ?? '');
        continue;
      }
      if (!owner || !catalog) continue;
      if (event.method === 'Page.frameNavigated' && !event.params.frame.parentId) {
        const f = event.params.frame;
        frames.set(owner.targetId, f);
        clearPending(owner.targetId);
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
        event.method === 'Page.frameStoppedLoading' &&
        event.params.frameId === frames.get(owner.targetId)?.id
      )
        clearPending(owner.targetId);
    }
  };
  const redactInfo = (info) => {
    if (
      options.extensionFrames &&
      !options.exposeExtensionFrames &&
      catalog?.extensionFrame(info.url)
    )
      return { ...info, url: '', title: '' };
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
  const keepClosed = async (targetId) => {
    if (options.allowKeptClose) return false;
    learnFrames();
    if (navigating.has(targetId))
      return unclosableShape({
        url: navigationURLs.get(targetId) ?? '',
        documentURL: frames.get(targetId)?.url,
        securityOrigin: frames.get(targetId)?.securityOrigin,
        navigating: true,
        navigationURL: navigationURLs.get(targetId),
      });
    const info = await Promise.race([
      unguarded.send('Target.getTargetInfo', { targetId }),
      pause(400).then(() => undefined),
    ]);
    if (!info) return false;
    const { targetInfo } = info;
    let f = frames.get(targetId);
    if (!f) {
      const attached = await outcome(
        unguarded.send('Target.attachToTarget', { targetId, flatten: true })
      );
      if (attached.ok) {
        observerSessions.set(attached.result.sessionId, targetId);
        await outcome(unguarded.send('Page.enable', {}, attached.result.sessionId));
        const tree = await Promise.race([
          outcome(unguarded.send('Page.getFrameTree', {}, attached.result.sessionId)),
          pause(400).then(() => ({ ok: false })),
        ]);
        if (tree.ok) {
          f = tree.result.frameTree.frame;
          frames.set(targetId, f);
        }
      }
    }
    let securityOrigin = f?.securityOrigin;
    const blank =
      !targetInfo.url || targetInfo.url === 'about:blank' || targetInfo.url === 'about:srcdoc';
    if (blank && (!securityOrigin || securityOrigin === '://') && targetInfo.openerId) {
      const opener = await Promise.race([
        unguarded.send('Target.getTargetInfo', { targetId: targetInfo.openerId }),
        pause(400).then(() => undefined),
      ]);
      if (opener) securityOrigin = parseURL(opener.targetInfo.url)?.origin ?? opener.targetInfo.url;
    }
    return unclosableShape({
      url: targetInfo.url,
      documentURL: f?.url ?? targetInfo.url,
      securityOrigin,
      navigating: navigating.has(targetId),
      navigationURL: navigationURLs.get(targetId),
    });
  };
  const contexts = new Set();
  const extensionContexts = new Map();
  const cutSessions = new Set();
  const cutFrameSessions = new Set();
  const casting = new Set();
  const castStopped = new Set();
  const failedDocumentTargets = new Set();
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
  const destroyedIds = new Set();
  const protectedBodies = new Set();
  let bodyCursor = options.extensionFrames ? client.events.length : 0;
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
    ) {
      protectedBodies.add(`${event.sessionId}:${event.params.requestId}`);
      if (event.params.networkId)
        protectedBodies.add(`${event.sessionId}:${event.params.networkId}`);
    }
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
  let cursor = options.extensionFrames ? client.events.length : 0;
  let guardCursor = options.extensionFrames ? unguarded.events.length : 0;
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
    const failDocument = (options.failDocumentOrigins ?? []).some((origin) =>
      request.url.startsWith(`${origin}/`)
    );
    const blocked =
      hosts.includes(parseURL(request.url)?.host) ||
      Boolean(catalog?.url(request.url)) ||
      failDocument;
    if (
      options.closeProtected &&
      event.params.resourceType === 'Document' &&
      /\/slow(?:\?|$)/.test(request.url ?? '')
    ) {
      markPending(owner.targetId, request.url ?? '');
      await unguarded.send('Fetch.continueRequest', { requestId }, event.sessionId).catch(() => {});
      return;
    }
    if (!blocked) {
      await pause(options.documentLatency?.(request.url) ?? 0);
      await unguarded.send('Fetch.continueRequest', { requestId }, event.sessionId).catch(() => {});
      return;
    }
    if (failDocument) failedDocumentTargets.add(owner.targetId);
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
        if (options.extensionFrames && !options.exposeExtensionFrames) {
          if (
            event.method === 'Target.attachedToTarget' &&
            catalog.extensionFrame(event.params.targetInfo.url)
          ) {
            cutFrameSessions.add(event.params.sessionId);
            await client
              .send('Target.detachFromTarget', { sessionId: event.params.sessionId })
              .catch(() => {});
            continue;
          }
          if (
            cutFrameSessions.has(event.sessionId) ||
            (event.method === 'Target.detachedFromTarget' &&
              cutFrameSessions.has(event.params.sessionId))
          )
            continue;
          if (
            event.method === 'Page.screencastFrame' &&
            !options.keepScreencastStreaming &&
            (casting.has(event.sessionId) || castStopped.has(event.sessionId))
          ) {
            const owner = sessions.get(event.sessionId);
            if (
              castStopped.has(event.sessionId) ||
              (owner && (await extensionFramesOf(owner)).length > 0)
            ) {
              if (casting.has(event.sessionId) && !castStopped.has(event.sessionId)) {
                castStopped.add(event.sessionId);
                casting.delete(event.sessionId);
                await client.send('Page.stopScreencast', {}, event.sessionId).catch(() => {});
              }
              continue;
            }
          }
        }
        const failedDocumentTarget =
          sessions.get(event.sessionId) ?? shields.get(event.sessionId)?.targetId;
        if (
          failedDocumentTargets.has(failedDocumentTarget) &&
          event.method === 'Page.loadEventFired'
        )
          continue;
        if (
          catalog &&
          ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.attachedToTarget'].includes(
            event.method
          ) &&
          event.params?.targetInfo?.type === 'iframe' &&
          (await iframeAncestorProtected(
            unguarded,
            catalog,
            event.params.targetInfo,
            options,
            decisions
          ))
        ) {
          const leaked = emitProtectedParentIframeLeak(event, options, {
            messages,
            events,
            waiters,
            sanitize,
            redactInfo,
            mentions,
            hidden,
            destroyedIds,
          });
          if (leaked !== 'attached') continue;
        } else if (
          catalog &&
          event.method === 'Target.attachedToTarget' &&
          event.params?.targetInfo?.type === 'iframe'
        ) {
          await leakDescendantIframeEvents(
            event,
            options,
            {
              messages,
              events,
              waiters,
              sanitize,
              redactInfo,
              mentions,
              hidden,
              destroyedIds,
            },
            unguarded,
            catalog,
            decisions
          );
        }
        const pageSession = event.sessionId;
        if (options.protectedParentPages) {
          const blocked = pageSession ? sessionBlocked.get(pageSession) : undefined;
          if (event.method === 'Page.frameNavigated' && event.params?.frame?.id) {
            frameUrls.set(event.params.frame.id, event.params.frame.url ?? '');
            if (event.params.frame.parentId)
              frameParents.set(event.params.frame.id, event.params.frame.parentId);
          }
          if (
            event.method === 'Page.frameAttached' &&
            event.params?.frameId &&
            event.params.parentFrameId
          )
            frameParents.set(event.params.frameId, event.params.parentFrameId);
          if (
            catalog &&
            pageDescendantEvent(event, blocked, options, catalog, frameUrls, frameParents) &&
            !(
              (options.leakProtectedFrameEvents || options.refuseChildEnableLeakEvents) &&
              pageFrameEventName(event.method)
            ) &&
            !(
              (options.leakProtectedFrameContexts || options.refuseChildEnableLeakEvents) &&
              event.method === 'Runtime.executionContextCreated'
            )
          ) {
            if (
              event.method === 'Runtime.executionContextCreated' &&
              pageSession &&
              event.params?.context?.id != null
            )
              blockedContexts.add(`${pageSession}:${event.params.context.id}`);
            continue;
          }
          if (
            catalog &&
            event.method === 'Runtime.executionContextCreated' &&
            pageSession &&
            pageDescendantEvent(
              event,
              blocked,
              { ...options, leakProtectedFrameContexts: false },
              catalog,
              frameUrls,
              frameParents
            )
          )
            blockedContexts.add(`${pageSession}:${event.params.context.id}`);
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
  const forwarded = [];
  return {
    client: {
      ...client,
      events,
      messages,
      forwarded,
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
  async function extensionFramesOf(targetId) {
    const { targetInfos } = await unguarded.send('Target.getTargets');
    const byId = new Map(targetInfos.map((info) => [info.targetId, info]));
    const under = (info) => {
      let cur = info;
      while (cur) {
        if (cur.parentId === targetId) return true;
        if (!cur.parentId) return false;
        cur = byId.get(cur.parentId);
      }
      return false;
    };
    return targetInfos.filter(
      (info) => info.type === 'iframe' && catalog.extensionFrame(info.url) && under(info)
    );
  }
  function scrubExtensionSecrets(value) {
    if (!options.extensionFrames || !catalog) return value;
    const text = JSON.stringify(value);
    if (
      !text.includes('slicc-frame-test-user') &&
      !text.includes('slicc-private-extension-frame-content') &&
      !text.includes('chrome-extension://')
    )
      return value;
    const walk = (entry) => {
      if (typeof entry === 'string') {
        if (
          entry.includes('slicc-frame-test-user') ||
          entry.includes('slicc-private-extension-frame-content') ||
          catalog.extensionFrame(entry) ||
          entry.startsWith('chrome-extension://')
        )
          return '';
        return entry;
      }
      if (Array.isArray(entry)) return entry.map(walk);
      if (entry && typeof entry === 'object') {
        const copy = {};
        for (const [key, child] of Object.entries(entry)) copy[key] = walk(child);
        return copy;
      }
      return entry;
    };
    return walk(value);
  }
  async function frameOwner(targetId, frameId) {
    const shieldSession = [...shields].find(([, entry]) => entry.targetId === targetId)?.[0];
    const root = frames.get(targetId)?.id;
    if (!shieldSession || !root) return null;
    await unguarded.send('DOM.enable', {}, shieldSession);
    const world = await unguarded.send(
      'Page.createIsolatedWorld',
      { frameId: root, worldName: 'slicc-emulator-frames' },
      shieldSession
    );
    const { backendNodeId } = await unguarded.send('DOM.getFrameOwner', { frameId }, shieldSession);
    const { object } = await unguarded.send(
      'DOM.resolveNode',
      { backendNodeId, executionContextId: world.executionContextId },
      shieldSession
    );
    return { shieldSession, objectId: object.objectId };
  }
  async function frameShown(targetId, list) {
    if (!list.length || options.frameVisibility === 'ignored') return false;
    const test =
      options.frameVisibility === 'opacity'
        ? `function(){
            if (!this.checkVisibility({visibilityProperty:true,opacityProperty:true})) return false;
            const r = this.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }`
        : options.frameVisibility === 'viewport'
          ? `function(){
            if (!this.checkVisibility({visibilityProperty:true})) return false;
            const r = this.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return false;
            return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
          }`
          : `function(){
            if (!this.checkVisibility({visibilityProperty:true})) return false;
            const r = this.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }`;
    try {
      for (const frame of list) {
        const owner = await frameOwner(targetId, frame.targetId);
        if (!owner) return true;
        const { result } = await unguarded.send(
          'Runtime.callFunctionOn',
          {
            objectId: owner.objectId,
            functionDeclaration: test,
            returnByValue: true,
          },
          owner.shieldSession
        );
        if (result.value !== false) return true;
      }
      return false;
    } catch {
      return true;
    }
  }
  async function frameFocused(targetId, list) {
    if (!list.length || options.frameFocus === 'ignored') return false;
    try {
      for (const frame of list) {
        const owner = await frameOwner(targetId, frame.targetId);
        if (!owner) return true;
        const { result } = await unguarded.send(
          'Runtime.callFunctionOn',
          {
            objectId: owner.objectId,
            functionDeclaration: `function () {
              let node = this;
              for (let depth = 0; depth < 64; depth++) {
                const root = node.getRootNode();
                if (root.activeElement !== node) return false;
                if (!root.host) return true;
                node = root.host;
              }
              return true;
            }`,
            returnByValue: true,
          },
          owner.shieldSession
        );
        if (result.value === true) return true;
      }
      return false;
    } catch {
      return true;
    }
  }
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
      options.closeProtected &&
      (method === 'Target.closeTarget'
        ? !options.refuseClose && (await keepClosed(targetId))
        : method === 'Target.attachToTarget' && (await keepClosed(targetId)))
    )
      throw refusal('protected target');
    if (
      catalog &&
      !options.catalogAttachOnly &&
      targetId &&
      !(options.forwardFrameReads ?? []).includes(method) &&
      (sessionId ||
        method === 'Target.attachToTarget' ||
        ((!options.closeProtected || options.refuseClose) && method === 'Target.closeTarget')) &&
      (await decision(targetId))
    )
      throw refusal('protected target');
    learnWorlds();
    if (
      cutSessions.has(sessionId) &&
      !(
        options.protectedParentPages &&
        (method === 'Page.getResourceTree' || method === 'Page.getFrameTree')
      )
    )
      throw refusal('session cut on protected execution context');
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
      const underParent = await iframeAncestorProtected(
        unguarded,
        catalog,
        targetInfo,
        options,
        decisions
      );
      if (
        (await decision(params.targetId)) ||
        (underParent &&
          !options.allowProtectedParentAttach &&
          !(options.protectedParentPages && options.refuseChildEnableAllowAttach))
      )
        throw catalog.unparseable(targetInfo.url)
          ? new Error(options.protectedOrigins.unparseableRefusal)
          : refusal('protected target');
      const attached = await unguarded.send('Target.attachToTarget', {
        targetId: params.targetId,
        flatten: true,
      });
      try {
        const { frameTree } = await unguarded.send('Page.getFrameTree', {}, attached.sessionId);
        const allowExtension = (url) => options.extensionFrames && catalog.extensionFrame(url);
        const protectedFrame = (tree) =>
          (catalog.url(tree.frame.url) && !allowExtension(tree.frame.url)) ||
          (tree.frame.securityOrigin &&
            catalog.url(tree.frame.securityOrigin) &&
            !allowExtension(tree.frame.securityOrigin)) ||
          (tree.childFrames ?? []).some(protectedFrame);
        if (options.protectedParentPages) {
          const top = frameTree?.frame;
          const topProtected =
            top &&
            ((catalog.url(top.url) && !allowExtension(top.url)) ||
              (top.securityOrigin &&
                catalog.url(top.securityOrigin) &&
                !allowExtension(top.securityOrigin)));
          if (topProtected) throw refusal('protected frame');
          targetBlocked.set(
            params.targetId,
            collectProtectedDescendantIds(frameTree, catalog, options)
          );
        } else if (protectedFrame(frameTree)) throw refusal('protected frame');
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
        if (options.protectedParentPages) {
          const blocked = targetBlocked.get(params.targetId) ?? {
            ids: new Set(),
            urls: new Set(),
            midIds: new Set(),
          };
          for (const event of frames) {
            const info = event.params.targetInfo;
            if (!catalog.url(info.url) || allowExtension(info.url)) continue;
            blocked.urls.add(info.url);
            if (info.targetId) blocked.ids.add(info.targetId);
          }
          targetBlocked.set(params.targetId, blocked);
        } else if (
          frames.some(
            (event) =>
              catalog.url(event.params.targetInfo.url) &&
              !allowExtension(event.params.targetInfo.url)
          )
        )
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
    const frameRules = options.extensionFrames ? options.protectedOrigins.extensionFrames : null;
    const inputMethod = method.startsWith('Input.');
    const gated =
      frameRules &&
      sessionId &&
      targetId &&
      (frameRules.whenShown.includes(method) || frameRules.whilePresent.includes(method));
    const held = gated ? await extensionFramesOf(targetId) : [];
    if (
      held.length &&
      frameRules.whilePresent.includes(method) &&
      !(options.exposeFramePDF && method === 'Page.printToPDF')
    )
      throw new Error(frameRules.presentRefusal);
    const focusBlocks =
      held.length > 0 &&
      (inputMethod || options.screenshotFocus !== 'ignored') &&
      (await frameFocused(targetId, held));
    const blocked =
      held.length &&
      frameRules.whenShown.includes(method) &&
      ((await frameShown(targetId, held)) || focusBlocks);
    if (blocked) throw new Error(frameRules.shownRefusal);
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
    let forward = params;
    if (options.stripUniversalAccess && method === 'Page.createIsolatedWorld' && params) {
      forward = { ...params };
      delete forward.grantUniveralAccess;
      delete forward.contentSecurityPolicy;
    }
    if (
      options.narrowAutoAttach &&
      method === 'Target.setAutoAttach' &&
      params?.autoAttach &&
      Array.isArray(params.filter) &&
      !sessionId
    ) {
      forward = {
        ...params,
        filter: [{ type: 'tab' }],
      };
    }
    forwarded.push({ method, params: forward, sessionId, sentAt: Date.now() });
    const result = await client.send(method, forward, sessionId);
    if (method === 'Page.startScreencast' && sessionId) casting.add(sessionId);
    if (method === 'Page.stopScreencast' && sessionId) {
      casting.delete(sessionId);
      castStopped.delete(sessionId);
    }
    const after = held.length ? await extensionFramesOf(targetId) : [];
    const focusBlocksAfter =
      after.length > 0 &&
      (inputMethod || options.screenshotFocus !== 'ignored') &&
      (await frameFocused(targetId, after));
    if (
      after.length &&
      frameRules.whenShown.includes(method) &&
      ((await frameShown(targetId, after)) || focusBlocksAfter)
    )
      throw new Error(frameRules.shownRefusal);
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
      if (options.protectedParentPages && catalog && targetBlocked.has(params.targetId))
        sessionBlocked.set(result.sessionId, targetBlocked.get(params.targetId));
    }
    if (options.protectedParentPages && catalog && method === 'Page.enable' && sessionId) {
      const owner = sessions.get(sessionId) ?? ownerOf(sessionId);
      if (owner && targetBlocked.has(owner))
        sessionBlocked.set(sessionId, targetBlocked.get(owner));
    }
    if (
      options.protectedParentPages &&
      catalog &&
      (options.refuseChildEnableLeakEvents || options.refuseChildEnableAllowAttach) &&
      sessionId &&
      (method === 'Page.enable' || method === 'Runtime.enable')
    ) {
      const owner = sessions.get(sessionId) ?? ownerOf(sessionId);
      if (owner && !pages.has(owner)) {
        const { targetInfo } = await unguarded
          .send('Target.getTargetInfo', { targetId: owner })
          .catch(() => ({ targetInfo: null }));
        if (
          (await decision(owner)) ||
          (targetInfo &&
            (await iframeAncestorProtected(unguarded, catalog, targetInfo, options, decisions)))
        )
          throw refusal('protected frame');
      }
    }
    if (method === 'Target.getTargetInfo' && catalog) {
      const info = result.targetInfo;
      if (
        info &&
        (await iframeAncestorProtected(unguarded, catalog, info, options, decisions)) &&
        options.redactIframeUrlKeepId
      )
        return { ...result, targetInfo: rewriteIframeInfo(info, options) };
      if (info && (await iframeAncestorProtected(unguarded, catalog, info, options, decisions)))
        throw refusal('protected target');
      return { ...result, targetInfo: redactInfo(info) };
    }
    if (method === 'Target.getTargets' && Array.isArray(result?.targetInfos)) {
      const visible = [];
      for (const info of result.targetInfos) {
        if (
          options.extensionFrames &&
          !options.exposeExtensionFrames &&
          catalog?.extensionFrame(info.url)
        )
          continue;
        const underParent = catalog
          ? await iframeAncestorProtected(unguarded, catalog, info, options, decisions)
          : false;
        if (underParent && options.redactIframeUrlKeepId) {
          visible.push(rewriteIframeInfo(info, options));
          continue;
        }
        if (underParent) continue;
        if (
          !mentions(info) &&
          !(options.hideTypes ?? []).includes(info.type) &&
          (!catalog || !(await decision(info.targetId)))
        )
          visible.push(info);
      }
      return {
        ...result,
        targetInfos: visible.map((info) => (catalog ? redactInfo(info) : info)),
      };
    }
    if (
      options.protectedParentPages &&
      catalog &&
      method === 'Runtime.evaluate' &&
      sessionId &&
      params?.contextId != null &&
      blockedContexts.has(`${sessionId}:${params.contextId}`) &&
      !options.leakProtectedFrameContexts &&
      !options.refuseChildEnableLeakEvents
    )
      throw refusal('protected frame context');
    if (
      options.protectedParentPages &&
      catalog &&
      method === 'Page.getFrameTree' &&
      result?.frameTree
    ) {
      const blocked = collectProtectedDescendantIds(result.frameTree, catalog, options);
      if (sessionId) sessionBlocked.set(sessionId, blocked);
      const learn = (node, parentId) => {
        if (!node?.frame) return;
        frameUrls.set(node.frame.id, node.frame.url ?? '');
        if (parentId) frameParents.set(node.frame.id, parentId);
        for (const child of node.childFrames ?? []) learn(child, node.frame.id);
      };
      learn(result.frameTree, undefined);
      return {
        ...result,
        frameTree: scrubProtectedDescendantTree(result.frameTree, catalog, options),
      };
    }
    if (
      options.protectedParentPages &&
      catalog &&
      method === 'Page.getResourceTree' &&
      result?.frameTree
    ) {
      const blocked = collectProtectedDescendantIds(result.frameTree, catalog, options);
      if (sessionId) sessionBlocked.set(sessionId, blocked);
      if (options.leakResourceTreeAlways) return result;
      if (options.leakResourceTreeAfterLive) {
        const live = /[?&]live=|-live-/.test(JSON.stringify(result.frameTree));
        if (live) {
          liveResourceTreeReads += 1;
          if (liveResourceTreeReads > 1) return result;
        }
      }
      return scrubProtectedResourceTree(result, catalog, options);
    }
    if (
      options.extensionFrames &&
      [
        'Page.getFrameTree',
        'DOM.getDocument',
        'DOMSnapshot.captureSnapshot',
        'Accessibility.getFullAXTree',
        'Accessibility.getPartialAXTree',
        'DOM.describeNode',
        'DOM.getOuterHTML',
        'Runtime.evaluate',
      ].includes(method) &&
      !options.exposeFramePageReads &&
      !(options.forwardFrameReads ?? []).includes(method)
    )
      return scrubExtensionSecrets(result);
    return options.redirectSecrets && catalog ? redactProtectedURLs(result, catalog) : result;
  }
}

async function timedSend(client, method, params, sessionId, ms, label) {
  let timer;
  try {
    return await Promise.race([
      client.send(method, params, sessionId),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Page.getFrameTree timed out on ${label} session ${sessionId ?? 'browser'} after ${ms}ms`
              )
            ),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function emulatedGuardWithWorkerRules(browser, options = {}) {
  const { client, unguarded } = browser;
  const hosts = options.protectedHosts ?? [];
  const catalog = options.protectedOrigins
    ? protectedOrigins(options.protectedOrigins, options.extraOrigins ?? [])
    : null;
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
  const navigationURLs = new Map();
  let frameCursor = 0;
  const markPending = (targetId, url) => {
    if (!targetId) return;
    navigating.add(targetId);
    if (url !== undefined) navigationURLs.set(targetId, url);
  };
  const clearPending = (targetId) => {
    navigating.delete(targetId);
    navigationURLs.delete(targetId);
  };
  const learnFrames = () => {
    for (const event of unguarded.events.slice(frameCursor)) {
      frameCursor++;
      const owner = shields.get(event.sessionId);
      if (!owner || !catalog) continue;
      if (event.method === 'Page.frameNavigated' && !event.params.frame.parentId) {
        const f = event.params.frame;
        frames.set(owner.targetId, f);
        clearPending(owner.targetId);
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
        markPending(owner.targetId, event.params.url ?? '');
      if (
        event.method === 'Page.frameStoppedLoading' &&
        event.params.frameId === frames.get(owner.targetId)?.id
      )
        clearPending(owner.targetId);
    }
  };
  const redactInfo = (info) => {
    if (
      options.extensionFrames &&
      !options.exposeExtensionFrames &&
      catalog?.extensionFrame(info.url)
    )
      return { ...info, url: '', title: '' };
    if (!catalog?.url(info.url, { readOnly: true })) return info;
    let origin;
    try {
      origin = new URL(info.url).origin;
    } catch {
      return info;
    }
    return { ...info, url: origin, title: origin };
  };
  const rewriteWorkerInfo = (info) => {
    if (options.emptyWorkerTargetInfo) return {};
    if (options.rewriteProtectedWorkers)
      return { targetId: `rewritten-${info.targetId}`, type: 'other', url: '' };
    return redactInfo(info);
  };
  const workerHeldUntil = options.delayProtectedWorkerMs
    ? Date.now() + options.delayProtectedWorkerMs
    : 0;
  let listHoldStart = 0;
  const workerType = (info) => ['worker', 'shared_worker', 'service_worker'].includes(info.type);
  const ownerOpener = async (info) => {
    const ownerIds = [
      ...new Set([info.openerId, info.parentId, info.openerFrameId].filter(Boolean)),
    ];
    if (!ownerIds.length) return info.url ? undefined : 'unknown';
    for (const ownerId of ownerIds) {
      if (decisions.get(ownerId) === true) return 'protected';
      const frame = frames.get(ownerId);
      if (frame?.url && catalog.url(frame.url)) return 'protected';
      if (frame?.unreachableUrl && catalog.url(frame.unreachableUrl)) return 'protected';
      const got = await unguarded
        .send('Target.getTargetInfo', { targetId: ownerId })
        .catch(() => null);
      const owner = got?.targetInfo;
      if (!owner) continue;
      if (catalog.url(owner.url)) return 'protected';
      if (
        catalog.target({
          ...owner,
          documentURL: frame?.url,
          unreachableURL: frame?.unreachableUrl,
          previous: decisions.get(ownerId) ?? false,
        })
      )
        return 'protected';
    }
    return 'unprotected';
  };
  const decision = async (targetId) => {
    const got = await unguarded.send('Target.getTargetInfo', { targetId }).catch(() => null);
    if (!got?.targetInfo) return false;
    const { targetInfo } = got;
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
    if (blocked || options.targetURLOnly || !workerType(targetInfo)) return blocked;
    const opener = await ownerOpener(targetInfo);
    if (opener === undefined) return blocked;
    return catalog.target({
      ...targetInfo,
      documentURL,
      unreachableURL,
      navigating: navigating.has(targetId),
      previous: options.unlockErrorPage ? false : previous,
      opener,
    });
  };
  const contexts = new Set();
  const extensionContexts = new Map();
  const cutSessions = new Set();
  const paused = new Set();
  const tabSessions = new Set();
  const cutFrameSessions = new Set();
  const casting = new Set();
  const castStopped = new Set();
  const failedDocumentTargets = new Set();
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
  const destroyedIds = new Set();
  const protectedBodies = new Set();
  let bodyCursor = options.extensionFrames ? client.events.length : 0;
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
    ) {
      protectedBodies.add(`${event.sessionId}:${event.params.requestId}`);
      if (event.params.networkId)
        protectedBodies.add(`${event.sessionId}:${event.params.networkId}`);
    }
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
  let cursor = options.extensionFrames ? client.events.length : 0;
  let guardCursor = options.extensionFrames ? unguarded.events.length : 0;
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
    const failDocument = (options.failDocumentOrigins ?? []).some((origin) =>
      request.url.startsWith(`${origin}/`)
    );
    const blocked =
      hosts.includes(parseURL(request.url)?.host) ||
      Boolean(catalog?.url(request.url)) ||
      failDocument;
    if (
      options.closeProtected &&
      event.params.resourceType === 'Document' &&
      /\/slow(?:\?|$)/.test(request.url ?? '')
    ) {
      markPending(owner.targetId, request.url ?? '');
      await unguarded.send('Fetch.continueRequest', { requestId }, event.sessionId).catch(() => {});
      return;
    }
    if (!blocked) {
      await pause(options.documentLatency?.(request.url) ?? 0);
      await unguarded.send('Fetch.continueRequest', { requestId }, event.sessionId).catch(() => {});
      return;
    }
    if (failDocument) failedDocumentTargets.add(owner.targetId);
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
          catalog &&
          ['Target.attachedToTarget', 'Target.targetCreated', 'Target.targetInfoChanged'].includes(
            event.method
          ) &&
          ['worker', 'shared_worker', 'service_worker'].includes(event.params?.targetInfo?.type) &&
          (await decision(event.params.targetInfo.targetId))
        ) {
          const rewrite = options.rewriteProtectedWorkers || options.emptyWorkerTargetInfo;
          if (!options.exposeProtectedWorkers && !rewrite) {
            if (event.method === 'Target.attachedToTarget') {
              if (event.params.waitingForDebugger)
                await client
                  .send('Runtime.runIfWaitingForDebugger', {}, event.params.sessionId)
                  .catch(() => {});
              await client
                .send('Target.detachFromTarget', { sessionId: event.params.sessionId })
                .catch(() => {});
            }
            continue;
          }
          if (options.delayProtectedWorkerMs) await pause(options.delayProtectedWorkerMs);
          if (rewrite) {
            if (event.method === 'Target.attachedToTarget' && event.params.waitingForDebugger)
              await client
                .send('Runtime.runIfWaitingForDebugger', {}, event.params.sessionId)
                .catch(() => {});
            const exposed = sanitize({
              ...event,
              params: {
                ...event.params,
                waitingForDebugger: false,
                targetInfo: rewriteWorkerInfo(event.params.targetInfo),
              },
            });
            if (!mentions(exposed) && !hidden(exposed)) {
              messages.push(JSON.stringify(exposed));
              events.push(exposed);
              for (const waiter of waiters)
                if (waiter.pred(exposed)) {
                  waiters.delete(waiter);
                  waiter.resolve(exposed);
                }
            }
            continue;
          }
        }
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
        if (options.extensionFrames && !options.exposeExtensionFrames) {
          if (
            event.method === 'Target.attachedToTarget' &&
            catalog.extensionFrame(event.params.targetInfo.url)
          ) {
            cutFrameSessions.add(event.params.sessionId);
            await client
              .send('Target.detachFromTarget', { sessionId: event.params.sessionId })
              .catch(() => {});
            continue;
          }
          if (
            cutFrameSessions.has(event.sessionId) ||
            (event.method === 'Target.detachedFromTarget' &&
              cutFrameSessions.has(event.params.sessionId))
          )
            continue;
          if (
            event.method === 'Page.screencastFrame' &&
            !options.keepScreencastStreaming &&
            (casting.has(event.sessionId) || castStopped.has(event.sessionId))
          ) {
            const owner = sessions.get(event.sessionId);
            if (
              castStopped.has(event.sessionId) ||
              (owner && (await extensionFramesOf(owner)).length > 0)
            ) {
              if (casting.has(event.sessionId) && !castStopped.has(event.sessionId)) {
                castStopped.add(event.sessionId);
                casting.delete(event.sessionId);
                await client.send('Page.stopScreencast', {}, event.sessionId).catch(() => {});
              }
              continue;
            }
          }
        }
        const failedDocumentTarget =
          sessions.get(event.sessionId) ?? shields.get(event.sessionId)?.targetId;
        if (
          failedDocumentTargets.has(failedDocumentTarget) &&
          event.method === 'Page.loadEventFired'
        )
          continue;
        if (
          catalog &&
          ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.attachedToTarget'].includes(
            event.method
          ) &&
          event.params?.targetInfo?.type === 'iframe' &&
          (await iframeAncestorProtected(
            unguarded,
            catalog,
            event.params.targetInfo,
            options,
            decisions
          ))
        ) {
          const leaked = emitProtectedParentIframeLeak(event, options, {
            messages,
            events,
            waiters,
            sanitize,
            redactInfo,
            mentions,
            hidden,
            destroyedIds,
          });
          if (leaked !== 'attached') continue;
        } else if (
          catalog &&
          event.method === 'Target.attachedToTarget' &&
          event.params?.targetInfo?.type === 'iframe'
        ) {
          await leakDescendantIframeEvents(
            event,
            options,
            {
              messages,
              events,
              waiters,
              sanitize,
              redactInfo,
              mentions,
              hidden,
              destroyedIds,
            },
            unguarded,
            catalog,
            decisions
          );
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
        if (options.resumeUnexposed && event.method === 'Target.attachedToTarget') {
          const info = event.params.targetInfo;
          const type = info?.type;
          const foreign = Boolean(type) && !pages.has(info.targetId) && !pages.has(info.openerId);
          if (
            event.params.waitingForDebugger &&
            type &&
            (foreign || (type !== 'page' && type !== 'iframe'))
          )
            await client
              .send('Runtime.runIfWaitingForDebugger', {}, event.params.sessionId)
              .catch(() => {});
          else if (event.params.waitingForDebugger) paused.add(event.params.sessionId);
          if (type === 'tab') tabSessions.add(event.params.sessionId);
        }
        if (event.method !== 'Target.attachedToTarget') continue;
        const info = event.params.targetInfo;
        sessions.set(event.params.sessionId, info.targetId);
        if (event.params.waitingForDebugger) children.add(event.params.sessionId);
        const owned = pages.has(info.targetId) || pages.has(info.openerId);
        if (!owned) {
          foreign.add(event.params.sessionId);
          continue;
        }
        if (info.type !== 'page' || shielded.has(info.targetId)) continue;
        shielded.add(info.targetId);
        pages.add(info.targetId);
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
  const forwarded = [];
  return {
    client: {
      ...client,
      events,
      messages,
      forwarded,
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
  async function extensionFramesOf(targetId) {
    const { targetInfos } = await unguarded.send('Target.getTargets');
    const byId = new Map(targetInfos.map((info) => [info.targetId, info]));
    const under = (info) => {
      let cur = info;
      while (cur) {
        if (cur.parentId === targetId) return true;
        if (!cur.parentId) return false;
        cur = byId.get(cur.parentId);
      }
      return false;
    };
    return targetInfos.filter(
      (info) => info.type === 'iframe' && catalog.extensionFrame(info.url) && under(info)
    );
  }
  function scrubExtensionSecrets(value) {
    if (!options.extensionFrames || !catalog) return value;
    const text = JSON.stringify(value);
    if (
      !text.includes('slicc-frame-test-user') &&
      !text.includes('slicc-private-extension-frame-content') &&
      !text.includes('chrome-extension://')
    )
      return value;
    const walk = (entry) => {
      if (typeof entry === 'string') {
        if (
          entry.includes('slicc-frame-test-user') ||
          entry.includes('slicc-private-extension-frame-content') ||
          catalog.extensionFrame(entry) ||
          entry.startsWith('chrome-extension://')
        )
          return '';
        return entry;
      }
      if (Array.isArray(entry)) return entry.map(walk);
      if (entry && typeof entry === 'object') {
        const copy = {};
        for (const [key, child] of Object.entries(entry)) copy[key] = walk(child);
        return copy;
      }
      return entry;
    };
    return walk(value);
  }
  async function frameOwner(targetId, frameId) {
    const shieldSession = [...shields].find(([, entry]) => entry.targetId === targetId)?.[0];
    const root = frames.get(targetId)?.id;
    if (!shieldSession || !root) return null;
    await unguarded.send('DOM.enable', {}, shieldSession);
    const world = await unguarded.send(
      'Page.createIsolatedWorld',
      { frameId: root, worldName: 'slicc-emulator-frames' },
      shieldSession
    );
    const { backendNodeId } = await unguarded.send('DOM.getFrameOwner', { frameId }, shieldSession);
    const { object } = await unguarded.send(
      'DOM.resolveNode',
      { backendNodeId, executionContextId: world.executionContextId },
      shieldSession
    );
    return { shieldSession, objectId: object.objectId };
  }
  async function frameShown(targetId, list) {
    if (!list.length || options.frameVisibility === 'ignored') return false;
    const test =
      options.frameVisibility === 'opacity'
        ? `function(){
            if (!this.checkVisibility({visibilityProperty:true,opacityProperty:true})) return false;
            const r = this.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }`
        : options.frameVisibility === 'viewport'
          ? `function(){
            if (!this.checkVisibility({visibilityProperty:true})) return false;
            const r = this.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return false;
            return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
          }`
          : `function(){
            if (!this.checkVisibility({visibilityProperty:true})) return false;
            const r = this.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }`;
    try {
      for (const frame of list) {
        const owner = await frameOwner(targetId, frame.targetId);
        if (!owner) return true;
        const { result } = await unguarded.send(
          'Runtime.callFunctionOn',
          {
            objectId: owner.objectId,
            functionDeclaration: test,
            returnByValue: true,
          },
          owner.shieldSession
        );
        if (result.value !== false) return true;
      }
      return false;
    } catch {
      return true;
    }
  }
  async function frameFocused(targetId, list) {
    if (!list.length || options.frameFocus === 'ignored') return false;
    try {
      for (const frame of list) {
        const owner = await frameOwner(targetId, frame.targetId);
        if (!owner) return true;
        const { result } = await unguarded.send(
          'Runtime.callFunctionOn',
          {
            objectId: owner.objectId,
            functionDeclaration: `function () {
              let node = this;
              for (let depth = 0; depth < 64; depth++) {
                const root = node.getRootNode();
                if (root.activeElement !== node) return false;
                if (!root.host) return true;
                node = root.host;
              }
              return true;
            }`,
            returnByValue: true,
          },
          owner.shieldSession
        );
        if (result.value === true) return true;
      }
      return false;
    } catch {
      return true;
    }
  }
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
    const startup =
      options.resumeUnexposed &&
      ((method === 'Runtime.runIfWaitingForDebugger' && paused.has(sessionId)) ||
        (method === 'Target.setAutoAttach' && tabSessions.has(sessionId)));
    if (
      catalog &&
      !startup &&
      !options.catalogAttachOnly &&
      targetId &&
      !(options.forwardFrameReads ?? []).includes(method) &&
      (sessionId ||
        method === 'Target.attachToTarget' ||
        ((!options.closeProtected || options.refuseClose) && method === 'Target.closeTarget')) &&
      !(method === 'Target.attachToTarget' && options.allowProtectedAttach) &&
      (await decision(targetId))
    ) {
      if (method === 'Target.attachToTarget' && options.cutProtectedAttach) {
        const attached = await unguarded.send('Target.attachToTarget', {
          targetId: params.targetId,
          flatten: true,
        });
        await unguarded
          .send('Target.detachFromTarget', { sessionId: attached.sessionId })
          .catch(() => {});
      }
      throw refusal('protected target');
    }
    learnWorlds();
    if (
      cutSessions.has(sessionId) &&
      !(
        options.protectedParentPages &&
        (method === 'Page.getResourceTree' || method === 'Page.getFrameTree')
      )
    )
      throw refusal('session cut on protected execution context');
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
      const worker = workerType(targetInfo);
      const pageLike = ['page', 'iframe', 'tab'].includes(targetInfo.type);
      const underParent = await iframeAncestorProtected(
        unguarded,
        catalog,
        targetInfo,
        options,
        decisions
      );
      const blocked =
        (await decision(params.targetId)) ||
        (underParent &&
          !options.allowProtectedParentAttach &&
          !(options.protectedParentPages && options.refuseChildEnableAllowAttach));
      const emptyWorker =
        worker && !(typeof targetInfo.url === 'string' && targetInfo.url.length > 0);
      if (
        (blocked || (emptyWorker && !options.exposeProtectedWorkers)) &&
        !options.allowProtectedAttach
      ) {
        if (options.cutProtectedAttach) {
          const cut = await unguarded.send('Target.attachToTarget', {
            targetId: params.targetId,
            flatten: true,
          });
          await unguarded
            .send('Target.detachFromTarget', { sessionId: cut.sessionId })
            .catch(() => {});
        }
        throw catalog.unparseable(targetInfo.url)
          ? new Error(options.protectedOrigins.unparseableRefusal)
          : refusal('protected target');
      }
      if (blocked && options.allowProtectedAttach)
        return unguarded.send('Target.attachToTarget', {
          targetId: params.targetId,
          flatten: true,
        });
      if (pageLike) {
        const attached = await unguarded.send('Target.attachToTarget', {
          targetId: params.targetId,
          flatten: true,
        });
        try {
          await unguarded
            .send('Runtime.runIfWaitingForDebugger', {}, attached.sessionId)
            .catch(() => {});
          const { frameTree } = await timedSend(
            unguarded,
            'Page.getFrameTree',
            {},
            attached.sessionId,
            3000,
            `attach probe ${targetInfo.type} ${params.targetId}`
          );
          const allowExtension = (url) => options.extensionFrames && catalog.extensionFrame(url);
          const protectedFrame = (tree) =>
            (catalog.url(tree.frame.url) && !allowExtension(tree.frame.url)) ||
            (tree.frame.securityOrigin &&
              catalog.url(tree.frame.securityOrigin) &&
              !allowExtension(tree.frame.securityOrigin)) ||
            (tree.childFrames ?? []).some(protectedFrame);
          if (protectedFrame(frameTree)) throw refusal('protected frame');
          const start = unguarded.events.length;
          await unguarded.send(
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            attached.sessionId
          );
          const childFrames = unguarded.events
            .slice(start)
            .filter(
              (event) =>
                event.method === 'Target.attachedToTarget' &&
                event.sessionId === attached.sessionId &&
                event.params.targetInfo.type === 'iframe'
            );
          if (
            childFrames.some(
              (event) =>
                catalog.url(event.params.targetInfo.url) &&
                !allowExtension(event.params.targetInfo.url)
            )
          )
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
    }
    const frameRules = options.extensionFrames ? options.protectedOrigins.extensionFrames : null;
    const inputMethod = method.startsWith('Input.');
    const gated =
      frameRules &&
      sessionId &&
      targetId &&
      (frameRules.whenShown.includes(method) || frameRules.whilePresent.includes(method));
    const held = gated ? await extensionFramesOf(targetId) : [];
    if (
      held.length &&
      frameRules.whilePresent.includes(method) &&
      !(options.exposeFramePDF && method === 'Page.printToPDF')
    )
      throw new Error(frameRules.presentRefusal);
    const focusBlocks =
      held.length > 0 &&
      (inputMethod || options.screenshotFocus !== 'ignored') &&
      (await frameFocused(targetId, held));
    const blocked =
      held.length &&
      frameRules.whenShown.includes(method) &&
      ((await frameShown(targetId, held)) || focusBlocks);
    if (blocked) throw new Error(frameRules.shownRefusal);
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
    let forward = params;
    if (options.stripUniversalAccess && method === 'Page.createIsolatedWorld' && params) {
      forward = { ...params };
      delete forward.grantUniveralAccess;
      delete forward.contentSecurityPolicy;
    }
    if (
      options.narrowAutoAttach &&
      method === 'Target.setAutoAttach' &&
      params?.autoAttach &&
      Array.isArray(params.filter) &&
      !sessionId
    ) {
      forward = {
        ...params,
        filter: [{ type: 'tab' }],
      };
    }
    forwarded.push({ method, params: forward, sessionId, sentAt: Date.now() });
    if (forwarded.length > 200) forwarded.splice(0, forwarded.length - 200);
    if (messages.length > 200) messages.splice(0, messages.length - 200);
    const result = await client.send(method, forward, sessionId);
    if (method === 'Page.startScreencast' && sessionId) casting.add(sessionId);
    if (method === 'Page.stopScreencast' && sessionId) {
      casting.delete(sessionId);
      castStopped.delete(sessionId);
    }
    const after = held.length ? await extensionFramesOf(targetId) : [];
    const focusBlocksAfter =
      after.length > 0 &&
      (inputMethod || options.screenshotFocus !== 'ignored') &&
      (await frameFocused(targetId, after));
    if (
      after.length &&
      frameRules.whenShown.includes(method) &&
      ((await frameShown(targetId, after)) || focusBlocksAfter)
    )
      throw new Error(frameRules.shownRefusal);
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
    if (method === 'Target.getTargetInfo' && catalog) {
      const info = result.targetInfo;
      if (
        info &&
        (await iframeAncestorProtected(unguarded, catalog, info, options, decisions)) &&
        options.redactIframeUrlKeepId
      )
        return { ...result, targetInfo: rewriteIframeInfo(info, options) };
      if (info && (await iframeAncestorProtected(unguarded, catalog, info, options, decisions)))
        throw refusal('protected target');
      return { ...result, targetInfo: redactInfo(info) };
    }
    if (method === 'Target.getTargets' && Array.isArray(result?.targetInfos)) {
      const visible = [];
      for (const info of result.targetInfos) {
        if (
          options.extensionFrames &&
          !options.exposeExtensionFrames &&
          catalog?.extensionFrame(info.url)
        )
          continue;
        const underParent = catalog
          ? await iframeAncestorProtected(unguarded, catalog, info, options, decisions)
          : false;
        if (underParent && options.redactIframeUrlKeepId) {
          visible.push(rewriteIframeInfo(info, options));
          continue;
        }
        if (underParent) continue;
        const worker = ['worker', 'shared_worker', 'service_worker'].includes(info.type);
        const blocked = catalog && (await decision(info.targetId));
        if (
          blocked &&
          worker &&
          (options.rewriteProtectedWorkers || options.emptyWorkerTargetInfo)
        ) {
          if (workerHeldUntil && Date.now() < workerHeldUntil) continue;
          visible.push(rewriteWorkerInfo(info));
          continue;
        }
        if (blocked && worker && options.delayProtectedListMs) {
          if (!listHoldStart) listHoldStart = Date.now();
          if (Date.now() < listHoldStart + options.delayProtectedListMs) continue;
          visible.push(redactInfo(info));
          continue;
        }
        if (
          !mentions(info) &&
          !(options.hideTypes ?? []).includes(info.type) &&
          (!catalog || options.exposeProtectedWorkers || !blocked)
        ) {
          if (blocked && worker && workerHeldUntil && Date.now() < workerHeldUntil) continue;
          visible.push(catalog ? redactInfo(info) : info);
        }
      }
      return { ...result, targetInfos: visible };
    }
    if (
      options.extensionFrames &&
      [
        'Page.getFrameTree',
        'DOM.getDocument',
        'DOMSnapshot.captureSnapshot',
        'Accessibility.getFullAXTree',
        'Accessibility.getPartialAXTree',
        'DOM.describeNode',
        'DOM.getOuterHTML',
        'Runtime.evaluate',
      ].includes(method) &&
      !options.exposeFramePageReads &&
      !(options.forwardFrameReads ?? []).includes(method)
    )
      return scrubExtensionSecrets(result);
    return options.redirectSecrets && catalog ? redactProtectedURLs(result, catalog) : result;
  }
}

export function emulatedGuard(browser, options = {}) {
  if (options.workerRules) return emulatedGuardWithWorkerRules(browser, options);
  return emulatedGuardPlain(browser, options);
}

export function withPausedSharedWorkerStall(client) {
  const paused = new Set();
  const note = (event) => {
    if (
      event?.method === 'Target.attachedToTarget' &&
      event.params?.targetInfo?.type === 'shared_worker' &&
      event.params?.waitingForDebugger &&
      event.params?.sessionId
    )
      paused.add(event.params.sessionId);
  };
  for (const event of client.events ?? []) note(event);
  const events = client.events ?? [];
  const push = events.push.bind(events);
  events.push = (...items) => {
    for (const event of items) note(event);
    return push(...items);
  };
  return {
    ...client,
    events,
    pausedSharedSessions: paused,
    send: async (method, params, sessionId) => {
      if (method === 'Runtime.runIfWaitingForDebugger' && sessionId) paused.delete(sessionId);
      if (method === 'Target.detachFromTarget' && params?.sessionId)
        paused.delete(params.sessionId);
      if (method === 'Target.createTarget' && paused.size > 0)
        throw new Error('CDP timed out: Target.createTarget');
      return client.send(method, params, sessionId);
    },
  };
}
