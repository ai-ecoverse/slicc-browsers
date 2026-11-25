import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
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
export const TIMED_OUT = 'Input.dispatchMouseEvent timed out';
export const within = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
export const FLAT_FRAME = { left: 500, right: 800, top: 400, bottom: 600 };
const NESTED_FRAME = { left: 100, right: 400, top: 300, bottom: 500 };
export const BUTTON = { left: 0, right: 100, top: 0, bottom: 100 };

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

export function transport({
  pressError,
  refuse = false,
  deliver = true,
  focusGate = false,
  nested = false,
  typedOn = () => true,
  keyError,
} = {}) {
  const state = {
    sent: [],
    pageFocused: true,
    frameFocused: false,
    armed: false,
    clicked: false,
    frameHits: 0,
    buttonPresses: 0,
    typed: '',
    keyTries: 0,
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
      if (expression.includes('i.value = ""')) state.typed = '';
      focusPage();
      return { result: { type: 'boolean', value: true } };
    }
    if (expression.includes('getElementById("typed").value === "k"'))
      return { result: { type: 'boolean', value: state.typed === 'k' } };
    if (expression.includes('getElementById("typed")'))
      return { result: { type: 'boolean', value: true } };
    if (expression.includes('f.src')) return { result: { type: 'string', value: '' } };
    if (expression.includes('performance.now()')) return { result: { type: 'number', value: 1 } };
    return { result: { type: 'boolean', value: true } };
  };
  const input = (method, params) => {
    state.sent.push({ method, params });
    if (method === 'Input.insertText' && params.text === 'k') {
      state.keyTries += 1;
      if (keyError) throw new Error(keyError);
      if (typedOn(state.keyTries)) state.typed = 'k';
      return {};
    }
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

export function probe(mod, mode, fake, side = 'control', inputMethods = [], notes) {
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
    notes,
  });
}

export function swap(source, from, to) {
  assert.equal(source.split(from).length, 2, `mutation anchor not unique: ${from.slice(0, 80)}`);
  return source.replace(from, () => to);
}

export function swapSpan(source, start, end, to) {
  const at = source.indexOf(start);
  assert.ok(at >= 0 && source.indexOf(start, at + 1) < 0, `span start not unique: ${start}`);
  const stop = source.indexOf(end, at);
  assert.ok(stop > at, `span end missing: ${end}`);
  return source.slice(0, at) + to + source.slice(stop + end.length);
}

export async function mutant(change, dirs, prefix) {
  const here = new URL('../../extension-frame.mjs', import.meta.url);
  const source = change(await readFile(here, 'utf8')).replaceAll(
    /from '\.\/([^']+)'/g,
    (_, file) => `from '${new URL(file, here).href}'`
  );
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  const path = join(dir, 'extension-frame.mjs');
  await writeFile(path, source);
  return import(pathToFileURL(path).href);
}
