import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(
  await readFile(
    process.env.GUARD_VECTOR_REFERENCE ?? new URL('../../guard-vectors.json', import.meta.url)
  )
);
const rules = JSON.parse(
  await readFile(new URL('../../catalog.json', import.meta.url))
).protectedOrigins;
const vectors = data.vectors.filter((vector) => vector.id === 'C8.protected-error-page');
const discoveryEvent = (event) =>
  ['Target.targetCreated', 'Target.targetInfoChanged'].includes(event.method);

test('discovery is local to the C8 event observation, not the other legs or the entire row', () => {
  const rows = data.vectors.filter((vector) => vector.trigger.some((step) => step.errorPage));
  assert(rows.length > 0);
  for (const vector of rows) {
    assert.deepEqual(vector.observe.eventsRedacted.requires, ['discovery']);
    assert.equal(vector.requires?.includes('discovery') ?? false, false);
    for (const [name, observation] of Object.entries(vector.observe))
      if (name !== 'eventsRedacted')
        assert.equal(observation.requires?.includes('discovery') ?? false, false);
  }
});

test('real Chrome observers have no opener; absent discovery skips only events and liars fail', {
  timeout: 240000,
}, async () => {
  const fixture = await fixtureServer();
  try {
    for (const mode of ['declared', 'absent', 'lying-created', 'lying-changed']) {
      const browser = await launch(fixture);
      const guard = emulatedGuard(browser, { protectedOrigins: rules });
      const extra = [];
      const client = {
        get events() {
          return [
            ...guard.client.events.filter((event) => mode === 'declared' || !discoveryEvent(event)),
            ...extra,
          ];
        },
        send: async (method, params, session) => {
          if (mode !== 'declared') assert.notEqual(method, 'Target.setDiscoverTargets');
          const result = await guard.client.send(method, params, session);
          if (mode.startsWith('lying') && method === 'Target.getTargetInfo')
            extra.push({
              method:
                mode === 'lying-created' ? 'Target.targetCreated' : 'Target.targetInfoChanged',
              params: { targetInfo: result.targetInfo },
            });
          return result;
        },
      };
      const observed = [];
      const reader = {
        ...browser.unguarded,
        send: async (method, params, session) => {
          const result = await browser.unguarded.send(method, params, session);
          if (method === 'Target.createTarget') {
            assert.equal(params.newWindow, true, JSON.stringify(params));
            const { targetInfo } = await browser.unguarded.send('Target.getTargetInfo', {
              targetId: result.targetId,
            });
            assert.equal(Object.hasOwn(targetInfo, 'openerId'), false, JSON.stringify(targetInfo));
            observed.push(result.targetId);
          }
          return result;
        },
      };
      try {
        const execution = await run(
          { ...data, vectors, variants: { prompt: 0 } },
          {
            client,
            unguarded: reader,
            fixture,
            targets: origins(fixture),
            capabilities: { discovery: mode === 'declared' },
          }
        );
        const row = execution.results[0];
        console.log(`${mode}: ${JSON.stringify(row)}`);
        assert(observed.length >= 3);
        assert(row.notes.some((note) => note.includes('newWindow=true, openerId absent')));
        if (mode === 'declared') {
          assert.equal(row.notSupported, undefined);
          assert.equal(row.guarded, 'pass', JSON.stringify(row));
        } else {
          assert.deepEqual(row.notSupported, ['eventsRedacted']);
          assert.equal(row.observations.guarded.eventsRedacted, 'not-supported');
          assert(row.notes.some((note) => note.includes('not-supported:discovery')));
          assert.equal(row.guarded, mode === 'absent' ? 'pass' : 'fail', JSON.stringify(row));
          for (const name of [
            'live',
            'attached',
            'infoRedacted',
            'listRedacted',
            'attachRedacted',
            'reload',
            'blank',
            'close',
          ])
            assert.equal(row.observations.guarded[name], true, name);
          if (mode.startsWith('lying'))
            assert(row.errors.some((error) => error.includes('discovery not declared')));
        }
      } finally {
        await guard.stop();
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
});
