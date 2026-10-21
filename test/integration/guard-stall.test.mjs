import assert from 'node:assert/strict';
import test from 'node:test';
import { load, waitFor } from '../../guard-driver.mjs';

const stall = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};

test('a load whose event arrives just after a synchronous event-loop stall still completes', async () => {
  let resumed = Infinity;
  const navigated = {
    method: 'Page.frameNavigated',
    sessionId: 'S',
    params: { frame: { loaderId: 'L' } },
  };
  const fired = { method: 'Page.loadEventFired', sessionId: 'S', params: {} };
  let sent = false;
  const client = {
    get events() {
      if (!sent) return [];
      return Date.now() > resumed + 30 ? [navigated, fired] : [navigated];
    },
    send: async () => {
      sent = true;
      setTimeout(() => {
        stall(1500);
        resumed = Date.now();
      }, 5);
      return { loaderId: 'L' };
    },
  };
  await load(client, 'S', 'https://ordinary.example.test/doc', 150);
});

test('a load that never arrives still times out at its bound', async () => {
  const client = { events: [], send: async () => ({ loaderId: 'L' }) };
  const started = Date.now();
  await assert.rejects(
    load(client, 'S', 'https://ordinary.example.test/doc', 150),
    /load of https:\/\/ordinary\.example\.test\/doc timed out/
  );
  assert(Date.now() - started < 1000);
});

test('a stall while the check awaits its reply does not consume the bound', async () => {
  let resumed = Infinity;
  setTimeout(() => {
    stall(1500);
    resumed = Date.now();
  }, 5);
  const held = await waitFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Date.now() > resumed + 30;
  }, 150);
  assert.equal(held, true);
});

test('a check that always stalls still ends', async () => {
  const started = Date.now();
  const held = await waitFor(
    () => {
      stall(60);
      return false;
    },
    10,
    5
  );
  assert.equal(held, false);
  assert(Date.now() - started < 1000);
});
