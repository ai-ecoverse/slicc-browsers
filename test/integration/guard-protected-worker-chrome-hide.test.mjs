import test from 'node:test';
import {
  assertAllPass,
  protectedWorkerIds,
  rowsFor,
  runWorkerRows,
} from './protected-worker-chrome.mjs';

test('a per-target-hiding guard that still delivers ordinary workers passes the protected rows', {
  timeout: 900000,
}, async () => {
  assertAllPass(await runWorkerRows('hide', rowsFor(protectedWorkerIds)), protectedWorkerIds);
});
