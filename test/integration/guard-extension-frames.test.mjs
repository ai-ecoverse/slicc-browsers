import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_EXTENSION_WORLD_ID } from '../../extension-world.mjs';
import { fixtureServer } from '../../fixture-server.mjs';
import { summary as driverSummary } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { protectedOrigins } from '../../protected.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const vectors = set.vectors.filter((vector) => vector.id.startsWith('C9.frame-'));
const frames = catalog.protectedOrigins.extensionFrames;
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  chromeUrlsAttach: true,
  extensionFrame: true,
};

test('extensionFrame matches only foreign chrome-extension: frames', () => {
  const own = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const is = protectedOrigins(catalog.protectedOrigins, [own]);
  assert.equal(
    is.extensionFrame('chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/x.html'),
    true
  );
  assert.equal(is.extensionFrame(`${own}/frame.html`), false);
  assert.equal(is.extensionFrame('https://vault.sliccy.ai/'), false);
  assert.equal(is.extensionFrame('chrome://settings/'), false);
  assert.equal(is.extensionFrame('not a url'), false);
  assert.equal(is.url('chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/x.html'), true);
  assert.equal(is.url(`${own}/frame.html`), true);
});

test('extension-frame rows skip transports that do not declare extensionFrame', async () => {
  const fixture = await fixtureServer();
  try {
    const client = { events: [], send: async () => assert.fail('unsupported transport sent CDP') };
    for (const declared of [{}, { extensionWorld: true }, { extensionFrame: false }]) {
      const execution = await run(
        { ...set, vectors, variants: { prompt: 0 } },
        { client, unguarded: client, fixture, targets: origins(fixture), capabilities: declared }
      );
      assert.equal(execution.results.length, vectors.length);
      for (const row of execution.results) {
        assert.equal(row.guarded, 'skip');
        assert.equal(row.reason, 'not-supported:extensionFrame');
      }
      assert.equal(
        execution.summary({ guard: 'reference', sha: 'test' }).pass,
        true,
        'skips without declaring the capability still pass'
      );
    }
  } finally {
    await fixture.close();
  }
});

test('forgeries reject not-supported:extensionFrame when the run declared the capability', () => {
  const one = { ...set, vectors: vectors.slice(0, 1), variants: { prompt: 0 } };
  const skipped = one.vectors.flatMap((vector) =>
    vector.targets.map((target) => ({
      id: vector.id,
      target,
      variant: 'prompt',
      transport: 'cdp',
      control: 'skip',
      guarded: 'skip',
      live: 'skip',
      reason: 'not-supported:extensionFrame',
    }))
  );
  const forged = driverSummary({
    guard: 'fake',
    sha: 'test',
    set: one,
    results: skipped,
    capabilities: { extensionFrame: true },
  });
  assert.equal(forged.pass, false);
  assert.ok(
    forged.forged.every((row) =>
      row.why.includes('not-supported:extensionFrame while the run declared extensionFrame')
    )
  );
  const honest = driverSummary({
    guard: 'fake',
    sha: 'test',
    set: one,
    results: skipped,
    capabilities: {},
  });
  assert.equal(honest.pass, true);
  assert.deepEqual(honest.forged, []);
});

test('extension-frame rows reject missing evidence and unsafe capture or attachment paths', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const cases = [
    { name: 'auto-attach', options: { exposeExtensionFrames: true }, observation: 'autoAttached' },
    { name: 'PDF', options: { exposeFramePDF: true }, observation: 'pdf' },
    {
      name: 'page-read leak',
      options: { exposeFramePageReads: true },
      observation: 'evaluateLeak',
    },
    { name: 'snapshot content', marker: true, observation: 'snapshotFrameRead' },
    { name: 'snapshot document', document: true, observation: 'snapshotFrameRead' },
    { name: 'snapshot src', src: true, observation: 'snapshotFrameRead' },
    { name: 'missing target list', listing: {}, incomplete: true },
    { name: 'malformed target list', listing: { targetInfos: {} }, incomplete: true },
    { name: 'dropped target info', dropInfo: true, incomplete: true },
    { name: 'HeadlessExperimental gate', beginFrame: true },
    {
      name: 'input while hidden',
      options: { frameInput: 'ignored' },
      observation: 'click',
      onlyHidden: true,
    },
  ];
  try {
    for (const mode of cases) {
      const guard = emulatedGuard(browser, {
        protectedOrigins: catalog.protectedOrigins,
        extensionFrames: true,
        ...mode.options,
      });
      let began = false;
      const client = {
        ...guard.client,
        async send(method, params, session) {
          if (mode.beginFrame && method === 'Page.printToPDF') {
            await assert.rejects(
              guard.client.send(
                'HeadlessExperimental.beginFrame',
                { screenshot: { format: 'png' } },
                session
              ),
              { message: frames.presentRefusal }
            );
            began = true;
          }
          if (mode.dropInfo && method === 'Target.getTargetInfo')
            throw new Error('Target.getTargetInfo dropped');
          const answer = await guard.client.send(method, params, session);
          if (method === 'Target.getTargets' && mode.listing) return mode.listing;
          if (method === 'DOMSnapshot.captureSnapshot') {
            if (mode.marker) answer.strings.push('slicc-private-extension-frame-content');
            if (mode.document) {
              answer.documents.push({ documentURL: answer.strings.length });
              answer.strings.push(`chrome-extension://${DEFAULT_EXTENSION_WORLD_ID}/frame.html`);
            }
            if (mode.src) {
              answer.strings.push(
                `chrome-extension://${DEFAULT_EXTENSION_WORLD_ID}/frame.html?username=slicc-frame-test-user`
              );
            }
          }
          return answer;
        },
      };
      try {
        const subset = mode.onlyHidden
          ? vectors.filter((vector) => vector.id === 'C9.frame-hidden')
          : vectors.slice(0, 1);
        const execution = await run(
          { ...set, vectors: subset, variants: { prompt: 0 } },
          {
            client,
            unguarded: browser.unguarded,
            fixture,
            targets: origins(fixture),
            capabilities,
            rowTimeoutMs: 60000,
          }
        );
        const row = execution.results[0];
        assert.equal(row.control, 'pass', JSON.stringify({ mode, row }));
        assert.equal(
          row.guarded,
          mode.incomplete ? 'incomplete' : mode.beginFrame ? 'pass' : 'fail',
          JSON.stringify({ mode, row })
        );
        if (mode.observation)
          assert.equal(row.observations.guarded[mode.observation], true, mode.name);
        if (mode.incomplete) {
          assert.match(
            row.incomplete.join('; '),
            /Target\.(getTargets returned no targetInfos array|getTargetInfo failed)/
          );
          assert.equal(execution.summary().incomplete, 1);
        }
        if (mode.beginFrame) assert.equal(began, true);
        assert.equal(execution.summary().pass, Boolean(mode.beginFrame));
      } finally {
        await guard.stop();
      }
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});

const expectations = {
  catalog: () => 'pass',
  'whole tab': () => 'fail',
  plain: () => 'fail',
  'visibility ignored': (id) =>
    ['C9.frame-hidden', 'C9.frame-concealed', 'C9.frame-revealed'].includes(id) ? 'pass' : 'fail',
  'opacity counts as hidden': (id) => (id === 'C9.frame-transparent' ? 'fail' : 'pass'),
  'input while hidden': () => 'fail',
};

test('extension-frame rows: only the catalog rule passes', { timeout: 600000 }, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    for (const [mode, expected] of Object.entries(expectations)) {
      const guard =
        mode === 'plain'
          ? { client: browser.client, stop: async () => {} }
          : emulatedGuard(browser, {
              protectedOrigins: catalog.protectedOrigins,
              extensionFrames: mode !== 'whole tab',
              frameVisibility:
                mode === 'visibility ignored'
                  ? 'ignored'
                  : mode === 'opacity counts as hidden'
                    ? 'opacity'
                    : undefined,
              frameInput: mode === 'input while hidden' ? 'ignored' : undefined,
            });
      try {
        const execution = await run(
          { ...set, vectors, variants: { prompt: 0 } },
          {
            client: guard.client,
            unguarded: browser.unguarded,
            fixture,
            targets: origins(fixture),
            capabilities,
            rowTimeoutMs: 60000,
          }
        );
        for (const row of execution.results) {
          assert.equal(row.control, 'pass', JSON.stringify({ mode, row }));
          assert.equal(row.guarded, expected(row.id), JSON.stringify({ mode, row }));
          if (row.guarded === 'pass') assert.equal(row.live, 'pass', JSON.stringify({ mode, row }));
          if (mode === 'catalog' && row.guarded === 'pass') {
            for (const key of [
              'archiveRefusal',
              'pdfRefusal',
              'castRefusal',
              'clickRefusal',
              'keyRefusal',
              'tabRefusal',
            ])
              assert.equal(row.observations.guarded[key], true, `${row.id} ${key}`);
          }
        }
        assert.equal(execution.summary().pass, mode === 'catalog');
      } finally {
        await guard.stop();
      }
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('seven vault and own-extension URLs stay protected while foreign extension frames are exempt', () => {
  const own = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const foreign = 'chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/completion_list.html';
  const withOwn = protectedOrigins(catalog.protectedOrigins, [own]);
  const plain = protectedOrigins(catalog.protectedOrigins);
  assert.equal(plain.extensionFrame(foreign), true);
  assert.equal(plain.url(foreign), true);
  assert.equal(withOwn.extensionFrame(`${own}/frame.html`), false);
  assert.equal(withOwn.url(`${own}/frame.html`), true);
  assert.equal(plain.url('https://seven.sliccy.ai/'), true);
  assert.equal(plain.extensionFrame('https://seven.sliccy.ai/'), false);
  assert.equal(plain.url('https://vault.sliccy.ai/'), true);
  assert.equal(plain.extensionFrame('https://vault.sliccy.ai/'), false);
  assert.equal(
    Boolean(frames.inputWhilePresent?.length) &&
      frames.whenShown.includes('Page.captureScreenshot') &&
      !frames.whenShown.some((method) => method.startsWith('Input.')),
    true
  );
});
