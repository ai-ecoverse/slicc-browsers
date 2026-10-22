import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { connect, launch, origins } from './cdp-client.mjs';

export const published = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);

export const partitions = {
  ordinary: ['ordinary'],
  seven: ['seven'],
  vault: ['vault'],
  'vault-x': ['vault-x'],
  apex: ['apex'],
  others: [
    'own',
    'chrome-newtab',
    'chrome-new-tab-page',
    'chrome-settings',
    'chrome-passwords',
    'chrome-search',
    'network-error',
    'chrome-extension-page',
    'file-root',
  ],
};

export const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  chromeUrlsAttach: true,
  extensionWorld: true,
  discovery: true,
  clientExit: true,
  siteIsolationOff: true,
};

export const drivable = new Set([
  'C8.newtab',
  'C8.network-error',
  'C8.iframe-error',
  'C9.page-drivable',
  'X1.after-exit',
]);

export const repeats = 2;

const key = (row) => JSON.stringify([row.id, row.target, row.variant]);

export function selection(set, target) {
  return {
    ...set,
    vectors: set.vectors
      .filter((vector) => vector.targets.includes(target))
      .map((vector) => ({ ...vector, targets: [target] })),
  };
}

export function rowsFor(set, targets) {
  return set.vectors.flatMap((vector) =>
    vector.targets
      .filter((target) => targets.includes(target))
      .flatMap((target) =>
        Object.keys(set.variants).map((variant) => ({ id: vector.id, target, variant }))
      )
  );
}

export function expectedSkip(vector, target) {
  const missing = (vector.requires ?? []).find((capability) => capabilities[capability] !== true);
  if (missing) return `not-supported:${missing}`;
  if (vector.skip?.target === target) return vector.skip.reason;
  if (vector.observable?.[target] === false) return 'not-applicable';
  if (vector.scope !== 'any') return 'not-applicable';
  return null;
}

function rowProblem(vector, row) {
  const legs = [row.control, row.guarded, row.live];
  const shown = `${legs.join('/')}${row.reason ? ` (${row.reason})` : ''}`;
  if (!vector) return `is not a published vector: ${shown}`;
  if (vector.kind === 'text')
    return legs.every((leg) => leg === 'not-run') ? null : `is a text vector but ${shown}`;
  const skip = expectedSkip(vector, row.target);
  if (skip)
    return legs.every((leg) => leg === 'skip') && row.reason === skip
      ? null
      : `must skip with "${skip}" but is ${shown}`;
  if (legs.some((leg) => leg === 'skip' || leg === 'not-run'))
    return `declares no skip but is ${shown}`;
  const guarded = drivable.has(vector.id) ? 'pass' : 'fail';
  if (row.control === 'pass' && row.live === 'pass' && row.guarded === guarded) return null;
  return `must be pass/${guarded}/pass without a guard but is ${shown}${row.why ? `: ${row.why}` : ''}`;
}

export function verdictProblems(set, targets, results) {
  const vectors = new Map(set.vectors.map((vector) => [vector.id, vector]));
  const problems = [];
  const seen = new Map();
  for (const row of results) seen.set(key(row), (seen.get(key(row)) ?? 0) + 1);
  for (const row of rowsFor(set, targets)) {
    const count = seen.get(key(row)) ?? 0;
    if (count !== 1) problems.push(`${row.id} ${row.target} ${row.variant} ran ${count} times`);
    seen.delete(key(row));
  }
  for (const extra of seen.keys()) problems.push(`${JSON.parse(extra).join(' ')} is not selected`);
  for (const row of results) {
    const problem = rowProblem(vectors.get(row.id), row);
    if (problem) problems.push(`${row.id} ${row.target} ${row.variant} ${problem}`);
  }
  for (const target of targets)
    if (!results.some((row) => row.target === target && row.control === 'pass'))
      problems.push(`${target}: no row ran, so the sweep proved nothing`);
  return problems;
}

async function factory(fixture, browsers, timeouts) {
  let shared;
  const clientFactory = async ({ slot, vector }) => {
    const browser = vector.requires?.includes('siteIsolationOff')
      ? await (shared ??= launch(fixture, { isolation: false }))
      : browsers[slot];
    const raw = await connect(browser.ws);
    const client = /^E[46]\b/.test(vector.id)
      ? {
          ...raw,
          send: (method, params, sessionId) =>
            raw.send(method, params, sessionId).catch((error) => {
              if (/timed out/i.test(error.message)) timeouts.push(`${vector.id}: ${method}`);
              throw error;
            }),
        }
      : raw;
    if (!vector.requires?.includes('clientExit'))
      return { client, unguarded: client, close: () => client.close() };
    const unguarded = await connect(browser.ws);
    return {
      client,
      unguarded,
      close: () => {
        client.close();
        unguarded.close();
      },
    };
  };
  return { clientFactory, shared: () => shared?.catch(() => undefined) };
}

async function once(name, fixture) {
  const set = selection(published, name);
  const width = name === 'ordinary' ? 2 : 6;
  const browsers = await Promise.all(Array.from({ length: width }, () => launch(fixture)));
  const timeouts = [];
  const made = await factory(fixture, browsers, timeouts);
  try {
    const execution = await run(set, {
      clientFactory: made.clientFactory,
      targets: origins(fixture),
      capabilities,
      parallel: width,
      variant: Object.keys(published.variants),
      fixture,
    });
    return { set, execution, timeouts };
  } finally {
    await Promise.all(
      [...browsers, await made.shared()].filter(Boolean).map((browser) => browser.close())
    );
  }
}

async function target(name, repeat, fixture) {
  const begun = Date.now();
  const { set, execution, timeouts } = await once(name, fixture);
  const { results } = execution;
  const summary = execution.summary({ guard: 'reference' });
  const problems = [
    ...verdictProblems(set, [name], results),
    ...summary.missing.map((row) => `${row.id} ${row.target} ${row.variant} is missing`),
    ...summary.forged.map((row) => `${row.id} ${row.target} ${row.variant} ${row.why}`),
    ...timeouts.map((call) => `${call} timed out`),
  ].map((problem) => `repeat ${repeat + 1}: ${problem}`);
  const ran = results.filter((row) => row.control === 'pass').length;
  const failing = results.filter((row) => row.guarded === 'fail').length;
  const skipped = results.filter((row) => row.control === 'skip').length;
  const line = `${name} repeat ${repeat + 1}: controls pass ${ran}/${results.length}, guarded without a guard fail ${failing}, skipped ${skipped}, ${problems.length} problems, ${Date.now() - begun}ms`;
  process.stdout.write(`${line}\n`);
  return { target: name, repeat, line, counts: summary.counts, problems, results };
}

export async function sweep(partition) {
  const started = Date.now();
  const runs = [];
  try {
    for (const name of partitions[partition]) {
      const fixture = await fixtureServer();
      try {
        for (let repeat = 0; repeat < repeats; repeat++)
          runs.push(await target(name, repeat, fixture));
      } finally {
        await fixture.close();
      }
    }
  } finally {
    const directory = new URL('../../artifacts/', import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(
      new URL(`guard-sweep-${partition}.json`, directory),
      `${JSON.stringify({ partition, ms: Date.now() - started, runs }, null, 2)}\n`
    );
  }
  assert.deepEqual(
    runs.flatMap((run) => run.problems),
    []
  );
}
