import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/guard-lifecycle.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function running(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}

async function removed(directory) {
  try {
    await access(directory);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

for (const mode of [
  'close',
  'exit',
  'error',
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGKILL',
  'timeout',
]) {
  test(`launcher reaps its Chrome process group and profile on ${mode}`, {
    timeout: 30000,
  }, async (t) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const runner = fork(fixture, [mode], {
      execArgv: [],
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exited = new Promise((resolve, reject) => {
      runner.once('exit', (code, signal) => resolve({ code, signal }));
      runner.once('error', reject);
    });
    let ready;
    runner.on('message', (message) => {
      ready = message;
    });
    let output = '';
    let errors = '';
    runner.stdout.on('data', (chunk) => {
      output += chunk;
    });
    runner.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    t.after(async () => {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
      if (ready) {
        try {
          process.kill(-ready.pid, 'SIGKILL');
        } catch {}
        await rm(ready.directory, { recursive: true, force: true });
      }
    });
    const deadline = Date.now() + 15000;
    while (!ready && Date.now() < deadline) {
      if (runner.exitCode !== null || runner.signalCode !== null) break;
      await pause(25);
    }
    assert(ready, `runner never launched Chrome: ${output}\n${errors}`);
    assert(ready.pids.includes(ready.pid), JSON.stringify(ready));
    if (mode.startsWith('SIG')) runner.kill(mode);
    const result = await exited;
    if (mode === 'close' || mode === 'exit') assert.equal(result.code, 0, errors);
    if (mode === 'error' || mode === 'timeout')
      assert.notEqual(result.code, 0, `${output}\n${errors}`);
    if (mode === 'timeout') assert.match(`${output}\n${errors}`, /timed out after/);
    const cleanupDeadline = Date.now() + 5000;
    let alive;
    let profileGone;
    do {
      alive = (
        await Promise.all(ready.pids.map(async (pid) => ((await running(pid)) ? pid : null)))
      ).filter(Boolean);
      profileGone = await removed(ready.directory);
      if (!alive.length && profileGone) break;
      await pause(50);
    } while (Date.now() < cleanupDeadline);
    assert.deepEqual(alive, [], `Chrome survived ${mode}: ${alive}`);
    assert(profileGone, `profile survived ${mode}: ${ready.directory}`);
  });
}
