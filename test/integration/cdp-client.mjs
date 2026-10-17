import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

export async function launch(fixture, { spki } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'slicc-guard-'));
  const child = spawn(
    chromium.executablePath(),
    [
      '--headless',
      '--use-mock-keychain',
      ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${directory}`,
      '--no-proxy-server',
      '--site-per-process',
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LocalNetworkAccessChecks,LocalNetworkAccessRestrictions,LocalNetworkAccessChecksWebRTC,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults',
      `--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1:${fixture.port}, MAP sliccy.ai 127.0.0.1:${fixture.port}, MAP *.example.test 127.0.0.1:${fixture.port}, MAP *.control.test 127.0.0.1:${fixture.port}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let failure;
  child.on('error', (error) => {
    failure = error;
  });
  let closing;
  const close = () =>
    (closing ??= (async () => {
      if (child.pid && child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
      }
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        process.stderr.write(`Warning: Chromium profile cleanup ${directory}: ${error.message}\n`);
      }
    })());
  try {
    const deadline = Date.now() + 15000;
    let endpoint;
    while (!endpoint) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error('Chromium exited before CDP startup');
      if (Date.now() > deadline) throw new Error('Chromium CDP startup timed out');
      try {
        const [port, path] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8'))
          .trim()
          .split('\n');
        if (Number(port) > 0 && path) endpoint = `ws://127.0.0.1:${port}${path}`;
      } catch {}
      if (!endpoint) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const client = await connect(endpoint);
    const unguarded = await connect(endpoint);
    return {
      client,
      unguarded,
      ws: endpoint,
      directory,
      close: async () => {
        client.close();
        unguarded.close();
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const waiters = new Set();
  const events = [];
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(message.error.message);
        error.cdp = message.error;
        entry.reject(error);
      } else entry.resolve(message.result);
    } else {
      events.push(message);
      for (const waiter of waiters)
        if (waiter.pred(message)) {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          waiter.resolve(message);
        }
    }
  });
  ws.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP closed'));
    }
    pending.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('CDP closed'));
    }
    waiters.clear();
  });
  return {
    events,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const seq = ++id;
        const timer = setTimeout(() => {
          pending.delete(seq);
          reject(new Error(`CDP timed out: ${method}`));
        }, 10000);
        pending.set(seq, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: seq, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    waitEvent: (pred, ms) =>
      new Promise((resolve, reject) => {
        const entry = { pred, resolve, reject, timer: undefined };
        entry.timer = setTimeout(() => {
          waiters.delete(entry);
          reject(new Error('Event timed out'));
        }, ms);
        waiters.add(entry);
      }),
    close: () => ws.close(),
  };
}

export function origins(fixture) {
  const origin = (host) =>
    `${new URL(fixture.origin ?? 'http://127.0.0.1').protocol}//${host}:${fixture.port}`;
  return {
    ordinary: origin('ordinary.example.test'),
    'ordinary-same-site': origin('ordinary.sliccy.ai'),
    plain: origin('ordinary.example.test'),
    cross: origin('cross.example.test'),
    seven: origin('seven.sliccy.ai'),
    vault: origin('vault.sliccy.ai'),
    'vault-x': origin('vault-x.sliccy.ai'),
    apex: origin('sliccy.ai'),
    own: origin('client.example.test'),
    client: origin('client.example.test'),
    log: origin('log.example.test'),
  };
}
