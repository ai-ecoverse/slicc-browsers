import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { judge } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { protectedOrigins } from '../../protected.mjs';
import { canonicalURL, rootURL } from '../../unparseable-url.mjs';
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

test('unparseable fixture URLs omit empty and default ports and match Chrome canonical URLs', () => {
  for (const origin of [
    'https://ordinary.test',
    'https://ordinary.test:443',
    'http://ordinary.test:80',
  ]) {
    const root = new URL(origin);
    const url = rootURL(root, 'exa%20mple.sliccy.ai', '/doc?n=default');
    assert.equal(url, `${root.protocol}//exa%20mple.sliccy.ai/doc?n=default`);
    assert.equal(
      canonicalURL(url),
      canonicalURL(`${root.protocol}//exa%20mple.sliccy.ai:/doc?n=default`)
    );
    assert.equal(
      canonicalURL(url),
      canonicalURL(
        `${root.protocol}//exa mple.sliccy.ai:${root.protocol === 'https:' ? '443' : '80'}/doc?n=default`
      )
    );
  }
  assert.equal(
    rootURL(new URL('http://ordinary.test:8123'), 'exa%20mple.sliccy.ai', '/doc'),
    'http://exa%20mple.sliccy.ai:8123/doc'
  );
  assert.equal(canonicalURL('HTTPS://example.test:443'), 'https://example.test/');
});

test('observation-only capabilities skip explicitly unavailable fields, not missing evidence', () => {
  const vector = vectors[0];
  assert.deepEqual(vector.requires ?? [], []);
  assert.deepEqual(vector.trigger[0].requires ?? [], []);
  assert.deepEqual(vector.observe.listed.requires, ['browserSession']);
  const observed = { ...vector.expected, listed: 'not-supported' };
  assert.equal(judge(vector, 'guarded', observed).pass, true);
  assert.deepEqual(judge(vector, 'guarded', observed).skipped, ['listed']);
  assert.equal(judge(vector, 'guarded', { ...observed, listed: undefined }).pass, false);
  assert.equal(judge(vector, 'guarded', { ...observed, cookieRefused: false }).pass, false);
  assert.equal(
    judge(vector, 'guarded', { ...observed, cookieRefused: 'not-supported' }).pass,
    false
  );
});

test('real Chrome unparseable documents are refused, hidden, unattachable and deliver no seven cookie', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  try {
    for (const browserSession of [true, false]) {
      for (const mode of ['catalog', 'plain', '1.9.0', 'filtering']) {
        const browser = await launch(fixture);
        const rules = { ...catalog.protectedOrigins };
        if (mode === '1.9.0') {
          delete rules.unparseable;
          delete rules.unparseableRefusal;
        }
        const guard = mode === 'plain' ? null : emulatedGuard(browser, { protectedOrigins: rules });
        const guardedClient = guard?.client ?? browser.client;
        const client = {
          events: guardedClient.events,
          send: (method, params, session) => {
            if (!browserSession) {
              assert.notEqual(method, 'Storage.setCookies');
              assert.notEqual(method, 'Target.getTargets');
              if (!method.startsWith('Target.')) assert(session, `${method} needs a page session`);
            }
            if (mode === 'filtering' && method === 'Network.getCookies')
              return Promise.resolve({ cookies: [] });
            return guardedClient.send(method, params, session);
          },
        };
        const evidence = {};
        try {
          const execution = await run(
            { ...set, vectors, variants: { prompt: 0 } },
            {
              client,
              unguarded: browser.unguarded,
              fixture,
              targets: Object.fromEntries(
                Object.entries(origins(fixture)).map(([key, origin]) => [
                  key,
                  origin.replace(`:${fixture.port}`, ''),
                ])
              ),
              capabilities: { browserSession },
              rowTimeoutMs: 40000,
              debug: (entry) => {
                if (entry.calls?.unparseable?.result)
                  evidence[entry.side] = entry.calls.unparseable.result;
              },
            }
          );
          const row = execution.results[0];
          assert.equal(row.control, 'pass', JSON.stringify({ mode, browserSession, row }));
          assert.equal(
            evidence.guarded.listed,
            browserSession ? mode === 'plain' || mode === '1.9.0' : 'not-supported'
          );
          if (!browserSession) assert.deepEqual(row.notSupported, ['listed']);
          if (mode === 'filtering') {
            assert.equal(evidence.guarded.cookieRefused, false);
            assert.match(row.why, /cookieRefused/);
          }
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
    }
  } finally {
    await fixture.close();
  }
});
