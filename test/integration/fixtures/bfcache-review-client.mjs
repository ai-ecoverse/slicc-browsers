import { bfcacheClients } from './bfcache-client.mjs';

const signature = '\x89PNG\r\n\x1a\n';

export function bfcacheReviewClient({ fault, method = 'DOM.getDocument', delay = 450 } = {}) {
  const browser = bfcacheClients({ guard: 'refuse' });
  const faults = new Set(Array.isArray(fault) ? fault : [fault]);
  let observer;
  let frames = 0;
  for (const [name, transport] of [
    ['observer', browser.unguarded],
    ['client', browser.client],
  ]) {
    const send = transport.send;
    transport.send = async (command, params = {}, session) => {
      const target = browser.targets.get(browser.sessions.get(session));
      if (name === 'client' && target?.state.persisted && command === method) {
        if (faults.has('origin')) throw new Error(`slicc: refused: ${new URL(target.url).origin}`);
        if (faults.has('late'))
          return new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  root: { origin: new URL(target.url).origin, marker: target.state.marker },
                }),
              delay
            )
          );
      }
      const result = await send(command, params, session);
      if (name === 'observer' && command === 'Target.attachToTarget') observer ??= result.sessionId;
      if (command === 'Page.captureScreenshot') {
        const marker = target.state.marker;
        result.data =
          faults.has('image') && session !== observer
            ? btoa(signature + 'ordinary-image')
            : faults.has('invalid-image') && session !== observer
              ? 'not-an-image'
              : btoa(signature + marker);
      }
      if (faults.has('io') && command === 'IO.read' && session !== observer)
        result.data = 'ordinary-body';
      if (
        faults.has('flag') &&
        name === 'observer' &&
        command === 'Page.getFrameTree' &&
        target?.state.persisted
      ) {
        frames++;
        if (frames === 3) result.frameTree.frame.url = 'about:blank';
      }
      return result;
    };
  }
  const install = browser.client.inboundDelay;
  browser.client.inboundDelay = async (args) => {
    const gate = await install(args);
    frames = 0;
    const release = gate.release;
    const audit = gate.audit;
    return {
      ...gate,
      release: async () => {
        const evidence = await release();
        return faults.has('hold') && args.side === 'guarded'
          ? { ...evidence, delayedEvents: 0 }
          : evidence;
      },
      audit: async ({ probes, ...options }) => {
        const ledger = await audit({ probes, ...options });
        if (faults.has('flag')) {
          const probe = probes.find((item) => item.protectedCurrent === false);
          if (probe) ledger.probes.find((entry) => entry.id === probe.id).forwarded = true;
        }
        if (faults.has('partial')) {
          ledger.complete = false;
          ledger.probes = ledger.probes.filter((entry) => entry.forwarded);
        }
        return ledger;
      },
    };
  };
  return browser;
}
