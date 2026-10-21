import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('semantic-release cuts versions from main alone', () => {
  assert.deepEqual(JSON.parse(read('.releaserc.json')).branches, ['main']);
});

test('the release workflow runs from main alone and publishes npm without an explicit dist-tag', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /push:\n {4}branches: \[main\]\n/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && !inputs\.cert-only\n/);
  assert.doesNotMatch(workflow, /1\.13\.x|dist-tag|sparse-checkout/);
  const publish = workflow.split('\n').filter((line) => line.includes('npm publish'));
  assert.deepEqual(publish, [
    '          npm publish --provenance --access public --ignore-scripts',
  ]);
  assert.equal(existsSync(new URL('scripts/dist-tag.mjs', root)), false);
});
