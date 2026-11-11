import test from 'node:test';
import {
  assertAllGuardedFail,
  protectedWorkerIds,
  rowsFor,
  runWorkerRows,
} from './protected-worker-chrome.mjs';

test('a rewritten attach delivered after the trigger probe fails each protected worker row', {
  timeout: 900000,
}, async () => {
  assertAllGuardedFail(
    await runWorkerRows('late-rewrite', rowsFor(protectedWorkerIds)),
    protectedWorkerIds
  );
});
