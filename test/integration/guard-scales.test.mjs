import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';

const set = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);

const leak = '{target}/doc?n={tag}-leak';

const vector = {
  id: 'S1.late-leak',
  kind: 'cdp',
  scope: 'any',
  targets: ['seven'],
  setup: [{ page: 'tab', url: '{ordinary}/doc?n={tag}' }],
  trigger: [
    {
      page: 'eval',
      expression: `fetch('${leak}', { mode: 'no-cors' }).then(() => true, () => true)`,
    },
    { settle: { served: leak, ms: 2000 } },
  ],
  observe: {
    leak: {
      check: { any: [{ served: leak, observer: 'fixture' }], observer: 'client' },
    },
  },
  liveCheck: { loaded: '{ordinary}/doc?n={tag}', observer: 'fixture' },
  control: { origin: 'ordinary', via: 'guard', expected: { leak: true } },
  expected: { leak: false },
};

async function leg({ settleScale, refusalScale, delays }) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const hosts = origins(fixture);
  const first = new Map();
  const late = {
    log: () =>
      fixture.log().filter((entry) => {
        if (!entry.url.includes('-leak')) return true;
        const side = entry.url.startsWith(hosts.seven) ? 'guarded' : 'control';
        if (!first.has(entry.url)) first.set(entry.url, Date.now());
        return Date.now() - first.get(entry.url) >= delays[side];
      }),
  };
  const fired = {};
  const settled = {};
  try {
    const { results } = await run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        targets: hosts,
        fixture: late,
        settleScale,
        refusalScale,
        debug: ({ step, side, events }) => {
          if (step?.page === 'eval') fired[side] = Date.now();
          if (events) settled[side] = Date.now();
        },
      }
    );
    const [row] = results;
    return {
      row,
      elapsed: {
        control: settled.control - fired.control,
        guarded: settled.guarded - fired.guarded,
      },
    };
  } finally {
    await browser.close();
    await fixture.close();
  }
}

test('at settleScale 3 and refusalScale 1 a guarded wait for an absent leak takes the unscaled bound', {
  timeout: 120000,
}, async () => {
  const { row, elapsed } = await leg({
    settleScale: 3,
    refusalScale: 1,
    delays: { control: 0, guarded: Infinity },
  });
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(elapsed.guarded >= 2000, JSON.stringify(elapsed));
  assert.ok(elapsed.guarded < 4000, JSON.stringify(elapsed));
});

for (const [refusalScale, caught] of [
  [3, true],
  [1, false],
]) {
  test(`a guarded leak 3.5 s late is ${caught ? 'caught' : 'missed'} at refusalScale ${refusalScale}`, {
    timeout: 120000,
  }, async () => {
    const { row } = await leg({
      settleScale: 1,
      refusalScale,
      delays: { control: 0, guarded: 3500 },
    });
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.observations.guarded.leak, caught, JSON.stringify(row));
    assert.equal(row.guarded, caught ? 'fail' : 'pass', JSON.stringify(row));
  });
}

for (const [settleScale, refusalScale, passes] of [
  [3, 1, true],
  [1, 3, false],
]) {
  test(`a control event 3.5 s late ${passes ? 'passes' : 'fails'} at settleScale ${settleScale} and refusalScale ${refusalScale}`, {
    timeout: 120000,
  }, async () => {
    const { row, elapsed } = await leg({
      settleScale,
      refusalScale,
      delays: { control: 3500, guarded: Infinity },
    });
    assert.equal(row.control, passes ? 'pass' : 'fail', JSON.stringify(row));
    if (passes) assert.ok(elapsed.control >= 3500, JSON.stringify(elapsed));
    else assert.ok(elapsed.control < 3500, JSON.stringify(elapsed));
  });
}

test('refusalScale below 1 is refused', async () => {
  for (const refusalScale of [0.5, 0, -1, Number.NaN, Infinity])
    await assert.rejects(
      run(
        { ...set, vectors: [vector], variants: { prompt: 0 } },
        { fixture: { log: () => [] }, refusalScale }
      ),
      /refusalScale must be a number of at least 1/
    );
});
