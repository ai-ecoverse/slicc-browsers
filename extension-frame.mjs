import catalog from './catalog.json' with { type: 'json' };
import { DEFAULT_EXTENSION_WORLD_ID } from './extension-world.mjs';
import { outcome } from './guard-driver.mjs';

const INPUT_METHODS = catalog.protectedOrigins.extensionFrames.whenShown.filter((method) =>
  method.startsWith('Input.')
);
const PRESENT = catalog.protectedOrigins.extensionFrames.presentRefusal;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FRAME = 'slicc-extension-frame';
const HOST = 'slicc-extension-frame-host';
const SHADOW = 'slicc-extension-frame-shadow';
const MARKER = 'slicc-private-extension-frame-content';
const USERNAME = 'slicc-frame-test-user';
const BOX = 'position:fixed;right:0;bottom:0;width:300px;height:200px;border:0';
const STYLES = {
  hidden: 'f.hidden = true; f.style.cssText = ""',
  concealed:
    'f.hidden = false; f.style.cssText = "position:fixed;left:-999999px;top:0;width:300px;height:200px;border:0;visibility:hidden;opacity:0"',
  shown: `f.hidden = false; f.style.cssText = ${JSON.stringify(BOX)}`,
  transparent: `f.hidden = false; f.style.cssText = ${JSON.stringify(`${BOX};opacity:0`)}`,
  nested: `f.hidden = false; f.style.cssText = ${JSON.stringify(BOX)}`,
  focused:
    'f.hidden = false; f.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;border:0;overflow:hidden;opacity:0"',
};
const refusal = (out) => (out.ok ? null : String(out.error?.message ?? out.error));
const presentish = (out) => {
  const text = refusal(out);
  if (!text) return null;
  return text === PRESENT || /^slicc: refused/.test(text) ? PRESENT : text;
};
const carries = (value) => {
  const text = JSON.stringify(value) ?? '';
  return text.includes(USERNAME) || text.includes(MARKER);
};
const frameLookup = `document.getElementById(${JSON.stringify(FRAME)})
  ?? document.getElementById(${JSON.stringify(HOST)})?.contentDocument?.getElementById(${JSON.stringify(FRAME)})`;

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
  const apply = STYLES[mode] ?? STYLES.shown;
  await observe(reader, observer, `(() => { const f = ${frameLookup}; ${apply}; return true; })()`);
  await painted(reader, observer, ms);
}

async function frameTarget(reader, targetId, extensionId) {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + 5000;
  do {
    const { targetInfos } = await reader.send('Target.getTargets');
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
    const found = targetInfos.find(
      (info) => info.type === 'iframe' && info.url.startsWith(prefix) && under(info)
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

async function clickAt(client, _reader, session, _observer, x, y) {
  const down = await outcome(
    client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      session
    )
  );
  const up = await outcome(
    client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      session
    )
  );
  return { out: down.ok ? up : down, ok: down.ok && up.ok };
}

async function click(client, reader, session, observer) {
  await observe(reader, observer, 'delete document.body.dataset.clicked; true');
  const pressed = await clickAt(client, reader, session, observer, 20, 20);
  const clicked = await observe(reader, observer, 'document.body.dataset.clicked === "yes"');
  return { out: pressed.out, ok: pressed.ok && clicked === true };
}

async function key(client, reader, session, observer, beforeSend, requireTyped = true) {
  await observe(
    reader,
    observer,
    'const i = document.getElementById("typed"); i.value = ""; i.focus(); true'
  );
  if (beforeSend) await beforeSend();
  const out = await outcome(client.send('Input.insertText', { text: 'k' }, session));
  const typed = await observe(reader, observer, 'document.getElementById("typed").value === "k"');
  return { out, ok: out.ok && (!requireTyped || typed === true) };
}

async function inputMethods(client, session, methods) {
  const results = {};
  for (const method of methods) {
    let params = {};
    if (method === 'Input.dispatchKeyEvent') params = { type: 'keyDown', key: 'Tab', code: 'Tab' };
    else if (method === 'Input.dispatchMouseEvent')
      params = { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 };
    else if (method === 'Input.dispatchTouchEvent')
      params = { type: 'touchStart', touchPoints: [{ x: 20, y: 20 }] };
    else if (method === 'Input.dispatchDragEvent')
      params = {
        type: 'dragEnter',
        x: 20,
        y: 20,
        data: { items: [], files: [], dragOperationsMask: 1 },
      };
    else if (method === 'Input.emulateTouchFromMouseEvent')
      params = { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 };
    else if (method === 'Input.insertText') params = { text: 'k' };
    else if (method === 'Input.imeSetComposition')
      params = { text: 'k', selectionStart: 1, selectionEnd: 1 };
    else if (method === 'Input.synthesizePinchGesture') params = { x: 20, y: 20, scaleFactor: 1.1 };
    else if (method === 'Input.synthesizeScrollGesture') params = { x: 20, y: 20, yDistance: -10 };
    else if (method === 'Input.synthesizeTapGesture') params = { x: 20, y: 20 };
    const out = await outcome(client.send(method, params, session));
    results[method] = { ok: out.ok, refusal: refusal(out) };
  }
  return results;
}

function snapshotReadsFrame(snapshot, extensionId, frameURL) {
  if (!snapshot.ok) return false;
  const text = JSON.stringify(snapshot.result);
  if (carries(snapshot.result) || text.includes(frameURL) || text.includes(`${frameURL}?`))
    return true;
  return (
    snapshot.result.documents?.some((doc) =>
      snapshot.result.strings?.[doc.documentURL]?.startsWith(`chrome-extension://${extensionId}/`)
    ) ?? false
  );
}

async function pageLeaks({ client, page, extensionId, frameURL, missing }) {
  const leaks = {
    frameTreeLeak: false,
    documentLeak: false,
    shadowDocumentLeak: false,
    axLeak: false,
    evaluateLeak: false,
    snapshotFrameRead: false,
  };
  const tree = await outcome(client.send('Page.getFrameTree', {}, page));
  if (!tree.ok) missing.push('Page.getFrameTree failed');
  else leaks.frameTreeLeak = carries(tree.result) || JSON.stringify(tree.result).includes(frameURL);
  const document = await outcome(client.send('DOM.getDocument', { depth: -1, pierce: true }, page));
  if (!document.ok) missing.push('DOM.getDocument failed');
  else {
    const text = JSON.stringify(document.result);
    leaks.documentLeak = carries(document.result) || text.includes(frameURL);
    leaks.shadowDocumentLeak = text.includes(USERNAME) && text.includes(SHADOW);
  }
  const ax = await outcome(client.send('Accessibility.getFullAXTree', {}, page));
  if (!ax.ok) missing.push('Accessibility.getFullAXTree failed');
  else leaks.axLeak = carries(ax.result) || JSON.stringify(ax.result).includes(frameURL);
  const evaluated = await outcome(
    client.send(
      'Runtime.evaluate',
      {
        expression: `(() => { const f = ${frameLookup}; return f ? f.src : ''; })()`,
        returnByValue: true,
      },
      page
    )
  );
  if (!evaluated.ok) missing.push('Runtime.evaluate of iframe.src failed');
  else {
    const value = evaluated.result.result?.value;
    leaks.evaluateLeak =
      carries(evaluated.result) ||
      (typeof value === 'string' && (value.includes(USERNAME) || value.includes(frameURL)));
  }
  const snapshot = await outcome(
    client.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, page)
  );
  leaks.snapshot = snapshot.ok && snapshot.result.documents?.length > 0;
  if (!snapshot.ok) missing.push('DOMSnapshot.captureSnapshot failed');
  else leaks.snapshotFrameRead = snapshotReadsFrame(snapshot, extensionId, frameURL);
  return { ...leaks, snapshotOut: snapshot };
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
  if (!info.ok) missing.push('Target.getTargetInfo failed');
  else if (!info.result?.targetInfo || typeof info.result.targetInfo.url !== 'string')
    missing.push('Target.getTargetInfo returned no targetInfo URL');
  else result.targetInfoURL = JSON.stringify(info.result).includes(frameURL);
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

async function embed(reader, observer, mode, frameURL) {
  const styleMode =
    mode === 'revealed'
      ? 'hidden'
      : mode === 'focused'
        ? 'focused'
        : mode === 'nested'
          ? 'nested'
          : mode;
  const src = `${frameURL}?username=${USERNAME}`;
  if (mode === 'nested') {
    return observe(
      reader,
      observer,
      `new Promise((resolve) => {
        document.body.innerHTML = '<button id="c9-click" style="position:fixed;left:0;top:0;width:100px;height:100px" onclick="document.body.dataset.clicked=\\'yes\\'">C9 click</button><input id="typed" style="position:fixed;left:0;top:120px;width:100px"><iframe id=${JSON.stringify(HOST)} style="position:fixed;left:0;top:200px;width:400px;height:300px;border:0"></iframe>';
        const shadowHost = document.createElement('div');
        shadowHost.id = ${JSON.stringify(SHADOW)};
        const root = shadowHost.attachShadow({ mode: 'closed' });
        const shadowFrame = document.createElement('iframe');
        shadowFrame.id = ${JSON.stringify(FRAME)} + '-shadow';
        shadowFrame.hidden = true;
        shadowFrame.src = ${JSON.stringify(src)};
        root.append(shadowFrame);
        document.body.append(shadowHost);
        const host = document.getElementById(${JSON.stringify(HOST)});
        host.addEventListener('load', () => {
          const doc = host.contentDocument;
          doc.body.innerHTML = '';
          const f = doc.createElement('iframe');
          f.id = ${JSON.stringify(FRAME)};
          ${STYLES.nested};
          f.addEventListener('load', () => resolve(true), { once: true });
          setTimeout(() => resolve(false), 5000);
          f.src = ${JSON.stringify(src)};
          doc.body.append(f);
        }, { once: true });
        host.src = 'about:blank';
      })`
    );
  }
  return observe(
    reader,
    observer,
    `new Promise((resolve) => {
      document.body.innerHTML = '<button id="c9-click" style="position:fixed;left:0;top:0;width:100px;height:100px" onclick="document.body.dataset.clicked=\\'yes\\'">C9 click</button><input id="typed" style="position:fixed;left:0;top:120px;width:100px">';
      const f = document.createElement('iframe');
      f.id = ${JSON.stringify(FRAME)};
      ${STYLES[styleMode]};
      const shadowHost = document.createElement('div');
      shadowHost.id = ${JSON.stringify(SHADOW)};
      const root = shadowHost.attachShadow({ mode: 'closed' });
      const shadowFrame = document.createElement('iframe');
      shadowFrame.id = ${JSON.stringify(FRAME)} + '-shadow';
      shadowFrame.hidden = true;
      shadowFrame.src = ${JSON.stringify(src)};
      root.append(shadowFrame);
      f.addEventListener('load', () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 5000);
      f.src = ${JSON.stringify(src)};
      document.body.append(f, shadowHost);
    })`
  );
}

async function paintMarker(reader, frame, focus = false) {
  const privateSession = (
    await reader.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
  ).sessionId;
  try {
    await observe(
      reader,
      privateSession,
      focus
        ? `(() => {
            const i = document.createElement('input');
            i.id = 'slicc-frame-focus';
            i.value = ${JSON.stringify(MARKER)};
            document.body.replaceChildren(i);
            document.body.style.cssText = 'background:#f00;color:#f00;font:48px monospace';
            i.focus();
            return document.activeElement === i;
          })()`
        : `document.body.textContent = ${JSON.stringify(MARKER)}; document.body.style.cssText = 'background:#f00;color:#f00;font:48px monospace'; true`
    );
  } finally {
    await reader.send('Target.detachFromTarget', { sessionId: privateSession });
  }
}

async function holdFocus(reader, frame) {
  const privateSession = (
    await reader.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
  ).sessionId;
  try {
    await observe(
      reader,
      privateSession,
      `(() => {
        let i = document.getElementById('slicc-frame-focus');
        if (!i) {
          i = document.createElement('input');
          i.id = 'slicc-frame-focus';
          i.value = ${JSON.stringify(MARKER)};
          document.body.replaceChildren(i);
        }
        i.focus();
        return document.activeElement === i;
      })()`
    );
  } finally {
    await reader.send('Target.detachFromTarget', { sessionId: privateSession });
  }
}

async function driveInput(client, reader, page, observer, inputList, mode, frame) {
  const visible = await observe(
    reader,
    observer,
    `(() => {
      const f = ${frameLookup};
      if (!f || !f.checkVisibility({ visibilityProperty: true })) return false;
      const r = f.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`
  );
  let frameFocused = false;
  if (mode === 'focused' && frame) {
    await holdFocus(reader, frame);
    frameFocused = await observe(
      reader,
      observer,
      `(() => { const f = ${frameLookup}; if (f) f.focus(); return Boolean(f) && document.activeElement === f; })()`
    );
  }
  const box = await observe(
    reader,
    observer,
    `(() => {
      const f = ${frameLookup};
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`
  );
  const refocus = async () => {
    if (!(mode === 'focused' && frame)) return;
    await holdFocus(reader, frame);
    await observe(
      reader,
      observer,
      `(() => { const f = ${frameLookup}; if (f) f.focus(); return true; })()`
    );
  };
  await refocus();
  const frameClick = await clickAt(
    client,
    reader,
    page,
    observer,
    box && box.w > 0 ? box.x : 99990,
    box && box.h > 0 ? box.y : 10
  );
  await refocus();
  const tab = await outcome(
    client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' }, page)
  );
  await refocus();
  const pressed = await click(client, reader, page, observer);
  await refocus();
  const typed = await key(client, reader, page, observer, refocus, mode !== 'focused');
  await refocus();
  const inputs = await inputMethods(client, page, inputList);
  await refocus();
  const focusedKey = await outcome(
    client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA' }, page)
  );
  await refocus();
  const focusedText = await outcome(client.send('Input.insertText', { text: 'x' }, page));
  await refocus();
  const focusedIME = await outcome(
    client.send('Input.imeSetComposition', { text: 'x', selectionStart: 1, selectionEnd: 1 }, page)
  );
  return {
    frameClick,
    visible,
    frameFocused,
    tab,
    pressed,
    typed,
    inputs,
    focusedKey,
    focusedText,
    focusedIME,
  };
}

async function driveCaptures(client, page, missing) {
  const archive = await outcome(client.send('Page.captureSnapshot', { format: 'mhtml' }, page));
  const pdf = await outcome(client.send('Page.printToPDF', {}, page));
  if (pdf.ok && !(typeof pdf.result.data === 'string' && pdf.result.data.length > 0))
    missing.push('Page.printToPDF returned no PDF data');
  const cast = await outcome(
    client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }, page)
  );
  if (cast.ok) await outcome(client.send('Page.stopScreencast', {}, page));
  const begin = await outcome(
    client.send('HeadlessExperimental.beginFrame', { screenshot: { format: 'png' } }, page)
  );
  return { archive, pdf, cast, begin };
}

async function driveReveal(client, reader, page, observer, frameMs) {
  const flipping = (async () => {
    await pause(20);
    await style(reader, observer, 'shown', Math.min(frameMs, 200));
  })();
  const revealed = await shot(client, page);
  await flipping;
  const revealedPress = await click(client, reader, page, observer);
  await style(reader, observer, 'hidden', frameMs);
  const rehidden = await shot(client, page);
  return {
    revealedShot: revealed.ok,
    revealedRefusal: refusal(revealed.out),
    revealedClick: revealedPress.ok,
    revealedClickRefusal: refusal(revealedPress.out),
    rehiddenShot: rehidden.ok,
  };
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
  inputMethods: inputList = INPUT_METHODS,
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
    await reader.send('DOM.enable', {}, observer);
    await reader.send('Accessibility.enable', {}, observer);
    await embed(reader, observer, mode, frameURL);
    const frame = await frameTarget(reader, targetId, extensionId);
    await paintMarker(reader, frame, mode === 'focused');
    await painted(reader, observer, frameMs);
    const attach = await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }));
    page = attach.ok ? attach.result.sessionId : session;
    pageAttached = attach.ok;
    await outcome(client.send('DOM.enable', {}, page));
    await outcome(client.send('Accessibility.enable', {}, page));
    const read = await outcome(
      client.send('Runtime.evaluate', { expression: 'self.origin', returnByValue: true }, page)
    );
    const leaks = await pageLeaks({ client, page, extensionId, frameURL, missing });
    const picture = await shot(client, page);
    const input = await driveInput(client, reader, page, observer, inputList, mode, frame);
    const captures = await driveCaptures(client, page, missing);
    const result = {
      exists: true,
      attached: attach.ok,
      read: read.ok && read.result.result?.value === origin && !carries(read.result),
      snapshot: leaks.snapshot === true,
      snapshotFrameRead: leaks.snapshotFrameRead,
      frameTreeLeak: leaks.frameTreeLeak,
      documentLeak: leaks.documentLeak,
      shadowDocumentLeak: leaks.shadowDocumentLeak,
      axLeak: leaks.axLeak,
      evaluateLeak: leaks.evaluateLeak,
      shot: picture.ok,
      shotRefusal: refusal(picture.out),
      click: input.pressed.ok,
      clickRefusal: refusal(input.pressed.out),
      key: input.typed.ok,
      keyRefusal: refusal(input.typed.out),
      frameClick: input.frameClick.ok,
      frameClickRefusal: refusal(input.frameClick.out),
      tab: input.tab.ok,
      tabRefusal: refusal(input.tab),
      frameVisible: input.visible === true,
      frameFocused: input.frameFocused === true,
      focusedKey: input.focusedKey.ok,
      focusedKeyRefusal: refusal(input.focusedKey),
      focusedText: input.focusedText.ok,
      focusedTextRefusal: refusal(input.focusedText),
      focusedIME: input.focusedIME.ok,
      focusedIMERefusal: refusal(input.focusedIME),
      archive: captures.archive.ok,
      archiveRefusal: presentish(captures.archive),
      pdf: captures.pdf.ok,
      pdfRefusal: presentish(captures.pdf),
      cast: captures.cast.ok,
      castRefusal: presentish(captures.cast),
      beginFrame: captures.begin.ok,
      beginFrameRefusal: presentish(captures.begin),
      inputs: input.inputs,
    };
    if (mode === 'revealed')
      Object.assign(result, await driveReveal(client, reader, page, observer, frameMs));
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
    result.alive = alive.ok && alive.result.result?.value === origin && !carries(alive.result);
    return missing.length ? { ...result, incomplete: missing.join('; ') } : result;
  } finally {
    if (pageAttached) await outcome(client.send('Target.detachFromTarget', { sessionId: page }));
    if (discovery.ok) await outcome(client.send('Target.setDiscoverTargets', { discover: false }));
    await outcome(reader.send('Target.detachFromTarget', { sessionId: observer }));
  }
}
