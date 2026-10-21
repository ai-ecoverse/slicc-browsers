import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from '../../guard-driver.mjs';

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
        stall(400);
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
