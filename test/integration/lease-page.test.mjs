import assert from 'node:assert/strict';
import test from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers' with { type: 'json' };
import { leaseScope } from '@ai-ecoverse/slicc-browsers/lease-scope.mjs';
import { launch } from './cdp-client.mjs';
import { leaseFixtureCookiePolicy, leasePageFixture } from './fixtures/lease-page.mjs';

for (const sameSite of ['Strict', 'Lax'])
  test(`fixture premise: a fresh SameSite=${sameSite} billing session renders external dependencies and submits a real form`, {
    timeout: 45000,
  }, async () => {
    const f = await leasePageFixture({ sameSite });
    try {
      const browser = await launch(f, { spki: f.spki });
      try {
        const client = browser.client;
        const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await client.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        const send = (method, params = {}) => client.send(method, params, sessionId);
        const loaded = () =>
          client.waitEvent(
            (e) => e.sessionId === sessionId && e.method === 'Page.loadEventFired',
            10000
          );
        await send('Page.enable');
        await Promise.all([
          loaded(),
          send('Page.navigate', { url: `${f.sites.billing}/owner-session` }),
        ]);
        const read = async (expression) => {
          const r = await send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
          return r.result.value;
        };
        assert.equal(await read('window.invoiceReady'), true);
        const view = await read(
          '({url:location.href,text:document.querySelector("#invoice").textContent,frame:document.querySelector("iframe").src,receipt:document.querySelector("a").href})'
        );
        assert.deepEqual(await leaseFixtureCookiePolicy(client, f, sessionId), {
          sameSite,
          secure: true,
          httpOnly: true,
        });
        assert.equal(view.text, 'Invoice 1042 · paid');
        assert.equal(view.url, `${f.sites.billing}/invoices/1042?view=table#paid`);
        assert.deepEqual([...f.assets].sort(), [
          'api',
          'embed',
          'font',
          'script',
          'stylesheet',
          'websocket',
          'worker',
        ]);
        const billing = { kind: 'origin', url: f.sites.billing };
        const match = leaseScope(catalog, [billing]);
        assert.ok(match(view.url));
        for (const outside of [view.frame, view.receipt, f.sites.api, f.sites.cdn, f.sites.push])
          assert.equal(match(outside), false);
        const broader = leaseScope(catalog, [billing, { kind: 'exact', url: view.receipt }]);
        assert.ok(broader(view.receipt));
        assert.equal(broader(view.frame), false);
        assert.equal(broader(`${view.receipt}?another`), false);
        await Promise.all([
          loaded(),
          read(
            'document.querySelector("input").value="fixture";document.querySelector("button").click();true'
          ),
        ]);
        assert.equal(f.submitted(), 1);
        assert.equal(await read('document.title'), 'Saved');
        if (sameSite === 'Strict') return;
        const handoff = `${f.sites.support}/sso`;
        assert.equal(match(handoff), false);
        await Promise.all([loaded(), send('Page.navigate', { url: handoff })]);
        await Promise.all([loaded(), read('document.querySelector("a").click();true')]);
        assert.equal(await read('window.invoiceReady'), true);
        assert.ok(match(await read('location.href')));
      } finally {
        await browser.close();
      }
    } finally {
      await f.close();
    }
  });
