import { spawn } from 'node:child_process';

const targets = ['seven', 'vault', 'vault-x', 'apex', 'own'];
for (const target of targets) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'test/integration/guard-runner.test.mjs'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        GUARD_TARGET: target,
        GUARD_REPORT: process.env.GUARD_REPORT ? `${process.env.GUARD_REPORT}-${target}.json` : '',
      },
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) process.exit(code ?? 1);
}
