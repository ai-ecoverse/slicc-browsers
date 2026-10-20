import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { parseURL } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  chromeUrlsAttach: true,
  extensionWorld: true,
};
const chain = set.vectors.find((vector) => vector.id === 'C2.chain-301-302-303');
const together = set.vectors.filter(
  (vector) =>
    vector.id === 'C2.chain-301-302-303' ||
    vector.id === 'C8.unparseable' ||
    vector.id.startsWith('C9.')
);

const guardFor = (browser, fixture) =>
  emulatedGuard(browser, {
    protectedHosts: [new URL(origins(fixture).seven).host],
    protectedOrigins: catalog.protectedOrigins,
  });

test('parseURL returns null for unparseable fixture and Chrome URLs', () => {
  assert.equal(parseURL('http://exa%20mple.sliccy.ai:8123/doc?n=x'), null);
  assert.equal(parseURL('http://exa mple.sliccy.ai/'), null);
  assert.equal(parseURL('http://a:99999/'), null);
  assert.equal(parseURL(undefined), null);
  assert.equal(parseURL({}), null);
  assert.equal(parseURL('/doc?n=x', 'http://exa%20mple.sliccy.ai'), null);
  assert.equal(parseURL('/doc?n=x', 'http://ordinary.test').href, 'http://ordinary.test/doc?n=x');
  assert.equal(parseURL('http://ordinary.test/live?tag=t').searchParams.get('tag'), 't');
});

test('another row’s unparseable fixture entries never break C2 attempt and request checks', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const guard = guardFor(browser, fixture);
  const foreign = (tag) => ({
    url: `http://exa%20mple.sliccy.ai:${fixture.port}/doc?n=${tag}-create-0`,
    method: 'GET',
    headers: { host: `exa%20mple.sliccy.ai:${fixture.port}` },
    time: Date.now(),
  });
  let reads = 0;
  const shared = {
    ...fixture,
    log: async () => {
      reads++;
      const entries = fixture.log();
      const at = Math.floor(entries.length / 2);
      return [
        ...entries.slice(0, at),
        foreign(`other-${reads}`),
        ...entries.slice(at),
        foreign(`late-${reads}`),
        {
          ...foreign(`live-${reads}`),
          url: `http://exa%20mple.sliccy.ai:${fixture.port}/live?tag=other&to=x`,
        },
      ];
    },
  };
  try {
    const execution = await run(
      { ...set, vectors: [{ ...chain, targets: ['seven'] }], variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture: shared,
        targets: origins(fixture),
        capabilities,
        rowTimeoutMs: 60000,
      }
    );
    assert(reads > 0);
    for (const row of execution.results) {
      assert.doesNotMatch(JSON.stringify(row), /Invalid URL/, JSON.stringify(row));
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
    }
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});

test('C2, C8 and C9 share one fixture log in parallel in real Chrome', {
  timeout: 600000,
}, async () => {
  const fixture = await fixtureServer();
  const width = 3;
  const browsers = await Promise.all(Array.from({ length: width }, () => launch(fixture)));
  try {
    const execution = await run(
      {
        ...set,
        vectors: together.map((vector) =>
          vector.id.startsWith('C2.') ? { ...vector, targets: ['seven'] } : vector
        ),
        variants: { prompt: 0 },
      },
      {
        clientFactory: async ({ slot }) => {
          const guard = guardFor(browsers[slot], fixture);
          return {
            client: guard.client,
            unguarded: browsers[slot].unguarded,
            close: () => guard.stop(),
          };
        },
        parallel: width,
        fixture,
        targets: origins(fixture),
        capabilities,
        rowTimeoutMs: 90000,
      }
    );
    assert.equal(execution.results.length, together.length);
    assert(
      fixture.log().some((entry) => entry.url.includes('exa%20mple.sliccy.ai')),
      'C8 left no unparseable entries in the shared log'
    );
    for (const row of execution.results) {
      assert.doesNotMatch(JSON.stringify(row), /Invalid URL/, JSON.stringify(row));
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
    }
    assert.equal(execution.summary().pass, true);
  } finally {
    await Promise.all(browsers.map((browser) => browser.close()));
    await fixture.close();
  }
});
