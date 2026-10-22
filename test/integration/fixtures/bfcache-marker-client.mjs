import { bfcacheClients } from './bfcache-client.mjs';

const replies = {
  'Runtime.evaluate': (marker) => ({ result: { value: marker } }),
  'Runtime.callFunctionOn': (marker) => ({ result: { value: marker } }),
  'DOM.getDocument': (marker) => ({ root: { nodeValue: marker } }),
  'Accessibility.getFullAXTree': (marker) => ({ nodes: [{ name: { value: marker } }] }),
  'Input.dispatchKeyEvent': (marker) => ({ description: marker }),
  'Page.captureScreenshot': (marker) => ({ data: btoa('\x89PNG\r\n\x1a\n' + marker) }),
  'IO.read': (marker) => ({ data: btoa(marker), base64Encoded: true, eof: true }),
};

export const markerMethods = Object.keys(replies);

export function bfcacheMarkerClients({
  page = 'ordinary',
  channel = 'reply',
  method = 'Runtime.evaluate',
  protectedCurrent = false,
} = {}) {
  const browser = bfcacheClients({ guard: 'refuse' });
  const markers = {};
  let armed = false;
  let probing = false;
  let session;
  const install = browser.client.inboundDelay;
  browser.client.inboundDelay = async (args) => {
    const target = browser.targets.get(args.targetId);
    markers.ordinary = target.state.marker;
    markers.protected = target.protectedState.marker;
    session = args.sessionId;
    const gate = await install(args);
    armed = true;
    return gate;
  };
  const observe = browser.unguarded.send;
  browser.unguarded.send = async (command, params, sessionId) => {
    const reply = await observe(command, params, sessionId);
    if (armed && command === 'Network.loadNetworkResource') probing = true;
    if (probing && !protectedCurrent && command === 'Page.getFrameTree')
      reply.frameTree.frame.url = 'about:blank';
    return reply;
  };
  const send = browser.client.send;
  browser.client.send = async (command, params, sessionId) => {
    if (armed && sessionId === session && command === method) {
      const marker = markers[page];
      if (channel === 'reply') return replies[command](marker);
      if (channel === 'error') throw new Error(`slicc: refused: ${marker}`);
      if (channel === 'event')
        browser.client.events.push({
          sessionId,
          method: 'Runtime.consoleAPICalled',
          params: { args: [{ value: btoa(marker) }] },
        });
      if (channel === 'message')
        browser.client.messages.push(JSON.stringify({ result: { value: marker } }));
    }
    return send(command, params, sessionId);
  };
  return { ...browser, markers };
}
