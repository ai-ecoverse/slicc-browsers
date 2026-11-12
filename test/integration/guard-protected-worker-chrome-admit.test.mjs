import test from 'node:test';
import {
  assertAllGuardedFail,
  protectedWorkerIds,
  rowsFor,
  runWorkerRows,
} from './protected-worker-chrome.mjs';

const cases = [
  ['none', 'a guard that delivers a protected worker fails each protected worker row'],
  ['redact-url', 'a guard that delivers protected workers with redacted URLs fails each row'],
  ['lying-attach', 'a lying attach reply that still returns a session id fails the protected rows'],
];

for (const [mode, name] of cases)
  test(name, { timeout: 900000 }, async () => {
    assertAllGuardedFail(
      await runWorkerRows(mode, rowsFor(protectedWorkerIds)),
      protectedWorkerIds
    );
  });
