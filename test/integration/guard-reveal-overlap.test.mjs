import assert from 'node:assert/strict';
import test from 'node:test';
import { driveReveal } from '../../extension-frame.mjs';

test('driveReveal treats a capture that finishes after reveal apply as unknown', async () => {
  const events = [];
  let resolveCapture;
  let captures = 0;
  let revealApplied = false;
  let clock = 0;
  let chain = Promise.resolve();
  const client = {
    send: (method) => {
      if (method === 'Page.captureScreenshot' && ++captures === 1) {
        events.push('capture-started');
        return new Promise((resolve) => {
          resolveCapture = resolve;
        });
      }
      if (method === 'Page.captureScreenshot')
        return Promise.resolve({ data: 'hidden-frame-shot' });
      return Promise.reject(new Error('slicc: refused: input while shown'));
    },
  };
  const reader = {
    send: (method, params) => {
      const run = async () => {
        if (method !== 'Runtime.evaluate') return {};
        if (params.expression === 'performance.now()') {
          clock += 5;
          if (revealApplied) return { result: { value: Math.max(clock, 25) } };
          return { result: { value: clock } };
        }
        if (
          typeof params.expression === 'string' &&
          params.expression.includes('f.hidden = false') &&
          params.expression.includes('return performance.now()')
        ) {
          events.push('reveal-applied');
          revealApplied = true;
          events.push('capture-completed-with-visible-frame');
          resolveCapture({ data: 'visible-extension-pixels' });
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          events.push('reveal-acknowledged');
          return { result: { value: 20 } };
        }
        return { result: { value: false } };
      };
      const next = chain.then(run, run);
      chain = next.catch(() => {});
      return next;
    },
  };
  const missing = [];
  const result = await driveReveal(client, reader, 'page', 'observer', 0, missing, 'guarded');
  assert.deepEqual(events, [
    'capture-started',
    'reveal-applied',
    'capture-completed-with-visible-frame',
    'reveal-acknowledged',
  ]);
  assert.equal(result.revealOverlap, 'unknown');
  assert.equal(result.revealRacePass, false);
  assert.match(missing.join('\n'), /overlap unproven/);
});
