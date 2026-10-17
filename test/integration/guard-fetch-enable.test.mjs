import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const flatten = (steps) => steps.flatMap((step) => [step, ...flatten(step.children ?? [])]);
const protectedPattern =
  /\{(?:target|seven|vault|vault-x|apex|own|client|chrome-settings|chrome-passwords|chrome-extension-page|file-root)\}/;
const vectors = data.vectors.filter((vector) =>
  flatten(vector.setup).some(
    (step) =>
      step.cdp === 'Fetch.enable' &&
      step.params.patterns.some((pattern) => protectedPattern.test(pattern.urlPattern))
  )
);

test('only Fetch.enable patterns naming protected placeholders are refusable', () => {
  assert.deepEqual(
    vectors.map((vector) => vector.id),
    ['C5.guessed-id.continue-response']
  );
  for (const vector of data.vectors) {
    for (const [index, step] of flatten([...vector.setup, ...vector.trigger]).entries()) {
      if (step.cdp !== 'Fetch.enable') continue;
      const protectedOrigin = step.params.patterns.some((pattern) =>
        protectedPattern.test(pattern.urlPattern)
      );
      assert.equal(Boolean(step.refusable), protectedOrigin, vector.id);
      if (!protectedOrigin) continue;
      assert.equal(step.refusal.match, '^slicc: refused');
      assert.equal(step.refusal.onlyProtected, true);
      for (const observation of Object.values(vector.observe))
        assert.ok(observation.dependsOn.includes(step.as ?? `refused.${index}`), vector.id);
    }
  }
});

async function row(vector, route) {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    const targets = origins(fixture);
    const protectedHost = new URL(targets.seven).host;
    const mentions = (params) => JSON.stringify(params).includes(protectedHost);
    const guard = emulatedGuard(browser, { protectedHosts: [protectedHost] });
    const send = guard.client.send;
    const client =
      route === 'plain'
        ? browser.client
        : {
            ...guard.client,
            send: async (method, params, sessionId) => {
              if (method === 'Fetch.enable') {
                if (route === 'ordinary-refusal' || (route === 'refuse' && mentions(params)))
                  throw new Error("slicc: refused: target is on seven's origin");
                if ((route === 'internal' || route === 'timeout') && mentions(params))
                  throw new Error(
                    route === 'internal' ? 'Internal error' : 'Fetch.enable timed out'
                  );
                params = {
                  ...params,
                  patterns: params.patterns.filter((pattern) => !mentions(pattern)),
                };
              }
              if (
                method === 'Fetch.continueResponse' &&
                !guard.client.events.some(
                  (event) =>
                    event.method === 'Fetch.requestPaused' &&
                    event.sessionId === sessionId &&
                    event.params.requestId === params.requestId
                )
              )
                throw new Error('slicc: refused: unknown request id');
              return send(method, params, sessionId);
            },
          };
    try {
      const execution = await run(
        { ...data, vectors: [{ ...vector, targets: ['seven'] }], variants: { prompt: 0 } },
        { client, unguarded: browser.unguarded, targets, fixture }
      );
      return execution.results[0];
    } finally {
      await guard.stop();
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
}

for (const vector of vectors) {
  for (const route of ['allow', 'refuse']) {
    test(`${vector.id}: ${route} protected-pattern registration passes through run`, async () => {
      const result = await row(vector, route);
      for (const leg of ['control', 'guarded', 'live'])
        assert.equal(result[leg], 'pass', JSON.stringify(result));
      if (route === 'refuse') {
        assert.equal(result.observations.control['refused.2'], false);
        assert.equal(result.observations.guarded['refused.2'], true);
        for (const name of Object.keys(vector.observe))
          assert.equal(result.observations.guarded[name], undefined, name);
      } else {
        for (const [name, value] of Object.entries(vector.expected))
          assert.equal(result.observations.guarded[name], value, name);
      }
    });
  }

  test(`${vector.id}: refusing an ordinary-only Fetch.enable fails`, async () => {
    const result = await row(vector, 'ordinary-refusal');
    assert.equal(result.control, 'fail', JSON.stringify(result));
    assert.match(result.why, /protected-only step was refused on the control/);
  });

  test(`${vector.id}: protected-only refusal without the flag still fails`, async () => {
    const symmetric = structuredClone(vector);
    delete symmetric.setup.find((step) => step.cdp === 'Fetch.enable').refusal.onlyProtected;
    const result = await row(symmetric, 'refuse');
    assert.equal(result.control, 'pass', JSON.stringify(result));
    assert.equal(result.guarded, 'fail', JSON.stringify(result));
    assert.match(result.why, /refused only on the protected target: refused.2/);
  });

  test(`${vector.id}: a plain client still fails the guarded leg`, async () => {
    const result = await row(vector, 'plain');
    assert.equal(result.control, 'pass', JSON.stringify(result));
    assert.equal(result.guarded, 'fail', JSON.stringify(result));
  });

  for (const route of ['internal', 'timeout']) {
    test(`${vector.id}: ${route} is not a matched registration refusal`, async () => {
      const result = await row(vector, route);
      assert.equal(result.guarded, 'fail', JSON.stringify(result));
      assert.ok(
        result.errors.some((error) => error.startsWith('refused.2 failed without a refusal:'))
      );
    });
  }
}
