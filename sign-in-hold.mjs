import { outcome, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

const CALLBACK = 'https://www.sliccy.ai/auth/callback';
const CALLBACK_ORIGIN = 'https://www.sliccy.ai';
const MARK_PREFIX = 'slicc-sign-in-';
const BODY = 'SIGN-IN-HOLD-BODY';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const refused = (out) => {
  if (out.ok) return false;
  return /^slicc: refused:/.test(String(out.error?.message ?? out.error ?? ''));
};

function answered(out) {
  if (!out) return false;
  if (out.ok) return true;
  const err = out.error;
  if (err && typeof err.code === 'number') return true;
  return /^slicc: refused:/.test(String(err?.message ?? err ?? ''));
}

function note(notes, label, evidence) {
  notes.push(`${label}: ${JSON.stringify(evidence)}`);
}

function authorizeUrl(idp, redirect) {
  return `${idp}/ims/authorize/v2?client_id=any&redirect_uri=${redirect}&response_type=token`;
}

function callbackRedirect(mode) {
  if (mode === 'callback') return encodeURIComponent(CALLBACK);
  if (mode === 'callback-encoded') return encodeURIComponent(encodeURIComponent(CALLBACK));
  if (mode === 'callback-origin') return encodeURIComponent(CALLBACK_ORIGIN);
  return null;
}

function identifyingLeak(info, rawId, rawUrl, mark) {
  if (!info) return false;
  if (info.targetId === rawId) {
    if (typeof info.url === 'string' && info.url.length > 0 && info.url !== 'about:blank')
      return true;
    if (typeof info.title === 'string' && info.title.length > 0 && info.title !== 'about:blank')
      return true;
  }
  if (typeof info.url === 'string' && rawUrl && info.url === rawUrl) return true;
  if (typeof info.title === 'string' && mark && info.title.includes(mark)) return true;
  if (typeof info.url === 'string' && mark && info.url.includes(mark)) return true;
  return false;
}

function idOnlySeen(info, rawId) {
  if (!info || info.targetId !== rawId) return false;
  const url = info.url ?? '';
  const title = info.title ?? '';
  return url === '' && title === '';
}

function leakFromEvents(events, rawId, rawUrl, mark, from = 0) {
  let urlLeaked = false;
  let idOnly = false;
  for (const event of (events ?? []).slice(from)) {
    if (
      ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.attachedToTarget'].includes(
        event.method
      )
    ) {
      const info = event.params?.targetInfo;
      if (identifyingLeak(info, rawId, rawUrl, mark)) urlLeaked = true;
      else if (idOnlySeen(info, rawId)) idOnly = true;
    }
  }
  return { urlLeaked, idAnnounced: idOnly && !urlLeaked };
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

async function openPage(reader, url, notes, internalSessions) {
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
  note(notes, 'sign-in-hold.open', {
    targetId: created.result.targetId,
    url,
    ready: Boolean(ready),
  });
  if (!ready)
    return {
      ok: true,
      result: { incomplete: 'opener page did not become ready', ...created.result },
    };
  return created;
}

async function listHttp(client, notes) {
  if (typeof client?.jsonList === 'function') {
    const listed = await outcome(client.jsonList());
    note(notes, 'sign-in-hold.json-list', {
      via: 'client.jsonList',
      ok: listed.ok,
      count: listed.ok ? (listed.result?.length ?? 0) : undefined,
      error: listed.ok ? undefined : String(listed.error?.message ?? listed.error),
    });
    return listed;
  }
  const base =
    client?.devtoolsHttp ??
    (typeof client?.ws === 'string'
      ? (() => {
          try {
            const u = new URL(client.ws);
            return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
          } catch {
            return null;
          }
        })()
      : null);
  if (!base) {
    note(notes, 'sign-in-hold.json-list', { via: 'unavailable' });
    return { ok: false, missing: true, error: { message: '/json/list unavailable' } };
  }
  try {
    const response = await fetch(`${base}/json/list`);
    if (!response.ok) {
      note(notes, 'sign-in-hold.json-list', {
        via: 'http',
        ok: false,
        status: response.status,
      });
      return { ok: false, error: { message: `json/list HTTP ${response.status}` } };
    }
    const body = await response.json();
    note(notes, 'sign-in-hold.json-list', { via: 'http', count: body?.length ?? 0 });
    return { ok: true, result: body };
  } catch (error) {
    note(notes, 'sign-in-hold.json-list', {
      via: 'http-failed',
      error: String(error?.message ?? error),
    });
    return {
      ok: false,
      missing: true,
      error: { message: String(error?.message ?? error) },
    };
  }
}

function jsonEntryLeak(entry, rawId, rawUrl, mark) {
  if (!entry) return false;
  if (entry.id === rawId) {
    if (typeof entry.url === 'string' && entry.url.length > 0 && entry.url !== 'about:blank')
      return true;
    if (typeof entry.title === 'string' && entry.title.length > 0) return true;
  }
  if (typeof entry.url === 'string' && rawUrl && entry.url === rawUrl) return true;
  if (typeof entry.title === 'string' && mark && String(entry.title).includes(mark)) return true;
  return false;
}

function recordJson(listed, result, missing, rawId, rawUrl, mark) {
  if (listed?.missing) {
    if (!missing.includes('/json/list unavailable')) missing.push('/json/list unavailable');
    return;
  }
  if (!answered(listed)) {
    if (!missing.includes('/json/list unanswered')) missing.push('/json/list unanswered');
    return;
  }
  const leak = listed.ok
    ? (listed.result ?? []).some((entry) => jsonEntryLeak(entry, rawId, rawUrl, mark))
    : false;
  if (leak) {
    result.jsonListed = true;
    result.idAnnounced = false;
  } else {
    result.jsonListed = result.jsonListed ?? false;
  }
}

function recordTargets(targets, result, missing, rawId, rawUrl, mark) {
  if (!answered(targets)) {
    if (!missing.includes('Target.getTargets unanswered'))
      missing.push('Target.getTargets unanswered');
    return;
  }
  if (!targets.ok) return;
  const infos = targets.result?.targetInfos ?? [];
  const match = infos.find((info) => info.targetId === rawId);
  const listed = identifyingLeak(match, rawId, rawUrl, mark)
    ? true
    : infos.some((info) => identifyingLeak(info, rawId, rawUrl, mark));
  if (listed) {
    result.targetsListed = true;
    result.idAnnounced = false;
  } else {
    result.targetsListed = result.targetsListed ?? false;
    if (idOnlySeen(match, rawId)) result.idAnnounced = true;
  }
}

function recordEvents(client, result, discovery, rawId, rawUrl, mark, eventStart) {
  if (!discovery) return;
  const leaked = leakFromEvents(client.events ?? [], rawId, rawUrl, mark, eventStart);
  if (leaked.urlLeaked) {
    result.eventsSeen = true;
    result.idAnnounced = false;
  } else {
    result.eventsSeen = result.eventsSeen ?? false;
    if (leaked.idAnnounced && result.targetsListed !== true && result.jsonListed !== true)
      result.idAnnounced = true;
  }
}

async function recordAttach(client, result, missing, rawId, mark) {
  const attached = await outcome(
    client.send('Target.attachToTarget', { targetId: rawId, flatten: true })
  );
  if (!answered(attached)) {
    if (!missing.includes('Target.attachToTarget unanswered'))
      missing.push('Target.attachToTarget unanswered');
    return attached;
  }
  if (attached.ok && attached.result?.sessionId) {
    result.attachSession = true;
    result.attachRefused = false;
    const sessionId = attached.result.sessionId;
    const enabled = await outcome(client.send('Runtime.enable', {}, sessionId));
    const read = await outcome(
      client.send(
        'Runtime.evaluate',
        {
          expression: 'document.title + " " + (document.body && document.body.innerText)',
          returnByValue: true,
        },
        sessionId
      )
    );
    const text = read.ok ? String(read.result?.result?.value ?? '') : '';
    if (mark && text.includes(mark)) result.contentRead = true;
    else if (answered(read) && !refused(read)) result.contentRead ??= false;
    if (refused(read) || refused(enabled)) {
      result.attachRefused = true;
      result.guardError = String((refused(read) ? read : enabled).error?.message ?? '');
    }
    await outcome(client.send('Target.detachFromTarget', { sessionId }));
    return attached;
  }
  if (refused(attached)) {
    result.attachSession = false;
    result.attachRefused = true;
    result.guardError = String(attached.error?.message ?? '');
    result.contentRead ??= false;
  } else {
    result.attachSession = false;
    result.attachRefused = false;
    result.contentRead ??= false;
  }
  return attached;
}

async function recordConnect(client, result, missing) {
  const connect = await outcome(
    (async () => {
      await client.send('Browser.getVersion', {});
      await client.send('Target.getTargets', {});
      return { ok: true };
    })()
  );
  result.connectCompletes = answered(connect) && connect.ok !== false;
  if (!answered(connect)) missing.push('Browser.getVersion/connect unanswered');
  return connect;
}

function finalizeMeasured(result, discovery) {
  if (discovery && result.eventsSeen === undefined) result.eventsSeen = false;
  result.jsonListed ??= false;
  result.targetsListed ??= false;
  result.idAnnounced ??= false;
  if (result.targetsListed || result.jsonListed || result.eventsSeen) result.idAnnounced = false;
  result.attachSession ??= false;
  result.attachRefused ??= false;
  result.contentRead ??= false;
  result.connectCompletes ??= false;
}

async function measureClient({
  client,
  rawId,
  rawUrl,
  mark,
  discovery,
  eventStart,
  budget,
  notes,
}) {
  const result = {};
  const missing = [];
  const windowMs = Math.min(budget, 1500);
  const deadline = Date.now() + windowMs;
  let firstTargets;
  let firstAttach;
  let firstConnect;

  while (Date.now() <= deadline) {
    const listedHttp = await listHttp(client, notes);
    recordJson(listedHttp, result, missing, rawId, rawUrl, mark);
    if (result.jsonListed === true) result.idAnnounced = false;
    const targets = await outcome(client.send('Target.getTargets', {}));
    firstTargets ??= targets;
    recordTargets(targets, result, missing, rawId, rawUrl, mark);
    recordEvents(client, result, discovery, rawId, rawUrl, mark, eventStart);
    if (result.attachSession !== true)
      firstAttach ??= await recordAttach(client, result, missing, rawId, mark);
    if (firstConnect === undefined) firstConnect = await recordConnect(client, result, missing);
    if (
      result.jsonListed === true &&
      result.targetsListed === true &&
      result.attachSession === true &&
      result.contentRead === true
    )
      break;
    await pause(50);
  }

  finalizeMeasured(result, discovery);
  note(notes, 'sign-in-hold.client', {
    jsonListed: result.jsonListed,
    targetsListed: result.targetsListed,
    eventsSeen: discovery ? result.eventsSeen : 'not-declared',
    idAnnounced: result.idAnnounced,
    attachSession: result.attachSession,
    attachRefused: result.attachRefused,
    contentRead: result.contentRead,
    connectCompletes: result.connectCompletes,
    guardError: result.guardError ?? null,
    firstTargetsOk: firstTargets?.ok,
    firstAttachOk: firstAttach?.ok,
    unanswered: missing,
  });
  if (missing.length) return { ...result, incomplete: missing.join('; ') };
  return result;
}

async function rawReadable(reader, targetId, mark, notes) {
  const attached = await outcome(reader.send('Target.attachToTarget', { targetId, flatten: true }));
  if (!attached.ok || !attached.result?.sessionId)
    return { readable: false, reason: `raw attach failed: ${attached.error?.message}` };
  const sessionId = attached.result.sessionId;
  await outcome(reader.send('Runtime.enable', {}, sessionId));
  const read = await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression: 'document.title + " " + (document.body && document.body.innerText)',
        returnByValue: true,
      },
      sessionId
    )
  );
  await outcome(reader.send('Target.detachFromTarget', { sessionId }));
  const text = read.ok ? String(read.result?.result?.value ?? '') : '';
  const readable = Boolean(mark && text.includes(mark));
  note(notes, 'sign-in-hold.raw-read', { targetId, readable, text: text.slice(0, 120) });
  return { readable, text };
}

function holdExpression(control, ordinary, tag, marker, heldUrl) {
  if (control)
    return `(async () => {
        const popup = window.open(${JSON.stringify(`${ordinary}/held?n=${tag}`)}, 'slicc-ordinary', 'popup,width=520,height=720');
        return { answer: 'none', opened: Boolean(popup) };
      })()`;
  return `(async () => {
        const marker = ${JSON.stringify(marker)};
        const heldUrl = ${JSON.stringify(heldUrl)};
        const popup = window.open('about:blank#${MARK_PREFIX}' + marker, 'slicc-sign-in', 'popup,width=520,height=720');
        const channel = new BroadcastChannel('slicc-held');
        const answer = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 6000);
          channel.onmessage = ({ data }) => {
            if (data?.marker !== marker || data.type === 'hold') return;
            clearTimeout(timer);
            resolve(data.type);
          };
          channel.postMessage({ type: 'hold', marker });
        });
        channel.close();
        if (popup && (answer === 'held' || answer === 'timeout')) popup.location.href = heldUrl;
        return { answer, opened: Boolean(popup) };
      })()`;
}

function matchPopup(info, known, openerId, heldUrl, control) {
  if (info.type !== 'page' || known.has(info.targetId) || info.targetId === openerId) return false;
  const url = info.url ?? '';
  if (control) return url === heldUrl || url.includes('/held');
  return url === heldUrl || url.startsWith('about:blank#') || url.includes('/held');
}

async function moveHeldPopup(reader, raw, heldUrl, budget, internalSessions) {
  if (raw.url === heldUrl) return raw;
  const attached = await outcome(
    reader.send('Target.attachToTarget', { targetId: raw.targetId, flatten: true })
  );
  if (attached.ok && attached.result?.sessionId) {
    internalSessions.add(attached.result.sessionId);
    await outcome(reader.send('Page.navigate', { url: heldUrl }, attached.result.sessionId));
    await outcome(reader.send('Target.detachFromTarget', { sessionId: attached.result.sessionId }));
    internalSessions.delete(attached.result.sessionId);
  }
  const moved = await until(
    async () => {
      const info = await outcome(reader.send('Target.getTargetInfo', { targetId: raw.targetId }));
      return info.ok && info.result?.targetInfo?.url === heldUrl ? info.result.targetInfo : null;
    },
    Math.min(budget, 2000)
  );
  return moved ? Object.assign(raw, moved) : raw;
}

async function heldPopup({
  reader,
  client,
  openerOrigin,
  ordinary,
  tag,
  notes,
  budget,
  discovery,
  internalSessions,
  eventStart,
  control,
}) {
  const mark = BODY;
  const marker = `hold-${tag}`;
  const heldUrl = `${ordinary}/held?n=${encodeURIComponent(tag)}`;
  const openerUrl = control
    ? `${ordinary}/doc?n=opener-${tag}`
    : `${openerOrigin}/doc?n=opener-${tag}`;
  const opened = await openPage(reader, openerUrl, notes, internalSessions);
  if (!opened.ok)
    return { incomplete: `observer setup failed: ${opened.error?.message ?? opened.error}` };
  if (opened.result.incomplete) return { live: false, incomplete: opened.result.incomplete };
  const { sessionId, targetId: openerId } = opened.result;
  const before = await outcome(reader.send('Target.getTargets', {}));
  const known = new Set((before.result?.targetInfos ?? []).map((info) => info.targetId));
  const asked = await outcome(
    reader.send(
      'Runtime.evaluate',
      {
        expression: holdExpression(control, ordinary, tag, marker, heldUrl),
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      sessionId
    )
  );
  if (!asked.ok)
    return {
      live: false,
      incomplete: `hold evaluate failed: ${asked.error?.message ?? asked.error}`,
      openerId,
    };
  const holdAnswer = asked.result?.result?.value?.answer ?? 'missing';
  const openedPopup = asked.result?.result?.value?.opened;
  note(notes, 'sign-in-hold.hold', {
    holdAnswer,
    control: Boolean(control),
    opened: openedPopup,
  });
  if (openedPopup === false)
    return {
      live: false,
      incomplete: 'window.open returned null',
      holdAnswer,
      openerId,
    };
  const raw = await until(async () => {
    const listed = await outcome(reader.send('Target.getTargets', {}));
    if (!listed.ok) return null;
    return (
      (listed.result?.targetInfos ?? []).find((info) =>
        matchPopup(info, known, openerId, heldUrl, control)
      ) ?? null
    );
  }, budget);
  if (!raw) {
    return {
      live: false,
      incomplete: 'popup target did not appear in the raw leg within the budget',
      holdAnswer,
      openerId,
    };
  }
  if (!control) await moveHeldPopup(reader, raw, heldUrl, budget, internalSessions);
  const settled = await until(
    async () => {
      const info = await outcome(reader.send('Target.getTargetInfo', { targetId: raw.targetId }));
      if (!info.ok) return null;
      if (info.result?.targetInfo?.url === heldUrl || control) return info.result.targetInfo;
      return info.result?.targetInfo ?? null;
    },
    Math.min(budget, 3000)
  );
  const rawUrl = settled?.url ?? raw.url ?? heldUrl;
  const { readable } = await rawReadable(reader, raw.targetId, mark, notes);
  if (!readable)
    return {
      live: false,
      incomplete: 'raw leg could not read the popup body mark',
      holdAnswer,
      openerId,
      targetId: raw.targetId,
    };
  const measured = await measureClient({
    client,
    rawId: raw.targetId,
    rawUrl,
    mark,
    discovery,
    eventStart,
    budget,
    notes,
  });
  const held = !control && holdAnswer === 'held';
  return {
    live: true,
    holdAnswer: control ? 'none' : holdAnswer,
    openerId,
    targetId: raw.targetId,
    rawUrl,
    ...measured,
    held,
  };
}

async function callbackTab({
  reader,
  client,
  idp,
  ordinary,
  mode,
  tag,
  notes,
  budget,
  discovery,
  internalSessions,
  eventStart,
  control,
}) {
  const mark = BODY;
  const redirect = control ? encodeURIComponent(`${ordinary}/cb`) : callbackRedirect(mode);
  if (!redirect && !control) return { incomplete: `unknown callback mode ${mode}` };
  const url = authorizeUrl(idp, redirect);
  note(notes, 'sign-in-hold.callback-url', { url, control: Boolean(control), mode });

  const created = await outcome(reader.send('Target.createTarget', { url, background: true }));
  if (!created.ok)
    return {
      live: false,
      incomplete: `createTarget failed: ${created.error?.message ?? created.error}`,
    };
  const targetId = created.result?.targetId;
  if (!targetId) return { live: false, incomplete: 'createTarget returned no targetId' };

  const ready = await until(async () => {
    const info = await outcome(reader.send('Target.getTargetInfo', { targetId }));
    if (!info.ok) return null;
    const current = info.result?.targetInfo;
    if (current?.url && (current.url.includes('/ims/authorize') || current.url === url))
      return current;
    return null;
  }, budget);

  if (!ready)
    return {
      live: false,
      incomplete: 'callback tab did not settle in the raw leg',
      targetId,
    };

  const { readable } = await rawReadable(reader, targetId, mark, notes);
  if (!readable)
    return {
      live: false,
      incomplete: 'raw leg could not read the callback tab mark',
      targetId,
    };

  const measured = await measureClient({
    client,
    rawId: targetId,
    rawUrl: ready.url ?? url,
    mark,
    discovery,
    eventStart,
    budget,
    notes,
  });

  return {
    live: true,
    targetId,
    rawUrl: ready.url ?? url,
    ...measured,
  };
}

export async function signInHold({
  client,
  reader,
  mode,
  openerOrigin,
  ordinary,
  cross,
  tag,
  internalSessions = new Set(),
  notes = [],
  budget = 5000,
  discovery = false,
  eventStart = 0,
  control = false,
}) {
  if (!reader) return { incomplete: 'missing unguarded reader' };
  if (!ordinary) return { incomplete: 'missing {ordinary} placeholder' };
  if (!cross && String(mode).startsWith('callback'))
    return { incomplete: 'missing {cross} placeholder' };
  if (discovery) {
    await outcome(client.send('Target.setDiscoverTargets', { discover: true }));
    await outcome(reader.send('Target.setDiscoverTargets', { discover: true }));
    notes.push('sign-in-hold.discovery: setDiscoverTargets discover=true');
  }

  const built =
    mode === 'held-popup' || mode === 'ordinary-popup'
      ? await heldPopup({
          reader,
          client,
          openerOrigin: openerOrigin ?? ordinary,
          ordinary,
          tag,
          notes,
          budget,
          discovery,
          internalSessions,
          eventStart,
          control: control || mode === 'ordinary-popup',
        })
      : String(mode).startsWith('callback')
        ? await callbackTab({
            reader,
            client,
            idp: cross,
            ordinary,
            mode,
            tag,
            notes,
            budget,
            discovery,
            internalSessions,
            eventStart,
            control,
          })
        : { incomplete: `unknown signInHold mode ${mode}` };

  for (const id of [built.openerId, built.targetId].filter(Boolean))
    await outcome(reader.send('Target.closeTarget', { targetId: id }));
  return built;
}

export const SIGN_IN_HOLD_CALLBACK = CALLBACK;
export const SIGN_IN_HOLD_BODY = BODY;
export const SIGN_IN_HOLD_MARK = MARK_PREFIX;
