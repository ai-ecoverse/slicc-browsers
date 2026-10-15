import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { connect, launch, origins } from './cdp-client.mjs';

const set = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);

test('foreground tab requests are reflected by the real document', async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    const vector = {
      id: 'C1.foreground',
      kind: 'cdp',
      scope: 'any',
      targets: ['seven'],
      setup: [{ page: 'tab', url: '{ordinary}/doc?n={tag}', background: false }],
      trigger: [{ page: 'eval', expression: 'document.visibilityState', as: 'visibility' }],
      observe: {
        visible: {
          check: {
            result: 'visibility',
            path: 'result.result.value',
            equals: 'visible',
            observer: 'client',
          },
        },
      },
      liveCheck: { executed: 'trigger', observer: 'client' },
      control: { origin: 'ordinary', via: 'guard', expected: { visible: true } },
      expected: { visible: true },
    };
    const execution = await run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      { client: browser.client, unguarded: browser.client, targets: origins(fixture), fixture }
    );
    assert.equal(execution.results[0].control, 'pass');
    assert.equal(execution.results[0].guarded, 'pass');
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('the reference runner checks real Chromium effects without a guard', {
  timeout: 720000,
}, async () => {
  const target = process.env.GUARD_TARGET ?? 'seven';
  const fixture = await fixtureServer();
  const started = Date.now();
  const reports = [];
  try {
    const selection = process.env.GUARD_IDS?.split(',');
    const selected = {
      ...set,
      vectors: set.vectors
        .filter((v) => (!selection || selection.includes(v.id)) && v.targets.includes(target))
        .map((v) => ({ ...v, targets: [target] })),
    };
    assert(
      selected.vectors.some((v) => v.kind === 'cdp'),
      'no runnable vectors for the target'
    );
    const repeats = process.env.GUARD_IDS ? 1 : 2;
    for (let repeat = 0; repeat < repeats; repeat++) {
      const width = Number(process.env.GUARD_PARALLEL ?? 6);
      const browsers = await Promise.all(Array.from({ length: width }, () => launch(fixture)));
      let execution;
      try {
        execution = await run(selected, {
          clientFactory: async ({ slot }) => {
            const client = await connect(browsers[slot].ws);
            return { client, unguarded: client, close: () => client.close() };
          },
          targets: origins(fixture),
          capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
          parallel: width,
          variant: process.env.GUARD_VARIANT ?? Object.keys(set.variants),
          fixture,
          debug: process.env.GUARD_DEBUG
            ? (data) => process.stdout.write(`${JSON.stringify(data)}\n`)
            : undefined,
          log: process.env.GUARD_IDS
            ? (row) => process.stdout.write(`${JSON.stringify(row)}\n`)
            : undefined,
        });
      } finally {
        await Promise.all(browsers.map((browser) => browser.close()));
      }
      const rows = execution.results.filter((r) => r.control !== 'skip' && r.control !== 'not-run');
      const failures = rows.filter((r) => r.control !== 'pass' || r.guarded !== 'fail');
      reports.push({ repeat, counts: execution.summary().counts, results: execution.results });
      if (process.env.GUARD_REPORT)
        await writeFile(
          process.env.GUARD_REPORT,
          JSON.stringify({ reports, ms: Date.now() - started }, null, 2)
        );
      assert.deepEqual(
        failures.map(({ id, target, variant, why, errors }) => ({
          id,
          target,
          variant,
          why,
          errors,
        })),
        []
      );
      process.stdout.write(
        `controls pass ${rows.filter((r) => r.control === 'pass').length}/${rows.length}; guarded without guard fail ${rows.filter((r) => r.guarded === 'fail').length}/${rows.length}\n`
      );
    }
    process.stdout.write(`${target}: elapsed ${Date.now() - started}ms\n`);
  } finally {
    await fixture.close();
  }
});
