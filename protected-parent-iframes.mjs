import { outcome, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const refused = (out) => {
  if (out.ok) return false;
  const message = String(out.error?.message ?? out.error ?? '');
  if (/^slicc: refused:/.test(message)) return true;
  if (
    /timed out|timeout|ECONN|ENOTFOUND|EPIPE|socket hang up|fetch failed|no answer/i.test(message)
  )
    return false;
  return /Protocol error|Invalid parameters|No target with given id|No session with given id|Session with given id not found|Target closed|not found|Cannot find context/i.test(
    message
  );
};

function answered(out) {
  if (!out) return false;
  if (out.ok) return true;
  const err = out.error;
  if (err && typeof err.code === 'number') return true;
  return /^slicc: refused:/.test(String(err?.message ?? err ?? ''));
}

async function until(check, ms, step = 25) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await pause(step);
  }
}

function note(notes, label, evidence) {
  notes.push(`${label}: ${JSON.stringify(evidence)}`);
}

function walkFrames(tree, out = []) {
  if (!tree?.frame) return out;
  out.push(tree.frame);
  for (const child of tree.childFrames ?? []) walkFrames(child, out);
  return out;
}

function byIdMap(infos) {
  return new Map((infos ?? []).map((info) => [info.targetId, info]));
}

function ancestorsOf(info, byId) {
  const chain = [];
  let cur = info;
  const seen = new Set();
  while (cur) {
    if (seen.has(cur.targetId)) break;
    seen.add(cur.targetId);
    chain.push(cur);
    if (!cur.parentId) break;
    cur = byId.get(cur.parentId);
  }
  return chain;
}

function underProtected(info, byId, pageId) {
  if (!info || info.targetId === pageId) return false;
  return ancestorsOf(info, byId)
    .slice(1)
    .some((ancestor) => ancestor.targetId === pageId);
}

function collectIframes(infos, pageId) {
  const byId = byIdMap(infos);
  return (infos ?? []).filter(
    (info) => info.type === 'iframe' && info.targetId && underProtected(info, byId, pageId)
  );
}

function matchLeak(info, rawIds, rawUrls, pageId, rawParentIds) {
  if (!info) return false;
  if (rawIds.has(info.targetId)) return true;
  if (typeof info.url === 'string' && info.url.length > 0 && rawUrls.has(info.url)) return true;
  if (info.parentId && (info.parentId === pageId || rawParentIds.has(info.parentId))) return true;
  return false;
}

function leakFromList(infos, rawIds, rawUrls, pageId, rawParentIds) {
  return (infos ?? []).some((info) => matchLeak(info, rawIds, rawUrls, pageId, rawParentIds));
}

function leakFromEvents(events, rawIds, rawUrls, pageId, rawParentIds, from = 0) {
  return (events ?? []).slice(from).some((event) => {
    if (
      ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.attachedToTarget'].includes(
        event.method
      )
    )
      return matchLeak(event.params?.targetInfo, rawIds, rawUrls, pageId, rawParentIds);
    if (event.method === 'Target.targetDestroyed') return rawIds.has(event.params?.targetId);
    return false;
  });
}

async function openProtected(reader, url, notes, internalSessions) {
  const created = await outcome(
    createObserverTarget(reader, { url }, notes).then(async (result) => {
      const { sessionId } = await reader.send('Target.attachToTarget', {
        targetId: result.targetId,
        flatten: true,
      });
      await reader.send('Page.enable', {}, sessionId);
      await reader.send('Runtime.enable', {}, sessionId);
      return { targetId: result.targetId, sessionId };
    })
  );
  if (!created.ok) return created;
  internalSessions.add(created.result.sessionId);
  const ready = await waitFor(async () => {
    const read = await outcome(
      reader.send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        created.result.sessionId
      )
    );
    return read.ok && ['interactive', 'complete'].includes(read.result?.result?.value);
  }, 4000);
  note(notes, 'protected-parent.open', {
    targetId: created.result.targetId,
    url,
    ready: Boolean(ready),
  });
  if (!ready)
    return {
      ok: true,
      result: { incomplete: 'protected page did not become ready', ...created.result },
    };
  return created;
}

async function readTree(reader, sessionId) {
  const tree = await outcome(reader.send('Page.getFrameTree', {}, sessionId));
  if (!tree.ok) return null;
  return tree.result?.frameTree ?? null;
}

async function waitRawIframes(reader, pageId, budget, notes, want = 2) {
  const found = await until(async () => {
    const listed = await outcome(reader.send('Target.getTargets', {}));
    if (!listed.ok) return null;
    const iframes = collectIframes(listed.result?.targetInfos ?? [], pageId);
    if (iframes.length >= want) return { infos: listed.result.targetInfos, iframes };
    return null;
  }, budget);
  if (found) {
    note(notes, 'protected-parent.raw-iframes', {
      count: found.iframes.length,
      iframes: found.iframes.map((info) => ({
        targetId: info.targetId,
        url: info.url,
        parentId: info.parentId,
        type: info.type,
      })),
    });
    return found;
  }
  const listed = await outcome(reader.send('Target.getTargets', {}));
  note(notes, 'protected-parent.raw-iframes-missing', {
    want,
    listed: (listed.result?.targetInfos ?? [])
      .filter((info) => info.type === 'iframe' || info.targetId === pageId)
      .map((info) => ({
        targetId: info.targetId,
        type: info.type,
        url: info.url,
        parentId: info.parentId,
      })),
  });
  return null;
}

async function measureList(client, rawIds, rawUrls, pageId, rawParentIds) {
  const listed = await outcome(client.send('Target.getTargets', {}));
  if (!answered(listed)) return { out: listed, unanswered: true, leak: false };
  return {
    out: listed,
    unanswered: false,
    leak: listed.ok
      ? leakFromList(listed.result?.targetInfos ?? [], rawIds, rawUrls, pageId, rawParentIds)
      : false,
  };
}

async function measureInfo(client, rawIds, rawUrls, pageId, rawParentIds) {
  let out;
  let leak = false;
  let unanswered = false;
  let unansweredId;
  for (const targetId of rawIds) {
    const info = await outcome(client.send('Target.getTargetInfo', { targetId }));
    out ??= info;
    if (!answered(info)) {
      unanswered = true;
      unansweredId ??= targetId;
      continue;
    }
    if (!info.ok) continue;
    const targetInfo = info.result?.targetInfo;
    if (matchLeak(targetInfo, rawIds, rawUrls, pageId, rawParentIds)) leak = true;
  }
  return { out, leak, unanswered, unansweredId };
}

async function measureAttach(client, rawIds) {
  let out;
  let attachSession = false;
  let attachRefused = false;
  let unanswered = false;
  let unansweredId;
  for (const targetId of rawIds) {
    const attached = await outcome(
      client.send('Target.attachToTarget', { targetId, flatten: true })
    );
    out ??= attached;
    if (!answered(attached)) {
      unanswered = true;
      unansweredId ??= targetId;
      continue;
    }
    if (attached.ok && attached.result?.sessionId) {
      attachSession = true;
      attachRefused = false;
      await outcome(
        client.send('Target.detachFromTarget', { sessionId: attached.result.sessionId })
      );
      continue;
    }
    if (refused(attached)) attachRefused = true;
  }
  return { out, attachSession, attachRefused, unanswered, unansweredId };
}

function takeFirst(slot, sample, apply) {
  if (!slot.out) slot.out = sample.out;
  slot.unanswered ||= sample.unanswered;
  slot.unansweredId ??= sample.unansweredId;
  apply(sample);
}

function settleArm(result, key, unanswered, label, missing, fallback) {
  if (unanswered) missing.push(label);
  else if (result[key] === undefined) Object.assign(result, fallback);
}

async function measureClient({
  client,
  rawIds,
  rawUrls,
  pageId,
  rawParentIds,
  discovery,
  eventStart,
  budget,
  notes,
}) {
  const result = {};
  const missing = [];
  const windowMs = Math.min(budget, 1500);
  const deadline = Date.now() + windowMs;
  const list = { out: undefined, unanswered: false };
  const info = { out: undefined, unanswered: false };
  const attach = { out: undefined, unanswered: false };
  let firstEvents = false;
  while (Date.now() <= deadline) {
    const listed = await measureList(client, rawIds, rawUrls, pageId, rawParentIds);
    takeFirst(list, listed, (sample) => {
      if (sample.leak) result.iframeListed = true;
      else if (!sample.unanswered) result.iframeListed ??= false;
    });
    const informed = await measureInfo(client, rawIds, rawUrls, pageId, rawParentIds);
    takeFirst(info, informed, (sample) => {
      if (sample.leak) result.infoRead = true;
      else if (!sample.unanswered) result.infoRead ??= false;
    });
    if (
      discovery &&
      leakFromEvents(client.events ?? [], rawIds, rawUrls, pageId, rawParentIds, eventStart)
    ) {
      result.eventsSeen = true;
      firstEvents = true;
    }
    if (result.attachSession !== true) {
      const attached = await measureAttach(client, rawIds);
      takeFirst(attach, attached, (sample) => {
        if (sample.attachSession) {
          result.attachSession = true;
          result.attachRefused = false;
        } else if (!sample.unanswered) {
          result.attachSession = sample.attachSession;
          result.attachRefused = sample.attachRefused;
        }
      });
    }
    if (
      result.iframeListed === true &&
      result.infoRead === true &&
      (!discovery || result.eventsSeen === true) &&
      result.attachSession === true
    )
      break;
    await pause(50);
  }
  if (discovery && result.eventsSeen === undefined) result.eventsSeen = false;
  settleArm(result, 'iframeListed', list.unanswered, 'Target.getTargets unanswered', missing, {
    iframeListed: false,
  });
  settleArm(
    result,
    'infoRead',
    info.unanswered,
    info.unansweredId
      ? `Target.getTargetInfo unanswered (${info.unansweredId})`
      : 'Target.getTargetInfo unanswered',
    missing,
    { infoRead: false }
  );
  settleArm(
    result,
    'attachSession',
    attach.unanswered,
    attach.unansweredId
      ? `Target.attachToTarget unanswered (${attach.unansweredId})`
      : 'Target.attachToTarget unanswered',
    missing,
    { attachSession: false, attachRefused: false }
  );
  note(notes, 'protected-parent.client', {
    iframeListed: result.iframeListed ?? 'unmeasured',
    infoRead: result.infoRead ?? 'unmeasured',
    eventsSeen: discovery ? (result.eventsSeen ?? false) : 'not-declared',
    attachSession: result.attachSession ?? 'unmeasured',
    attachRefused: result.attachRefused ?? 'unmeasured',
    windowMs,
    firstListOk: list.out?.ok,
    firstInfoOk: info.out?.ok,
    firstAttachOk: attach.out?.ok,
    firstEvents,
    unanswered: missing,
  });
  return missing.length ? { ...result, incomplete: missing.join('; ') } : result;
}

async function nestedCross({
  reader,
  client,
  protectedOrigin,
  cross,
  ordinary,
  tag,
  notes,
  budget,
  discovery,
  internalSessions,
  eventStart,
}) {
  if (!cross) return { incomplete: 'no cross-site ordinary origin ({cross}) mapped' };
  const mid = `${cross}/oopif-mid?inner=${encodeURIComponent(`${ordinary}/doc?n=inner-${tag}`)}&n=mid-${tag}`;
  const page = `${protectedOrigin}/oopif-nest?mid=${encodeURIComponent(mid)}&n=host-${tag}`;
  note(notes, 'protected-parent.nest-urls', {
    host: protectedOrigin,
    mid: cross,
    inner: ordinary,
    crossMapping:
      '{cross} must be a different registrable domain from {ordinary} (e.g. cross.test); same-site {cross} leaves nested iframe targets missing and this row incomplete',
  });
  const opened = await openProtected(reader, page, notes, internalSessions);
  if (!opened.ok)
    return {
      incomplete: `observer setup failed: ${opened.error?.message ?? opened.error}`,
    };
  if (opened.result.incomplete) return { live: false, incomplete: opened.result.incomplete };
  const { targetId: pageId, sessionId } = opened.result;
  await until(
    async () => {
      const tree = await readTree(reader, sessionId);
      return walkFrames(tree).length >= 3 ? tree : null;
    },
    Math.min(budget, 2000)
  );
  const tree = await readTree(reader, sessionId);
  note(notes, 'protected-parent.frame-tree', {
    frames: walkFrames(tree).map((frame) => ({ id: frame.id, url: frame.url })),
  });
  const raw = await waitRawIframes(reader, pageId, budget, notes, 2);
  if (!raw) {
    const late = await readTree(reader, sessionId);
    note(notes, 'protected-parent.frame-tree-late', {
      frames: walkFrames(late).map((frame) => ({ id: frame.id, url: frame.url })),
    });
    return {
      live: true,
      incomplete: 'nested ordinary iframe targets did not appear in the raw leg within the budget',
      pageId,
    };
  }
  const rawIds = new Set(raw.iframes.map((info) => info.targetId));
  const rawUrls = new Set(
    raw.iframes.map((info) => info.url).filter((url) => typeof url === 'string' && url.length > 0)
  );
  const rawParentIds = new Set(
    raw.iframes.map((info) => info.parentId).filter((id) => typeof id === 'string' && id.length > 0)
  );
  rawParentIds.add(pageId);
  const measured = await measureClient({
    client,
    rawIds,
    rawUrls,
    pageId,
    rawParentIds,
    discovery,
    eventStart,
    budget,
    notes,
  });
  return {
    live: true,
    pageId,
    iframeIds: [...rawIds],
    iframeUrls: [...rawUrls],
    ...measured,
  };
}

async function sandboxedSrcdoc({
  reader,
  client,
  protectedOrigin,
  tag,
  notes,
  budget,
  discovery,
  internalSessions,
  eventStart,
}) {
  const page = `${protectedOrigin}/oopif-srcdoc?n=srcdoc-${tag}`;
  const opened = await openProtected(reader, page, notes, internalSessions);
  if (!opened.ok)
    return {
      incomplete: `observer setup failed: ${opened.error?.message ?? opened.error}`,
    };
  if (opened.result.incomplete) return { live: false, incomplete: opened.result.incomplete };
  const { targetId: pageId, sessionId } = opened.result;
  const tree = await readTree(reader, sessionId);
  const frames = walkFrames(tree);
  const srcdocFrame =
    frames.find((frame) => frame.url === 'about:srcdoc') ??
    frames.find((frame) => typeof frame.url === 'string' && frame.url.includes('srcdoc')) ??
    frames.find((frame) => frame.id && frame.id !== (tree?.frame?.id ?? pageId));
  note(notes, 'protected-parent.srcdoc-tree', {
    frames: frames.map((frame) => ({ id: frame.id, url: frame.url })),
    srcdocFrame: srcdocFrame ? { id: srcdocFrame.id, url: srcdocFrame.url } : null,
  });
  const raw = await waitRawIframes(reader, pageId, budget, notes, 1);
  if (!raw) {
    const reason = 'sandboxed srcdoc frame has no own target in this Chrome';
    note(notes, 'protected-parent.srcdoc-no-oopif', {
      reason,
      pageId,
      frameTreeHasChild: Boolean(srcdocFrame),
      childUrl: srcdocFrame?.url ?? null,
    });
    notes.push('srcdoc: no own target in this Chrome (incomplete)');
    return {
      live: true,
      incomplete: reason,
      pageId,
    };
  }
  const rawIds = new Set(raw.iframes.map((info) => info.targetId));
  const rawUrls = new Set(
    raw.iframes.map((info) => info.url).filter((url) => typeof url === 'string' && url.length > 0)
  );
  const rawParentIds = new Set(
    raw.iframes.map((info) => info.parentId).filter((id) => typeof id === 'string' && id.length > 0)
  );
  rawParentIds.add(pageId);
  note(notes, 'protected-parent.srcdoc-oopif', {
    count: raw.iframes.length,
    iframes: raw.iframes.map((info) => ({
      targetId: info.targetId,
      url: info.url,
      parentId: info.parentId,
    })),
  });
  notes.push('srcdoc: own iframe target, hidden');
  const measured = await measureClient({
    client,
    rawIds,
    rawUrls,
    pageId,
    rawParentIds,
    discovery,
    eventStart,
    budget,
    notes,
  });
  return {
    live: true,
    pageId,
    iframeIds: [...rawIds],
    iframeUrls: [...rawUrls],
    ...measured,
  };
}

const pageFrameEvents = [
  'Page.frameAttached',
  'Page.frameStartedLoading',
  'Page.frameNavigated',
  'Page.frameRequestedNavigation',
  'Page.lifecycleEvent',
  'Page.navigatedWithinDocument',
];

function midFrameIdsOf(raw) {
  if (raw.midFrameIds?.size) return raw.midFrameIds;
  return new Set([raw.midFrameId].filter(Boolean));
}

function frameEventHit(event, raw) {
  if (!pageFrameEvents.includes(event.method)) return false;
  const params = event.params ?? {};
  const frame = params.frame ?? {};
  const frameId = params.frameId ?? frame.id;
  const parentId = params.parentFrameId ?? params.parentId ?? frame.parentId;
  const url = params.url ?? frame.url ?? '';
  if (frameId && raw.frameIds.has(frameId)) return true;
  if (parentId && midFrameIdsOf(raw).has(parentId)) return true;
  if (typeof url === 'string' && url.length > 0 && raw.urls.has(url)) return true;
  return false;
}

function contextHit(event, raw) {
  if (event.method !== 'Runtime.executionContextCreated') return false;
  const context = event.params?.context;
  const frameId = context?.auxData?.frameId;
  if (frameId && raw.frameIds.has(frameId)) return true;
  if (raw.frameIds.size) return false;
  const origin = context?.origin ?? '';
  return Boolean(origin && raw.origins.has(origin));
}

function treeMentions(tree, raw) {
  const mids = midFrameIdsOf(raw);
  for (const frame of walkFrames(tree)) {
    if (raw.frameIds.has(frame.id)) return true;
    if (typeof frame.url === 'string' && frame.url.length > 0 && raw.urls.has(frame.url))
      return true;
    if (frame.parentId && mids.has(frame.parentId)) return true;
  }
  const visit = (node, underMid) => {
    if (!node?.frame) return false;
    const here = underMid || mids.has(node.frame.id);
    for (const child of node.childFrames ?? []) {
      if (here) return true;
      if (visit(child, here)) return true;
    }
    return false;
  };
  return visit(tree, false);
}

function resourceMentions(resource, raw) {
  const frameTree = resource?.frameTree ?? resource;
  if (treeMentions(frameTree, raw)) return true;
  const text = JSON.stringify(resource ?? {});
  for (const id of raw.frameIds) if (text.includes(id)) return true;
  for (const url of raw.urls) if (url && text.includes(url)) return true;
  for (const mid of midFrameIdsOf(raw)) {
    if (text.includes(`"parentId":"${mid}"`)) return true;
  }
  return false;
}

function midFrameAttachedHit(event, raw) {
  if (event.method !== 'Page.frameAttached') return false;
  const frameId = event.params?.frameId;
  return Boolean(frameId && midFrameIdsOf(raw).has(frameId));
}

function childMatches(url, innerNeedle) {
  if (innerNeedle === 'about:srcdoc') return url === 'about:srcdoc';
  return typeof url === 'string' && (url === innerNeedle || url.includes(innerNeedle));
}

function midMatches(midUrl, midHint) {
  if (!midHint) return true;
  try {
    const hint = new URL(midHint);
    const mid = new URL(midUrl);
    return mid.origin === hint.origin;
  } catch {
    return midUrl.includes(midHint) || midUrl.startsWith(String(midHint).split('?')[0]);
  }
}

function grandchildFromMid(mid, innerNeedle) {
  const midUrl = mid.frame?.url ?? '';
  for (const child of mid.childFrames ?? []) {
    const url = child.frame?.url ?? '';
    if (!childMatches(url, innerNeedle)) continue;
    return {
      midFrameId: mid.frame.id,
      midUrl,
      frameId: child.frame.id,
      url,
      parentId: child.frame.parentId ?? mid.frame.id,
    };
  }
  return null;
}

function findGrandchild(tree, midHint, innerNeedle) {
  if (!tree?.frame) return null;
  for (const mid of tree.childFrames ?? []) {
    if (!midMatches(mid.frame?.url ?? '', midHint)) continue;
    const hit = grandchildFromMid(mid, innerNeedle);
    if (hit) return hit;
  }
  for (const mid of tree.childFrames ?? []) {
    if (!/\/oopif-(mid|srcdoc)/.test(mid.frame?.url ?? '')) continue;
    const hit = grandchildFromMid(mid, innerNeedle);
    if (hit) return hit;
  }
  return null;
}

function hitFromMidTree(midTree, innerNeedle, midUrl) {
  if (!midTree?.frame) return null;
  for (const child of midTree.childFrames ?? []) {
    const url = child.frame?.url ?? '';
    if (!childMatches(url, innerNeedle)) continue;
    return {
      midFrameId: midTree.frame.id,
      midUrl: midTree.frame.url ?? midUrl ?? '',
      frameId: child.frame.id,
      url,
      parentId: child.frame.parentId ?? midTree.frame.id,
    };
  }
  return null;
}

function targetSnapshot(infos) {
  return (infos ?? []).map((info) => ({
    targetId: info.targetId,
    type: info.type,
    url: info.url,
    parentId: info.parentId,
  }));
}

async function listTargetSnapshot(reader) {
  const listed = await outcome(reader.send('Target.getTargets', {}));
  if (!answered(listed) || !listed.ok) return { unanswered: !answered(listed), targets: [] };
  return { unanswered: false, targets: targetSnapshot(listed.result?.targetInfos) };
}

function liveNestPlan(pageUrl, innerKind, innerHint) {
  const page = new URL(pageUrl);
  const midRaw = page.searchParams.get('mid');
  let midNeedle = null;
  if (midRaw) {
    try {
      midNeedle = new URL(midRaw).searchParams.get('n');
    } catch {
      midNeedle = null;
    }
  }
  page.searchParams.set('live', '1');
  return {
    liveUrl: page.toString(),
    innerHint: innerHint || (innerKind === 'srcdoc' ? 'about:srcdoc' : ''),
    midNeedle,
  };
}

function stampedMidLive(midUrl, innerKind, innerHint) {
  const stamp = `live-${Date.now().toString(36)}`;
  try {
    const mid = new URL(midUrl);
    mid.searchParams.set('n', `${mid.searchParams.get('n') ?? 'mid'}-${stamp}`);
    if (innerKind === 'srcdoc' || innerHint === 'about:srcdoc') {
      return {
        midUrl: mid.toString(),
        innerHint: 'about:srcdoc',
        midNeedle: mid.searchParams.get('n'),
      };
    }
    const innerRaw = mid.searchParams.get('inner');
    if (!innerRaw) {
      return {
        midUrl: mid.toString(),
        innerHint,
        midNeedle: mid.searchParams.get('n'),
      };
    }
    const inner = new URL(innerRaw);
    const prior = inner.searchParams.get('n') ?? `inner-${stamp}`;
    inner.searchParams.set('n', `${prior}-${stamp}`);
    mid.searchParams.set('inner', inner.toString());
    return {
      midUrl: mid.toString(),
      innerHint: inner.searchParams.get('n'),
      midNeedle: mid.searchParams.get('n'),
    };
  } catch {
    return { midUrl, innerHint, midNeedle: null };
  }
}

async function waitChildUnderMid(
  reader,
  midAttached,
  innerHint,
  budget,
  internalSessions,
  beforeIds,
  midNeedle = null
) {
  return until(async () => {
    return hitFromGrandchildTarget(
      reader,
      midAttached,
      innerHint,
      internalSessions,
      beforeIds,
      midNeedle
    );
  }, budget);
}

async function attachIframeTarget(reader, match, internalSessions) {
  const listed = await outcome(reader.send('Target.getTargets', {}));
  if (!answered(listed) || !listed.ok) return null;
  const info = (listed.result?.targetInfos ?? []).find(
    (entry) => entry.type === 'iframe' && match(entry)
  );
  if (!info?.targetId) return null;
  const attached = await outcome(
    reader.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
  );
  if (!answered(attached) || !attached.ok || !attached.result?.sessionId) return null;
  internalSessions?.add(attached.result.sessionId);
  await outcome(reader.send('Page.enable', {}, attached.result.sessionId));
  await outcome(reader.send('Runtime.enable', {}, attached.result.sessionId));
  return { info, sessionId: attached.result.sessionId };
}

async function armMidChildWatch(reader, midSession, waitMs = 1500) {
  await outcome(
    reader.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      midSession
    )
  );
  await until(async () => {
    const evaled = await outcome(
      reader.send(
        'Runtime.evaluate',
        { expression: 'document.querySelector("iframe")?.src || ""', returnByValue: true },
        midSession
      )
    );
    if (!answered(evaled) || !evaled.ok) return null;
    const src = evaled.result?.result?.value;
    return typeof src === 'string' && src.length > 0 ? src : null;
  }, waitMs);
}

async function hitFromGrandchildTarget(
  reader,
  midAttached,
  innerHint,
  internalSessions,
  beforeIds = null,
  midNeedle = null
) {
  if (!midAttached.armed) {
    await armMidChildWatch(reader, midAttached.sessionId, 400);
    midAttached.armed = true;
  }
  const midTree = await readTree(reader, midAttached.sessionId);
  const midFrameId = midTree?.frame?.id;
  const midUrl = midTree?.frame?.url ?? midAttached.info.url ?? '';
  const tag = midTagFrom(midUrl, midNeedle);
  const fromMid = hitFromMidTree(midTree, innerHint, midUrl);
  if (fromMid) {
    return {
      tree: midTree,
      hit: fromMid,
      via: 'mid-target',
      midSession: midAttached.sessionId,
      midTargetId: midAttached.info.targetId,
    };
  }
  const child = await attachIframeTarget(
    reader,
    (info) => {
      if (beforeIds?.has(info.targetId)) return false;
      if (!childMatches(info.url ?? '', innerHint)) return false;
      return info.parentId === midAttached.info.targetId;
    },
    internalSessions
  );
  if (!child) return null;
  if (innerHint === 'about:srcdoc' && tag) {
    if (!(await srcdocDocHasTag(reader, child.sessionId, tag))) return null;
  }
  const childTree = await readTree(reader, child.sessionId);
  if (!childTree?.frame) return null;
  const frameId = childTree.frame.id;
  const frameParentId = childTree.frame.parentId ?? midFrameId;
  const linked =
    innerHint !== 'about:srcdoc' ||
    srcdocLinkedToMid(reader, midFrameId ?? midAttached.info.targetId, frameId, frameParentId) ||
    child.info.parentId === midAttached.info.targetId;
  if (innerHint === 'about:srcdoc' && !linked) return null;
  return {
    tree: childTree,
    hit: {
      midFrameId: midFrameId ?? midAttached.info.targetId,
      midUrl,
      frameId,
      url: childTree.frame.url ?? child.info.url ?? '',
      parentId: frameParentId,
    },
    via: 'grandchild-target',
    midSession: midAttached.sessionId,
    midTargetId: midAttached.info.targetId,
    grandchildSession: child.sessionId,
    grandchildTargetId: child.info.targetId,
  };
}

function midTargetMatch(info, midHint, pageId, midNeedle, beforeIds) {
  if (beforeIds?.has(info.targetId)) return false;
  if (midNeedle && !(info.url ?? '').includes(midNeedle)) return false;
  if (!midMatches(info.url ?? '', midHint)) return false;
  if (pageId && info.parentId && info.parentId !== pageId) return false;
  return true;
}

function midTagFrom(midUrl, midNeedle) {
  if (typeof midNeedle === 'string' && midNeedle.length > 0) return midNeedle;
  try {
    return new URL(midUrl).searchParams.get('n');
  } catch {
    return null;
  }
}

function localMidFrame(tree, midHint) {
  if (!tree?.frame) return null;
  for (const mid of tree.childFrames ?? []) {
    if (!midMatches(mid.frame?.url ?? '', midHint)) continue;
    return mid;
  }
  for (const mid of tree.childFrames ?? []) {
    if (!/\/oopif-(mid|srcdoc)/.test(mid.frame?.url ?? '')) continue;
    return mid;
  }
  return null;
}

async function srcdocDocHasTag(reader, sessionId, tag) {
  if (!tag) return false;
  const evaluated = await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression:
          '(document.body && (document.body.innerText || document.body.textContent)) || ""',
        returnByValue: true,
      },
      sessionId
    )
  );
  if (!answered(evaluated) || !evaluated.ok) return false;
  const text = evaluated.result?.result?.value;
  return typeof text === 'string' && text.includes(tag);
}

function srcdocLinkedToMid(reader, midFrameId, frameId, frameParentId) {
  if (midFrameId && frameParentId && frameParentId === midFrameId) return true;
  if (!midFrameId || !frameId) return false;
  for (const event of reader.events ?? []) {
    if (event.method === 'Page.frameAttached') {
      if (event.params?.frameId === frameId && event.params?.parentFrameId === midFrameId)
        return true;
    }
    if (event.method === 'Page.frameNavigated') {
      const frame = event.params?.frame ?? {};
      if (frame.id === frameId && frame.parentId === midFrameId) return true;
    }
  }
  return false;
}

function srcdocTargetCandidate(info, pageId, midFrameId, beforeIds) {
  if (info.type !== 'iframe') return false;
  if ((info.url ?? '') !== 'about:srcdoc') return false;
  if (beforeIds?.has(info.targetId)) return false;
  if (!pageId || !info.parentId) return true;
  return info.parentId === pageId || info.parentId === midFrameId;
}

function finishSrcdocHit({ tree, mid, info, attached, childTree, notes, pageId, tag, reader }) {
  const midFrameId = mid.frame.id;
  const frameId = childTree?.frame?.id ?? info.targetId;
  const frameParentId = childTree?.frame?.parentId ?? null;
  const linked = srcdocLinkedToMid(reader, midFrameId, frameId, frameParentId);
  const topParentOnly = Boolean(pageId && info.parentId === pageId);
  if (!linked && !topParentOnly) return null;
  if (!linked && topParentOnly) {
    note(notes, 'protected-parent.srcdoc-top-parent', {
      midFrameId,
      frameId,
      targetId: info.targetId,
      targetParentId: info.parentId,
      tag,
    });
  }
  return {
    tree: childTree ?? tree,
    hit: {
      midFrameId,
      midUrl: mid.frame.url ?? '',
      frameId,
      url: childTree?.frame?.url ?? info.url ?? 'about:srcdoc',
      parentId: frameParentId ?? (linked ? midFrameId : info.parentId),
    },
    via: 'grandchild-target',
    grandchildSession: attached.sessionId,
    grandchildTargetId: topParentOnly ? undefined : info.targetId,
  };
}

async function hitFromSrcdocUnderLocalMid(
  reader,
  tree,
  midHint,
  pageId,
  internalSessions,
  beforeIds,
  midNeedle,
  notes
) {
  const mid = localMidFrame(tree, midHint);
  if (!mid?.frame?.id) return null;
  const tag = midTagFrom(mid.frame.url ?? '', midNeedle);
  if (!tag) return null;
  const listed = await outcome(reader.send('Target.getTargets', {}));
  if (!answered(listed) || !listed.ok) return null;
  for (const info of listed.result?.targetInfos ?? []) {
    if (!srcdocTargetCandidate(info, pageId, mid.frame.id, beforeIds)) continue;
    const attached = await attachIframeTarget(
      reader,
      (entry) => entry.targetId === info.targetId,
      internalSessions
    );
    if (!attached) continue;
    if (!(await srcdocDocHasTag(reader, attached.sessionId, tag))) continue;
    const hit = finishSrcdocHit({
      tree,
      mid,
      info,
      attached,
      childTree: await readTree(reader, attached.sessionId),
      notes,
      pageId,
      tag,
      reader,
    });
    if (hit) return hit;
  }
  return null;
}

async function waitGrandchild(
  reader,
  sessionId,
  midHint,
  innerHint,
  budget,
  notes,
  pageId,
  internalSessions,
  midNeedle = null,
  beforeIds = null
) {
  let midAttached;
  await outcome(reader.send('Target.setDiscoverTargets', { discover: true }));
  const found = await until(async () => {
    const tree = await readTree(reader, sessionId);
    const hit = findGrandchild(tree, midHint, innerHint);
    if (hit) return { tree, hit, via: 'top' };
    if (innerHint === 'about:srcdoc') {
      const underTop = await hitFromSrcdocUnderLocalMid(
        reader,
        tree,
        midHint,
        pageId,
        internalSessions,
        beforeIds,
        midNeedle,
        notes
      );
      if (underTop) return underTop;
    }
    const listed = await outcome(reader.send('Target.getTargets', {}));
    const infos = answered(listed) && listed.ok ? (listed.result?.targetInfos ?? []) : [];
    if (
      midAttached &&
      !infos.some((info) => info.targetId === midAttached.info.targetId && info.type === 'iframe')
    )
      midAttached = null;
    midAttached ??= await attachIframeTarget(
      reader,
      (info) => midTargetMatch(info, midHint, pageId, midNeedle, beforeIds),
      internalSessions
    );
    if (!midAttached) return null;
    return hitFromGrandchildTarget(
      reader,
      midAttached,
      innerHint,
      internalSessions,
      beforeIds,
      midNeedle
    );
  }, budget);
  if (found) {
    const branch =
      found.via === 'top'
        ? 'top-tree'
        : found.via === 'mid-target'
          ? 'mid-target'
          : 'grandchild-target';
    note(notes, 'protected-parent.page-branch', { branch, via: found.via });
    note(notes, 'protected-parent.page-raw', {
      midFrameId: found.hit.midFrameId,
      midUrl: found.hit.midUrl,
      frameId: found.hit.frameId,
      url: found.hit.url,
      parentId: found.hit.parentId,
      via: found.via,
      branch,
      midTargetId: found.midTargetId,
      grandchildTargetId: found.grandchildTargetId,
      frames: walkFrames(found.tree).map((frame) => ({
        id: frame.id,
        url: frame.url,
        parentId: frame.parentId,
      })),
    });
    return found;
  }
  const tree = await readTree(reader, sessionId);
  const listed = await listTargetSnapshot(reader);
  note(notes, 'protected-parent.page-raw-missing', {
    midHint,
    innerHint,
    midNeedle,
    frames: walkFrames(tree).map((frame) => ({
      id: frame.id,
      url: frame.url,
      parentId: frame.parentId,
    })),
    targets: listed.targets,
  });
  return null;
}

async function rawContexts(reader, sessionIds, raw, eventStart, budget, notes) {
  const allowed = new Set((sessionIds ?? []).filter(Boolean));
  const deadline = Date.now() + Math.min(budget, 1500);
  const contexts = [];
  while (Date.now() <= deadline) {
    for (const event of (reader.events ?? []).slice(eventStart)) {
      if (event.sessionId && allowed.size && !allowed.has(event.sessionId)) continue;
      if (!contextHit(event, raw)) continue;
      const context = event.params?.context;
      if (context?.id != null && !contexts.some((entry) => entry.id === context.id))
        contexts.push({
          id: context.id,
          origin: context.origin,
          frameId: context.auxData?.frameId,
          sessionId: event.sessionId,
        });
    }
    if (contexts.length) break;
    await pause(25);
  }
  note(notes, 'protected-parent.page-raw-contexts', { contexts });
  return contexts;
}

function applyTreeSample(arm, sample, result, key, mentions) {
  takeFirst(arm, sample, (entry) => {
    if (entry.unanswered) return;
    if (entry.out.ok) {
      if (mentions(entry.out.result)) result[key] = true;
      else if (result[key] !== true) result[key] = false;
    } else if (result[key] !== true) result[key] = false;
  });
}

async function attachOrdinaryTop(client, targetId, notes, internalSessions) {
  note(notes, 'protected-parent.page-attach-order', {
    midPresentBeforeAttach: true,
    targetId,
  });
  const attached = await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }));
  if (!answered(attached)) {
    note(notes, 'protected-parent.page-attach', {
      ok: false,
      unanswered: true,
      error: String(attached.error?.message ?? attached.error ?? ''),
    });
    return { incomplete: 'Target.attachToTarget unanswered for ordinary top page' };
  }
  if (!attached.ok || !attached.result?.sessionId) {
    note(notes, 'protected-parent.page-attach', {
      ok: false,
      refused: refused(attached),
      error: String(attached.error?.message ?? attached.error ?? ''),
    });
    return {
      incomplete: `Target.attachToTarget on ordinary top failed: ${attached.error?.message ?? attached.error}`,
    };
  }
  internalSessions.add(attached.result.sessionId);
  return { sessionId: attached.result.sessionId };
}

function adoptLiveRaw(raw, liveRaw) {
  if (liveRaw.midTargetId) raw.midTargetId = liveRaw.midTargetId;
  if (liveRaw.grandchildTargetId) raw.grandchildTargetId = liveRaw.grandchildTargetId;
  if (liveRaw.hit.midFrameId) {
    raw.midFrameIds = raw.midFrameIds ?? new Set([raw.midFrameId].filter(Boolean));
    raw.midFrameIds.add(liveRaw.hit.midFrameId);
    raw.midFrameId = liveRaw.hit.midFrameId;
  }
  if (liveRaw.hit.frameId) raw.frameIds.add(liveRaw.hit.frameId);
  if (typeof liveRaw.hit.url === 'string' && liveRaw.hit.url.length > 0)
    raw.urls.add(liveRaw.hit.url);
  try {
    raw.origins.add(new URL(liveRaw.hit.url).origin);
  } catch {
    if (liveRaw.hit.url === 'about:srcdoc') raw.origins.add('://');
  }
}

async function evaluateContexts(client, sessionIds, contexts, evaluateArm, result) {
  const sessions = [...new Set((sessionIds ?? []).filter(Boolean))];
  let anyUnanswered = false;
  let unansweredId;
  let unansweredText = '';
  for (const context of contexts) {
    const ordered = [
      context.sessionId,
      ...sessions.filter((id) => id && id !== context.sessionId),
    ].filter(Boolean);
    for (const sessionId of [...new Set(ordered)]) {
      const evaluated = await outcome(
        client.send(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true, contextId: context.id },
          sessionId
        )
      );
      const message = String(evaluated.error?.message ?? evaluated.error ?? '');
      const gone =
        !evaluated.ok &&
        /Cannot find context|No context|Invalid context|Session with given id/i.test(message);
      if (!answered(evaluated) && !gone) {
        anyUnanswered = true;
        unansweredId ??= context.id;
        unansweredText ??= errorText(evaluated);
        continue;
      }
      takeFirst(
        evaluateArm,
        { out: evaluated, unanswered: false, unansweredId: context.id },
        (sample) => {
          if (sample.out.ok) result.contextEvaluate = true;
          else result.contextEvaluate ??= false;
        }
      );
      if (result.contextEvaluate === true) {
        evaluateArm.unanswered = false;
        return;
      }
    }
  }
  if (result.contextEvaluate !== true && anyUnanswered) {
    evaluateArm.unanswered = true;
    evaluateArm.unansweredId ??= unansweredId;
    evaluateArm.unansweredText ??= unansweredText;
    evaluateArm.out ??= { ok: false };
  }
}

function collectAutoSessions(events, from) {
  const sessions = new Set();
  for (const event of events.slice(from)) {
    if (event.method !== 'Target.attachedToTarget') continue;
    const child = event.params?.sessionId;
    const type = event.params?.targetInfo?.type;
    if (child && (type === 'iframe' || type === 'page' || !type)) sessions.add(child);
  }
  return sessions;
}

async function sampleTrees(client, sessionIds, treeArm, result, raw) {
  for (const sessionId of sessionIds) {
    const treeAgain = await outcome(client.send('Page.getFrameTree', {}, sessionId));
    applyTreeSample(
      treeArm,
      { out: treeAgain, unanswered: !answered(treeAgain) },
      result,
      'frameTree',
      (payload) => treeMentions(payload?.frameTree, raw)
    );
    if (result.frameTree === true) return;
  }
}

function recordChildEnable(out, label, child, childSessions, missing, result) {
  if (out.ok) return 'ok';
  if (refused(out)) {
    const message = String(out.error?.message ?? out.error ?? '');
    if (result) result.childEnableRefused = message;
    if (/No session with given id|Session with given id not found|Target closed/i.test(message))
      childSessions.delete(child);
    return 'refused';
  }
  if (!answered(out)) {
    missing.push(`${label} unanswered${errorText(out)}`);
    return 'missing';
  }
  missing.push(`${label} failed: ${out.error?.message ?? out.error}`);
  return 'missing';
}

async function enableChildDomains(client, childSessions, missing, result) {
  for (const child of [...childSessions]) {
    const pageOut = await outcome(client.send('Page.enable', {}, child));
    const pageStatus = recordChildEnable(
      pageOut,
      'Page.enable',
      child,
      childSessions,
      missing,
      result
    );
    if (pageStatus === 'missing') return;
    if (pageStatus === 'refused') continue;
    const runtimeOut = await outcome(client.send('Runtime.enable', {}, child));
    const runtimeStatus = recordChildEnable(
      runtimeOut,
      'Runtime.enable',
      child,
      childSessions,
      missing,
      result
    );
    if (runtimeStatus === 'missing') return;
  }
}

async function adoptLiveClientSessions(
  client,
  sessionId,
  clientEventStart,
  raw,
  childSessions,
  internalSessions,
  missing,
  result
) {
  await autoAttachSession(client, sessionId);
  pullAutoSessions(client, clientEventStart, childSessions);
  for (const targetId of [raw.midTargetId, raw.grandchildTargetId].filter(Boolean)) {
    const attached = await outcome(
      client.send('Target.attachToTarget', { targetId, flatten: true })
    );
    await adoptAttachedSession(attached, childSessions, internalSessions, null);
  }
  for (const child of [...childSessions]) await autoAttachSession(client, child);
  pullAutoSessions(client, clientEventStart, childSessions);
  await enableChildDomains(client, childSessions, missing, result);
}

async function armNewChildSessions(client, events, childSessions, missing, result) {
  for (const child of collectAutoSessions(events, 0)) {
    if (childSessions.has(child)) continue;
    childSessions.add(child);
    const pageOut = await outcome(client.send('Page.enable', {}, child));
    const pageStatus = recordChildEnable(
      pageOut,
      'Page.enable',
      child,
      childSessions,
      missing,
      result
    );
    if (pageStatus === 'missing') return;
    if (pageStatus === 'refused') continue;
    const runtimeOut = await outcome(client.send('Runtime.enable', {}, child));
    if (
      recordChildEnable(runtimeOut, 'Runtime.enable', child, childSessions, missing, result) ===
      'missing'
    )
      return;
  }
}

async function remasureLiveGrandchild({
  reader,
  readerSessionId,
  pageUrl,
  targetId,
  midHint,
  innerHint,
  innerKind,
  raw,
  budget,
  notes,
  internalSessions,
}) {
  const before = await listTargetSnapshot(reader);
  const beforeIds = new Set(before.targets.map((info) => info.targetId).filter(Boolean));
  const kind = innerKind ?? (innerHint === 'about:srcdoc' ? 'srcdoc' : 'ordinary');
  const childBudget = budget < 2000 ? budget : Math.max(budget, 4000);
  if (raw.midTargetId) {
    const midAttached = await attachIframeTarget(
      reader,
      (info) => info.targetId === raw.midTargetId,
      internalSessions
    );
    if (midAttached) {
      const stamp = stampedMidLive(midAttached.info.url ?? '', kind, innerHint);
      note(notes, 'protected-parent.page-live-nav', {
        via: 'mid-session-remeasure',
        url: stamp.midUrl,
        innerHint: stamp.innerHint,
        midNeedle: stamp.midNeedle,
        midTargetId: raw.midTargetId,
      });
      const navigated = await outcome(
        reader.send('Page.navigate', { url: stamp.midUrl }, midAttached.sessionId)
      );
      if (answered(navigated) && navigated.ok) {
        const found = await waitChildUnderMid(
          reader,
          midAttached,
          stamp.innerHint || innerHint,
          childBudget,
          internalSessions,
          beforeIds,
          stamp.midNeedle
        );
        if (found) return found;
      }
    }
  }
  const plan = liveNestPlan(pageUrl, kind, innerHint);
  let liveUrl = plan.liveUrl;
  try {
    const page = new URL(plan.liveUrl);
    page.searchParams.set('live', String((Number(page.searchParams.get('live')) || 1) + 1));
    liveUrl = page.toString();
  } catch {
    liveUrl = plan.liveUrl;
  }
  note(notes, 'protected-parent.page-live-nav', {
    via: 'top-session-remeasure',
    url: liveUrl,
    innerHint: plan.innerHint,
    midNeedle: plan.midNeedle,
    beforeTargetIds: [...beforeIds],
  });
  const navigated = await outcome(reader.send('Page.navigate', { url: liveUrl }, readerSessionId));
  if (!answered(navigated) || !navigated.ok) return null;
  return waitGrandchild(
    reader,
    readerSessionId,
    midHint,
    plan.innerHint || innerHint,
    childBudget,
    notes,
    targetId,
    internalSessions,
    plan.midNeedle,
    beforeIds
  );
}

async function pollPageClient({
  client,
  sessionId,
  childSessions,
  clientEventStart,
  raw,
  liveContexts,
  treeArm,
  resourceArm,
  evaluateArm,
  result,
  missing,
  budget,
  skipEvaluate = false,
}) {
  const windowMs = Math.min(budget, 1500);
  const deadline = Date.now() + windowMs;
  while (Date.now() <= deadline) {
    const events = (client.events ?? []).slice(clientEventStart);
    await armNewChildSessions(client, events, childSessions, missing, result);
    if (missing.length) break;
    result.frameEvents = events.some((event) => frameEventHit(event, raw))
      ? true
      : (result.frameEvents ?? false);
    result.midFrameAttached = events.some((event) => midFrameAttachedHit(event, raw))
      ? true
      : (result.midFrameAttached ?? false);
    if (liveContexts.length) {
      if (events.some((event) => contextHit(event, raw))) result.contextCreated = true;
      if (!skipEvaluate && result.contextEvaluate !== true)
        await evaluateContexts(
          client,
          [sessionId, ...childSessions],
          liveContexts,
          evaluateArm,
          result
        );
    }
    await sampleTrees(client, [sessionId, ...childSessions], treeArm, result, raw);
    await sampleResources(client, [sessionId, ...childSessions], resourceArm, result, raw);
    if (
      result.frameTree === true &&
      result.resourceTree === true &&
      result.frameEvents === true &&
      result.contextCreated === true &&
      (skipEvaluate || result.contextEvaluate === true) &&
      result.midFrameAttached === true
    )
      break;
    await pause(50);
  }
  return windowMs;
}

function errorText(out) {
  const text = String(out?.error?.message ?? out?.error ?? '').slice(0, 160);
  return text ? `: ${text}` : '';
}

function enableFailure(out, label, missing) {
  if (!answered(out)) missing.push(`${label} unanswered${errorText(out)}`);
  else if (!out.ok) missing.push(`${label} failed: ${out.error?.message ?? out.error}`);
}

async function abortPageClient(client, sessionId, notes, missing, result = {}) {
  note(notes, 'protected-parent.page-client', {
    unanswered: missing,
    frameTree: result.frameTree ?? 'unmeasured',
    resourceTree: result.resourceTree ?? 'unmeasured',
    frameEvents: 'unmeasured',
    contextCreated: 'unmeasured',
    contextEvaluate: 'unmeasured',
    midFrameAttached: 'unmeasured',
  });
  await outcome(client.send('Target.detachFromTarget', { sessionId }));
  return { ...result, incomplete: missing.join('; ') };
}

async function sampleResources(client, sessionIds, resourceArm, result, raw) {
  for (const sessionId of sessionIds) {
    if (result.resourceTree === true) return;
    const resourceOut = await outcome(client.send('Page.getResourceTree', {}, sessionId));
    if (!resourceOut.ok && refused(resourceOut)) continue;
    applyTreeSample(
      resourceArm,
      { out: resourceOut, unanswered: !answered(resourceOut) },
      result,
      'resourceTree',
      (payload) => resourceMentions(payload, raw)
    );
  }
}

async function liveViaMidSession({
  reader,
  raw,
  innerKind,
  innerHint,
  budget,
  notes,
  internalSessions,
  beforeIds,
  preferMidLive,
}) {
  if (!preferMidLive || !raw.midTargetId) return null;
  const midAttached = await attachIframeTarget(
    reader,
    (info) => info.targetId === raw.midTargetId,
    internalSessions
  );
  if (!midAttached) return null;
  const midUrl = midAttached.info.url ?? '';
  const stamp = stampedMidLive(
    midUrl,
    innerKind ?? (innerHint === 'about:srcdoc' ? 'srcdoc' : 'ordinary'),
    innerHint
  );
  note(notes, 'protected-parent.page-live-nav', {
    via: 'mid-session',
    url: stamp.midUrl,
    innerHint: stamp.innerHint,
    midNeedle: stamp.midNeedle,
    midTargetId: raw.midTargetId,
  });
  const navigated = await outcome(
    reader.send('Page.navigate', { url: stamp.midUrl }, midAttached.sessionId)
  );
  if (!answered(navigated) || !navigated.ok) return null;
  const childBudget = budget < 2000 ? budget : Math.max(budget, 8000);
  const found = await waitChildUnderMid(
    reader,
    midAttached,
    stamp.innerHint || innerHint,
    childBudget,
    internalSessions,
    beforeIds,
    stamp.midNeedle
  );
  if (!found) return null;
  const branch = found.via === 'mid-target' ? 'mid-target' : 'grandchild-target';
  note(notes, 'protected-parent.page-branch', { branch, via: found.via, live: 'mid-session' });
  return found;
}

async function liveGrandchild({
  reader,
  readerSessionId,
  readerSessions,
  targetId,
  pageUrl,
  midHint,
  innerHint,
  innerKind,
  preferMidLive,
  raw,
  contexts,
  budget,
  notes,
  internalSessions,
  missing,
}) {
  const before = await listTargetSnapshot(reader);
  note(notes, 'protected-parent.page-targets-before', {
    unanswered: before.unanswered,
    targets: before.targets,
    midTargetId: raw.midTargetId ?? null,
    grandchildTargetId: raw.grandchildTargetId ?? null,
    urls: [...raw.urls],
  });
  const beforeIds = new Set(before.targets.map((info) => info.targetId).filter(Boolean));
  const liveBudget = budget < 2000 ? budget : Math.max(budget, 8000);
  let liveRaw = await liveViaMidSession({
    reader,
    raw,
    innerKind,
    innerHint,
    budget: liveBudget,
    notes,
    internalSessions,
    beforeIds,
    preferMidLive,
  });
  if (!liveRaw) {
    const plan = liveNestPlan(
      pageUrl,
      innerKind ?? (innerHint === 'about:srcdoc' ? 'srcdoc' : 'ordinary'),
      innerHint
    );
    note(notes, 'protected-parent.page-live-nav', {
      via: 'top-session',
      url: plan.liveUrl,
      innerHint: plan.innerHint,
      midNeedle: plan.midNeedle,
      beforeTargetIds: [...beforeIds],
    });
    const navigated = await outcome(
      reader.send('Page.navigate', { url: plan.liveUrl }, readerSessionId)
    );
    if (!answered(navigated)) missing.push('unguarded Page.navigate unanswered after attach');
    else if (!navigated.ok)
      missing.push(
        `unguarded Page.navigate failed: ${navigated.error?.message ?? navigated.error}`
      );
    liveRaw = await waitGrandchild(
      reader,
      readerSessionId,
      midHint,
      plan.innerHint || innerHint,
      liveBudget,
      notes,
      targetId,
      internalSessions,
      plan.midNeedle,
      beforeIds
    );
  }
  const after = await listTargetSnapshot(reader);
  note(notes, 'protected-parent.page-targets-after', {
    unanswered: after.unanswered,
    targets: after.targets,
    foundLive: Boolean(liveRaw),
  });
  if (!liveRaw) {
    missing.push('grandchild missing in raw leg after post-attach navigation');
    return contexts;
  }
  adoptLiveRaw(raw, liveRaw);
  note(notes, 'protected-parent.page-live-raw', {
    midFrameId: liveRaw.hit.midFrameId,
    frameId: liveRaw.hit.frameId,
    url: liveRaw.hit.url,
    via: liveRaw.via,
  });
  const liveSessions = [
    ...(readerSessions ?? []),
    readerSessionId,
    liveRaw.midSession,
    liveRaw.grandchildSession,
  ].filter(Boolean);
  const liveContexts = await rawContexts(
    reader,
    liveSessions,
    raw,
    reader.events?.length ? reader.events.length - 50 : 0,
    budget,
    notes
  );
  return liveContexts.length ? liveContexts : contexts;
}

function targetInfoHit(info, raw) {
  if (!info) return false;
  if (raw.grandchildTargetId && info.targetId === raw.grandchildTargetId) return true;
  if (raw.midTargetId && info.parentId === raw.midTargetId) {
    const url = info.url ?? '';
    if ([...raw.urls].some((entry) => entry && (url === entry || url.includes(entry)))) return true;
  }
  const url = info.url ?? '';
  return [...raw.urls].some((entry) => entry && url === entry);
}

function targetEventHit(event, raw) {
  if (
    !['Target.targetCreated', 'Target.targetInfoChanged', 'Target.attachedToTarget'].includes(
      event.method
    )
  )
    return false;
  return targetInfoHit(event.params?.targetInfo, raw);
}

async function autoAttachSession(client, sessionId) {
  await outcome(
    client.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId
    )
  );
}

function pullAutoSessions(client, clientEventStart, childSessions) {
  for (const child of collectAutoSessions(client.events ?? [], clientEventStart))
    childSessions.add(child);
}

async function adoptAttachedSession(out, childSessions, internalSessions, result) {
  if (!answered(out)) return 'unanswered';
  if (out.ok && out.result?.sessionId) {
    childSessions.add(out.result.sessionId);
    internalSessions?.add(out.result.sessionId);
    if (result) result.childAttach = true;
    return 'attached';
  }
  if (result) {
    result.childAttach ??= false;
    if (refused(out)) result.attachRefused = true;
  }
  return refused(out) ? 'refused' : 'failed';
}

async function probeListedGrandchildren(
  client,
  raw,
  childSessions,
  internalSessions,
  result,
  missing
) {
  const listed = await outcome(client.send('Target.getTargets', {}));
  if (!answered(listed)) {
    missing.push('Target.getTargets unanswered');
    return;
  }
  if (!listed.ok) {
    result.targetInfo ??= false;
    return;
  }
  const infos = listed.result?.targetInfos ?? [];
  if (infos.some((info) => targetInfoHit(info, raw))) result.targetInfo = true;
  for (const info of infos) {
    if (info.type !== 'iframe') continue;
    if (!targetInfoHit(info, raw) && info.targetId !== raw.grandchildTargetId) continue;
    const attachedChild = await outcome(
      client.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
    );
    const status = await adoptAttachedSession(
      attachedChild,
      childSessions,
      internalSessions,
      result
    );
    if (status === 'unanswered')
      missing.push(`Target.attachToTarget unanswered (${info.targetId})`);
  }
}

async function probeRawGrandchildTarget(
  client,
  raw,
  childSessions,
  internalSessions,
  result,
  missing
) {
  if (!raw.grandchildTargetId) {
    result.targetInfo ??= false;
    result.childAttach ??= false;
    return;
  }
  if (result.childAttach === true) return;
  const infoOut = await outcome(
    client.send('Target.getTargetInfo', { targetId: raw.grandchildTargetId })
  );
  if (!answered(infoOut)) missing.push('Target.getTargetInfo unanswered for grandchild');
  else if (infoOut.ok) result.targetInfo = true;
  else result.targetInfo ??= false;
  const attachedRaw = await outcome(
    client.send('Target.attachToTarget', {
      targetId: raw.grandchildTargetId,
      flatten: true,
    })
  );
  const status = await adoptAttachedSession(attachedRaw, childSessions, internalSessions, result);
  if (status === 'unanswered')
    missing.push('Target.attachToTarget unanswered for raw grandchild target');
}

async function gatherChildSessions(
  client,
  sessionId,
  clientEventStart,
  raw,
  internalSessions,
  result,
  missing
) {
  const childSessions = new Set();
  await autoAttachSession(client, sessionId);
  await until(async () => {
    pullAutoSessions(client, clientEventStart, childSessions);
    return childSessions.size > 0 ? childSessions : null;
  }, 200);
  pullAutoSessions(client, clientEventStart, childSessions);
  if (raw.midTargetId) {
    const midAttached = await outcome(
      client.send('Target.attachToTarget', { targetId: raw.midTargetId, flatten: true })
    );
    await adoptAttachedSession(midAttached, childSessions, internalSessions, null);
  }
  for (const child of [...childSessions]) await autoAttachSession(client, child);
  const before = childSessions.size;
  await until(async () => {
    pullAutoSessions(client, clientEventStart, childSessions);
    return childSessions.size > before ? childSessions : null;
  }, 200);
  pullAutoSessions(client, clientEventStart, childSessions);
  result.targetEvents = (client.events ?? [])
    .slice(clientEventStart)
    .some((event) => targetEventHit(event, raw))
    ? true
    : (result.targetEvents ?? false);
  await probeListedGrandchildren(client, raw, childSessions, internalSessions, result, missing);
  await probeRawGrandchildTarget(client, raw, childSessions, internalSessions, result, missing);
  result.targetInfo ??= false;
  result.childAttach ??= false;
  result.targetEvents ??= false;
  return childSessions;
}

async function measurePageClient({
  client,
  reader,
  readerSessionId,
  readerSessions,
  targetId,
  pageUrl,
  midHint,
  innerHint,
  innerKind,
  preferMidLive,
  raw,
  contexts,
  budget,
  notes,
  internalSessions,
}) {
  const result = {};
  const missing = [];
  const attached = await attachOrdinaryTop(client, targetId, notes, internalSessions);
  if (attached.incomplete) return attached;
  const { sessionId } = attached;
  const clientEventStart = client.events?.length ?? 0;
  enableFailure(await outcome(client.send('Page.enable', {}, sessionId)), 'Page.enable', missing);
  if (missing.length) return abortPageClient(client, sessionId, notes, missing);
  const treeArm = { out: undefined, unanswered: false };
  const resourceArm = { out: undefined, unanswered: false };
  const evaluateArm = { out: undefined, unanswered: false };
  const childSessions = await gatherChildSessions(
    client,
    sessionId,
    clientEventStart,
    raw,
    internalSessions,
    result,
    missing
  );
  if (missing.length) return abortPageClient(client, sessionId, notes, missing, result);
  const sessions = [sessionId, ...childSessions];
  await sampleTrees(client, sessions, treeArm, result, raw);
  enableFailure(
    await outcome(client.send('Runtime.enable', {}, sessionId)),
    'Runtime.enable',
    missing
  );
  if (missing.length) return abortPageClient(client, sessionId, notes, missing, result);
  await enableChildDomains(client, childSessions, missing, result);
  if (missing.length) return abortPageClient(client, sessionId, notes, missing, result);
  await outcome(client.send('Network.enable', {}, sessionId));
  if (contexts.length)
    result.contextCreated = (client.events ?? [])
      .slice(clientEventStart)
      .some((event) => contextHit(event, raw));
  let liveContexts = await liveGrandchild({
    reader,
    readerSessionId,
    readerSessions,
    targetId,
    pageUrl,
    midHint,
    innerHint,
    innerKind,
    preferMidLive,
    raw,
    contexts,
    budget,
    notes,
    internalSessions,
    missing,
  });
  await adoptLiveClientSessions(
    client,
    sessionId,
    clientEventStart,
    raw,
    childSessions,
    internalSessions,
    missing,
    result
  );
  if (missing.length) return abortPageClient(client, sessionId, notes, missing, result);
  await probeRawGrandchildTarget(client, raw, childSessions, internalSessions, result, missing);
  if (raw.midTargetId || raw.grandchildTargetId) {
    const remasured = await remasureLiveGrandchild({
      reader,
      readerSessionId,
      pageUrl,
      targetId,
      midHint,
      innerHint,
      innerKind,
      raw,
      budget,
      notes,
      internalSessions,
    });
    if (remasured) {
      adoptLiveRaw(raw, remasured);
      note(notes, 'protected-parent.page-live-raw', {
        midFrameId: remasured.hit.midFrameId,
        frameId: remasured.hit.frameId,
        url: remasured.hit.url,
        via: remasured.via,
        remasure: true,
      });
      await adoptLiveClientSessions(
        client,
        sessionId,
        clientEventStart,
        raw,
        childSessions,
        internalSessions,
        missing,
        result
      );
      if (missing.length) return abortPageClient(client, sessionId, notes, missing, result);
      await probeRawGrandchildTarget(client, raw, childSessions, internalSessions, result, missing);
    }
  }
  const clientContexts = await rawContexts(
    client,
    [sessionId, ...childSessions],
    raw,
    clientEventStart,
    Math.min(budget, 1500),
    notes
  );
  if (clientContexts.length) liveContexts = clientContexts;
  await sampleResources(client, [sessionId, ...childSessions], resourceArm, result, raw);
  const windowMs = await pollPageClient({
    client,
    sessionId,
    childSessions,
    clientEventStart,
    raw,
    liveContexts,
    treeArm,
    resourceArm,
    evaluateArm,
    result,
    missing,
    budget,
    skipEvaluate: innerKind === 'srcdoc',
  });
  if (missing.length) return abortPageClient(client, sessionId, notes, missing, result);
  await finishPageClient(
    client,
    sessionId,
    clientEventStart,
    raw,
    liveContexts,
    treeArm,
    resourceArm,
    evaluateArm,
    result,
    missing,
    notes,
    childSessions,
    windowMs,
    innerKind === 'srcdoc'
  );
  if (missing.length) return { ...result, incomplete: missing.join('; ') };
  return result;
}

function finishPageClient(
  client,
  sessionId,
  clientEventStart,
  raw,
  liveContexts,
  treeArm,
  resourceArm,
  evaluateArm,
  result,
  missing,
  notes,
  childSessions,
  windowMs,
  skipEvaluate = false
) {
  result.targetEvents = (client.events ?? [])
    .slice(clientEventStart)
    .some((event) => targetEventHit(event, raw))
    ? true
    : (result.targetEvents ?? false);
  settleArm(result, 'frameTree', treeArm.unanswered, 'Page.getFrameTree unanswered', missing, {
    frameTree: false,
  });
  settleArm(
    result,
    'resourceTree',
    resourceArm.unanswered,
    'Page.getResourceTree unanswered',
    missing,
    { resourceTree: false }
  );
  result.frameEvents ??= false;
  result.midFrameAttached ??= false;
  result.targetInfo ??= false;
  result.childAttach ??= false;
  result.targetEvents ??= false;
  result.childEnableRefused ??= false;
  if (!liveContexts.length) missing.push('grandchild execution context missing in raw leg');
  else {
    result.contextCreated ??= false;
    if (!skipEvaluate) {
      settleArm(
        result,
        'contextEvaluate',
        evaluateArm.unanswered,
        evaluateArm.unansweredId
          ? `Runtime.evaluate unanswered (${evaluateArm.unansweredId}${evaluateArm.unansweredText ?? ''})`
          : 'Runtime.evaluate unanswered',
        missing,
        { contextEvaluate: false }
      );
    }
  }
  note(notes, 'protected-parent.page-client', {
    frameTree: result.frameTree ?? 'unmeasured',
    resourceTree: result.resourceTree ?? 'unmeasured',
    frameEvents: result.frameEvents ?? 'unmeasured',
    contextCreated: result.contextCreated ?? 'unmeasured',
    contextEvaluate: skipEvaluate ? 'skipped' : (result.contextEvaluate ?? 'unmeasured'),
    midFrameAttached: result.midFrameAttached ?? 'unmeasured',
    targetInfo: result.targetInfo ?? 'unmeasured',
    childAttach: result.childAttach ?? 'unmeasured',
    targetEvents: result.targetEvents ?? 'unmeasured',
    childEnableRefused: result.childEnableRefused ?? false,
    attachRefused: result.attachRefused ?? false,
    grandchildTargetId: raw.grandchildTargetId ?? null,
    windowMs,
    childSessions: [...childSessions],
    firstTreeOk: treeArm.out?.ok,
    firstResourceOk: resourceArm.out?.ok,
    firstEvaluateOk: skipEvaluate ? false : evaluateArm.out?.ok,
    unanswered: missing,
  });
  return outcome(client.send('Target.detachFromTarget', { sessionId }));
}

async function pageNested({
  reader,
  client,
  midOrigin,
  ordinary,
  tag,
  notes,
  budget,
  internalSessions,
  eventStart,
  innerKind,
  preferMidLive = false,
}) {
  if (!midOrigin) return { incomplete: 'no middle origin mapped' };
  const inner = innerKind === 'srcdoc' ? 'about:srcdoc' : `${ordinary}/doc?n=inner-${tag}`;
  const mid =
    innerKind === 'srcdoc'
      ? `${midOrigin}/oopif-srcdoc?n=mid-${tag}`
      : `${midOrigin}/oopif-mid?inner=${encodeURIComponent(inner)}&n=mid-${tag}`;
  const page = `${ordinary}/oopif-nest?mid=${encodeURIComponent(mid)}&n=host-${tag}`;
  note(notes, 'protected-parent.page-urls', {
    top: ordinary,
    mid: midOrigin,
    inner,
    page,
    attachOrder: 'mid-already-present',
  });
  const opened = await openProtected(reader, page, notes, internalSessions);
  if (!opened.ok)
    return {
      incomplete: `observer setup failed: ${opened.error?.message ?? opened.error}`,
    };
  if (opened.result.incomplete) return { live: false, incomplete: opened.result.incomplete };
  const { targetId: pageId, sessionId } = opened.result;
  const midHint = midOrigin;
  const innerHint = innerKind === 'srcdoc' ? 'about:srcdoc' : `inner-${tag}`;
  const midNeedle = `mid-${tag}`;
  const rawFound = await waitGrandchild(
    reader,
    sessionId,
    midHint,
    innerHint,
    budget,
    notes,
    pageId,
    internalSessions,
    midNeedle
  );
  if (!rawFound) {
    return {
      live: true,
      incomplete:
        innerKind === 'srcdoc'
          ? 'srcdoc grandchild under the middle frame did not appear in the raw page frame tree within the budget'
          : 'ordinary grandchild under the middle frame did not appear in the raw page frame tree within the budget',
      pageId,
    };
  }
  const raw = {
    midFrameId: rawFound.hit.midFrameId,
    midTargetId: rawFound.midTargetId,
    grandchildTargetId: rawFound.grandchildTargetId,
    frameIds: new Set([rawFound.hit.frameId]),
    urls: new Set([rawFound.hit.url].filter((url) => typeof url === 'string' && url.length > 0)),
    origins: new Set(),
  };
  try {
    raw.origins.add(new URL(rawFound.hit.url).origin);
  } catch {
    if (rawFound.hit.url === 'about:srcdoc') raw.origins.add('://');
  }
  const readerEventStart = reader.events?.length ?? 0;
  const readerSessions = [sessionId, rawFound.midSession, rawFound.grandchildSession].filter(
    Boolean
  );
  const contexts = await rawContexts(
    reader,
    readerSessions,
    raw,
    Math.min(eventStart, readerEventStart),
    budget,
    notes
  );
  if (!contexts.length) {
    note(notes, 'protected-parent.page-no-context', {
      frameId: rawFound.hit.frameId,
      url: rawFound.hit.url,
      via: rawFound.via,
    });
  }
  const measured = await measurePageClient({
    client,
    reader,
    readerSessionId: sessionId,
    readerSessions,
    targetId: pageId,
    pageUrl: page,
    midHint,
    innerHint,
    innerKind,
    preferMidLive,
    raw,
    contexts,
    budget,
    notes,
    internalSessions,
  });
  return {
    live: true,
    pageId,
    frameIds: [...raw.frameIds],
    frameUrls: [...raw.urls],
    midFrameId: raw.midFrameId,
    ...measured,
  };
}

export async function protectedParentIframes({
  client,
  reader,
  protectedOrigin,
  cross,
  ordinary,
  mode,
  tag,
  internalSessions = new Set(),
  notes = [],
  budget = 5000,
  discovery = false,
  eventStart = 0,
}) {
  if (!reader) return { incomplete: 'missing unguarded reader' };
  const pageMode = ['page-nested', 'page-srcdoc', 'page-ordinary'].includes(mode);
  if (discovery && !pageMode) {
    await outcome(client.send('Target.setDiscoverTargets', { discover: true }));
    await outcome(reader.send('Target.setDiscoverTargets', { discover: true }));
    notes.push('protected-parent.discovery: setDiscoverTargets discover=true');
  }
  const built =
    mode === 'nested-cross'
      ? await nestedCross({
          reader,
          client,
          protectedOrigin,
          cross,
          ordinary,
          tag,
          notes,
          budget,
          discovery,
          internalSessions,
          eventStart,
        })
      : mode === 'sandboxed-srcdoc'
        ? await sandboxedSrcdoc({
            reader,
            client,
            protectedOrigin,
            tag,
            notes,
            budget,
            discovery,
            internalSessions,
            eventStart,
          })
        : mode === 'page-nested'
          ? await pageNested({
              reader,
              client,
              midOrigin: protectedOrigin,
              ordinary,
              tag,
              notes,
              budget,
              internalSessions,
              eventStart,
              innerKind: 'ordinary',
              preferMidLive: true,
            })
          : mode === 'page-srcdoc'
            ? await pageNested({
                reader,
                client,
                midOrigin: protectedOrigin,
                ordinary,
                tag,
                notes,
                budget,
                internalSessions,
                eventStart,
                innerKind: 'srcdoc',
                preferMidLive: true,
              })
            : mode === 'page-ordinary'
              ? await pageNested({
                  reader,
                  client,
                  midOrigin: cross,
                  ordinary,
                  tag,
                  notes,
                  budget,
                  internalSessions,
                  eventStart,
                  innerKind: 'ordinary',
                  preferMidLive: false,
                })
              : { incomplete: `unknown protectedParentIframes mode ${mode}` };
  if (built.pageId) await outcome(reader.send('Target.closeTarget', { targetId: built.pageId }));
  return built;
}
