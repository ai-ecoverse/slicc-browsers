import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import * as real from '../../extension-frame.mjs';
import { presentRefusal, shownRefusal } from '../../extension-frames-rules.mjs';
import { mutant as load, probe, swap, transport } from './extension-frame-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const row = set.vectors.find((vector) => vector.id === 'C9.frame-transparent');
const KEY_TIMED_OUT = 'Input.insertText timed out';
const KEY_URL_ERROR = `Input.insertText failed for https://secret.example.test/a?token=t0k3n ${'x'.repeat(400)}`;
const REFUSALS = [shownRefusal, presentRefusal, 'slicc: refused: Input.insertText'];
const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const mutant = (change) => load(change, dirs, 'c9-key-');

async function run(mod, side, options, mode = 'transparent') {
  const fake = transport(options);
  const notes = [];
  const result = await probe(mod, mode, fake, side, [], notes);
  return { fake, notes, result, keyNotes: notes.filter((note) => note.startsWith('key:')) };
}

async function lateFocusRecovers(mod) {
  const { fake, keyNotes, result } = await run(mod, 'control', { typedOn: (n) => n > 1 });
  assert.equal(result.key, true, JSON.stringify(result));
  assert.equal(result.keyRefusal, null);
  assert.ok(fake.state.keyTries > 1, `tries ${fake.state.keyTries}`);
  assert.equal(fake.state.keyTries, 2);
  assert.equal(keyNotes.length, 1, JSON.stringify(keyNotes));
  assert.match(keyNotes[0], /^key: delivered after 2 tries in \d+ms$/);
  assert.doesNotMatch(result.incomplete ?? '', /key:/);
}

async function neverDeliveredIsIncomplete(mod) {
  const { fake, keyNotes, result } = await run(mod, 'control', { typedOn: () => false });
  assert.equal(result.key, 'incomplete', JSON.stringify(result));
  assert.notEqual(result.key, false);
  assert.notEqual(result.key, true);
  assert.equal(result.keyRefusal, null);
  assert.match(result.incomplete ?? '', /(^|; )key: text was not delivered(;|$)/);
  assert.equal(fake.state.keyTries, 3);
  assert.equal(keyNotes.length, 1, JSON.stringify(keyNotes));
  const [, ms] = keyNotes[0].match(/^key: not delivered after 3 tries in (\d+)ms$/) ?? [];
  assert.ok(Number(ms) >= 200, keyNotes[0]);
}

async function guardedDoesNotRetry(mod) {
  const { fake, keyNotes, result } = await run(mod, 'guarded', { typedOn: (n) => n > 1 });
  assert.equal(result.key, false, JSON.stringify(result));
  assert.equal(fake.state.keyTries, 1);
  assert.deepEqual(keyNotes, []);
  assert.doesNotMatch(result.incomplete ?? '', /key:/);
}

test('a control key whose text arrives late is retried and reads true', () =>
  lateFocusRecovers(real));

test('a control key whose text never arrives is incomplete after a bounded retry, never false or true', () =>
  neverDeliveredIsIncomplete(real));

test('a control key delivered on the first try is sent once and adds no note', async () => {
  const { fake, keyNotes, result } = await run(real, 'control');
  assert.equal(result.key, true);
  assert.equal(fake.state.keyTries, 1);
  assert.deepEqual(keyNotes, []);
});

test('a guarded key whose text does not arrive is not retried and reads false', () =>
  guardedDoesNotRetry(real));

test('a guarded key that reads true where the row expects false is kept as a leak', async () => {
  assert.equal(row.expected.key, false);
  const { fake, result } = await run(real, 'guarded');
  assert.equal(result.key, true);
  assert.notEqual(result.key, row.expected.key);
  assert.equal(fake.state.keyTries, 1);
  assert.doesNotMatch(result.incomplete ?? '', /key:/);
});

async function controlErrorIsIncomplete(mod, keyError = KEY_TIMED_OUT) {
  const { fake, keyNotes, result } = await run(mod, 'control', { keyError });
  assert.equal(result.key, 'incomplete', JSON.stringify(result));
  assert.equal(result.keyRefusal, keyError);
  assert.equal(fake.state.keyTries, 1);
  assert.deepEqual(keyNotes, []);
  return result.incomplete.split('; ').filter((reason) => reason.startsWith('key:'));
}

async function controlTimeoutIsIncomplete(mod) {
  const reasons = await controlErrorIsIncomplete(mod);
  assert.deepEqual(reasons, [`key: ${KEY_TIMED_OUT}`]);
}

async function controlErrorIsBounded(mod) {
  const [reason, ...rest] = await controlErrorIsIncomplete(mod, KEY_URL_ERROR);
  assert.deepEqual(rest, []);
  assert.match(reason, /^key: Input\.insertText failed for <url> x+$/);
  assert.doesNotMatch(reason, /:\/\/|secret\.example|t0k3n/);
  assert.ok(reason.length <= 'key: '.length + 200, `${reason.length}`);
}

async function controlRefusalIsCredited(mod) {
  for (const keyError of REFUSALS) {
    const { fake, keyNotes, result } = await run(mod, 'control', { keyError });
    assert.equal(result.key, false, JSON.stringify(result));
    assert.equal(result.keyRefusal, keyError);
    assert.equal(fake.state.keyTries, 1);
    assert.deepEqual(keyNotes, []);
    assert.doesNotMatch(result.incomplete ?? '', /key:/);
  }
}

async function guardedErrorIsScored(mod) {
  for (const keyError of [...REFUSALS, KEY_TIMED_OUT]) {
    const { fake, keyNotes, result } = await run(mod, 'guarded', { keyError });
    assert.equal(result.key, false, JSON.stringify(result));
    assert.equal(result.keyRefusal, keyError);
    assert.equal(fake.state.keyTries, 1);
    assert.deepEqual(keyNotes, []);
    assert.doesNotMatch(result.incomplete ?? '', /key:/);
  }
}

test('a control insertText transport error without a refusal is incomplete after 1 try, never false or true', () =>
  controlTimeoutIsIncomplete(real));

test('a control insertText transport error reason is bounded and carries no URL', () =>
  controlErrorIsBounded(real));

test('a control insertText refusal is credited as a refusal and reads false', () =>
  controlRefusalIsCredited(real));

test('a guarded insertText refusal or transport error reads false with the error after 1 try', () =>
  guardedErrorIsScored(real));

test('a focused control key does not need the typed text and is not retried', async () => {
  const { fake, result } = await run(real, 'control', { typedOn: () => false }, 'focused');
  assert.equal(result.key, true, JSON.stringify(result));
  assert.equal(fake.state.keyTries, 1);
});

test('mutant: no retry leaves a late control key unmeasured', async () => {
  const mod = await mutant((source) =>
    swap(source, 'const KEY_TRIES = 3;', 'const KEY_TRIES = 1;')
  );
  await assert.rejects(() => lateFocusRecovers(mod), assert.AssertionError);
});

test('mutant: a retry on the guarded leg reads a late guarded key as true', async () => {
  const mod = await mutant((source) =>
    swap(
      source,
      'const retry = measured && requireTyped;',
      'const retry = requireTyped && Array.isArray(missing);'
    )
  );
  await assert.rejects(() => guardedDoesNotRetry(mod), assert.AssertionError);
});

for (const [name, ok] of [
  ['fail', 'false'],
  ['pass', 'true'],
])
  test(`mutant: a never-delivered control key scored as ${name} is caught`, async () => {
    const mod = await mutant((source) =>
      swap(
        source,
        "missing.push('key: text was not delivered');\n    return { out, ok: 'incomplete' };",
        `return { out, ok: ${ok} };`
      )
    );
    await assert.rejects(() => neverDeliveredIsIncomplete(mod), assert.AssertionError);
  });

const TRANSPORT_RULE = 'if (measured && !out.ok && !protectedRefusal(out)) {';
const TRANSPORT_INCOMPLETE =
  "missing.push(`key: ${keyError(out)}`);\n    return { out, ok: 'incomplete' };";

for (const [name, check, change] of [
  [
    'a control transport error scored false (old behaviour)',
    controlTimeoutIsIncomplete,
    (source) => swap(source, TRANSPORT_RULE, 'if (false) {'),
  ],
  [
    'a control transport error scored true',
    controlTimeoutIsIncomplete,
    (source) => swap(source, TRANSPORT_INCOMPLETE, 'return { out, ok: true };'),
  ],
  [
    'a control refusal treated as incomplete',
    controlRefusalIsCredited,
    (source) => swap(source, TRANSPORT_RULE, 'if (measured && !out.ok) {'),
  ],
  [
    'the transport-error rule applied to the guarded leg',
    guardedErrorIsScored,
    (source) =>
      swap(
        source,
        TRANSPORT_RULE,
        'if (Array.isArray(missing) && !out.ok && !protectedRefusal(out)) {'
      ),
  ],
  [
    'a URL kept in the control transport error reason',
    controlErrorIsBounded,
    (source) => swap(source, ".replace(/[a-z][a-z0-9+.-]*:\\/\\/[^\\s\"'<>]*/gi, '<url>')", ''),
  ],
  [
    'an unbounded control transport error reason',
    controlErrorIsBounded,
    (source) => swap(source, '.slice(0, KEY_ERROR_CAP)', ''),
  ],
])
  test(`mutant: ${name} is caught`, async () => {
    const mod = await mutant(change);
    await assert.rejects(() => check(mod), assert.AssertionError);
  });
