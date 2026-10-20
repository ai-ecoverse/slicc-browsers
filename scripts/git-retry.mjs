#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const git = process.env.REAL_GIT;
if (!git) {
  process.stderr.write('git-retry: REAL_GIT is not set\n');
  process.exit(1);
}
const args = process.argv.slice(2);
const notes = args[0] === 'push' && args.some((arg) => arg.startsWith('refs/notes/'));
const attempts = notes ? 5 : 1;
const delay = Number(process.env.GIT_RETRY_DELAY_MS ?? 5000);
for (let attempt = 1; ; attempt++) {
  const result = spawnSync(git, args, { stdio: 'inherit' });
  if (result.error) process.stderr.write(`git-retry: ${result.error.message}\n`);
  const status = result.status ?? 1;
  if (status === 0 || attempt === attempts) process.exit(status);
  process.stderr.write(
    `git-retry: git ${args.join(' ')} failed, attempt ${attempt} of ${attempts}\n`
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay * attempt);
}
