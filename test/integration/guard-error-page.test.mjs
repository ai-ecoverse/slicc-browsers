import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { protectedOrigins } from '../../protected.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const rules = JSON.parse(
  await readFile(new URL('../../catalog.json', import.meta.url))
).protectedOrigins;
const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vectors = data.vectors.filter((v) => v.trigger.some((s) => s.errorPage));

test('error-page exemption requires exact failed URL evidence and preserves the previous decision', () => {
  const matcher = protectedOrigins(rules);
  const target = {
    url: 'https://seven.sliccy.ai/path?secret=query#fragment',
    documentURL: rules.errorPage.url,
    unreachableURL: 'https://seven.sliccy.ai/path?secret=query#fragment',
  };
  assert.equal(matcher.target(target), false);
  assert.equal(matcher.target({ ...target, previous: true }), true);
  assert.equal(matcher.target({ ...target, navigating: true }), true);
  assert.equal(
    matcher.target({ ...target, unreachableURL: 'https://seven.sliccy.ai/other' }),
    true
  );
  assert.equal(matcher.target({ ...target, unreachableURL: undefined }), true);
  assert.equal(matcher.target({ ...target, documentURL: target.url }), true);
  assert.equal(matcher.target({ ...target, type: 'browser_ui' }), true);
});

test('protected error pages remain drivable and redacted; real and already-protected documents lock', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  try {
    for (const mode of ['catalog', 'target-url-only', 'unlock-error', 'plain']) {
      const browser = await launch(fixture);
      const guard =
        mode === 'plain'
          ? emulatedGuard(browser, { failDocumentOrigins: [origins(fixture).seven] })
          : emulatedGuard(browser, {
              protectedOrigins: rules,
              targetURLOnly: mode === 'target-url-only',
              unlockErrorPage: mode === 'unlock-error',
            });
      try {
        const execution = await run(
          { ...data, vectors, variants: { prompt: 0 } },
          {
            client: guard?.client ?? browser.client,
            unguarded: browser.unguarded,
            targets: origins(fixture),
            fixture,
            capabilities: { browserSession: true, browserContexts: true },
          }
        );
        for (const row of execution.results) {
          process.stdout.write(`${mode}: ${JSON.stringify(row)}\n`);
          assert.equal(row.control, 'pass', JSON.stringify(row));
          assert.equal(row.live, 'pass', JSON.stringify(row));
          assert.equal(
            row.guarded,
            mode === 'catalog' ||
              (mode === 'unlock-error' && row.id !== 'C8.protected-error-page-sticky')
              ? 'pass'
              : 'fail',
            JSON.stringify(row)
          );
          if (mode === 'target-url-only') assert.equal(row.observations.guarded.reload, false);
          if (mode === 'plain') assert.equal(row.observations.guarded.infoRedacted, false);
          if (mode === 'unlock-error' && row.id === 'C8.protected-error-page-sticky')
            assert.equal(row.observations.guarded.closeRefused, false);
        }
      } finally {
        await guard?.stop();
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
});
