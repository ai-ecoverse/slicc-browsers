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
const sticky = (id) => id.startsWith('C8.protected-error-page-sticky');
const lockedIds = new Set([
  'C8.protected-document-restore',
  'C8.protected-error-page-sticky',
  'C8.protected-error-page-sticky.query',
  'C8.protected-error-page-sticky.fragment',
]);

const locked = ({ observations: { guarded } }) => ({
  closed: guarded.closed,
  closeRefused: guarded.closeRefused,
  evaluateRefused: guarded.evaluateRefused,
  attachRefused: guarded.attachRefused,
});

const caps = (extra = {}) => ({
  browserSession: true,
  browserContexts: true,
  discovery: true,
  ...extra,
});

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
    for (const mode of [
      'catalog',
      'close-protected',
      'refuse-close',
      'target-url-only',
      'unlock-error',
      'plain',
      'unblocked',
    ]) {
      const browser = await launch(fixture);
      const declaresClose = mode === 'close-protected' || mode === 'refuse-close';
      const guard =
        mode === 'unblocked'
          ? undefined
          : mode === 'plain'
            ? emulatedGuard(browser, { failDocumentOrigins: [origins(fixture).seven] })
            : emulatedGuard(browser, {
                protectedOrigins: rules,
                targetURLOnly: mode === 'target-url-only',
                unlockErrorPage: mode === 'unlock-error',
                closeProtected: declaresClose,
                refuseClose: mode === 'refuse-close',
              });
      try {
        const execution = await run(
          { ...data, vectors, variants: { prompt: 0 } },
          {
            client: guard?.client ?? browser.client,
            unguarded: browser.unguarded,
            targets: origins(fixture),
            fixture,
            capabilities: caps(declaresClose ? { closeProtected: true } : {}),
          }
        );
        for (const row of execution.results) {
          process.stdout.write(`${mode}: ${JSON.stringify(row)}\n`);
          assert.equal(row.control, 'pass', JSON.stringify(row));
          assert.equal(row.live, mode === 'unblocked' ? 'fail' : 'pass', JSON.stringify(row));
          assert.equal(
            row.guarded,
            mode === 'catalog' ||
              mode === 'close-protected' ||
              (mode === 'unlock-error' && !sticky(row.id)) ||
              (mode === 'refuse-close' && !lockedIds.has(row.id))
              ? 'pass'
              : 'fail',
            JSON.stringify(row)
          );
          if (mode === 'refuse-close' && lockedIds.has(row.id))
            assert.deepEqual(locked(row), {
              closed: false,
              closeRefused: 'not-supported',
              evaluateRefused: true,
              attachRefused: true,
            });
          if (mode === 'target-url-only') assert.equal(row.observations.guarded.reload, false);
          if (mode === 'plain') assert.equal(row.observations.guarded.infoRedacted, false);
          if (mode === 'unlock-error' && sticky(row.id))
            assert.equal(row.observations.guarded.attachRefused, false);
          if (mode === 'catalog' && lockedIds.has(row.id))
            assert.deepEqual(locked(row), {
              closed: 'not-supported',
              closeRefused: true,
              evaluateRefused: true,
              attachRefused: true,
            });
          if (mode === 'close-protected' && lockedIds.has(row.id))
            assert.deepEqual(locked(row), {
              closed: true,
              closeRefused: 'not-supported',
              evaluateRefused: true,
              attachRefused: true,
            });
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

test('page-session transports run every error-page field', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  try {
    for (const mode of ['catalog', 'close-protected', 'plain', 'unlock-error']) {
      const browser = await launch(fixture);
      const declaresClose = mode === 'close-protected';
      const guard =
        mode === 'plain'
          ? emulatedGuard(browser, { failDocumentOrigins: [origins(fixture).seven] })
          : emulatedGuard(browser, {
              protectedOrigins: rules,
              unlockErrorPage: mode === 'unlock-error',
              closeProtected: declaresClose,
            });
      const pageless = [];
      const client = {
        events: guard.client.events,
        send: (method, params, session) => {
          if (
            !session &&
            (!method.startsWith('Target.') ||
              method === 'Target.setAutoAttach' ||
              method === 'Target.createBrowserContext' ||
              (method === 'Target.getTargetInfo' && !params?.targetId))
          )
            pageless.push(method);
          return guard.client.send(method, params, session);
        },
      };
      try {
        const execution = await run(
          { ...data, vectors, variants: { prompt: 0 } },
          {
            client,
            unguarded: browser.unguarded,
            targets: origins(fixture),
            fixture,
            capabilities: {
              discovery: true,
              ...(declaresClose ? { closeProtected: true } : {}),
            },
          }
        );
        assert.deepEqual(pageless, []);
        assert.equal(execution.results.length, vectors.length);
        for (const row of execution.results) {
          process.stdout.write(`page-session ${mode}: ${JSON.stringify(row)}\n`);
          assert.equal(row.control, 'pass', JSON.stringify(row));
          assert.equal(row.live, 'pass', JSON.stringify(row));
          assert.equal(
            row.guarded,
            mode === 'catalog' ||
              mode === 'close-protected' ||
              (mode === 'unlock-error' && !sticky(row.id))
              ? 'pass'
              : 'fail',
            JSON.stringify(row)
          );
          if (mode === 'plain') assert.equal(row.observations.guarded.infoRedacted, false);
          if (mode === 'unlock-error' && sticky(row.id))
            assert.equal(row.observations.guarded.attachRefused, false);
          if (mode === 'catalog' && lockedIds.has(row.id))
            assert.deepEqual(locked(row), {
              closed: 'not-supported',
              closeRefused: true,
              evaluateRefused: true,
              attachRefused: true,
            });
          if (mode === 'close-protected' && lockedIds.has(row.id))
            assert.deepEqual(locked(row), {
              closed: true,
              closeRefused: 'not-supported',
              evaluateRefused: true,
              attachRefused: true,
            });
        }
      } finally {
        await guard.stop();
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
});
