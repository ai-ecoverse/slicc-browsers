import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export async function browserRunner(entry) {
  if (!vm.SourceTextModule) throw new Error('browser-runner: run with --experimental-vm-modules');
  const context = vm.createContext({
    URL,
    URLSearchParams,
    atob,
    btoa,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    fetch,
  });
  const modules = new Map();
  const module = (path) => {
    if (modules.has(path)) return modules.get(path);
    const source = readFileSync(path, 'utf8');
    const forbidden =
      /\b(Buffer|process|require|__dirname|__filename|setImmediate|clearImmediate)\b/.exec(source);
    if (forbidden) throw new Error(`${basename(path)}: Node-only global ${forbidden[1]}`);
    if (/\bimport\s*\(/.test(source))
      throw new Error(`${basename(path)}: dynamic imports cannot be verified`);
    const value = new vm.SourceTextModule(source, { context, identifier: path });
    modules.set(path, value);
    return value;
  };
  const root = module(resolve(entry));
  await root.link((specifier, parent) => {
    if (!specifier.startsWith('./') && !specifier.startsWith('../'))
      throw new Error(`${basename(parent.identifier)}: non-browser import ${specifier}`);
    return module(resolve(dirname(parent.identifier), specifier));
  });
  await root.evaluate();
  const marker = 'browser-marker-雪';
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(`prefix ${marker} suffix`)));
  const redirect = modules.get(resolve(dirname(entry), 'redirect-secret.mjs'));
  if (!redirect?.namespace.containsSecret(encoded, marker))
    throw new Error('browser-runner: encoded body exercise failed');
  const events = [];
  const client = {
    events,
    send: async (method) => {
      if (method === 'Target.createTarget') return { targetId: 'page' };
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId: 'page', url: 'about:blank' } };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Page.navigate') {
        events.push(
          {
            method: 'Page.frameNavigated',
            sessionId: 'session',
            params: { frame: { loaderId: 'loader' } },
          },
          { method: 'Page.loadEventFired', sessionId: 'session' }
        );
        return { loaderId: 'loader' };
      }
      if (method === 'Runtime.evaluate') return { result: { value: 'browser' } };
      return {};
    },
  };
  const check = {
    result: 'title',
    path: 'result.result.value',
    equals: 'browser',
    observer: 'client',
  };
  const vector = {
    id: 'browser.page',
    family: 'C',
    kind: 'cdp',
    scope: 'any',
    targets: ['ordinary'],
    setup: [{ page: 'tab', url: '{ordinary}/doc' }],
    trigger: [{ cdp: 'Runtime.evaluate', params: { expression: 'document.title' }, as: 'title' }],
    observe: { title: { means: 'browser page remains drivable', check } },
    liveCheck: check,
    expected: { title: true },
    control: { origin: 'ordinary', via: 'unguarded', expected: { title: true } },
  };
  const execution = await root.namespace.run(
    { schemaVersion: 1, setVersion: '0.0.0', vectors: [vector], variants: { prompt: 0 } },
    {
      client,
      unguarded: client,
      fixture: { log: async () => [] },
      targets: { ordinary: 'https://ordinary.example.test' },
    }
  );
  if (!execution.summary().pass)
    throw new Error(`browser-runner: page row failed ${JSON.stringify(execution.results)}`);
  return modules.size;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const count = await browserRunner(
      process.argv[2] ?? fileURLToPath(new URL('../guard-runner.mjs', import.meta.url))
    );
    process.stdout.write(
      `browser-runner: PASS ${count} modules, encoded bodies and browser page row\n`
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
