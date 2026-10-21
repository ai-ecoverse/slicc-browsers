const refusal = 'slicc: refused: protected target';

export function bfcacheClients({ guard = 'none', missing, hooks = true } = {}) {
  const targets = new Map();
  const sessions = new Map();
  const transports = [];
  let next = 0;
  let held;
  let active = false;
  const publish = (targetId, params) => {
    for (const transport of transports) {
      for (const [sessionId, id] of sessions) {
        if (id !== targetId || sessionId.split('-')[0] !== transport.name) continue;
        const event = { method: 'Page.frameNavigated', params, sessionId };
        if (held && sessionId === held.sessionId && params.type === 'BackForwardCacheRestore') {
          held.count++;
          held.first ??= Date.now();
          held.events.push(event);
        } else transport.events.push(event);
        transport.events.push({ method: 'Page.loadEventFired', params: {}, sessionId });
      }
    }
  };
  const commit = (id, url, restore = false) => {
    const target = targets.get(id);
    target.url = url;
    const n = new URL(url).searchParams.get('n') ?? '';
    if (!restore) {
      target.history.push({ id: ++next, url });
      target.index = target.history.length - 1;
      target.state = {
        marker: `bfcache-marker-${n}`,
        stored: `bfcache-marker-${n}`,
        keys: 0,
        persisted: false,
      };
      if (!n.endsWith('-a') && !n.endsWith('-b') && new URL(url).pathname === '/bfcache')
        target.protectedState = target.state;
    } else {
      target.state = { ...target.protectedState, persisted: missing !== 'restore' };
      active = true;
    }
    publish(id, {
      frame: { id: 'F', loaderId: `L${next}`, url, securityOrigin: new URL(url).origin },
      ...(restore && missing !== 'restore' ? { type: 'BackForwardCacheRestore' } : {}),
    });
  };
  const make = (name) => {
    const transport = {
      name,
      events: [],
      messages: [],
      waitEvent: () => new Promise(() => {}),
      async send(method, params = {}, sessionId) {
        const id = sessions.get(sessionId);
        const target = targets.get(id);
        if (
          name === 'client' &&
          active &&
          target?.state.persisted &&
          guard === 'refuse' &&
          /^(Runtime\.|DOM\.|Accessibility\.|Input\.|Page\.captureScreenshot|IO\.read)/.test(method)
        )
          throw new Error(refusal);
        const suppress =
          name === 'client' &&
          active &&
          target?.state.persisted &&
          /^(Runtime\.|DOM\.|Accessibility\.|Input\.|Page\.captureScreenshot|IO\.read)/.test(
            method
          ) &&
          ['drop', 'queue'].includes(guard);
        if (suppress && guard === 'queue') return new Promise(() => {});
        let answer = {};
        if (method === 'Target.createTarget') {
          if (missing === 'create') throw new Error('create unavailable');
          const targetId = `T${++next}`;
          targets.set(targetId, { url: params.url, history: [], index: -1 });
          commit(targetId, params.url);
          answer = { targetId };
        } else if (method === 'Target.getTargetInfo') {
          answer = {
            targetInfo: {
              targetId: params.targetId,
              url: targets.get(params.targetId)?.url,
              type: 'page',
            },
          };
        } else if (method === 'Target.attachToTarget') {
          if (missing === 'observer' && name === 'observer') return {};
          if (missing === 'attach' && name === 'client') return {};
          const sessionId = `${name}-${++next}`;
          sessions.set(sessionId, params.targetId);
          answer = { sessionId };
        } else if (method === 'Target.detachFromTarget') {
          sessions.delete(params.sessionId);
        } else if (method === 'Target.closeTarget') {
          targets.delete(params.targetId);
          answer = { success: true };
        } else if (method === 'Page.navigate') {
          const part = new URL(params.url).searchParams.get('n') ?? '';
          if (
            !(
              (missing === 'seed' && !part.endsWith('-b')) ||
              (missing === 'b' && part.endsWith('-b'))
            )
          )
            commit(id, params.url);
          answer = { frameId: 'F' };
        } else if (method === 'Page.getFrameTree') {
          answer = {
            frameTree: {
              frame: {
                id: 'F',
                loaderId: `L${next}`,
                url: missing === 'a' ? 'about:blank' : target?.url,
              },
            },
          };
        } else if (method === 'Page.getNavigationHistory') {
          answer = {
            entries: missing === 'history' ? [] : target.history,
            currentIndex: target.index,
          };
        } else if (
          method === 'Page.navigateToHistoryEntry' ||
          (method === 'Runtime.evaluate' && params.expression === 'history.back()')
        ) {
          if (name === 'client' && guard === 'refuse-trigger') throw new Error(refusal);
          const entry =
            method === 'Page.navigateToHistoryEntry'
              ? target.history.find((item) => item.id === params.entryId)
              : target.history[target.index - 1];
          target.index = target.history.indexOf(entry);
          commit(id, entry.url, true);
        } else if (method === 'Runtime.enable') {
          transport.events.push({
            method: 'Runtime.executionContextCreated',
            sessionId,
            params: {
              context: {
                id: 7,
                origin: new URL(target.url).origin,
                auxData: { isDefault: true, frameId: 'F' },
              },
            },
          });
        } else if (method === 'Runtime.evaluate') {
          let value;
          if (params.expression === 'document.readyState') value = 'complete';
          else if (params.expression === 'location.href')
            value = missing === 'live' ? 'about:blank' : target.url;
          else if (params.expression === 'location.origin') {
            if (name === 'client' && guard.startsWith('refuse')) throw new Error(refusal);
            value = new URL(target.url).origin;
          } else if (params.expression.includes('__bfcachePersisted')) {
            value =
              missing === 'state' && active
                ? undefined
                : {
                    origin: new URL(target.url).origin,
                    ...target.state,
                    ...(missing === 'marker' ? { marker: '' } : {}),
                  };
          } else if (params.expression.includes('__touched=1')) {
            target.state.touched = 1;
            value = JSON.stringify({
              origin: new URL(target.url).origin,
              marker: target.state.marker,
              stored: target.state.stored,
            });
          }
          answer =
            params.expression === 'globalThis'
              ? { result: { type: 'object', objectId: `object-${sessionId}` } }
              : { result: { type: 'string', value } };
        } else if (method === 'Runtime.callFunctionOn') {
          target.state.touched = 1;
          answer = {
            result: {
              value: JSON.stringify({
                origin: new URL(target.url).origin,
                marker: target.state.marker,
              }),
            },
          };
        } else if (method === 'Page.captureScreenshot') {
          answer = { data: btoa('\x89PNG\r\n\x1a\n' + target.state.marker) };
        } else if (method === 'Network.loadNetworkResource') {
          answer = { resource: { stream: 'fixture-stream' } };
        } else if (method === 'IO.read') {
          answer = { data: target.state.marker, eof: true };
        } else if (method === 'Input.dispatchKeyEvent') {
          target.state.keys++;
        } else if (method === 'DOM.getDocument') {
          answer = { root: { nodeValue: target.state.marker } };
        } else if (method === 'Accessibility.getFullAXTree') {
          answer = { nodes: [{ name: { value: target.state.marker } }] };
        }
        if (suppress) return new Promise(() => {});
        return answer;
      },
    };
    transports.push(transport);
    return transport;
  };
  const unguarded = make('observer');
  const client = make('client');
  if (hooks)
    client.inboundDelay = async ({ targetId, sessionId, ms }) => {
      if (missing === 'delay-error') throw new Error('delay unavailable');
      held = { count: 0, events: [], sessionId };
      active = false;
      return {
        targetId,
        sessionId,
        ms: missing === 'ack' ? ms + 1 : ms,
        protectedObserved: missing !== 'seeding',
        ordinaryObserved: true,
        gate: true,
        audit: async ({ probes }) =>
          missing === 'audit'
            ? {}
            : {
                complete: true,
                probes: probes.map((probe) => ({
                  id: probe.id,
                  forwarded: !['refuse', 'queue', 'refuse-trigger'].includes(guard),
                })),
              },
        async release() {
          const evidence = {
            delayedEvents: missing === 'held' ? 0 : held.count,
            firstDelayedAt: held.first,
            releasedAt: Math.max(Date.now(), (held.first ?? Date.now()) + ms),
          };
          held = undefined;
          return evidence;
        },
      };
    };
  return { client, unguarded, targets, sessions };
}
