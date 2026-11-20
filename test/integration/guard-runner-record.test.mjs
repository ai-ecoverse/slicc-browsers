import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isRefusal } from '../../guard-driver.mjs';

const refusedOut = (step, out, gone = false) =>
  step.refusable
    ? isRefusal(out, step)
    : !gone && /refused/.test(String(out.error?.message ?? out.error));

const refusable = {
  refusable: true,
  refusal: { name: 'bypass', match: 'slicc:\\s*refused' },
};

test('genuine refusal reply counts as refused even when the child session detached', () => {
  const out = { ok: false, error: { message: 'slicc: refused: protected origin' } };
  assert.equal(refusedOut(refusable, out, true), true);
  assert.equal(isRefusal(out, refusable), true);
});

test('genuine refusal with the child still present is refused', () => {
  const out = { ok: false, error: { message: 'slicc: refused: protected origin' } };
  assert.equal(refusedOut(refusable, out, false), true);
});

test('Session with given id not found after detach is not refused', () => {
  const out = { ok: false, error: { message: 'Session with given id not found.' } };
  assert.equal(refusedOut(refusable, out, true), false);
});

test('Target closed after detach is not refused', () => {
  const out = { ok: false, error: { message: 'Target closed' } };
  assert.equal(refusedOut(refusable, out, true), false);
});

test('transport error after detach is not refused', () => {
  const out = { ok: false, error: { message: 'WebSocket is not open: readyState 3 (CLOSED)' } };
  assert.equal(refusedOut(refusable, out, true), false);
});

test('unrelated error that merely contains a similar word is not refused', () => {
  const out = { ok: false, error: { message: 'operation refused by the transport layer' } };
  assert.equal(refusedOut(refusable, out, true), false);
  assert.equal(refusedOut(refusable, out, false), false);
});

test('non-refusable step after detach stays refused:false (fallback gated by gone)', () => {
  const step = { refusable: false };
  const out = { ok: false, error: { message: 'slicc: refused: protected origin' } };
  assert.equal(refusedOut(step, out, true), false);
  assert.equal(refusedOut(step, out, false), true);
});

test('record() uses refusedOut(step, out, gone) and still reads gone (static)', async () => {
  const source = await readFile(new URL('../../guard-runner.mjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('record(step, out, session, phase, gone)'));
  const body = block.slice(0, 900);
  assert.match(body, /const refused = refusedOut\(step, out, gone\);/);
  assert.doesNotMatch(body, /const refused = !gone && refusedOut/);
  assert.match(body, /\.\.\.\(gone \? \{ detached: true \} : \{\}\)/);
  assert.match(body, /refusalError\(step, out, refused, gone, phase, this\.vector\)/);
  assert.match(
    source,
    /const refusedOut = \(step, out, gone = false\) =>\s*step\.refusable\s*\?\s*isRefusal\(out, step\)\s*:\s*!gone && \/refused\/\.test/
  );
});
