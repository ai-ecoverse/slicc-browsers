import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findBrowser } from '@ai-ecoverse/slicc-cdp';
import { fixtureServer } from '../../fixture-server.mjs';
import { launch } from './cdp-client.mjs';

const real = (await findBrowser())?.executable ?? '';
const scratch = await mkdtemp(join(tmpdir(), 'slicc-launch-'));
const fake = join(scratch, 'chromium');
const profiles = join(scratch, 'profiles');

await writeFile(
  fake,
  [
    '#!/bin/sh',
    'for arg in "$@"; do',
    '  case "$arg" in --user-data-dir=*) echo "${arg#--user-data-dir=}" >> "$SLICC_FAKE_PROFILES" ;; esac',
    'done',
    'n=$(wc -l < "$SLICC_FAKE_PROFILES")',
    'n=$((n + 0))',
    'if [ "$n" -le "$SLICC_FAKE_FAILS" ]; then',
    '  echo "fake chromium: attempt $n has no display" >&2',
    '  if [ "$SLICC_FAKE_HOW" = signal ]; then kill -9 $$; fi',
    '  exit 3',
    'fi',
    'exec "$SLICC_FAKE_REAL" "$@"',
    '',
  ].join('\n')
);
await chmod(fake, 0o755);
Object.assign(process.env, {
  CHROME_PATH: fake,
  SLICC_FAKE_REAL: real,
  SLICC_FAKE_PROFILES: profiles,
});

test.after(() => rm(scratch, { recursive: true, force: true }));

async function attempt(fails, how) {
  await writeFile(profiles, '');
  Object.assign(process.env, { SLICC_FAKE_FAILS: String(fails), SLICC_FAKE_HOW: how });
  const fixture = await fixtureServer();
  const started = Date.now();
  try {
    const result = await launch(fixture).catch((error) => error);
    return { result, ms: Date.now() - started };
  } finally {
    await fixture.close();
  }
}

const launched = async () => (await readFile(profiles, 'utf8')).trim().split('\n').filter(Boolean);

async function removed(directories) {
  for (const directory of directories)
    await assert.rejects(access(directory), { code: 'ENOENT' }, directory);
}

test('a Chromium that exits before CDP startup is launched again, and the browser it then starts works', async () => {
  const { result: browser } = await attempt(1, 'exit');
  assert(!(browser instanceof Error), browser?.stack);
  try {
    const directories = await launched();
    assert.equal(directories.length, 2);
    assert.equal(directories[1], browser.directory);
    assert.deepEqual(browser.exits, [
      'exit code 3, stderr:\nfake chromium: attempt 1 has no display',
    ]);
    await removed(directories.slice(0, 1));
    const { product } = await browser.client.send('Browser.getVersion');
    assert.match(product, /Chrome/);
  } finally {
    await browser.close();
  }
  await removed(await launched());
});

for (const [how, end] of [
  ['exit', 'exit code 3'],
  ['signal', 'signal SIGKILL'],
])
  test(`a Chromium that always ends with ${end} before CDP startup fails after three launches, with each exit and its stderr`, async () => {
    const { result: error, ms } = await attempt(99, how);
    assert(error instanceof Error, 'launch did not fail');
    assert.equal(
      error.message,
      [
        'Chromium exited before CDP startup on all 3 attempts',
        ...[1, 2, 3].map(
          (n) => `attempt ${n}: ${end}, stderr:\nfake chromium: attempt ${n} has no display`
        ),
      ].join('\n')
    );
    const directories = await launched();
    assert.equal(directories.length, 3);
    await removed(directories);
    assert(ms < 10000, `${ms}ms`);
  });
