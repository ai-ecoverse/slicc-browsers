import assert from 'node:assert/strict';
import test from 'node:test';
import { driveReveal } from '../../extension-frame.mjs';

function isReveal(expression) {
  return (
    typeof expression === 'string' &&
    expression.includes('f.hidden = false') &&
    expression.includes('return performance.now()')
  );
}

function isHide(expression) {
  return typeof expression === 'string' && expression.includes('f.hidden = true');
}

function harness({ race, events = [] }) {
  let raceIndex = 0;
  let chain = Promise.resolve();
  let resolveCapture;
  let attempt = 0;
  let afterClick = false;
  const base = () => attempt * 1000;
  const client = {
    send: (method) => {
      if (method === 'Page.captureScreenshot') {
        if (afterClick) {
          afterClick = false;
          return Promise.resolve({ data: 'rehidden-shot' });
        }
        if (raceIndex < race.length) {
          const step = race[raceIndex++];
          attempt = raceIndex;
          events.push(`capture-started-${raceIndex}`);
          return new Promise((resolve, reject) => {
            resolveCapture = { resolve, reject, step, n: raceIndex };
          });
        }
        return Promise.resolve({ data: 'rehidden-shot' });
      }
      if (typeof method === 'string' && method.startsWith('Input.')) {
        afterClick = true;
        return Promise.reject(new Error('slicc: refused: input while shown'));
      }
      return Promise.reject(new Error('slicc: refused: input while shown'));
    },
  };
  const reader = {
    send: (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression === 'performance.now()') {
        const pending = resolveCapture;
        if (pending?.settling) {
          pending.settling = false;
          return Promise.resolve({ result: { value: pending.settledAt } });
        }
        return Promise.resolve({ result: { value: base() + 10 } });
      }
      const run = async () => {
        if (method === 'Page.bringToFront') return {};
        if (method !== 'Runtime.evaluate') return {};
        const expression = params.expression;
        if (isReveal(expression)) {
          const pending = resolveCapture;
          const n = attempt;
          events.push(`reveal-applied-${n}`);
          if (pending?.step.mode === 'unknown') {
            events.push(`capture-completed-with-visible-frame-${n}`);
            pending.settledAt = base() + 40;
            pending.settling = true;
            pending.resolve({ data: pending.step.data ?? 'visible-extension-pixels' });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            events.push(`reveal-acknowledged-${n}`);
            return { result: { value: base() + 30 } };
          }
          if (pending?.step.mode === 'after') {
            events.push(`capture-completed-before-reveal-${n}`);
            pending.settledAt = base() + 20;
            pending.settling = true;
            pending.resolve({ data: pending.step.data ?? 'after-shot' });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            events.push(`reveal-acknowledged-${n}`);
            return { result: { value: base() + 50 } };
          }
          if (pending?.step.mode === 'during') {
            events.push(`reveal-acknowledged-pending-${n}`);
            const revealAt = base() + 30;
            setTimeout(() => {
              if (pending.step.refuse) {
                events.push(`capture-refused-${n}`);
                pending.settledAt = base() + 50;
                pending.settling = true;
                pending.reject(new Error(pending.step.refuse));
              } else {
                events.push(`capture-leaked-${n}`);
                pending.settledAt = base() + 50;
                pending.settling = true;
                pending.resolve({ data: pending.step.data ?? 'visible-extension-pixels' });
              }
            }, 0);
            return { result: { value: revealAt } };
          }
          return { result: { value: base() + 50 } };
        }
        if (isHide(expression)) {
          events.push('hide');
          resolveCapture = undefined;
          return { result: { value: true } };
        }
        if (expression === 'delete document.body.dataset.clicked; true')
          return { result: { value: true } };
        if (expression === 'document.body.dataset.clicked === "yes"')
          return { result: { value: false } };
        return { result: { value: false } };
      };
      const next = chain.then(run, run);
      chain = next.catch(() => {});
      return next;
    },
  };
  return { client, reader, events };
}

test('driveReveal treats a capture that finishes after reveal apply as unknown', async () => {
  const events = [];
  const { client, reader } = harness({
    events,
    race: [{ mode: 'unknown' }, { mode: 'unknown' }, { mode: 'unknown' }],
  });
  const missing = [];
  const result = await driveReveal(client, reader, 'page', 'observer', 0, missing, 'guarded');
  assert.deepEqual(events.slice(0, 4), [
    'capture-started-1',
    'reveal-applied-1',
    'capture-completed-with-visible-frame-1',
    'reveal-acknowledged-1',
  ]);
  assert.equal(result.revealOverlap, 'unknown');
  assert.equal(result.revealRacePass, false);
  assert.match(missing.join('\n'), /overlap unproven \(3 attempts\)/);
});

test('driveReveal retries an unproven overlap then passes on a proven during refusal', async () => {
  const { client, reader, events } = harness({
    race: [
      { mode: 'unknown' },
      {
        mode: 'during',
        refuse:
          "slicc: refused: a browser extension's frame (chrome-extension://) is showing or focused in this tab, such as a password manager's autofill list; close it or reload the tab",
      },
    ],
  });
  const missing = [];
  const result = await driveReveal(client, reader, 'page', 'observer', 0, missing, 'guarded');
  assert.ok(events.includes('capture-started-1'));
  assert.ok(events.includes('capture-started-2'));
  assert.ok(events.includes('capture-refused-2'));
  assert.ok(!events.some((e) => e.startsWith('capture-started-3')));
  assert.equal(result.revealOverlap, 'during');
  assert.equal(result.revealRacePass, true);
  assert.equal(result.revealedShot, false);
  assert.equal(missing.length, 0);
});

test('driveReveal stays incomplete after three unproven overlap attempts', async () => {
  const { client, reader } = harness({
    race: [{ mode: 'unknown' }, { mode: 'unknown' }, { mode: 'unknown' }],
  });
  const missing = [];
  const result = await driveReveal(client, reader, 'page', 'observer', 0, missing, 'guarded');
  assert.equal(result.revealOverlap, 'unknown');
  assert.equal(result.revealRacePass, false);
  assert.deepEqual(missing, ['reveal/capture overlap unproven (3 attempts)']);
});

test('driveReveal fails a proven during leak immediately without retry', async () => {
  const { client, reader, events } = harness({
    race: [{ mode: 'during', data: 'visible-extension-pixels' }],
  });
  const missing = [];
  const result = await driveReveal(client, reader, 'page', 'observer', 0, missing, 'guarded');
  assert.ok(events.includes('capture-leaked-1'));
  assert.ok(!events.some((e) => e.startsWith('capture-started-2')));
  assert.equal(result.revealOverlap, 'during');
  assert.equal(result.revealRacePass, false);
  assert.equal(result.revealedShot, true);
  assert.equal(missing.length, 0);
});

test('driveReveal control passes when attempt two proves after', async () => {
  const { client, reader, events } = harness({
    race: [{ mode: 'unknown' }, { mode: 'after', data: 'control-after-shot' }],
  });
  const missing = [];
  const result = await driveReveal(client, reader, 'page', 'observer', 0, missing, 'control');
  assert.ok(events.includes('capture-started-1'));
  assert.ok(events.includes('capture-started-2'));
  assert.ok(!events.some((e) => e.startsWith('capture-started-3')));
  assert.equal(result.revealOverlap, 'after');
  assert.equal(result.revealRacePass, true);
  assert.equal(result.revealedShot, true);
  assert.equal(missing.length, 0);
});
