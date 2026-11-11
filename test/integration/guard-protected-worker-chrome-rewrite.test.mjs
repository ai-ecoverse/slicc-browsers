import test from 'node:test';
import {
  assertAllGuardedFail,
  protectedWorkerIds,
  rowsFor,
  runWorkerRows,
} from './protected-worker-chrome.mjs';

test('a rewritten protected-worker attach fails each protected worker row', {
  timeout: 900000,
}, async () => {
  assertAllGuardedFail(
    await runWorkerRows('rewrite', rowsFor(protectedWorkerIds)),
    protectedWorkerIds
  );
});

test('an attachedToTarget with empty targetInfo fails each protected worker row', {
  timeout: 900000,
}, async () => {
  assertAllGuardedFail(
    await runWorkerRows('empty-info', rowsFor(protectedWorkerIds)),
    protectedWorkerIds
  );
});
