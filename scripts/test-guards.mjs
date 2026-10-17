import { spawn } from 'node:child_process';

const targets = [
  'seven',
  'vault',
  'vault-x',
  'apex',
  'own',
  'chrome-newtab',
  'chrome-new-tab-page',
  'chrome-settings',
  'chrome-passwords',
  'chrome-extension-page',
  'file-root',
];
const started = Date.now();
let next = 0;
let failed = 0;
const worker = async () => {
  while (next < targets.length && !failed) {
    const target = targets[next++];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--test', 'test/integration/guard-runner.test.mjs'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          GUARD_TARGET: target,
          GUARD_REPORT: process.env.GUARD_REPORT
            ? `${process.env.GUARD_REPORT}-${target}.json`
            : '',
        },
      });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) failed = code ?? 1;
  }
};
await Promise.all([worker(), worker()]);
process.stdout.write(`whole sweep elapsed ${Date.now() - started}ms\n`);
if (failed) process.exit(failed);
process.stdout.write(`guard-sweep: PASS ${targets.length} targets\n`);
