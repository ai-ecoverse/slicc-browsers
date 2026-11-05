import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extensionFrame } from '../../extension-frame.mjs';
import { shownRefusal } from '../../extension-frames-rules.mjs';
import { DEFAULT_EXTENSION_WORLD_ID } from '../../extension-world.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const origin = 'http://ordinary.example.test';
const extensionId = DEFAULT_EXTENSION_WORLD_ID;
const frameURL = `chrome-extension://${extensionId}/frame.html?username=slicc-frame-test-user`;
const pageId = 'PAGE';
const frameId = 'FRAME';
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  chromeUrlsAttach: true,
  discovery: true,
  extensionFrame: true,
};

function mouseTransport({
  leaveDownAfterClicks = 0,
  failPressAfter = Infinity,
  refuseShown = false,
  refuseReleaseAfterPresses = Infinity,
  refuseEndAfterStarts = Infinity,
  refuseCancelAfterEnters = Infinity,
} = {}) {
  const sessions = new Map();
  const mouse = {
    down: false,
    releases: 0,
    presses: 0,
    starts: 0,
    ends: 0,
    enters: 0,
    cancels: 0,
    sent: [],
  };
  let next = 0;
  const attach = (targetId) => {
    const sessionId = `S${++next}`;
    sessions.set(sessionId, targetId);
    return { sessionId };
  };
  const evaluate = (expression) => {
    if (expression === 'self.origin') return { result: { type: 'string', value: origin } };
    if (expression.includes('checkVisibility')) return { result: { type: 'boolean', value: true } };
    if (expression.includes('getBoundingClientRect'))
      return {
        result: {
          type: 'object',
          value: { x: -999849, y: 100, w: 300, h: 200 },
        },
      };
    if (expression.includes('dataset.clicked')) return { result: { type: 'boolean', value: true } };
    if (expression.includes('getElementById("typed")'))
      return { result: { type: 'boolean', value: true } };
    if (expression.includes('f.src')) return { result: { type: 'string', value: '' } };
    if (expression.includes('performance.now()')) return { result: { type: 'number', value: 1 } };
    return { result: { type: 'boolean', value: true } };
  };
  const send = async (method, params = {}) => {
    if (method === 'Target.attachToTarget') return attach(params.targetId);
    if (method === 'Target.detachFromTarget') {
      sessions.delete(params.sessionId);
      return {};
    }
    if (method === 'Target.getTargets')
      return {
        targetInfos: [
          { targetId: pageId, type: 'page', url: `${origin}/`, browserContextId: 'B1' },
          {
            targetId: frameId,
            type: 'iframe',
            url: frameURL,
            parentId: pageId,
            browserContextId: 'B1',
          },
          {
            targetId: 'SHADOW',
            type: 'iframe',
            url: `chrome-extension://${extensionId}/shadow.html`,
            parentId: pageId,
            browserContextId: 'B1',
          },
        ],
      };
    if (method === 'Target.getTargetInfo')
      return {
        targetInfo: {
          targetId: params.targetId,
          type: params.targetId === pageId ? 'page' : 'iframe',
          url: params.targetId === pageId ? `${origin}/` : frameURL,
          parentId: params.targetId === pageId ? undefined : pageId,
        },
      };
    if (method === 'Target.setDiscoverTargets') return {};
    if (method === 'Target.setAutoAttach') return {};
    if (method === 'Runtime.evaluate') return evaluate(params.expression ?? '');
    if (method === 'Runtime.enable') return {};
    if (method === 'DOM.enable') return {};
    if (method === 'Accessibility.enable') return {};
    if (method === 'Page.bringToFront') return {};
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: pageId, url: `${origin}/` }, childFrames: [] } };
    if (method === 'DOM.getDocument') return { root: { backendNodeId: 1, children: [] } };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 2 };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 2 } };
    if (method === 'DOM.getOuterHTML') return { outerHTML: '<iframe></iframe>' };
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
    if (method === 'Accessibility.getPartialAXTree') return { nodes: [] };
    if (method === 'DOMSnapshot.captureSnapshot')
      return { documents: [{ nodes: {} }], strings: [] };
    if (method === 'Page.captureScreenshot') return { data: 'abc' };
    if (method === 'Page.captureSnapshot') return { data: 'mhtml' };
    if (method === 'Page.printToPDF') return { data: 'pdf' };
    if (method === 'Page.startScreencast') return {};
    if (method === 'Page.stopScreencast') return {};
    if (method === 'HeadlessExperimental.beginFrame') return {};
    if (method.startsWith('Input.')) {
      if (refuseShown) throw new Error(shownRefusal);
      mouse.sent.push({ method, params });
      if (method === 'Input.dispatchMouseEvent' || method === 'Input.emulateTouchFromMouseEvent') {
        if (params.type === 'mousePressed') {
          mouse.presses += 1;
          if (mouse.down) throw new Error('Input.dispatchMouseEvent timed out');
          if (mouse.presses > failPressAfter) throw new Error('Input.dispatchMouseEvent timed out');
          mouse.down = true;
          return {};
        }
        if (params.type === 'mouseReleased') {
          mouse.releases += 1;
          if (mouse.presses >= refuseReleaseAfterPresses) throw new Error(shownRefusal);
          if (!(leaveDownAfterClicks > 0 && mouse.releases === leaveDownAfterClicks))
            mouse.down = false;
          return {};
        }
      }
      if (method === 'Input.dispatchTouchEvent') {
        if (params.type === 'touchStart') {
          mouse.starts += 1;
          return {};
        }
        if (params.type === 'touchEnd') {
          mouse.ends += 1;
          if (mouse.starts >= refuseEndAfterStarts) throw new Error(shownRefusal);
          return {};
        }
      }
      if (method === 'Input.dispatchDragEvent') {
        if (params.type === 'dragEnter') {
          mouse.enters += 1;
          return {};
        }
        if (params.type === 'dragCancel') {
          mouse.cancels += 1;
          if (mouse.enters >= refuseCancelAfterEnters) throw new Error(shownRefusal);
          return {};
        }
      }
      return {};
    }
    return {};
  };
  const client = { events: [], send };
  return { client, mouse, reader: client };
}

async function probe(mode, transport, side = 'control', methods = ['Input.dispatchMouseEvent']) {
  return extensionFrame({
    client: transport.client,
    reader: transport.reader,
    session: 'PAGE-SESSION',
    targetId: pageId,
    mode,
    origin,
    extensionId,
    frameMs: 0,
    inputMethods: methods,
    side,
    capabilities,
  });
}

test('per-method mouse probe sends press and release away from the shown frame box', async () => {
  const transport = mouseTransport();
  const result = await probe('offscreen', transport);
  assert.equal(result.inputs.dispatchMouseEvent.ok, true, JSON.stringify(result.inputs));
  assert.equal(result.incomplete, undefined, JSON.stringify(result));
  const mouseCalls = transport.mouse.sent.filter(
    (call) => call.method === 'Input.dispatchMouseEvent'
  );
  const probeCalls = mouseCalls.slice(-2);
  assert.deepEqual(
    probeCalls.map((call) => call.params.type),
    ['mousePressed', 'mouseReleased']
  );
  for (const call of probeCalls) {
    assert.equal(call.params.x, 20);
    assert.equal(call.params.y, 20);
  }
  assert.equal(transport.mouse.down, false);
});

test('a raw transport that times out the mouse press is incomplete, never false', async () => {
  const transport = mouseTransport({ failPressAfter: 2 });
  const result = await probe('offscreen', transport);
  assert.equal(result.inputs.dispatchMouseEvent.ok, 'incomplete', JSON.stringify(result.inputs));
  assert.notEqual(result.inputs.dispatchMouseEvent.ok, false);
  assert.notEqual(result.inputs.dispatchMouseEvent.ok, true);
  assert.match(result.incomplete ?? '', /dispatchMouseEvent/);
});

test('a raw transport that rejects a press while the button is down is incomplete, never a control-style false', async () => {
  const transport = mouseTransport({ leaveDownAfterClicks: 2 });
  const result = await probe('transparent', transport);
  assert.equal(result.inputs.dispatchMouseEvent.ok, 'incomplete', JSON.stringify(result.inputs));
  assert.match(result.incomplete ?? '', /dispatchMouseEvent/);
});

test('a guard that lets dispatchMouseEvent through on a shown row still reports delivery', async () => {
  const vector = set.vectors.find((item) => item.id === 'C9.frame-offscreen');
  assert.equal(vector.expected.dispatchMouseEvent, false);
  assert.equal(vector.expected.dispatchMouseEventRefusal, true);
  const transport = mouseTransport();
  const result = await probe('offscreen', transport, 'guarded');
  assert.equal(result.inputs.dispatchMouseEvent.ok, true, JSON.stringify(result.inputs));
  assert.equal(result.inputs.dispatchMouseEvent.refusal, null);
  assert.equal(result.incomplete, undefined);
});

test('catalog shownRefusal still refuses Input.dispatchMouseEvent on shown frames', async () => {
  const transport = mouseTransport({ refuseShown: true });
  const result = await probe('offscreen', transport, 'guarded');
  assert.equal(result.inputs.dispatchMouseEvent.ok, false);
  assert.equal(result.inputs.dispatchMouseEvent.refusal, shownRefusal);
  assert.equal(result.incomplete, undefined);
});

test('a refused mouseReleased after a delivered mousePressed still counts as delivery on shown rows', async () => {
  const vector = set.vectors.find((item) => item.id === 'C9.frame-offscreen');
  assert.equal(vector.expected.dispatchMouseEvent, false);
  assert.equal(vector.expected.dispatchMouseEventRefusal, true);
  const transport = mouseTransport({ refuseReleaseAfterPresses: 3 });
  const result = await probe('offscreen', transport, 'guarded');
  assert.equal(result.inputs.dispatchMouseEvent.ok, true, JSON.stringify(result.inputs));
  assert.equal(result.inputs.dispatchMouseEvent.refusal, null);
  assert.equal(result.incomplete, undefined);
});

test('a refused touchEnd after a delivered touchStart still counts as delivery on shown rows', async () => {
  const vector = set.vectors.find((item) => item.id === 'C9.frame-offscreen');
  assert.equal(vector.expected.dispatchTouchEvent, false);
  assert.equal(vector.expected.dispatchTouchEventRefusal, true);
  const transport = mouseTransport({ refuseEndAfterStarts: 1 });
  const result = await probe('offscreen', transport, 'guarded', ['Input.dispatchTouchEvent']);
  assert.equal(result.inputs.dispatchTouchEvent.ok, true, JSON.stringify(result.inputs));
  assert.equal(result.inputs.dispatchTouchEvent.refusal, null);
  assert.equal(result.incomplete, undefined);
});

test('a refused dragCancel after a delivered dragEnter still counts as delivery on shown rows', async () => {
  const vector = set.vectors.find((item) => item.id === 'C9.frame-offscreen');
  assert.equal(vector.expected.dispatchDragEvent, false);
  assert.equal(vector.expected.dispatchDragEventRefusal, true);
  const transport = mouseTransport({ refuseCancelAfterEnters: 1 });
  const result = await probe('offscreen', transport, 'guarded', ['Input.dispatchDragEvent']);
  assert.equal(result.inputs.dispatchDragEvent.ok, true, JSON.stringify(result.inputs));
  assert.equal(result.inputs.dispatchDragEvent.refusal, null);
  assert.equal(result.incomplete, undefined);
});

test('a control records cleanup failure when release is refused after a delivered press', async () => {
  const transport = mouseTransport({ refuseReleaseAfterPresses: 3 });
  const result = await probe('offscreen', transport, 'control');
  assert.equal(result.inputs.dispatchMouseEvent.ok, true, JSON.stringify(result.inputs));
  assert.equal(result.inputs.dispatchMouseEvent.refusal, null);
  assert.match(result.incomplete ?? '', /dispatchMouseEvent: cleanup/);
});

function focusAwareTransport({ refuseShown = false } = {}) {
  const sessions = new Map();
  const mouse = { down: false, presses: 0, releases: 0, sent: [], focusChecks: [] };
  let next = 0;
  let documentFocused = true;
  let typedFocused = false;
  const attach = (targetId) => {
    const sessionId = `S${++next}`;
    sessions.set(sessionId, targetId);
    return { sessionId };
  };
  const evaluate = (expression) => {
    if (expression.includes('window.focus()') && expression.includes('getElementById("typed")')) {
      documentFocused = true;
      typedFocused = true;
      return { result: { type: 'boolean', value: true } };
    }
    if (expression.includes('getElementById("typed")') && expression.includes('.focus()')) {
      documentFocused = true;
      typedFocused = true;
      return { result: { type: 'boolean', value: true } };
    }
    if (expression.includes('document.hasFocus()')) {
      const frames = documentFocused ? 2 : 0;
      mouse.focusChecks.push({ focused: documentFocused, frames });
      return {
        result: {
          type: 'object',
          value: { visible: true, focused: documentFocused, frames },
        },
      };
    }
    if (expression === 'self.origin') return { result: { type: 'string', value: origin } };
    if (expression.includes('checkVisibility')) return { result: { type: 'boolean', value: true } };
    if (expression.includes('getBoundingClientRect'))
      return {
        result: {
          type: 'object',
          value: { x: -999849, y: 100, w: 300, h: 200 },
        },
      };
    if (expression.includes('dataset.clicked')) return { result: { type: 'boolean', value: true } };
    if (expression.includes('getElementById("typed")'))
      return { result: { type: 'boolean', value: true } };
    if (expression.includes('f.src')) return { result: { type: 'string', value: '' } };
    if (expression.includes('performance.now()')) return { result: { type: 'number', value: 1 } };
    return { result: { type: 'boolean', value: true } };
  };
  const rawSend = async (method, params = {}) => {
    if (method === 'Target.attachToTarget') return attach(params.targetId);
    if (method === 'Target.detachFromTarget') {
      sessions.delete(params.sessionId);
      return {};
    }
    if (method === 'Target.getTargets')
      return {
        targetInfos: [
          { targetId: pageId, type: 'page', url: `${origin}/`, browserContextId: 'B1' },
          {
            targetId: frameId,
            type: 'iframe',
            url: frameURL,
            parentId: pageId,
            browserContextId: 'B1',
          },
          {
            targetId: 'SHADOW',
            type: 'iframe',
            url: `chrome-extension://${extensionId}/shadow.html`,
            parentId: pageId,
            browserContextId: 'B1',
          },
        ],
      };
    if (method === 'Target.getTargetInfo')
      return {
        targetInfo: {
          targetId: params.targetId,
          type: params.targetId === pageId ? 'page' : 'iframe',
          url: params.targetId === pageId ? `${origin}/` : frameURL,
          parentId: params.targetId === pageId ? undefined : pageId,
        },
      };
    if (method === 'Target.setDiscoverTargets') return {};
    if (method === 'Target.setAutoAttach') return {};
    if (method === 'Runtime.evaluate') return evaluate(params.expression ?? '');
    if (method === 'Runtime.enable') return {};
    if (method === 'DOM.enable') return {};
    if (method === 'Accessibility.enable') return {};
    if (method === 'Page.bringToFront') return {};
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: pageId, url: `${origin}/` }, childFrames: [] } };
    if (method === 'DOM.getDocument') return { root: { backendNodeId: 1, children: [] } };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 2 };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 2 } };
    if (method === 'DOM.getOuterHTML') return { outerHTML: '<iframe></iframe>' };
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
    if (method === 'Accessibility.getPartialAXTree') return { nodes: [] };
    if (method === 'DOMSnapshot.captureSnapshot')
      return { documents: [{ nodes: {} }], strings: [] };
    if (method === 'Page.captureScreenshot') return { data: 'abc' };
    if (method === 'Page.captureSnapshot') return { data: 'mhtml' };
    if (method === 'Page.printToPDF') return { data: 'pdf' };
    if (method === 'Page.startScreencast') return {};
    if (method === 'Page.stopScreencast') return {};
    if (method === 'HeadlessExperimental.beginFrame') return {};
    if (method.startsWith('Input.')) {
      if (refuseShown) throw new Error(shownRefusal);
      mouse.sent.push({ method, params });
      if (method === 'Input.dispatchKeyEvent' && params.key === 'Tab' && typedFocused) {
        documentFocused = false;
        typedFocused = false;
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mousePressed') {
          mouse.presses += 1;
          mouse.down = true;
          return {};
        }
        if (params.type === 'mouseReleased') {
          mouse.releases += 1;
          mouse.down = false;
          return {};
        }
      }
      return {};
    }
    return {};
  };
  let castSession;
  const client = { events: [], send: null };
  const send = async (method, params = {}, sessionId) => {
    if (method === 'Page.startScreencast') {
      castSession = sessionId;
      return rawSend(method, params, sessionId);
    }
    if (castSession != null && method === 'Runtime.evaluate' && client.events.length === 0) {
      client.events.push({
        method: 'Page.screencastFrame',
        params: { data: 'frame', sessionId: castSession },
        sessionId: castSession,
      });
    }
    if (method === 'Input.dispatchMouseEvent' && params.type !== 'mouseReleased') {
      await rawSend('Page.bringToFront', {}, sessionId);
      const renderReply = await rawSend(
        'Runtime.evaluate',
        {
          expression:
            '({ visible: document.visibilityState === "visible", focused: document.hasFocus(), frames: document.hasFocus() ? 2 : 0 })',
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId
      );
      const ready = renderReply.result?.value;
      if (!ready?.visible || !ready?.focused || ready.frames < 2) {
        throw new Error(
          `mouse target did not reach two focused visible frames: ${JSON.stringify(renderReply)}`
        );
      }
    }
    return rawSend(method, params, sessionId);
  };
  client.send = send;
  return { client, mouse, reader: client, state: () => ({ documentFocused, typedFocused }) };
}

const tabThenMouse = ['Input.dispatchKeyEvent', 'Input.dispatchMouseEvent'];

for (const mode of ['offscreen', 'cast']) {
  test(`control completes the per-method mouse probe when Tab would steal focus (${mode})`, async () => {
    const transport = focusAwareTransport();
    const result = await probe(mode, transport, 'control', tabThenMouse);
    assert.equal(result.inputs.dispatchMouseEvent.ok, true, JSON.stringify(result.inputs));
    assert.equal(result.inputs.dispatchKeyEvent.ok, true, JSON.stringify(result.inputs));
    assert.equal(result.incomplete, undefined, JSON.stringify(result));
    assert.ok(transport.mouse.focusChecks.some((check) => check.focused === true));
  });
}

test('a guard that lets the press through on a shown row still reports delivery under the focus gate', async () => {
  const vector = set.vectors.find((item) => item.id === 'C9.frame-shown');
  assert.equal(vector.expected.dispatchMouseEvent, false);
  const transport = focusAwareTransport();
  const result = await probe('shown', transport, 'guarded', tabThenMouse);
  assert.equal(result.inputs.dispatchMouseEvent.ok, true, JSON.stringify(result.inputs));
  assert.equal(result.inputs.dispatchMouseEvent.refusal, null);
  assert.equal(result.incomplete, undefined);
});

test('catalog shownRefusal still refuses mouse under the focus gate', async () => {
  const transport = focusAwareTransport({ refuseShown: true });
  const result = await probe('offscreen', transport, 'guarded', tabThenMouse);
  assert.equal(result.inputs.dispatchMouseEvent.ok, false);
  assert.equal(result.inputs.dispatchMouseEvent.refusal, shownRefusal);
});
