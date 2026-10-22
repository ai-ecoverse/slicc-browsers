import { bfcacheClients } from './bfcache-client.mjs';

export function bfcacheHistoryClients({
  forwarded = false,
  takesEffect = false,
  lateAnswer = false,
  lateAfterFallback = false,
  audit = 'complete',
} = {}) {
  const browser = bfcacheClients({ guard: 'refuse' });
  const evidence = { fallbacks: 0, audits: [] };
  let guarded = false;
  let answer;
  const send = browser.client.send;
  browser.client.send = async (method, params, sessionId) => {
    if (
      guarded &&
      /^(Runtime\.|DOM\.|Accessibility\.|Input\.|Page\.captureScreenshot|IO\.read)/.test(method)
    )
      throw new Error('slicc: refused: protected target');
    if (method !== 'Page.navigateToHistoryEntry') return send(method, params, sessionId);
    if (takesEffect) await send(method, params, sessionId);
    return new Promise((resolve, reject) => {
      answer =
        lateAnswer || lateAfterFallback
          ? () => resolve({})
          : () => reject(new Error('slicc: refused: history'));
    });
  };
  const read = browser.unguarded.send;
  browser.unguarded.send = async (method, params, sessionId) => {
    if (guarded && method === 'Page.navigateToHistoryEntry') evidence.fallbacks++;
    return read(method, params, sessionId);
  };
  const install = browser.client.inboundDelay;
  browser.client.inboundDelay = async (args) => {
    guarded = args.side === 'guarded';
    const gate = await install(args);
    return {
      ...gate,
      async audit(options) {
        if (options.probes[0]?.method === 'Page.navigateToHistoryEntry') {
          evidence.audits.push(options);
          if (lateAnswer) answer();
          if (audit === 'error') throw new Error('audit unavailable');
          if (audit === 'missing') return { complete: true, probes: [] };
          const entry = { id: options.probes[0].id, forwarded };
          return {
            complete: audit !== 'partial',
            probes: audit === 'duplicate' ? [entry, entry] : [entry],
          };
        }
        return gate.audit(options);
      },
      async release() {
        const result = await gate.release();
        if (guarded) answer?.();
        return result;
      },
    };
  };
  return { ...browser, evidence };
}
