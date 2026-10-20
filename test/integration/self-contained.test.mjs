import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/self-contained.mjs');
const run = (...files) =>
  promisify(execFile)(process.execPath, [
    '--experimental-vm-modules',
    '--no-warnings',
    script,
    ...files,
  ]);
const shipped = ['protected.mjs', 'seven.mjs'];

for (const name of shipped) {
  test(`${name} has no import or export-from statements`, async () => {
    const source = await readFile(join(root, name), 'utf8');
    assert.doesNotMatch(source, /^\s*import\b/m);
    assert.doesNotMatch(source, /\bimport\s*\(/);
    assert.doesNotMatch(source, /^\s*export\b[^;]*\bfrom\s*['"]/m);
  });
}

test('protected.mjs and seven.mjs load in a fresh context with only URL and no linker', async () => {
  const { stdout } = await run(...shipped.map((f) => join(root, f)));
  assert.match(stdout, /^self-contained: PASS protected\.mjs, seven\.mjs$/m);
});

test('a shipped module that imports the driver fails the check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'self-contained-'));
  try {
    const source = await readFile(join(root, 'protected.mjs'), 'utf8');
    const variants = {
      'protected.mjs': `import { parseURL } from './guard-driver.mjs';\n${source}`,
      'seven.mjs': `export { parseURL } from './guard-driver.mjs';\n`,
    };
    for (const [name, text] of Object.entries(variants)) {
      const path = join(directory, name);
      await writeFile(path, text);
      await assert.rejects(run(path), (error) => {
        assert.match(
          error.stderr,
          new RegExp(`${name.replace('.', '\\.')}: imports \\./guard-driver\\.mjs`)
        );
        assert.match(error.stderr, /no linker resolution allowed/);
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a shipped module that needs more than URL fails the check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'self-contained-'));
  try {
    const path = join(directory, 'seven.mjs');
    await writeFile(path, 'export const isSevenLabel = () => Buffer.from("x").length === 1;\n');
    await assert.rejects(run(path), (error) =>
      error.stderr.includes('seven.mjs: fails in isolation')
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
