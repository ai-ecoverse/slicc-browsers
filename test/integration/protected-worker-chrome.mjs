import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));

export const protectedWorkerIds = [
  'C3.protected-worker-dedicated',
  'C3.protected-worker-shared',
  'C3.protected-service-worker',
  'C3.protected-worker-framed',
];
export const ordinaryWorkerIds = ['C3.tab-worker-leak', 'C3.tab-service-worker-leak'];
export const browserAutoAttachWorkerIds = [
  'C3.protected-worker-shared',
  'C3.protected-service-worker',
];
export const pageSessionWorkerIds = ['C3.protected-worker-dedicated', 'C3.protected-worker-framed'];

const stockCaps = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  stockSetup: true,
  syntheticAutoAttach: true,
  forwardAudit: true,
};

const modes = {
  narrow: { narrowAutoAttach: true },
  hide: {},
  'hide-cut-attach': { cutProtectedAttach: true },
  'redact-url': { exposeProtectedWorkers: true },
  'late-worker': { exposeProtectedWorkers: true, delayProtectedWorkerMs: 800 },
  'late-listed': { delayProtectedListMs: 800 },
  rewrite: { rewriteProtectedWorkers: true },
  'late-rewrite': { rewriteProtectedWorkers: true, delayProtectedWorkerMs: 3000 },
  'empty-info': { emptyWorkerTargetInfo: true },
  'lying-attach': { allowProtectedAttach: true },
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

export function rowsFor(ids, target = 'seven') {
  return ids.map((id) => {
    const vector = set.vectors.find((entry) => entry.id === id);
    assert.ok(vector, id);
    assert.ok(vector.targets.includes(target), `${id} has no ${target} target`);
    return { ...vector, targets: [target] };
  });
}

export async function runWorkerRows(mode, vectors) {
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
  let guard = { client: browser.client, stop: async () => {} };
  try {
    if (mode !== 'none') {
      assert.ok(modes[mode], mode);
      guard = emulatedGuard(browser, {
        protectedOrigins: catalog.protectedOrigins,
        extraOrigins: [targets.seven, targets.vault],
        resumeUnexposed: true,
        ...modes[mode],
      });
    }
    record(browser.unguarded);
    record(guard.client);
    return await run(
      { ...set, vectors, variants: { prompt: 0 } },
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

function describe(row, expectation) {
  return JSON.stringify(
    {
      expectation,
      id: row.id,
      target: row.target,
      control: row.control,
      guarded: row.guarded,
      live: row.live,
      why: row.why,
      errors: row.errors,
      notes: row.notes,
      observations: row.observations?.guarded,
      calls: row.calls?.guarded,
    },
    null,
    1
  );
}

export function assertAllPass(execution, ids) {
  assertCovered(execution, ids);
  for (const row of execution.results)
    assert.deepEqual(
      [row.control, row.guarded, row.live],
      ['pass', 'pass', 'pass'],
      describe(row, 'control, guarded and live pass')
    );
}

export function assertAllGuardedFail(execution, ids) {
  assertCovered(execution, ids);
  for (const row of execution.results) {
    assert.deepEqual(
      [row.control, row.live],
      ['pass', 'pass'],
      describe(row, 'control and live pass so the guarded fail is the guard')
    );
    assert.equal(row.guarded, 'fail', describe(row, 'guarded fails'));
  }
}

export function assertRewriteAttackOutcomes(execution) {
  assertCovered(execution, protectedWorkerIds);
  for (const row of execution.results) {
    assert.deepEqual(
      [row.control, row.live],
      ['pass', 'pass'],
      describe(row, 'control and live pass')
    );
    if (browserAutoAttachWorkerIds.includes(row.id))
      assert.equal(
        row.guarded,
        'fail',
        describe(
          row,
          'browser-level rewrite/empty-info delivers shared/service workers so guarded fails'
        )
      );
    else
      assert.equal(
        row.guarded,
        'pass',
        describe(
          row,
          'dedicated/framed workers are page-session auto-attach only; browser-level rewrite never delivers them so guarded passes'
        )
      );
  }
}

function assertCovered(execution, ids) {
  for (const id of ids)
    assert.ok(
      execution.results.some((row) => row.id === id),
      `no row for ${id}`
    );
}
