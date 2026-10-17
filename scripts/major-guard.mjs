import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function moduleMajor(goMod) {
  const match = goMod.match(/^module\s+(\S+)/m);
  if (!match) {
    throw new Error('major-guard: go.mod has no module directive');
  }
  const suffix = match[1].match(/\/v(\d+)$/);
  const major = suffix ? Number(suffix[1]) : 1;
  return { path: match[1], major, allowed: suffix ? [major] : [0, 1] };
}

export async function verifyRelease(_config, { cwd, nextRelease, logger }) {
  const { path, allowed } = moduleMajor(await readFile(join(cwd, 'go.mod'), 'utf8'));
  const next = Number(nextRelease.version.split('.')[0]);
  if (!allowed.includes(next)) {
    const base = path.replace(/\/v\d+$/, '');
    const want = next < 2 ? base : `${base}/v${next}`;
    throw new Error(
      `major-guard: v${nextRelease.version} needs module path ${want}, go.mod declares ${path}`
    );
  }
  logger.log(`major-guard: PASS v${nextRelease.version} fits ${path}`);
}

const main = (url) => {
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
};

if (process.argv[1] && main(import.meta.url)) {
  try {
    await verifyRelease(
      {},
      { cwd: process.cwd(), nextRelease: { version: process.argv[2] }, logger: console }
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
