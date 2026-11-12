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
  if (discovery) {
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
        : { incomplete: `unknown protectedParentIframes mode ${mode}` };
  if (built.pageId) await outcome(reader.send('Target.closeTarget', { targetId: built.pageId }));
  return built;
}
