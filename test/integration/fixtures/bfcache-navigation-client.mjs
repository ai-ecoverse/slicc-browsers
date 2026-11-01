export function navigationReader({ fault } = {}) {
  const ordinary = 'http://ordinary.test:4901';
  const protectedOrigin = 'https://vault.sliccy.ai';
  const tag = 'navigation';
  const entries = [
    { id: 1, url: `${ordinary}/bfcache?n=${tag}-a` },
    { id: 2, url: `${protectedOrigin}/bfcache?n=${tag}-p` },
    { id: 3, url: `${ordinary}/bfcache?n=${tag}-b` },
  ];
  let current = entries[0].url;
  let persisted = false;
  let attaches = 0;
  const events = [];
  const calls = [];
  const reader = {
    events,
    calls,
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.attachToTarget')
        return { sessionId: fault === 'attach' ? undefined : `raw-${++attaches}` };
      if (method === 'Target.detachFromTarget' || method === 'Page.enable') return {};
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'root', url: current } } };
      if (method === 'Page.navigate') {
        current = params.url;
        persisted = false;
        return {};
      }
      if (method === 'Page.getNavigationHistory')
        return { entries: fault === 'ordinary-history' ? entries.slice(0, 2) : entries };
      if (method === 'Page.navigateToHistoryEntry') {
        if (fault === 'navigate') throw new Error('history refusal');
        current = entries.find((entry) => entry.id === params.entryId).url;
        persisted = fault !== 'persisted';
        if (fault !== 'event')
          events.push({
            sessionId: 'raw-1',
            method: 'Page.frameNavigated',
            params: { type: 'BackForwardCacheRestore', frame: { id: 'root', url: current } },
          });
        return {};
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
        const marker = `bfcache-marker-${new URL(current).searchParams.get('n')}`;
        return {
          result: {
            value: {
              origin: new URL(current).origin,
              marker: fault === 'marker' ? 'absent' : marker,
              stored: marker,
              persisted,
              keys: 0,
            },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { reader, targetId: 'owned', ordinary, protectedOrigin, tag, budget: 10 };
}
