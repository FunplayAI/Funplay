import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const inputRoots = process.argv.slice(2).map((input) => resolve(repoRoot, input));
const scanRoots = inputRoots.length ? inputRoots : [resolve(repoRoot, 'release')];

const requiredAsarEntries = [
  'node_modules/ai/dist/index.mjs',
  'node_modules/@opentelemetry/api/package.json',
  'node_modules/@opentelemetry/api/build/src/index.js'
];

async function collectAsars(directory, found = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectAsars(path, found);
    } else if (entry.isFile() && entry.name === 'app.asar') {
      found.push(path);
    }
  }
  return found;
}

function normalizeEntry(entry) {
  return entry.replace(/^\/+/, '').split(sep).join('/');
}

async function verifyAsar(asarPath) {
  const entries = new Set(listPackage(asarPath).map(normalizeEntry));
  const missing = requiredAsarEntries.filter((entry) => !entries.has(entry));
  if (missing.length) {
    throw new Error(`${asarPath} is missing runtime dependency entries:\n${missing.map((entry) => `- ${entry}`).join('\n')}`);
  }
}

const asars = [];
for (const scanRoot of scanRoots) {
  const scanStats = await stat(scanRoot).catch(() => null);
  if (!scanStats?.isDirectory()) {
    throw new Error(`${scanRoot} does not exist or is not a directory. Build packaged artifacts before verifying runtime dependencies.`);
  }
  await collectAsars(scanRoot, asars);
}
if (!asars.length) {
  throw new Error('No app.asar files found under release/. Build packaged artifacts before verifying runtime dependencies.');
}

for (const asarPath of asars) {
  await verifyAsar(asarPath);
}

console.log(`Packaged runtime dependency verification passed for ${asars.length} app.asar file(s).`);
