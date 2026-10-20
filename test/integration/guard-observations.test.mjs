import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';
import { fixtureServer } from '../../fixture-server.mjs';
import { parseURL } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';

const set = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);

for (const expression of [
  "Promise.race([new Promise(() => {}), new Promise(resolve => setTimeout(() => resolve('timeout'), 25))])",
  "Promise.reject(new Error('observation timed out'))",
])
  for (const check of [
    { compare: ['one', 'two'], path: 'result.result.value', observer: 'client' },
    { result: 'one', path: 'result.result.value', equals: 'timeout', observer: 'client' },
    { expression, equals: 'timeout', via: 'unguarded', observer: 'unguarded' },
  ])
    test(`incomplete observations fail instead of comparing: ${JSON.stringify(check)} ${expression}`, async () => {
      const fixture = await fixtureServer();
      const browser = await launch(fixture);
      try {
        const vector = {
          id: 'C1.timeout',
          kind: 'cdp',
          scope: 'any',
          targets: ['seven'],
          setup: [{ page: 'tab', url: '{ordinary}/doc?n={tag}' }],
          trigger: [
            { page: 'eval', expression, as: 'one' },
            { page: 'eval', expression, as: 'two' },
          ],
          observe: { completed: { check } },
          liveCheck: { loaded: '{ordinary}/doc?n={tag}', observer: 'fixture' },
          control: { origin: 'ordinary', via: 'guard', expected: { completed: true } },
          expected: { completed: false },
        };
        const execution = await run(
          { ...set, vectors: [vector], variants: { prompt: 0 } },
          {
            client: browser.client,
            unguarded: browser.unguarded,
            targets: origins(fixture),
            fixture,
          }
        );
        assert.equal(execution.results[0].control, 'fail');
        assert.equal(execution.results[0].guarded, 'fail');
        assert(execution.results[0].errors.includes('Observation did not complete'));
      } finally {
        await browser.close();
        await fixture.close();
      }
    });

test('auth observations use request evidence without a plain baseline', async () => {
  const fixture = await fixtureServer();
  try {
    const vectors = set.vectors.filter(({ id }) =>
      ['C5.auth', 'C5.guessed-id.continue-with-auth'].includes(id)
    );
    const execution = await run(
      {
        ...set,
        vectors: vectors.map((v) => ({ ...v, targets: ['seven', 'vault'] })),
        variants: { prompt: 0 },
      },
      {
        clientFactory: async () => {
          const browser = await launch(fixture);
          return { client: browser.client, unguarded: browser.client, close: browser.close };
        },
        targets: origins(fixture),
        fixture,
      }
    );
    for (const row of execution.results) {
      assert.equal(row.control, 'pass');
      assert.equal(row.guarded, 'fail');
      assert.equal(row.live, 'pass');
      assert.equal(row.observations.control.authed, true);
      assert.equal(row.observations.guarded.refused, false);
    }
    const requests = await fixture.log();
    assert(!requests.some(({ url }) => parseURL(url)?.searchParams.has('plain')));
  } finally {
    await fixture.close();
  }
});

test('redirect settlement waits for the final hop instead of a setup beacon', async () => {
  const entries = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    entries.push({ url: url.href, headers: req.headers });
    if (url.pathname === '/hop') {
      setTimeout(() => {
        res.writeHead(Number(url.searchParams.get('code')), {
          location: url.searchParams.get('to'),
        });
        res.end();
      }, 100);
    } else {
      res.writeHead(url.pathname === '/beacon' ? 204 : 200, {
        'content-type': 'text/html',
      });
      res.end('<!doctype html><title>redirect fixture</title>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fixture = {
    port: server.address().port,
    log: () => structuredClone(entries),
  };
  const browser = await launch(fixture);
  try {
    const vector = structuredClone(set.vectors.find(({ id }) => id === 'C2.chain-301-302-303'));
    vector.targets = ['seven'];
    vector.expected = { ...vector.control.expected };
    vector.liveCheck = { loaded: '{target}/doc?n={tag}', observer: 'fixture' };
    const execution = await run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.client,
        targets: origins(fixture),
        fixture,
      }
    );
    const row = execution.results[0];
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass');
    for (const side of ['control', 'guarded']) {
      assert.equal(row.observations[side].loaded, true);
      assert.equal(row.observations[side].hopped, true);
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a profile removal error is a warning rather than a failed browser close', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const script = `
    import { chmod, rm } from 'node:fs/promises';
    import { fixtureServer } from ${JSON.stringify(new URL('../../fixture-server.mjs', import.meta.url).href)};
    import { launch } from ${JSON.stringify(new URL('./cdp-client.mjs', import.meta.url).href)};
    const fixture = await fixtureServer();
    const browser = await launch(fixture);
    try {
      await chmod(browser.directory, 0o500);
      await browser.close();
      console.log('closed');
    } finally {
      await chmod(browser.directory, 0o700);
      await rm(browser.directory, { recursive: true, force: true });
      await fixture.close();
    }
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    { env }
  );
  assert.equal(stdout.trim(), 'closed');
  assert.match(stderr, /Warning: Chromium profile cleanup/);
});

test('concurrent Chromium close waits for exit and removes profiles once', async () => {
  const fixture = await fixtureServer();
  const browsers = await Promise.all(Array.from({ length: 3 }, () => launch(fixture)));
  try {
    await Promise.all(browsers.flatMap((browser) => [browser.close(), browser.close()]));
    for (const browser of browsers)
      await assert.rejects(access(browser.directory), { code: 'ENOENT' });
  } finally {
    await Promise.all(browsers.map((browser) => browser.close()));
    await fixture.close();
  }
});
