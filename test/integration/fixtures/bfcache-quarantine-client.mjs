import { bfcacheClients } from './bfcache-client.mjs';

const protectedURL = (url) => new URL(url).hostname.endsWith('.sliccy.ai');

export function bfcacheQuarantineClients({
  blockProtectedLoads = true,
  leak = false,
  refuseHistory = false,
} = {}) {
  const browser = bfcacheClients({ guard: leak ? 'none' : 'refuse' });
  const calls = [];
  const blockedLoads = [];
  const scriptRefusals = [];
  for (const transport of [browser.client, browser.unguarded]) {
    const send = transport.send;
    transport.send = async (method, params = {}, sessionId) => {
      const id = browser.sessions.get(sessionId);
      const target = browser.targets.get(id);
      calls.push({ name: transport.name, method, params, sessionId, url: target?.url });
      if (
        blockProtectedLoads &&
        method === 'Page.navigate' &&
        protectedURL(params.url) &&
        [...browser.sessions].some(
          ([session, targetId]) => session.startsWith('client-') && targetId === id
        )
      ) {
        blockedLoads.push(params.url);
        return { frameId: 'F', errorText: 'net::ERR_BLOCKED_BY_CLIENT' };
      }
      if (
        transport === browser.client &&
        target?.history.some((entry) => protectedURL(entry.url))
      ) {
        if (
          /^(Runtime\.evaluate|Runtime\.callFunctionOn)$/.test(method) &&
          !(leak && target.state.persisted)
        ) {
          scriptRefusals.push({ method, params, sessionId });
          throw new Error('slicc: refused: script in a quarantined tab');
        }
        if (refuseHistory && method === 'Page.navigateToHistoryEntry')
          throw new Error('slicc: refused: history in a quarantined tab');
      }
      return send(method, params, sessionId);
    };
  }
  return { ...browser, calls, blockedLoads, scriptRefusals };
}
