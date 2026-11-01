import assert from 'node:assert/strict';
import test from 'node:test';
import { bfcacheNavigation } from '../../bfcache-restore.mjs';
import { navigationReader } from './fixtures/bfcache-navigation-client.mjs';

test('existing BFCache driver seeds an owned target and measures both actual history restores without delay machinery', async () => {
  const fixture = navigationReader();
  const driver = bfcacheNavigation(fixture);
  try {
    const seeded = await driver.prepare();
    assert.equal(seeded.url, `${fixture.ordinary}/bfcache?n=navigation-b`);
    for (const entry of [seeded.protectedEntry, seeded.ordinaryEntry]) {
      const restored = await driver.restore(entry);
      assert.equal(restored.restored, true);
      assert.equal(restored.state.persisted, true);
      assert.ok(restored.elapsedMs < 7000);
    }
  } finally {
    await driver.close();
  }
  assert.equal(
    fixture.reader.calls.some(({ method }) => method.startsWith('Debugger.')),
    false
  );
});

test('history navigation is not a BFCache pass without both the restoration event and persisted state', async () => {
  for (const fault of ['event', 'persisted']) {
    const driver = bfcacheNavigation(navigationReader({ fault }));
    try {
      const seeded = await driver.prepare();
      await assert.rejects(
        driver.restore(seeded.protectedEntry),
        /real BFCache restore not observed/
      );
    } finally {
      await driver.close();
    }
  }
});
