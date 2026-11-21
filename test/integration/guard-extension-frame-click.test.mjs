import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import * as real from '../../extension-frame.mjs';
import { shownRefusal } from '../../extension-frames-rules.mjs';
import { DEFAULT_EXTENSION_WORLD_ID } from '../../extension-world.mjs';

const origin = 'http://ordinary.example.test';
const extensionId = DEFAULT_EXTENSION_WORLD_ID;
const frameURL = `chrome-extension://${extensionId}/frame.html?username=slicc-frame-test-user`;
const pageId = 'PAGE';
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  chromeUrlsAttach: true,
  discovery: true,
  extensionFrame: true,
};
const FOCUS_LOST = 'mouse target did not reach two focused visible frames';
const TIMED_OUT = 'Input.dispatchMouseEvent timed out';
const within = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
const FLAT_FRAME = { left: 500, right: 800, top: 400, bottom: 600 };
const NESTED_FRAME = { left: 100, right: 400, top: 300, bottom: 500 };
const BUTTON = { left: 0, right: 100, top: 0, bottom: 100 };

function nestedBox(expression) {
  const top = { frameElement: null };
  top.parent = top;
  const host = {
    clientLeft: 0,
    clientTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 200, width: 400, height: 300 }),
  };
  const hostWindow = { frameElement: host, parent: top };
  const frame = {
    ownerDocument: { defaultView: hostWindow },
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 300, height: 200 }),
  };
  host.contentDocument = {
    getElementById: (id) => (id === 'slicc-extension-frame' ? frame : null),
  };
  const document = {
    getElementById: (id) => (id === 'slicc-extension-frame-host' ? host : null),
  };
  const value = vm.runInContext(expression, vm.createContext({ window: top, document }));
  return JSON.parse(JSON.stringify(value));
}

function transport({
  pressError,
  refuse = false,
  deliver = true,
  focusGate = false,
  nested = false,
} = {}) {
  const state = {
    sent: [],
    pageFocused: true,
    frameFocused: false,
    armed: false,
    clicked: false,
    frameHits: 0,
    buttonPresses: 0,
  };
  const frameRect = nested ? NESTED_FRAME : FLAT_FRAME;
  let next = 0;
  const focusPage = () => {
    state.pageFocused = true;
    state.frameFocused = false;
  };
  const evaluate = (expression) => {
    if (expression === 'self.origin') return { result: { type: 'string', value: origin } };
    if (expression.includes('checkVisibility')) return { result: { type: 'boolean', value: true } };
    if (expression.includes('getBoundingClientRect'))
      return {
        result: {
          type: 'object',
          value: nested ? nestedBox(expression) : { x: 650, y: 500, w: 300, h: 200 },
        },
      };
    if (expression.includes('delete document.body.dataset.clicked')) {
      state.armed = true;
      state.clicked = false;
      return { result: { type: 'boolean', value: true } };
    }
    if (expression.includes('document.body.dataset.clicked === "yes"'))
      return { result: { type: 'boolean', value: state.clicked } };
    if (expression.includes('getElementById("typed")') && expression.includes('focus()')) {
      focusPage();
      return { result: { type: 'boolean', value: true } };
    }
    if (expression.includes('getElementById("typed")'))
      return { result: { type: 'boolean', value: true } };
    if (expression.includes('f.src')) return { result: { type: 'string', value: '' } };
    if (expression.includes('performance.now()')) return { result: { type: 'number', value: 1 } };
    return { result: { type: 'boolean', value: true } };
  };
  const input = (method, params) => {
    state.sent.push({ method, params });
    if (method === 'Input.dispatchKeyEvent' && params.key === 'Tab' && state.frameFocused)
      state.pageFocused = false;
    if (method !== 'Input.dispatchMouseEvent') return {};
    const onButton = within(params.x, params.y, BUTTON);
    if (params.type === 'mousePressed') {
      if (onButton) state.buttonPresses += 1;
      const probe = onButton && state.buttonPresses === 1;
      if (probe && refuse) throw new Error(shownRefusal);
      if (probe && pressError) throw new Error(pressError);
      if (focusGate && !state.pageFocused) throw new Error(FOCUS_LOST);
      if (within(params.x, params.y, frameRect)) {
        state.frameHits += 1;
        state.frameFocused = true;
      } else focusPage();
    }
    if (params.type === 'mouseReleased' && onButton && state.armed && deliver) {
      state.clicked = true;
      state.armed = false;
    }
    return {};
  };
  const send = async (method, params = {}) => {
    if (method === 'Target.attachToTarget') return { sessionId: `S${++next}` };
    if (method === 'Target.getTargets')
      return {
        targetInfos: [
          { targetId: pageId, type: 'page', url: `${origin}/`, browserContextId: 'B1' },
          {
            targetId: 'FRAME',
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
    if (method === 'Runtime.evaluate') return evaluate(params.expression ?? '');
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
    if (method.startsWith('Input.')) return input(method, params);
    return {};
  };
  const client = { events: [], send };
  return { client, reader: client, state };
}

function probe(mod, mode, fake, side = 'control', inputMethods = []) {
  return mod.extensionFrame({
    client: fake.client,
    reader: fake.reader,
    session: 'PAGE-SESSION',
    targetId: pageId,
    mode,
    origin,
    extensionId,
    frameMs: 0,
    inputMethods,
    side,
    capabilities,
  });
}

const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function swap(source, from, to) {
  assert.equal(source.split(from).length, 2, `mutation anchor not unique: ${from.slice(0, 80)}`);
  return source.replace(from, () => to);
}

function swapSpan(source, start, end, to) {
  const at = source.indexOf(start);
  assert.ok(at >= 0 && source.indexOf(start, at + 1) < 0, `span start not unique: ${start}`);
  const stop = source.indexOf(end, at);
  assert.ok(stop > at, `span end missing: ${end}`);
  return source.slice(0, at) + to + source.slice(stop + end.length);
}

async function mutant(change) {
  const here = new URL('../../extension-frame.mjs', import.meta.url);
  const source = change(await readFile(here, 'utf8')).replaceAll(
    /from '\.\/([^']+)'/g,
    (_, file) => `from '${new URL(file, here).href}'`
  );
  const dir = await mkdtemp(join(tmpdir(), 'c9-click-'));
  dirs.push(dir);
  const path = join(dir, 'extension-frame.mjs');
  await writeFile(path, source);
  return import(pathToFileURL(path).href);
}

const TAB = `  const tab = await outcome(
    client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' }, page)
  );
  await refocus();
`;
const tabRightAfterFrameClick = (source) =>
  swap(
    swap(source, `${TAB}  const focusedKey`, '  const focusedKey'),
    '  const pressed = await click(',
    `${TAB}  const pressed = await click(`
  );
const clickFalseOnError = (source) =>
  swapSpan(
    source,
    'async function click(',
    "return { out: pressed.out, ok: 'incomplete' };\n}",
    `async function click(client, reader, session, observer) {
  await observe(reader, observer, 'delete document.body.dataset.clicked; true');
  const pressed = await clickAt(client, reader, session, observer, 20, 20);
  const clicked = await observe(reader, observer, 'document.body.dataset.clicked === "yes"');
  return { out: pressed.out, ok: pressed.ok && clicked === true };
}`
  );
const boxInHostCoordinates = (source) =>
  swapSpan(
    source,
    '      let left = r.left;',
    'h: r.height };',
    '      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };'
  );

const pressIndex = (state, where) =>
  state.sent.findIndex(
    (call) =>
      call.method === 'Input.dispatchMouseEvent' &&
      call.params.type === 'mousePressed' &&
      within(call.params.x, call.params.y, where)
  );

async function clickRunsWithPageFocus(mod) {
  const fake = transport({ focusGate: true });
  const result = await probe(mod, 'transparent', fake, 'control', [
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent',
  ]);
  assert.equal(result.click, true, JSON.stringify(result));
  assert.equal(result.frameClick, true);
  assert.equal(result.tab, true);
  assert.equal(result.inputs.dispatchMouseEvent.ok, true, JSON.stringify(result.inputs));
  assert.equal(result.incomplete, undefined, result.incomplete);
  const tabs = fake.state.sent
    .map((call, index) =>
      call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Tab' ? index : -1
    )
    .filter((index) => index >= 0);
  const clickAt = pressIndex(fake.state, BUTTON);
  assert.ok(clickAt > pressIndex(fake.state, FLAT_FRAME));
  assert.ok(
    tabs.every((index) => index > clickAt),
    JSON.stringify(tabs)
  );
}

async function controlPressErrorIsIncomplete(mod) {
  const fake = transport({ pressError: TIMED_OUT });
  const result = await probe(mod, 'transparent', fake, 'control');
  assert.equal(result.click, 'incomplete', JSON.stringify(result));
  assert.notEqual(result.click, false);
  assert.match(result.incomplete ?? '', new RegExp(`click: ${TIMED_OUT}`));
  assert.equal(result.clickRefusal, TIMED_OUT);
}

async function controlClickNeverDeliveredIsIncomplete(mod) {
  const fake = transport({ deliver: false });
  const result = await probe(mod, 'transparent', fake, 'control');
  assert.equal(result.click, 'incomplete', JSON.stringify(result));
  assert.match(result.incomplete ?? '', /click: not delivered/);
}

async function nestedClickLandsInFrame(mod) {
  const fake = transport({ nested: true });
  const result = await probe(mod, 'nested', fake, 'control');
  assert.equal(result.frameClick, true);
  const press = fake.state.sent.find(
    (call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed'
  );
  assert.deepEqual({ x: press.params.x, y: press.params.y }, { x: 250, y: 400 });
  assert.equal(fake.state.frameHits, 1);
  assert.equal(result.click, true, JSON.stringify(result));
}

test('the control click probe runs with page focus: Tab is sent after inputMethods', () =>
  clickRunsWithPageFocus(real));

test('a control press that errors without a refusal is incomplete with the error text, never false', () =>
  controlPressErrorIsIncomplete(real));

test('a control click that is never delivered is incomplete, never false', () =>
  controlClickNeverDeliveredIsIncomplete(real));

for (const side of ['control', 'guarded'])
  test(`a refused click press still counts as refused (${side})`, async () => {
    const fake = transport({ refuse: true });
    const result = await probe(real, 'transparent', fake, side);
    assert.equal(result.click, false, JSON.stringify(result));
    assert.equal(result.clickRefusal, shownRefusal);
    assert.doesNotMatch(result.incomplete ?? '', /click:/);
  });

test('a guarded press error without a refusal keeps the guarded observation', async () => {
  const fake = transport({ pressError: TIMED_OUT });
  const result = await probe(real, 'transparent', fake, 'guarded');
  assert.equal(result.click, false);
  assert.equal(result.clickRefusal, TIMED_OUT);
});

test('the nested frame box is translated from host iframe into page coordinates', () =>
  nestedClickLandsInFrame(real));

test('mutant: the Tab probe right after frameClick loses page focus before the click probe', async () => {
  const mod = await mutant(tabRightAfterFrameClick);
  await assert.rejects(() => clickRunsWithPageFocus(mod), assert.AssertionError);
});

test('mutant: a click that records false on a control press error or a missing click fails', async () => {
  const mod = await mutant(clickFalseOnError);
  await assert.rejects(() => controlPressErrorIsIncomplete(mod), assert.AssertionError);
  await assert.rejects(() => controlClickNeverDeliveredIsIncomplete(mod), assert.AssertionError);
});

test('mutant: a nested frame box left in host iframe coordinates clicks the host top edge', async () => {
  const mod = await mutant(boxInHostCoordinates);
  await assert.rejects(() => nestedClickLandsInFrame(mod), assert.AssertionError);
  const fake = transport({ nested: true });
  await probe(mod, 'nested', fake, 'control');
  const press = fake.state.sent.find(
    (call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed'
  );
  assert.deepEqual({ x: press.params.x, y: press.params.y }, { x: 250, y: 200 });
  assert.equal(fake.state.frameHits, 0);
});
