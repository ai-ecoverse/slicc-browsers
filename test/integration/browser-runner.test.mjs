import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { containsSecret } from '../../redirect-secret.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/browser-runner.mjs');
const invoke = (entry) =>
  promisify(execFile)(process.execPath, [
    '--experimental-vm-modules',
    '--no-warnings',
    script,
    ...(entry ? [entry] : []),
  ]);

test('the complete runner graph executes with only browser globals, UTF-8 base64 and a page row', async () => {
  const { stdout } = await invoke(process.env.BROWSER_RUNNER_REFERENCE);
  assert.match(stdout, /^browser-runner: PASS \d+ modules, encoded bodies and browser page row$/m);
});

test('embedded, unaligned and base64url secrets retain the permissive 1.13.0 detector strength', () => {
  const marker = 'embedded-redirect-secret';
  const encoded = btoa(marker);
  const regression = `AAAA${encoded}A`;
  assert.throws(() => atob(regression));
  assert(Buffer.from(regression, 'base64').toString().includes(marker));
  assert.equal(containsSecret(regression, marker), true);
  for (const prefix of ['A', 'AA', 'AAA', 'AAAAA'])
    for (const suffix of ['A', 'AA', 'AAA'])
      assert.equal(
        containsSecret(`${prefix}${encoded}${suffix}`, marker),
        true,
        `${prefix}/${suffix}`
      );
  const unicode = 'url-雪-token';
  const url = btoa(String.fromCharCode(251, 255, ...new TextEncoder().encode(unicode)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  assert.equal(containsSecret(`AAA${url}AA`, unicode), true);
});

test('a Node-only global or import anywhere in the runtime graph fails verification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-runner-'));
  try {
    const entry = join(directory, 'guard-runner.mjs');
    await writeFile(entry, 'import "./nested.mjs";');
    for (const source of [
      'export const bad = Buffer;',
      'export const bad = process;',
      'export const bad = require;',
      'import fs from "node:fs";',
    ]) {
      await writeFile(join(directory, 'nested.mjs'), source);
      await assert.rejects(invoke(entry), (error) =>
        /Node-only global|non-browser import/.test(error.stderr)
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
