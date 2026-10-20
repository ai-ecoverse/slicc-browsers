import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { launch, origins } from './cdp-client.mjs';

const root = new URL('../../', import.meta.url);
const data = JSON.parse(await readFile(new URL('guard-vectors.json', root)));
const tls = {
  key: await readFile(new URL('./fixtures/tls-key.pem', import.meta.url)),
  cert: await readFile(new URL('./fixtures/tls-cert.pem', import.meta.url)),
};
const spki = createHash('sha256')
  .update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');

async function scenario(options) {
  let socket;
  try {
    if (typeof globalThis.Buffer !== 'undefined')
      throw new Error('the browser page must not have a Buffer shim');
    const { run } = await import(`${options.moduleBase}/guard-runner.mjs`);
    const { containsSecret } = await import(`${options.moduleBase}/redirect-secret.mjs`);
    socket = new WebSocket(options.endpoint);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    const client = {
      events: [],
      messages: [],
      send: (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
          const sequence = ++id;
          pending.set(sequence, { resolve, reject });
          socket.send(
            JSON.stringify({ id: sequence, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        }),
    };
    socket.onmessage = ({ data }) => {
      client.messages.push(String(data));
      const message = JSON.parse(data);
      if (!message.id) return client.events.push(message);
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message);
        error.cdp = message.error;
        entry.reject(error);
      } else entry.resolve(message.result);
    };
    const marker = 'browser-雪';
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(marker)));
    const execution = await run(options.set, {
      client,
      unguarded: client,
      fixtureBase: options.fixtureBase,
      targets: options.targets,
      capabilities: { browserSession: true },
    });
    globalThis.browserEvidence = {
      results: execution.results,
      encoded: containsSecret(encoded, marker),
      buffer: typeof globalThis.Buffer,
    };
  } catch (error) {
    globalThis.browserEvidence = { error: error.message, stack: error.stack };
  } finally {
    socket?.close();
  }
}

test('a real browser page runs C2 body controls with no Node shim and the auto-registered bundled fixture', {
  timeout: 180000,
}, async (context) => {
  const fixture = await fixtureServer({ tls });
  const modules = createServer(async (request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>browser runner</title>');
      return;
    }
    if (!/^\/[a-z-]+\.mjs$/.test(request.url)) {
      response.writeHead(404);
      response.end('missing');
      return;
    }
    try {
      const source = await readFile(new URL(request.url.slice(1), root));
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(source);
    } catch {
      response.writeHead(404);
      response.end('missing');
    }
  });
  await new Promise((resolve) => modules.listen(0, '127.0.0.1', resolve));
  const moduleBase = `http://127.0.0.1:${modules.address().port}`;
  let browser;
  try {
    browser = await launch(fixture, { spki, allowOrigin: moduleBase, signal: context.signal });
    const reader = browser.unguarded;
    const { targetId } = await reader.send('Target.createTarget', {
      url: moduleBase,
      newWindow: true,
    });
    const { sessionId } = await reader.send('Target.attachToTarget', { targetId, flatten: true });
    const options = {
      moduleBase,
      endpoint: browser.ws,
      fixtureBase: fixture.origin,
      set: {
        ...data,
        vectors: data.vectors.filter((vector) => vector.id === 'C2.redirect-body'),
        variants: { prompt: 0 },
      },
      targets: Object.fromEntries(
        Object.entries(origins(fixture)).map(([key, origin]) => [
          key,
          origin.replace(`:${fixture.port}`, ''),
        ])
      ),
    };
    await reader.send(
      'Runtime.evaluate',
      { expression: `(${scenario.toString()})(${JSON.stringify(options)})` },
      sessionId
    );
    const deadline = Date.now() + 150000;
    let evidence;
    while (!evidence && Date.now() < deadline) {
      const result = await reader.send(
        'Runtime.evaluate',
        { expression: 'globalThis.browserEvidence', returnByValue: true },
        sessionId
      );
      evidence = result.result?.value;
      if (!evidence) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(evidence, 'browser-page runner did not finish');
    assert.equal(evidence.error, undefined, JSON.stringify(evidence));
    assert.equal(evidence.buffer, 'undefined');
    assert.equal(evidence.encoded, true);
    assert.equal(evidence.results.length, 1);
    assert.equal(evidence.results[0].control, 'pass', JSON.stringify(evidence));
    assert.equal(evidence.results[0].guarded, 'fail', JSON.stringify(evidence));
    assert.equal(evidence.results[0].live, 'pass', JSON.stringify(evidence));
  } finally {
    await browser?.close();
    await fixture.close();
    await new Promise((resolve) => modules.close(resolve));
  }
});
