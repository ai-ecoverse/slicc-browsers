import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import * as real from '../../extension-frame.mjs';
import { shownRefusal } from '../../extension-frames-rules.mjs';
import {
  BUTTON,
  FLAT_FRAME,
  mutant as load,
  probe,
  swap,
  swapSpan,
  TIMED_OUT,
  transport,
  within,
} from './extension-frame-fake.mjs';

const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const mutant = (change) => load(change, dirs, 'c9-click-');

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
