import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as real from '../../extension-frame.mjs';
import { DEFAULT_EXTENSION_WORLD_ID } from '../../extension-world.mjs';

const origin = 'http://ordinary.example.test';
const extensionId = DEFAULT_EXTENSION_WORLD_ID;
const frameURL = `chrome-extension://${extensionId}/frame.html?username=slicc-frame-test-user`;
const pageId = 'PAGE';
const capabilities = { autoAttach: true, discovery: true, extensionFrame: true };
const REFUSED = 'slicc: refused: protected target';
const DROPPED = 'Target.attachToTarget dropped';
const SILENT =
  /autoAttached: the control auto-attached the frame; the guarded leg saw neither an attach event nor a refusal after \d+ms \(budget \d+ms\)/;
const frames = [
  { targetId: 'FRAME', type: 'iframe', url: frameURL, parentId: pageId, browserContextId: 'B1' },
  {
    targetId: 'SHADOW',
    type: 'iframe',
    url: `chrome-extension://${extensionId}/shadow.html`,
    parentId: pageId,
    browserContextId: 'B1',
  },
];

function evaluate(expression) {
  if (expression === 'self.origin') return { result: { type: 'string', value: origin } };
  if (expression.includes('new Promise') && expression.includes('createElement'))
    return { result: { type: 'boolean', value: true } };
  if (expression.includes('getBoundingClientRect') && !expression.includes('checkVisibility'))
    return { result: { type: 'object', value: { x: 650, y: 500, w: 300, h: 200 } } };
  if (expression.includes('f.src')) return { result: { type: 'string', value: '' } };
  if (expression.includes('performance.now()')) return { result: { type: 'number', value: 1 } };
  return { result: { type: 'boolean', value: true } };
}

function answer(method, params) {
  if (method === 'Target.getTargets')
    return {
      targetInfos: [
        { targetId: pageId, type: 'page', url: `${origin}/`, browserContextId: 'B1' },
        ...frames,
      ],
    };
  if (method === 'Runtime.evaluate') return evaluate(params.expression ?? '');
  if (method === 'Page.getFrameTree')
    return { frameTree: { frame: { id: pageId, url: `${origin}/` }, childFrames: [] } };
  if (method === 'DOM.getDocument') return { root: { backendNodeId: 1, children: [] } };
  if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
  if (method === 'DOMSnapshot.captureSnapshot') return { documents: [{ nodes: {} }], strings: [] };
  if (method === 'Page.captureScreenshot') return { data: 'abc' };
  if (method === 'Page.captureSnapshot') return { data: 'mhtml' };
  if (method === 'Page.printToPDF') return { data: 'pdf' };
  return {};
}

function transport({ attachAfterMs, frameAttach, refuseAutoAttach = false } = {}) {
  let next = 0;
  const sent = [];
  const reader = {
    events: [],
    async send(method, params = {}) {
      if (method === 'Target.attachToTarget') return { sessionId: `R${++next}` };
      return answer(method, params);
    },
  };
  const client = {
    events: [],
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId, at: Date.now() });
      if (method === 'Target.attachToTarget') {
        if (params.targetId !== pageId && frameAttach) throw new Error(frameAttach);
        return { sessionId: `C${++next}` };
      }
      if (method === 'Target.setAutoAttach' && params.autoAttach) {
        if (refuseAutoAttach) throw new Error('slicc: refused: auto-attach in this tab');
        if (attachAfterMs !== undefined)
          setTimeout(() => {
            for (const targetInfo of frames)
              client.events.push({
                method: 'Target.attachedToTarget',
                sessionId,
                params: { sessionId: `A${++next}`, targetInfo, waitingForDebugger: false },
              });
          }, attachAfterMs);
      }
      return answer(method, params);
    },
  };
  return { client, reader, sent };
}

function probe(mod, fake, { side = 'guarded', frameMs = 0, attachControls, notes } = {}) {
  return mod.extensionFrame({
    client: fake.client,
    reader: fake.reader,
    session: 'PAGE-SESSION',
    targetId: pageId,
    mode: 'hidden',
    origin,
    extensionId,
    frameMs,
    inputMethods: [],
    side,
    capabilities,
    notes,
    attachControls,
  });
}

const waitedOf = (notes) => {
  const line = notes.find((note) => note.startsWith('target events after '));
  assert.ok(line, JSON.stringify(notes));
  return { line, waited: Number(/after (\d+)ms/.exec(line)[1]) };
};

async function controlWaitsForTheEvent(mod) {
  const notes = [];
  const attachControls = {};
  const fake = transport({ attachAfterMs: 60 });
  const result = await probe(mod, fake, { side: 'control', frameMs: 3000, attachControls, notes });
  assert.equal(result.autoAttached, true, JSON.stringify(result));
  assert.equal(result.eventURL, true, JSON.stringify(result));
  assert.equal(attachControls.autoAttached, true);
  const { line, waited } = waitedOf(notes);
  assert.match(line, /\(budget 3000ms\): autoAttached 2 of 2 frames, eventURL seen$/);
  assert.ok(waited >= 40 && waited < 3000, line);
}

async function lateGuardedAttachLeaks(mod) {
  const notes = [];
  const fake = transport({ attachAfterMs: 150, frameAttach: REFUSED });
  const result = await probe(mod, fake, {
    frameMs: 2000,
    attachControls: { autoAttached: true },
    notes,
  });
  assert.equal(result.autoAttached, true, JSON.stringify(result));
  assert.equal(result.frameAttach, false, JSON.stringify(result));
  assert.doesNotMatch(result.incomplete ?? '', /autoAttached:/);
  assert.match(waitedOf(notes).line, /autoAttached 2 of 2 frames/);
}

async function silentGuardedLegIsIncomplete(mod) {
  const attachControls = {};
  const control = await probe(mod, transport({ attachAfterMs: 10 }), {
    side: 'control',
    frameMs: 1000,
    attachControls,
  });
  assert.equal(control.autoAttached, true, JSON.stringify(control));
  const notes = [];
  const guarded = await probe(mod, transport({ frameAttach: DROPPED }), {
    frameMs: 100,
    attachControls,
    notes,
  });
  assert.equal(guarded.autoAttached, false, JSON.stringify(guarded));
  assert.match(guarded.incomplete ?? '', SILENT);
  const { line, waited } = waitedOf(notes);
  assert.match(line, /\(budget 100ms\): autoAttached 0 of 2 frames, eventURL not seen$/);
  assert.ok(waited >= 100, line);
}

async function refusedAttachIsNoLeak(mod) {
  const notes = [];
  const fake = transport({ frameAttach: REFUSED });
  const result = await probe(mod, fake, {
    frameMs: 100,
    attachControls: { autoAttached: true },
    notes,
  });
  assert.equal(result.autoAttached, false, JSON.stringify(result));
  assert.equal(result.eventURL, false, JSON.stringify(result));
  assert.doesNotMatch(result.incomplete ?? '', /autoAttached:/);
  const { line, waited } = waitedOf(notes);
  assert.match(line, /\(budget 100ms\): autoAttached 0 of 2 frames, eventURL not seen$/);
  assert.ok(waited >= 100, line);
}

test('the control auto-attach read waits for the attach event and ends when it lands', () =>
  controlWaitsForTheEvent(real));

test('a guarded attach that lands late inside the budget is a leak', () =>
  lateGuardedAttachLeaks(real));

test('a silent guarded leg after a control auto-attach is incomplete, never a pass', () =>
  silentGuardedLegIsIncomplete(real));

test('a guard that refuses the frame attach and hides the auto-attach is no leak', () =>
  refusedAttachIsNoLeak(real));

test('a refused setAutoAttach counts as a refusal on the guarded leg', async () => {
  const fake = transport({ refuseAutoAttach: true, frameAttach: DROPPED });
  const result = await probe(real, fake, {
    frameMs: 50,
    attachControls: { autoAttached: true },
  });
  assert.equal(result.autoAttached, false, JSON.stringify(result));
  assert.doesNotMatch(result.incomplete ?? '', /autoAttached:/);
});

for (const attachControls of [undefined, {}, { autoAttached: false }])
  test(`a silent guarded leg without a control auto-attach keeps its observation (${JSON.stringify(attachControls)})`, async () => {
    const fake = transport({ frameAttach: DROPPED });
    const result = await probe(real, fake, { frameMs: 20, attachControls });
    assert.equal(result.autoAttached, false, JSON.stringify(result));
    assert.doesNotMatch(result.incomplete ?? '', /autoAttached:/);
  });

test('a control leg that sees no attach records it for the guarded leg', async () => {
  const attachControls = { autoAttached: true };
  const result = await probe(real, transport(), { side: 'control', frameMs: 20, attachControls });
  assert.equal(result.autoAttached, false, JSON.stringify(result));
  assert.equal(attachControls.autoAttached, false);
  assert.doesNotMatch(result.incomplete ?? '', /autoAttached:/);
});

test('without autoAttach the event read waits only for discovery and sends no setAutoAttach', async () => {
  const notes = [];
  const fake = transport({ attachAfterMs: 0 });
  const result = await real.extensionFrame({
    client: fake.client,
    reader: fake.reader,
    session: 'PAGE-SESSION',
    targetId: pageId,
    mode: 'hidden',
    origin,
    extensionId,
    frameMs: 30,
    inputMethods: [],
    side: 'guarded',
    capabilities: { discovery: true, extensionFrame: true },
    notes,
    attachControls: { autoAttached: true },
  });
  assert.equal(result.eventURL, false, JSON.stringify(result));
  assert.equal(
    fake.sent.some((call) => call.method === 'Target.setAutoAttach'),
    false
  );
  assert.doesNotMatch(result.incomplete ?? '', /autoAttached:/);
  assert.match(waitedOf(notes).line, /\(budget 30ms\): eventURL not seen$/);
});

const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function swap(source, from, to) {
  assert.equal(source.split(from).length, 2, `mutation anchor not unique: ${from.slice(0, 80)}`);
  return source.replace(from, () => to);
}

async function mutant(change) {
  const here = new URL('../../extension-frame.mjs', import.meta.url);
  const source = change(await readFile(here, 'utf8')).replaceAll(
    /from '\.\/([^']+)'/g,
    (_, file) => `from '${new URL(file, here).href}'`
  );
  const dir = await mkdtemp(join(tmpdir(), 'c9-attach-'));
  dirs.push(dir);
  const path = join(dir, 'extension-frame.mjs');
  await writeFile(path, source);
  return import(pathToFileURL(path).href);
}

test('mutant: a silent guarded leg read as no leak passes', async () => {
  const mod = await mutant((source) =>
    swap(
      source,
      'if (attachControls?.autoAttached !== true || result.autoAttached !== false || refused) return;',
      'return;'
    )
  );
  await assert.rejects(() => silentGuardedLegIsIncomplete(mod), assert.AssertionError);
});

test('mutant: any frame attach error counted as a refusal passes a silent guarded leg', async () => {
  const mod = await mutant((source) =>
    swap(
      source,
      'if (!frameAttach.ok && protectedRefusal(frameAttach)) attachRefused = true;',
      'if (!frameAttach.ok) attachRefused = true;'
    )
  );
  await assert.rejects(() => silentGuardedLegIsIncomplete(mod), assert.AssertionError);
});

test('mutant: a single read after setAutoAttach misses a late attach', async () => {
  const mod = await mutant((source) =>
    swap(source, 'if (done() || elapsed >= budgetMs) break;', 'break;')
  );
  await assert.rejects(() => lateGuardedAttachLeaks(mod), assert.AssertionError);
  await assert.rejects(() => controlWaitsForTheEvent(mod), assert.AssertionError);
});

test('mutant: a wait that ignores the attach event runs out the budget', async () => {
  const mod = await mutant((source) =>
    swap(source, 'if (done() || elapsed >= budgetMs) break;', 'if (elapsed >= budgetMs) break;')
  );
  await assert.rejects(() => controlWaitsForTheEvent(mod), assert.AssertionError);
});
