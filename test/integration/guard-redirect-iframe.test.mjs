import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';
import { ordinary } from './redirect-history-fixture.mjs';
import { redirectIframeFixture } from './redirect-iframe-fixture.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));

async function exercise(options = {}, settleScale = 1) {
  const browser = redirectIframeFixture(options);
  const evidence = {};
  const execution = await run(
    {
      ...set,
      variants: { prompt: 0 },
      vectors: set.vectors.filter((vector) => vector.id === 'C2.redirect-body'),
    },
    {
      client: browser.client,
      unguarded: browser.reader,
      fixture: browser.fixture,
      targets: { ordinary },
      capabilities: { browserSession: true },
      settleScale,
      debug: (entry) => {
        if (entry.calls?.redirect) evidence[entry.side] = entry.calls.redirect.result;
      },
    }
  );
  return { ...browser, row: execution.results[0], evidence };
}

test.describe('C2 ordinary iframe snapshot evidence', { concurrency: true, timeout: 90000 }, () => {
  test('a late ordinary iframe reaches both snapshot channels within the scaled wait', async () => {
    const { row, evidence, reads } = await exercise({ snapshotDelay: 900, domDelay: 1300 }, 0.4);
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(evidence.control.ordinaryIframeSnapshot, true);
    assert.equal(evidence.control.ordinaryIframeDOM, true);
    assert.ok(reads.filter((read) => read.method === 'Page.captureSnapshot').length > 1);
    assert.ok(
      reads.some((read) => read.method === 'DOMSnapshot.captureSnapshot' && read.elapsed >= 1300)
    );
  });

  test('an ordinary iframe that never appears is incomplete, not a control failure or a pass', async () => {
    const { row, evidence } = await exercise({ snapshotDelay: Infinity, domDelay: Infinity }, 0.15);
    assert.equal(row.control, 'incomplete', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(evidence.control.ordinaryIframeSnapshot, 'incomplete');
    assert.equal(evidence.control.ordinaryIframeDOM, 'incomplete');
    assert.equal(evidence.control.iframeSnapshotAttempted, true);
    assert.match(row.incomplete.join('; '), /control iframe.*750ms/);
    assert.deepEqual(row.errors, []);
  });

  test('one measured channel remains true while only the missing channel is incomplete', async () => {
    const { row, evidence } = await exercise({ snapshotDelay: 0, domDelay: Infinity }, 0.15);
    assert.equal(row.control, 'incomplete', JSON.stringify(row));
    assert.equal(evidence.control.ordinaryIframeSnapshot, true);
    assert.equal(evidence.control.ordinaryIframeDOM, 'incomplete');
    assert.match(row.incomplete.join('; '), /ordinaryIframeDOM/);
    assert.doesNotMatch(row.incomplete.join('; '), /ordinaryIframeSnapshot/);
  });

  test('a leaking guard still fails when the control iframe evidence is incomplete', async () => {
    const { row, evidence } = await exercise(
      { snapshotDelay: Infinity, domDelay: Infinity, leak: true },
      0.15
    );
    assert.equal(row.control, 'incomplete', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(evidence.guarded.secretHidden, false);
  });
});
