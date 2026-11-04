import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { summary as driverSummary } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';

const full = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const ids = ['E6.locale', 'E6.timezone'];
const methods = {
  'E6.locale': 'Emulation.setLocaleOverride',
  'E6.timezone': 'Emulation.setTimezoneOverride',
};
const trusted = {
  code: -32000,
  message: 'Locale override is only available to trusted clients',
};
const timezoneTrusted = {
  code: -32000,
  message: 'Timezone override is only available to trusted clients',
};
const errorFor = (id) => (id === 'E6.timezone' ? timezoneTrusted : trusted);
const failure = (cdp) => Object.assign(new Error(cdp.message), { cdp });

const targets = {
  ordinary: 'http://ordinary.test',
  seven: 'http://seven.test',
  vault: 'http://vault.test',
  'vault-x': 'http://x.vault.test',
  apex: 'http://apex.test',
  own: 'http://own.test',
  client: 'http://client.test',
  log: 'http://log.test',
};

const shrink = (vector) => ({
  ...vector,
  setup: vector.setup,
  trigger: vector.trigger.map((step) => (step.settle ? { settle: { ms: 1 } } : step)),
});

function browser({ emulation }) {
  const log = [];
  const pages = new Map();
  const sessions = new Map();
  let next = 0;
  let side = 'control';
  const overrides = new Map();
  const connect = () => {
    const client = { events: [], messages: [], transport: 'extension' };
    client.send = async (method, params = {}, sessionId) => {
      if (method === 'Target.createBrowserContext') return { browserContextId: `C${++next}` };
      if (method === 'Target.disposeBrowserContext') return {};
      if (method === 'Target.createTarget') {
        const targetId = `T${++next}`;
        pages.set(targetId, { url: params.url ?? 'about:blank' });
        return { targetId };
      }
      if (method === 'Target.attachToTarget') {
        const id = `S${++next}`;
        sessions.set(id, params.targetId);
        return { sessionId: id };
      }
      if (method === 'Target.detachFromTarget') {
        sessions.delete(params.sessionId);
        return {};
      }
      if (method === 'Target.closeTarget') {
        pages.delete(params.targetId);
        return { success: true };
      }
      if (method === 'Target.getTargetInfo') {
        const page = pages.get(params.targetId) ?? { url: 'about:blank' };
        return {
          targetInfo: {
            targetId: params.targetId,
            type: 'page',
            url: page.url,
            title: 'doc',
            attached: true,
          },
        };
      }
      if (method === 'Target.getTargets')
        return {
          targetInfos: [...pages].map(([targetId, page]) => ({
            targetId,
            type: 'page',
            url: page.url,
            title: 'doc',
          })),
        };
      if (method === 'Page.navigate') {
        const page = pages.get(sessions.get(sessionId));
        if (page) page.url = params.url;
        log.push({ url: params.url, headers: {}, time: Date.now() });
        const loaderId = `L${++next}`;
        client.events.push(
          {
            method: 'Page.frameNavigated',
            sessionId,
            params: { frame: { loaderId, url: params.url } },
          },
          { method: 'Page.loadEventFired', sessionId, params: {} }
        );
        return { loaderId };
      }
      if (method === 'Page.getFrameTree') {
        const page = pages.get(sessions.get(sessionId));
        return {
          frameTree: {
            frame: { id: 'F', loaderId: 'L', url: page?.url ?? 'about:blank' },
          },
        };
      }
      if (method === 'Emulation.setLocaleOverride' || method === 'Emulation.setTimezoneOverride') {
        const answer = emulation(side, method);
        if (answer === 'trusted')
          throw failure(errorFor(method.includes('Timezone') ? 'E6.timezone' : 'E6.locale'));
        if (answer === 'other') throw failure({ code: -32000, message: 'Internal error' });
        if (answer === 'refused') throw new Error('slicc: refused: emulation override');
        overrides.set(sessionId ?? 'page', method);
        return {};
      }
      if (method === 'Runtime.evaluate') {
        const page = pages.get(sessions.get(sessionId));
        const href = page?.url ?? '';
        if (params.expression?.includes('resolvedOptions().locale')) {
          const applied = [...overrides.values()].includes('Emulation.setLocaleOverride');
          return {
            result: {
              value: applied && href.includes('/doc?n=') ? 'fr-CH' : 'en-US',
            },
          };
        }
        if (params.expression?.includes('resolvedOptions().timeZone')) {
          const applied = [...overrides.values()].includes('Emulation.setTimezoneOverride');
          return {
            result: {
              value: applied && href.includes('/doc?n=') ? 'Pacific/Chatham' : 'UTC',
            },
          };
        }
        if (params.expression?.startsWith('location.href=')) {
          const url = JSON.parse(params.expression.slice('location.href='.length));
          if (page) page.url = url;
          log.push({ url, headers: {}, time: Date.now() });
          return { result: { value: url } };
        }
        if (params.expression === 'document.title') return { result: { value: 'doc' } };
        return { result: { value: true } };
      }
      return {};
    };
    return client;
  };
  return {
    log,
    connect,
    setSide: (value) => {
      side = value;
    },
  };
}

async function execute(id, emulation, listed = ['seven']) {
  const vector = shrink({
    ...full.vectors.find((v) => v.id === id),
    targets: listed,
  });
  const b = browser({ emulation });
  const client = b.connect();
  const unguarded = b.connect();
  const execution = await run(
    { ...full, vectors: [vector], variants: { prompt: 0 } },
    {
      client,
      unguarded,
      targets,
      fixture: { log: async () => b.log },
      capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
      settleScale: 0.001,
      debug: (data) => {
        if (data.side) b.setSide(data.side);
      },
    }
  );
  return execution;
}

for (const id of ids) {
  test(`${id}: Chrome's trusted-client error on the ordinary control is not-supported on every target`, async () => {
    const listed = ['seven', 'vault', 'vault-x', 'apex'];
    const execution = await execute(
      id,
      (_side, method) => (method === methods[id] ? 'trusted' : 'ok'),
      listed
    );
    assert.equal(execution.results.length, listed.length);
    for (const row of execution.results) {
      assert.equal(row.control, 'skip', JSON.stringify(row));
      assert.equal(row.guarded, 'skip', JSON.stringify(row));
      assert.equal(row.live, 'skip', JSON.stringify(row));
      assert.equal(row.reason, 'not-supported:trustedEmulation', JSON.stringify(row));
    }
    assert.deepEqual(execution.summary({ guard: 'fake', sha: 'test' }).forged, []);
  });

  test(`${id}: a trusted-client error only on the guarded leg fails as today`, async () => {
    const execution = await execute(id, (side, method) =>
      method === methods[id] ? (side === 'guarded' ? 'trusted' : 'ok') : 'ok'
    );
    const [row] = execution.results;
    assert.equal(row.control, 'fail', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.ok(
      row.errors.some((error) => /only available to trusted clients/i.test(error)),
      JSON.stringify(row.errors)
    );
  });

  test(`${id}: a different control error keeps today's fail verdict`, async () => {
    const execution = await execute(id, (_side, method) =>
      method === methods[id] ? 'other' : 'ok'
    );
    const [row] = execution.results;
    assert.equal(row.control, 'fail', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.ok(
      row.errors.some((error) => /Internal error/.test(error)),
      JSON.stringify(row.errors)
    );
    assert.equal(row.reason, undefined);
  });
}

test('forgeries accept not-supported:trustedEmulation only on locale and timezone rows', () => {
  const locale = full.vectors.find((v) => v.id === 'E6.locale');
  const other = full.vectors.find((v) => v.id === 'E6.ua-emulation');
  const skip = (vector, target) => ({
    id: vector.id,
    target,
    variant: 'prompt',
    transport: 'extension',
    control: 'skip',
    guarded: 'skip',
    live: 'skip',
    reason: 'not-supported:trustedEmulation',
  });
  const accepted = driverSummary({
    guard: 'fake',
    sha: 'test',
    set: { ...full, vectors: [locale], variants: { prompt: 0 } },
    results: locale.targets.map((target) => skip(locale, target)),
  });
  assert.deepEqual(accepted.forged, []);
  assert.equal(accepted.pass, true);
  const rejected = driverSummary({
    guard: 'fake',
    sha: 'test',
    set: { ...full, vectors: [other], variants: { prompt: 0 } },
    results: other.targets.map((target) => skip(other, target)),
  });
  assert.equal(rejected.pass, false);
  assert.ok(
    rejected.forged.every((row) =>
      row.why.includes('skip with a reason the runner never gives: not-supported:trustedEmulation')
    )
  );
});
