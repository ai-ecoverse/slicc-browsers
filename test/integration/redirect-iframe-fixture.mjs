import { redirectHistoryFixture } from './redirect-history-fixture.mjs';

export function redirectIframeFixture({
  snapshotDelay = 1200,
  domDelay = snapshotDelay,
  leak = false,
} = {}) {
  const browser = redirectHistoryFixture({ leak });
  const inserted = new Map();
  const reads = [];
  const send = browser.reader.send;
  browser.reader.send = async (method, params = {}, sessionId) => {
    if (
      method === 'Runtime.evaluate' &&
      params.expression.includes("document.createElement('iframe')")
    )
      inserted.set(sessionId, Date.now());
    const start = inserted.get(sessionId);
    if (
      start !== undefined &&
      ['Page.captureSnapshot', 'DOMSnapshot.captureSnapshot'].includes(method)
    ) {
      const elapsed = Date.now() - start;
      const delay = method === 'Page.captureSnapshot' ? snapshotDelay : domDelay;
      reads.push({ method, elapsed, sessionId });
      if (elapsed < delay) {
        const result = { data: 'ordinary parent without the iframe' };
        browser.reader.messages.push(
          JSON.stringify({ id: 100000 + reads.length, result, sessionId })
        );
        return result;
      }
    }
    return send(method, params, sessionId);
  };
  return { ...browser, inserted, reads };
}
