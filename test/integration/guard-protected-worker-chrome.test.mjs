import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const protectedWorkerIds = [
  'C3.protected-worker-dedicated',
  'C3.protected-worker-shared',
  'C3.protected-service-worker',
  'C3.protected-worker-framed',
];
const protectedWorkerVectors = set.vectors.filter((vector) =>
  protectedWorkerIds.includes(vector.id)
);
const ordinaryWorkerVectors = set.vectors.filter((vector) =>
  ['C3.tab-worker-leak', 'C3.tab-service-worker-leak'].includes(vector.id)
);
const stockCaps = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  stockSetup: true,
  syntheticAutoAttach: true,
  forwardAudit: true,
};

function record(client) {
  const forwarded = client.forwarded ?? [];
  if (!client.forwarded) client.forwarded = forwarded;
  const send = client.send.bind(client);
  client.send = (method, params = {}, sessionId) => {
    forwarded.push({ method, params, sessionId });
    return send(method, params, sessionId);
  };
}

async function runProtectedWorkers(mode) {
  const tls = {
    key: await readFile(new URL('./fixtures/tls-key.pem', import.meta.url)),
    cert: await readFile(new URL('./fixtures/tls-cert.pem', import.meta.url)),
  };
  const spki = createHash('sha256')
    .update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const fixture = await fixtureServer({ tls });
  const browser = await launch(fixture, { spki });
  const targets = origins(fixture);
  const catalogOpts = {
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
  };
  let guard;
  if (mode === 'narrow') {
    guard = emulatedGuard(browser, { ...catalogOpts, narrowAutoAttach: true });
  } else if (mode === 'hide') {
    guard = emulatedGuard(browser, catalogOpts);
  } else if (mode === 'hide-cut-attach') {
    guard = emulatedGuard(browser, { ...catalogOpts, cutProtectedAttach: true });
  } else if (mode === 'redact-url') {
    guard = emulatedGuard(browser, { ...catalogOpts, exposeProtectedWorkers: true });
  } else if (mode === 'late-worker') {
    guard = emulatedGuard(browser, {
      ...catalogOpts,
      exposeProtectedWorkers: true,
      delayProtectedWorkerMs: 800,
    });
  } else if (mode === 'late-listed') {
    guard = emulatedGuard(browser, {
      ...catalogOpts,
      delayProtectedListMs: 800,
    });
  } else if (mode === 'rewrite') {
    guard = emulatedGuard(browser, {
      ...catalogOpts,
      rewriteProtectedWorkers: true,
    });
  } else if (mode === 'late-rewrite') {
    guard = emulatedGuard(browser, {
      ...catalogOpts,
      rewriteProtectedWorkers: true,
      delayProtectedWorkerMs: 7000,
    });
  } else if (mode === 'empty-info') {
    guard = emulatedGuard(browser, {
      ...catalogOpts,
      emptyWorkerTargetInfo: true,
    });
  } else if (mode === 'lying-attach') {
    guard = emulatedGuard(browser, { ...catalogOpts, allowProtectedAttach: true });
  } else {
    guard = { client: browser.client, stop: async () => {} };
  }
  record(browser.unguarded);
  record(guard.client);
  try {
    return await run(
      { ...set, vectors: protectedWorkerVectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets,
        capabilities: { ...stockCaps, secureOrigin: true, discovery: true },
        rowTimeoutMs: 90000,
      }
    );
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
}

test('a bios-shaped narrowing guard passes ordinary and protected worker rows', {
  timeout: 900000,
}, async () => {
  const tls = {
    key: await readFile(new URL('./fixtures/tls-key.pem', import.meta.url)),
    cert: await readFile(new URL('./fixtures/tls-cert.pem', import.meta.url)),
  };
  const spki = createHash('sha256')
    .update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const fixture = await fixtureServer({ tls });
  const browser = await launch(fixture, { spki });
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    narrowAutoAttach: true,
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
  });
  record(browser.unguarded);
  record(guard.client);
  try {
    const execution = await run(
      {
        ...set,
        vectors: [...ordinaryWorkerVectors, ...protectedWorkerVectors],
        variants: { prompt: 0 },
      },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets,
        capabilities: { ...stockCaps, secureOrigin: true, discovery: true },
        rowTimeoutMs: 90000,
      }
    );
    for (const row of execution.results)
      assert.deepEqual(
        [row.control, row.guarded, row.live],
        ['pass', 'pass', 'pass'],
        JSON.stringify(row)
      );
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});

test('a per-target-hiding guard that still delivers ordinary workers passes the protected rows', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('hide');
  for (const row of execution.results)
    assert.deepEqual(
      [row.control, row.guarded, row.live],
      ['pass', 'pass', 'pass'],
      JSON.stringify(row)
    );
});

test('a per-target-hiding guard that forwards attach then cuts the session passes', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('hide-cut-attach');
  for (const row of execution.results)
    assert.deepEqual(
      [row.control, row.guarded, row.live],
      ['pass', 'pass', 'pass'],
      JSON.stringify(row)
    );
});

test('a guard that delivers a protected worker fails each protected worker row', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('none');
  for (const id of protectedWorkerIds) {
    const rows = execution.results.filter((row) => row.id === id);
    assert.ok(rows.length > 0, id);
    for (const row of rows) assert.equal(row.guarded, 'fail', JSON.stringify(row));
  }
});

test('a guard that delivers protected workers with redacted URLs fails each row', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('redact-url');
  for (const row of execution.results) assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('a late protected-worker delivery fails each protected worker row', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('late-worker');
  for (const row of execution.results) assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('a late getTargets listing of a protected worker fails each row', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('late-listed');
  for (const row of execution.results) assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('a rewritten protected-worker attach fails each protected worker row', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('rewrite');
  for (const row of execution.results) assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('a rewritten attach delivered after the trigger probe fails each protected worker row', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('late-rewrite');
  for (const row of execution.results) assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('an attachedToTarget with empty targetInfo fails each protected worker row', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('empty-info');
  for (const row of execution.results) assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('a lying attach reply that still returns a session id fails the protected rows', {
  timeout: 900000,
}, async () => {
  const execution = await runProtectedWorkers('lying-attach');
  for (const row of execution.results) assert.equal(row.guarded, 'fail', JSON.stringify(row));
});
