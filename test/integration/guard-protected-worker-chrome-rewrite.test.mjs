import test from 'node:test';
import {
  assertRewriteAttackOutcomes,
  protectedWorkerIds,
  rowsFor,
  runWorkerRows,
} from './protected-worker-chrome.mjs';

test('a rewritten protected-worker attach fails shared/service and passes dedicated/framed', {
  timeout: 900000,
}, async () => {
  assertRewriteAttackOutcomes(await runWorkerRows('rewrite', rowsFor(protectedWorkerIds)));
});

test('an attachedToTarget with empty targetInfo fails shared/service and passes dedicated/framed', {
  timeout: 900000,
}, async () => {
  assertRewriteAttackOutcomes(await runWorkerRows('empty-info', rowsFor(protectedWorkerIds)));
});
