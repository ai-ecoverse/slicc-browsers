import test from 'node:test';
import {
  assertAllPass,
  protectedWorkerIds,
  rowsFor,
  runWorkerRows,
} from './protected-worker-chrome.mjs';

test('a per-target-hiding guard that forwards attach then cuts the session passes', {
  timeout: 900000,
}, async () => {
  assertAllPass(
    await runWorkerRows('hide-cut-attach', rowsFor(protectedWorkerIds)),
    protectedWorkerIds
  );
});
