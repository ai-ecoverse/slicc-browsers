import test from 'node:test';
import {
  assertAllGuardedFail,
  protectedWorkerIds,
  rowsFor,
  runWorkerRows,
} from './protected-worker-chrome.mjs';

test('a late protected-worker delivery fails each protected worker row', {
  timeout: 900000,
}, async () => {
  assertAllGuardedFail(
    await runWorkerRows('late-worker', rowsFor(protectedWorkerIds)),
    protectedWorkerIds
  );
});

test('a late getTargets listing of a protected worker fails each row', {
  timeout: 900000,
}, async () => {
  assertAllGuardedFail(
    await runWorkerRows('late-listed', rowsFor(protectedWorkerIds)),
    protectedWorkerIds
  );
});
