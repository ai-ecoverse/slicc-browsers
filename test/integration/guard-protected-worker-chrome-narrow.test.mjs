import test from 'node:test';
import {
  assertAllPass,
  ordinaryWorkerIds,
  protectedWorkerIds,
  rowsFor,
  runWorkerRows,
} from './protected-worker-chrome.mjs';

const ids = [...ordinaryWorkerIds, ...protectedWorkerIds];

test('a bios-shaped narrowing guard passes ordinary and protected worker rows', {
  timeout: 900000,
}, async () => {
  assertAllPass(await runWorkerRows('narrow', rowsFor(ids)), ids);
});
