import test from 'node:test';
import { fixtureServer } from '../../../fixture-server.mjs';
import { launch } from '../cdp-client.mjs';

const mode = process.argv[2];
const fixture = await fixtureServer();
const controller = new AbortController();
const browser = await launch(fixture, { signal: controller.signal });
const { processInfo } = await browser.client.send('SystemInfo.getProcessInfo');
process.send({
  pid: browser.pid,
  pids: processInfo.map((entry) => entry.id),
  directory: browser.directory,
});
process.disconnect();

if (mode === 'timeout') {
  test('runner times out without reaching its finally', { timeout: 250 }, async (t) => {
    t.after(() => fixture.close());
    t.signal.addEventListener('abort', () => controller.abort(), { once: true });
    await new Promise(() => {});
  });
} else if (mode === 'close') {
  try {
    await browser.client.send('Target.getTargets');
  } finally {
    await browser.close();
    await fixture.close();
  }
} else if (mode === 'exit') {
  process.exit(0);
} else if (mode === 'error') {
  throw new Error('intentional uncaught runner error');
}
