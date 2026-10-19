import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { protectedOrigins } from '../../protected.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const data = JSON.parse(await readFile(new URL('../../protected.json', import.meta.url)));
const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vectors = set.vectors.filter((vector) => vector.id === 'C8.unparseable');

const invalid = [
  'http://exa mple.sliccy.ai/',
  'http://exa%20mple.sliccy.ai/',
  'http://\u200d.sliccy.ai/',
  'http://[::1',
  'http://',
  'http://a:99999/',
  'http://1.2.3.4.5/',
  'http://%zz/',
  'http://[1::2::3]/',
  'http://a^b/',
  'blob:http://[::1',
  'http://\u200d.example/',
  'https://exa mple.com/',
];

test('unparseable URL commands and browser-reported URLs fail closed, unlike read-only keys', () => {
  const matcher = protectedOrigins(catalog.protectedOrigins, data.origins);
  const old = protectedOrigins(
    { ...catalog.protectedOrigins, unparseable: undefined },
    data.origins
  );
  for (const url of invalid) {
    assert.equal(matcher.unparseable(url), true, url);
    assert.equal(matcher.url(url), true, url);
    assert.equal(matcher.target({ url }), true, url);
    assert.equal(matcher.url(url, { readOnly: true }), false, url);
    assert.equal(matcher.storageKey(url), false, url);
    assert.equal(old.url(url), false, url);
  }
  for (const url of ['', 'null', '://', 'about:blank']) {
    assert.equal(matcher.unparseable(url), false, url);
    assert.equal(matcher.url(url), false, url);
  }
  assert.equal(matcher.target({ url: '', previous: true }), true);
  assert.equal(matcher.target({ url: 'about:blank', opener: 'protected' }), true);
  assert.equal(matcher.url('view-source:'.repeat(8) + 'https://example.com/'), false);
  assert.equal(matcher.url('view-source:'.repeat(9) + 'https://example.com/'), true);
  assert.equal(
    matcher.url('view-source:'.repeat(9) + 'https://example.com/', { readOnly: true }),
    false
  );
  assert.equal(matcher.storageKey('https://example.com/^0http://[::1'), false);
  assert.equal(matcher.storageKey('https://example.com/^0https://seven.sliccy.ai'), true);
  assert.equal(catalog.protectedOrigins.unparseable, data.unparseable);
  assert.equal(catalog.protectedOrigins.unparseableRefusal, data.unparseableRefusal);
});

test('C8.unparseable skips before sending when browserSession is unavailable', async () => {
  const fixture = await fixtureServer();
  try {
    const client = { events: [], send: async () => assert.fail('unsupported transport sent CDP') };
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      { client, unguarded: client, fixture, targets: origins(fixture), capabilities: {} }
    );
    assert.equal(execution.results.length, 1);
    assert.equal(execution.results[0].reason, 'not-supported:browserSession');
  } finally {
    await fixture.close();
  }
});

test('real Chrome unparseable documents are refused, hidden, unattachable and deliver no seven cookie', {
  timeout: 180000,
}, async () => {
  const fixture = await fixtureServer();
  try {
    for (const mode of ['catalog', 'plain', '1.9.0']) {
      const browser = await launch(fixture);
      const rules = { ...catalog.protectedOrigins };
      if (mode === '1.9.0') {
        delete rules.unparseable;
        delete rules.unparseableRefusal;
      }
      const guard = mode === 'plain' ? null : emulatedGuard(browser, { protectedOrigins: rules });
      const evidence = {};
      try {
        const execution = await run(
          { ...set, vectors, variants: { prompt: 0 } },
          {
            client: guard?.client ?? browser.client,
            unguarded: browser.unguarded,
            fixture,
            targets: origins(fixture),
            capabilities: { browserSession: true },
            rowTimeoutMs: 40000,
            debug: (entry) => {
              if (entry.calls?.unparseable?.result)
                evidence[entry.side] = entry.calls.unparseable.result;
            },
          }
        );
        const row = execution.results[0];
        assert.equal(row.control, 'pass', JSON.stringify({ mode, row }));
        assert.equal(evidence.control.responses.length, 5);
        for (const response of evidence.control.responses) {
          const allowed =
            response.canonical === 'exa%20mple.sliccy.ai'
              ? ['document']
              : ['document', 'native-rejection'];
          assert(allowed.includes(response.createOutcome), JSON.stringify(response));
          assert(allowed.includes(response.navigateOutcome), JSON.stringify(response));
        }
        console.log(
          `${mode} ${evidence.control.browserVersion}: ${JSON.stringify(evidence.control.responses.map(({ input, createOutcome, navigateOutcome }) => ({ input, createOutcome, navigateOutcome })))}`
        );
        assert.equal(
          row.guarded,
          mode === 'catalog' ? 'pass' : 'fail',
          JSON.stringify({ mode, row })
        );
        assert.equal(row.live, 'pass', JSON.stringify({ mode, row }));
        assert.equal(execution.summary().pass, mode === 'catalog');
      } finally {
        await guard?.stop();
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
});
