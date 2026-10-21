import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const semver = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(version, what) {
  const match = semver.exec(version);
  if (!match) {
    throw new Error(`dist-tag: ${what} ${JSON.stringify(version)} is not X.Y.Z`);
  }
  return match.slice(1).map(Number);
}

function below(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

export function distTag(version, ref, latest) {
  const next = parse(version, 'version');
  const line = `release-${next[0]}.${next[1]}.x`;
  if (ref !== 'refs/heads/main') return line;
  if (below(next, parse(latest, 'latest'))) return line;
  return 'latest';
}

export function isMain(argv1, url) {
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

export function cli(argv, url, out = process.stdout, exit = process.exit) {
  if (!argv[1] || !isMain(argv[1], url)) return;
  try {
    out.write(`${distTag(argv[2], argv[3], argv[4])}\n`);
  } catch (error) {
    console.error(error.message);
    exit(1);
  }
}

cli(process.argv, import.meta.url);
