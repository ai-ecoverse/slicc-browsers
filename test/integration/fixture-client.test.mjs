import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { fixtureClient } from '../../fixture-client.mjs';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';

const registration = {
  path: '/registered-hop',
  to: 'https://vault.sliccy.ai/oauth/mcp-callback?code=fixture-marker#access_token=fixture-marker',
  code: 307,
  body: 'fixture-marker',
};

test('the bundled fixture serves CORS-safe redirect registration and append-only logs without adopter glue', async () => {
  const fixture = await fixtureServer();
  try {
    const client = fixtureClient(fixture.origin);
    const created = await fetch(`${fixture.origin}/redirect`, {
      method: 'POST',
      body: JSON.stringify(registration),
      headers: { origin: 'https://runner.example.test' },
    });
    assert.equal(created.status, 204);
    assert.equal(created.headers.get('access-control-allow-origin'), 'https://runner.example.test');
    const response = await fetch(`${fixture.origin}${registration.path}`, { redirect: 'manual' });
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), registration.to);
    assert.equal(response.headers.get('content-location'), registration.to);
    assert.equal(response.headers.get('refresh'), `0;url=${registration.to}`);
    assert.equal(response.headers.get('link'), `<${registration.to}>; rel=preconnect`);
    assert.equal(await response.text(), registration.body);
    const first = await client.log();
    assert.equal(first.length, 1);
    assert(first[0].url.endsWith(registration.path));
    fixture.reset();
    await fetch(`${fixture.origin}/data?n=after-reset`);
    const next = await client.log();
    assert.equal(next.length, 2);
    await client.redirectSecret({ path: registration.path, remove: true });
    assert.equal((await fetch(`${fixture.origin}${registration.path}`)).status, 404);
  } finally {
    await fixture.close();
  }
});

test('a missing redirect registration endpoint remains an explicit summary failure', async () => {
  const server = createServer((_, response) => {
    response.writeHead(404);
    response.end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const ordinary = `http://127.0.0.1:${server.address().port}`;
    const client = {
      events: [],
      messages: [],
      send: async (method) =>
        method === 'Target.attachToTarget' ? { sessionId: 'fake-session' } : {},
    };
    const check = { result: 'redirect', path: 'result.live', equals: true, observer: 'client' };
    const vector = {
      id: 'C2.redirect-secret',
      kind: 'cdp',
      scope: 'any',
      defaultContext: true,
      targets: ['ordinary'],
      setup: [],
      trigger: [{ redirectSecret: 'headers', as: 'redirect' }],
      observe: { live: { means: 'the registered redirect was served', check } },
      liveCheck: check,
      expected: { live: true },
      control: { origin: 'ordinary', via: 'unguarded', expected: { live: true } },
    };
    const execution = await run(
      { schemaVersion: 1, setVersion: '0.0.0', variants: { prompt: 0 }, vectors: [vector] },
      { client, unguarded: client, targets: { ordinary }, fixture: { log: async () => [] } }
    );
    assert.equal(execution.summary().pass, false);
    assert.equal(execution.results[0].control, 'fail');
    assert.equal(execution.results[0].guarded, 'fail');
    assert(
      execution.results[0].errors.some((error) =>
        error.includes(
          'redirectSecret fixture registration required: POST /redirect failed: HTTP 404'
        )
      )
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
