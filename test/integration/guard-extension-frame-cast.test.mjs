import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionFrame } from '../../extension-frame.mjs';
import { DEFAULT_EXTENSION_WORLD_ID } from '../../extension-world.mjs';

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

function castTransport({
  emitBeforeInsert = false,
  emitAfterInsert = false,
  emitDuringTargets = false,
  emitLateAfterInsert = false,
  emitStop = false,
  embedLoads = true,
} = {}) {
  const sessions = new Map();
  let next = 0;
  let castSession;
  let frameSeq = 0;
  let inserted = false;
  let lateArmed = false;
  const attach = (targetId) => {
    const sessionId = `S${++next}`;
    sessions.set(sessionId, targetId);
    return { sessionId };
  };
  const pushFrame = (sessionId) => {
    frameSeq += 1;
    client.events.push({
      method: 'Page.screencastFrame',
      params: { data: 'frame', sessionId: frameSeq },
      sessionId,
    });
  };
  const pushStop = (sessionId) => {
    client.events.push({
      method: 'Page.screencastVisibilityChanged',
      params: { visible: false },
      sessionId,
    });
  };
  const evaluate = (expression) => {
    if (expression.includes('sliccCastTick') || expression.includes('--slicc-cast-tick')) {
      if (!inserted && emitBeforeInsert && castSession != null) pushFrame(castSession);
      if (inserted && emitAfterInsert && castSession != null) pushFrame(castSession);
      if (inserted && emitLateAfterInsert && castSession != null) {
        if (lateArmed) pushFrame(castSession);
        else lateArmed = true;
      }
      if (inserted && emitStop && castSession != null) pushStop(castSession);
      return { result: { type: 'number', value: 1 } };
    }
    if (expression.includes('new Promise') && expression.includes('createElement')) {
      if (emitBeforeInsert && castSession != null) pushFrame(castSession);
      inserted = true;
      return { result: { type: 'boolean', value: embedLoads } };
    }
    if (expression.includes('slicc-private-extension-frame-content')) {
      if (emitAfterInsert && castSession != null) pushFrame(castSession);
      if (emitStop && castSession != null) pushStop(castSession);
      return { result: { type: 'boolean', value: true } };
    }
    if (expression === 'self.origin') return { result: { type: 'string', value: origin } };
    if (expression.includes('checkVisibility')) return { result: { type: 'boolean', value: true } };
    if (expression.includes('getBoundingClientRect'))
      return {
        result: {
          type: 'object',
          value: { x: 0, y: 0, w: 300, h: 200 },
        },
      };
    if (expression.includes('dataset.clicked')) return { result: { type: 'boolean', value: true } };
    if (expression.includes('getElementById("typed")'))
      return { result: { type: 'boolean', value: true } };
    if (/[^a-z]f\.src\b/.test(expression) || expression.includes('f.src ='))
      return { result: { type: 'string', value: '' } };
    if (expression.includes('performance.now()')) return { result: { type: 'number', value: 1 } };
    return { result: { type: 'boolean', value: true } };
  };
  const send = async (method, params = {}, sessionId) => {
    if (method === 'Target.attachToTarget') return attach(params.targetId);
    if (method === 'Target.detachFromTarget') {
      sessions.delete(params.sessionId);
      return {};
    }
    if (method === 'Target.getTargets') {
      if (emitDuringTargets && castSession != null) pushFrame(castSession);
      if (inserted && emitStop && castSession != null) pushStop(castSession);
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
    }
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
    if (method === 'Page.startScreencast') {
      castSession = sessionId;
      if (emitBeforeInsert) pushFrame(sessionId);
      return {};
    }
    if (method === 'Page.screencastFrameAck') return {};
    if (method === 'Page.stopScreencast') return {};
    if (method === 'HeadlessExperimental.beginFrame') return {};
    if (method.startsWith('Input.')) return {};
    return {};
  };
  const client = { events: [], send };
  return { client, reader: client };
}

async function probe(transport, side = 'guarded', frameMs = 0) {
  return extensionFrame({
    client: transport.client,
    reader: transport.reader,
    session: 'PAGE-SESSION',
    targetId: pageId,
    mode: 'cast',
    origin,
    extensionId,
    frameMs,
    inputMethods: [],
    side,
    capabilities,
  });
}

test('a compliant cast that stops after insertion passes', async () => {
  const transport = castTransport({
    emitBeforeInsert: true,
    emitAfterInsert: false,
    emitStop: true,
  });
  const result = await probe(transport);
  assert.equal(result.castBefore, true, JSON.stringify(result));
  assert.equal(result.castLeak, false, JSON.stringify(result));
  assert.equal(result.castStopped, true, JSON.stringify(result));
  assert.equal(result.incomplete, undefined, JSON.stringify(result));
});

test('a mutant cast that emits after insertion still leaks', async () => {
  const transport = castTransport({ emitBeforeInsert: true, emitAfterInsert: true });
  const result = await probe(transport);
  assert.equal(result.castBefore, true, JSON.stringify(result));
  assert.equal(result.castLeak, true, JSON.stringify(result));
  assert.equal(result.incomplete, undefined, JSON.stringify(result));
});

test('a mutant cast that emits during target discovery still leaks', async () => {
  const transport = castTransport({ emitBeforeInsert: true, emitDuringTargets: true });
  const result = await probe(transport);
  assert.equal(result.castBefore, true, JSON.stringify(result));
  assert.equal(result.castLeak, true, JSON.stringify(result));
  assert.equal(result.incomplete, undefined, JSON.stringify(result));
});

test('a late post-insertion frame still leaks and never passes', async () => {
  const transport = castTransport({
    emitBeforeInsert: true,
    emitLateAfterInsert: true,
  });
  const result = await probe(transport, 'guarded', 50);
  assert.equal(result.castBefore, true, JSON.stringify(result));
  assert.equal(result.castLeak, true, JSON.stringify(result));
  assert.equal(result.incomplete, undefined, JSON.stringify(result));
});

test('a stalled cast with no stop signal is incomplete', async () => {
  const transport = castTransport({ emitBeforeInsert: true, emitAfterInsert: false });
  const result = await probe(transport);
  assert.equal(result.castBefore, true, JSON.stringify(result));
  assert.equal(result.castLeak, undefined, JSON.stringify(result));
  assert.equal(result.castStopped, undefined, JSON.stringify(result));
  assert.match(
    result.incomplete ?? '',
    /cast stalled: no frame after insertion and no stop signal/
  );
});

test('control without post-insertion frames is incomplete', async () => {
  const transport = castTransport({
    emitBeforeInsert: true,
    emitAfterInsert: false,
    emitStop: true,
  });
  const result = await probe(transport, 'control');
  assert.equal(result.castBefore, true, JSON.stringify(result));
  assert.match(
    result.incomplete ?? '',
    /control screencast produced no frames after the extension frame appeared/
  );
});

test('control proves frames before and after insertion', async () => {
  const transport = castTransport({ emitBeforeInsert: true, emitAfterInsert: true });
  const result = await probe(transport, 'control');
  assert.equal(result.castBefore, true, JSON.stringify(result));
  assert.ok(result.castFramesBefore > 0, JSON.stringify(result));
  assert.equal(result.castLeak, true, JSON.stringify(result));
  assert.equal(result.incomplete, undefined, JSON.stringify(result));
});

test('a missing insertion confirmation is incomplete', async () => {
  const transport = castTransport({ embedLoads: false, emitBeforeInsert: true });
  const result = await probe(transport);
  assert.equal(result.castBefore, true, JSON.stringify(result));
  assert.equal(result.castLeak, false, JSON.stringify(result));
  assert.match(result.incomplete ?? '', /insertion was not confirmed/);
});

test('a pre-insertion frame alone does not count as a leak when the cast stops', async () => {
  const transport = castTransport({
    emitBeforeInsert: true,
    emitAfterInsert: false,
    emitStop: true,
  });
  const result = await probe(transport);
  assert.equal(result.castLeak, false, JSON.stringify(result));
  assert.equal(result.castStopped, true, JSON.stringify(result));
  assert.equal(result.incomplete, undefined, JSON.stringify(result));
});
