import test from 'node:test';
import {
  assertRewriteAttackOutcomes,
  protectedWorkerIds,
  rowsFor,
  runWorkerRows,
} from './protected-worker-chrome.mjs';

test('a rewritten attach delivered after the trigger probe fails shared/service and passes dedicated/framed', {
  timeout: 900000,
}, async () => {
  assertRewriteAttackOutcomes(await runWorkerRows('late-rewrite', rowsFor(protectedWorkerIds)));
});
