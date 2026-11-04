import { DEFAULT_EXTENSION_WORLD_ID } from './extension-world.mjs';
import { outcome } from './guard-driver.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FRAME = 'slicc-extension-frame';
const MARKER = 'slicc-private-extension-frame-content';
const BOX = 'position:fixed;right:0;bottom:0;width:300px;height:200px;border:0';
const STYLES = {
  hidden: 'f.hidden = true; f.style.cssText = ""',
  concealed:
    'f.hidden = false; f.style.cssText = "position:fixed;left:-999999px;top:0;width:300px;height:200px;border:0;visibility:hidden;opacity:0"',
  shown: `f.hidden = false; f.style.cssText = ${JSON.stringify(BOX)}`,
  transparent: `f.hidden = false; f.style.cssText = ${JSON.stringify(`${BOX};opacity:0`)}`,
};
const refusal = (out) => (out.ok ? null : String(out.error?.message ?? out.error));

async function observe(reader, observer, expression) {
  const out = await outcome(
    reader.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      observer
    )
  );
  if (!out.ok || out.result.exceptionDetails)
    throw new Error(
      `extensionFrame observer: ${out.error?.message ?? out.result.exceptionDetails?.text}`
    );
  return out.result.result?.value;
}

async function painted(reader, observer, ms) {
  await outcome(reader.send('Page.bringToFront', {}, observer));
  await Promise.race([
    outcome(
      reader.send(
        'Runtime.evaluate',
        {
          expression: `new Promise((resolve) => { setTimeout(resolve, ${ms}); requestAnimationFrame(() => requestAnimationFrame(resolve)); })`,
          awaitPromise: true,
          returnByValue: true,
        },
        observer
      )
    ),
    pause(ms),
  ]);
}

async function style(reader, observer, mode, ms) {
  await observe(
    reader,
    observer,
    `(() => { const f = document.getElementById(${JSON.stringify(FRAME)}); ${STYLES[mode]}; return true; })()`
  );
  await painted(reader, observer, ms);
}

async function frameTarget(reader, targetId, extensionId) {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + 5000;
  do {
    const { targetInfos } = await reader.send('Target.getTargets');
    const found = targetInfos.find(
      (info) => info.type === 'iframe' && info.parentId === targetId && info.url.startsWith(prefix)
    );
    if (found) return found;
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error(`extensionFrame: no frame target for ${extensionId}`);
}

async function shot(client, session) {
  const out = await outcome(client.send('Page.captureScreenshot', { format: 'png' }, session));
  return { out, ok: out.ok && typeof out.result.data === 'string' && out.result.data.length > 0 };
}

async function click(client, reader, session, observer) {
  await observe(reader, observer, 'delete document.body.dataset.clicked; true');
  const down = await outcome(
    client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 },
      session
    )
  );
  const up = await outcome(
    client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: 20, y: 20, button: 'left', clickCount: 1 },
      session
    )
  );
  const clicked = await observe(reader, observer, 'document.body.dataset.clicked === "yes"');
  return { out: down.ok ? up : down, ok: down.ok && up.ok && clicked === true };
}

async function key(client, reader, session, observer) {
  await observe(
    reader,
    observer,
    'const i = document.getElementById("typed"); i.value = ""; i.focus(); true'
  );
  const out = await outcome(client.send('Input.insertText', { text: 'k' }, session));
  const typed = await observe(reader, observer, 'document.getElementById("typed").value === "k"');
  return { out, ok: out.ok && typed === true };
}

function snapshotReadsFrame(snapshot, extensionId) {
  return (
    snapshot.ok &&
    (JSON.stringify(snapshot.result).includes(MARKER) ||
      snapshot.result.documents?.some((doc) =>
        snapshot.result.strings?.[doc.documentURL]?.startsWith(`chrome-extension://${extensionId}/`)
      ))
  );
}

async function targetExposure({
  client,
  reader,
  observer,
  page,
  frame,
  frameURL,
  eventStart,
  frameMs,
  missing,
}) {
  const result = {};
  const info = await outcome(client.send('Target.getTargetInfo', { targetId: frame.targetId }));
  if (info.ok && (!info.result?.targetInfo || typeof info.result.targetInfo.url !== 'string'))
    missing.push('Target.getTargetInfo returned no targetInfo URL');
  result.targetInfoURL = info.ok && JSON.stringify(info.result).includes(frameURL);
  const auto = await outcome(
    client.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      page
    )
  );
  try {
    await painted(reader, observer, frameMs);
    if (eventStart === undefined || !Array.isArray(client.events)) {
      missing.push('target event stream is unavailable');
    } else {
      const events = client.events.slice(eventStart);
      result.autoAttached = events.some(
        (event) =>
          event.method === 'Target.attachedToTarget' &&
          event.sessionId === page &&
          event.params?.targetInfo?.targetId === frame.targetId &&
          typeof event.params.sessionId === 'string'
      );
      result.eventURL = events.some(
        (event) =>
          ['Target.attachedToTarget', 'Target.targetCreated', 'Target.targetInfoChanged'].includes(
            event.method
          ) && JSON.stringify(event.params).includes(frameURL)
      );
    }
    const listing = await outcome(client.send('Target.getTargets'));
    if (!listing.ok || !Array.isArray(listing.result?.targetInfos)) {
      missing.push('Target.getTargets returned no targetInfos array');
    } else {
      result.listed = JSON.stringify(listing.result.targetInfos).includes(frameURL);
    }
    return result;
  } finally {
    if (auto.ok)
      await outcome(
        client.send(
          'Target.setAutoAttach',
          { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
          page
        )
      );
  }
}

export async function extensionFrame({
  client,
  reader,
  session,
  targetId,
  mode,
  origin,
  extensionId = DEFAULT_EXTENSION_WORLD_ID,
  frameMs = 1000,
}) {
  const attached = await reader.send('Target.attachToTarget', { targetId, flatten: true });
  const observer = attached.sessionId;
  const missing = [];
  const eventStart = client.events?.length;
  const frameURL = `chrome-extension://${extensionId}/frame.html`;
  let page;
  let pageAttached = false;
  const discovery = await outcome(client.send('Target.setDiscoverTargets', { discover: true }));
  try {
    await reader.send('Runtime.enable', {}, observer);
    await observe(
      reader,
      observer,
      `new Promise((resolve) => {
        document.body.innerHTML = '<button id="c9-click" style="position:fixed;left:0;top:0;width:100px;height:100px" onclick="document.body.dataset.clicked=\\'yes\\'">C9 click</button><input id="typed" style="position:fixed;left:0;top:120px;width:100px">';
        const f = document.createElement('iframe');
        f.id = ${JSON.stringify(FRAME)};
        ${STYLES[mode === 'revealed' ? 'hidden' : mode]};
        f.addEventListener('load', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 5000);
        f.src = ${JSON.stringify(`${frameURL}?username=slicc-frame-test-user`)};
        document.body.append(f);
      })`
    );
    const frame = await frameTarget(reader, targetId, extensionId);
    const privateSession = (
      await reader.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
    ).sessionId;
    try {
      await observe(
        reader,
        privateSession,
        `document.body.textContent = ${JSON.stringify(MARKER)}`
      );
    } finally {
      await reader.send('Target.detachFromTarget', { sessionId: privateSession });
    }
    await painted(reader, observer, frameMs);
    const attach = await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }));
    page = attach.ok ? attach.result.sessionId : session;
    pageAttached = attach.ok;
    const read = await outcome(
      client.send('Runtime.evaluate', { expression: 'self.origin', returnByValue: true }, page)
    );
    const snapshot = await outcome(
      client.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, page)
    );
    const picture = await shot(client, page);
    const pressed = await click(client, reader, page, observer);
    const typed = await key(client, reader, page, observer);
    const archive = await outcome(client.send('Page.captureSnapshot', { format: 'mhtml' }, page));
    const pdf = await outcome(client.send('Page.printToPDF', {}, page));
    if (pdf.ok && !(typeof pdf.result.data === 'string' && pdf.result.data.length > 0))
      missing.push('Page.printToPDF returned no PDF data');
    const cast = await outcome(
      client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }, page)
    );
    if (cast.ok) await outcome(client.send('Page.stopScreencast', {}, page));
    const result = {
      exists: true,
      attached: attach.ok,
      read: read.ok && read.result.result?.value === origin,
      snapshot: snapshot.ok && snapshot.result.documents?.length > 0,
      snapshotFrameRead: snapshotReadsFrame(snapshot, extensionId),
      shot: picture.ok,
      shotRefusal: refusal(picture.out),
      click: pressed.ok,
      clickRefusal: refusal(pressed.out),
      key: typed.ok,
      keyRefusal: refusal(typed.out),
      archive: archive.ok,
      archiveRefusal: refusal(archive),
      pdf: pdf.ok,
      pdfRefusal: refusal(pdf),
      cast: cast.ok,
      castRefusal: refusal(cast),
    };
    if (mode === 'revealed') {
      await style(reader, observer, 'shown', frameMs);
      const revealed = await shot(client, page);
      const revealedPress = await click(client, reader, page, observer);
      await style(reader, observer, 'hidden', frameMs);
      const rehidden = await shot(client, page);
      Object.assign(result, {
        revealedShot: revealed.ok,
        revealedRefusal: refusal(revealed.out),
        revealedClick: revealedPress.ok,
        rehiddenShot: rehidden.ok,
      });
    }
    const frameAttach = await outcome(
      client.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
    );
    if (frameAttach.ok)
      await outcome(
        client.send('Target.detachFromTarget', { sessionId: frameAttach.result.sessionId })
      );
    result.frameAttach = frameAttach.ok;
    Object.assign(
      result,
      await targetExposure({
        client,
        reader,
        observer,
        page,
        frame,
        frameURL,
        eventStart,
        frameMs,
        missing,
      })
    );
    const alive = await outcome(
      client.send('Runtime.evaluate', { expression: 'self.origin', returnByValue: true }, page)
    );
    result.alive = alive.ok && alive.result.result?.value === origin;
    return missing.length ? { ...result, incomplete: missing.join('; ') } : result;
  } finally {
    if (pageAttached) await outcome(client.send('Target.detachFromTarget', { sessionId: page }));
    if (discovery.ok) await outcome(client.send('Target.setDiscoverTargets', { discover: false }));
    await outcome(reader.send('Target.detachFromTarget', { sessionId: observer }));
  }
}
