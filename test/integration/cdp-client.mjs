import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { EXTENSION_ID, EXTENSION_PATH } from '@ai-ecoverse/slicc-shared-web/harness';
import { chromium } from 'playwright-core';

const running = new Set();

function killGroup(child, signal = 'SIGKILL') {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function reap() {
  const entries = [...running];
  for (const entry of entries) {
    killGroup(entry.child);
    if (entry.watchdog) killGroup(entry.watchdog);
  }
  const remove = () => {
    for (const entry of entries)
      rmSync(entry.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  remove();
  if (entries.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  remove();
  running.clear();
}

process.on('exit', reap);
process.on('uncaughtExceptionMonitor', reap);
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  process.on(signal, () => {
    reap();
    process.exit(code);
  });
}

function watchdog(child, directory) {
  if (!child.pid || process.platform === 'win32') return;
  const dog = spawn(
    'sh',
    [
      '-c',
      'read -r _; kill -9 -"$1" "$1" 2>/dev/null; sleep 0.2; rm -rf -- "$2"',
      'slicc-guard-watchdog',
      String(child.pid),
      directory,
    ],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore'] }
  );
  dog.on('error', () => {});
  dog.stdin.on('error', () => {});
  dog.unref();
  dog.stdin.unref?.();
  return dog;
}

export async function launch(fixture, { spki, signal, allowOrigin, isolation = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'slicc-guard-'));
  const child = spawn(
    chromium.executablePath(),
    [
      '--headless',
      '--use-mock-keychain',
      ...(allowOrigin
        ? [
            `--remote-allow-origins=${allowOrigin}`,
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
          ]
        : []),
      ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
      '--no-sandbox',
      '--disable-gpu',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${directory}`,
      '--no-proxy-server',
      ...(isolation ? ['--site-per-process'] : ['--disable-site-isolation-trials']),
      `--disable-features=${isolation ? '' : 'IsolateOrigins,site-per-process,OriginKeyedProcessesByDefault,'}HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LocalNetworkAccessChecks,LocalNetworkAccessRestrictions,LocalNetworkAccessChecksWebRTC,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults`,
      `--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1:${fixture.port}, MAP sliccy.ai 127.0.0.1:${fixture.port}, MAP *.example.test 127.0.0.1:${fixture.port}, MAP *.control.test 127.0.0.1:${fixture.port}`,
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' }
  );
  const entry = { child, directory, watchdog: watchdog(child, directory) };
  running.add(entry);
  let failure;
  child.on('error', (error) => {
    failure = error;
  });
  let closing;
  const close = () =>
    (closing ??= (async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        killGroup(child, 'SIGTERM');
        const timer = setTimeout(() => killGroup(child), 5000);
        await exited;
        clearTimeout(timer);
      }
      killGroup(child);
      if (entry.watchdog) killGroup(entry.watchdog);
      signal?.removeEventListener('abort', abort);
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        running.delete(entry);
      } catch (error) {
        process.stderr.write(`Warning: Chromium profile cleanup ${directory}: ${error.message}\n`);
      }
    })());
  let client;
  let unguarded;
  const abort = () => {
    client?.close();
    unguarded?.close();
    void close();
  };
  if (process.env.NODE_TEST_CONTEXT)
    after(async () => {
      client?.close();
      unguarded?.close();
      await close();
    });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const deadline = Date.now() + 15000;
    let endpoint;
    while (!endpoint) {
      signal?.throwIfAborted();
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
    client = await connect(endpoint);
    const loaded = await client.send('Extensions.loadUnpacked', { path: EXTENSION_PATH });
    if (loaded.id !== EXTENSION_ID) {
      client.close();
      throw new Error(`harness extension loaded as ${loaded.id}`);
    }
    unguarded = await connect(endpoint);
    signal?.throwIfAborted();
    return {
      pid: child.pid,
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
    client?.close();
    unguarded?.close();
    await close();
    throw error;
  }
}

export async function connect(url, { inbound, outbound } = {}) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const waiters = new Set();
  const events = [];
  const messages = [];
  const deliver = (data, message) => {
    messages.push(String(data));
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
  };
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const dispatch = () => deliver(data, message);
    if (inbound)
      inbound(message, dispatch, message.sessionId ?? pending.get(message.id)?.sessionId);
    else dispatch();
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
    messages,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const seq = ++id;
        const timer = setTimeout(() => {
          pending.delete(seq);
          reject(new Error(`CDP timed out: ${method}`));
        }, 10000);
        pending.set(seq, { resolve, reject, timer, sessionId });
        outbound?.({ id: seq, method, params, sessionId, sentAt: Date.now() });
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
