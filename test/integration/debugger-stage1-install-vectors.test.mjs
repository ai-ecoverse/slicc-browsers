import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const vectors = JSON.parse(await readFile(new URL('../../debugger-stage1.json', import.meta.url)));

test('Stage1 installer rechecks a published pause and never sends the two Stage2 methods', () => {
  const changed = vectors.rows.find((row) => row.id === 'document-change-before-install');
  assert.equal(changed.mode, 'document-change-before-install');
  assert.deepEqual(changed.expected, {
    admitted: true,
    published: true,
    installed: false,
    liveReads: true,
    released: true,
  });
  assert.deepEqual(changed.requires, [
    'publishedPause',
    'documentChange',
    'noSourceInNewDocument',
    'privateRescueAudit',
  ]);
  const refused = vectors.rows.find((row) => row.id === 'stage2-methods-at-published-pause');
  assert.deepEqual(refused.expected, {
    admitted: false,
    published: true,
    forwarded: false,
    released: true,
  });
  assert.deepEqual(refused.requires, [
    'publishedPause',
    'getScriptSourceRefused',
    'evaluateOnCallFrameRefused',
    'privateRescueAudit',
  ]);
});
