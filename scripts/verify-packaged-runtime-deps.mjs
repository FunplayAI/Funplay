import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require('@electron/asar');

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const inputRoots = process.argv.slice(2).map((input) => resolve(repoRoot, input));
const scanRoots = inputRoots.length ? inputRoots : [resolve(repoRoot, 'release')];
const rootPackage = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));
const expectedVersion = rootPackage.version;

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
  return entry.replaceAll('\\', '/').replace(/^\/+/, '');
}

async function verifyAsar(asarPath) {
  const entries = new Set(listPackage(asarPath).map(normalizeEntry));
  const missing = requiredAsarEntries.filter((entry) => !entries.has(entry));
  if (missing.length) {
    throw new Error(`${asarPath} is missing runtime dependency entries:\n${missing.map((entry) => `- ${entry}`).join('\n')}`);
  }
  verifyPackagedPackageVersion(asarPath);
  await verifyUpdateConfig(asarPath);
  await verifyMacBundleVersion(asarPath);
}

function verifyPackagedPackageVersion(asarPath) {
  const packagedPackage = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
  if (packagedPackage.version !== expectedVersion) {
    throw new Error(`${asarPath} contains package version ${packagedPackage.version}, expected ${expectedVersion}.`);
  }
}

async function verifyUpdateConfig(asarPath) {
  const updateConfigPath = join(dirname(asarPath), 'app-update.yml');
  const raw = await readFile(updateConfigPath, 'utf8').catch(() => null);
  if (!raw) {
    throw new Error(`${updateConfigPath} is missing. Packaged apps must include app-update.yml for automatic updates.`);
  }
  const config = yaml.load(raw);
  if (!config || typeof config !== 'object') {
    throw new Error(`${updateConfigPath} is not a valid update configuration.`);
  }
  const record = config;
  if (
    record.provider !== 'github' ||
    record.owner !== 'FunplayAI' ||
    record.repo !== 'Funplay' ||
    record.releaseType !== 'release'
  ) {
    throw new Error(`${updateConfigPath} must point to GitHub Releases for FunplayAI/Funplay.`);
  }
  if (record.updaterCacheDirName !== 'funplay-updater') {
    throw new Error(`${updateConfigPath} must set updaterCacheDirName to funplay-updater.`);
  }
}

async function verifyMacBundleVersion(asarPath) {
  const resourcesDir = dirname(asarPath);
  const infoPlistPath = resolve(resourcesDir, '..', 'Info.plist');
  const raw = await readFile(infoPlistPath, 'utf8').catch(() => null);
  if (!raw) {
    return;
  }
  const version = readPlistString(raw, 'CFBundleShortVersionString');
  const buildVersion = readPlistString(raw, 'CFBundleVersion');
  if (version && version !== expectedVersion) {
    throw new Error(`${infoPlistPath} has CFBundleShortVersionString ${version}, expected ${expectedVersion}.`);
  }
  if (buildVersion && buildVersion !== expectedVersion) {
    throw new Error(`${infoPlistPath} has CFBundleVersion ${buildVersion}, expected ${expectedVersion}.`);
  }
}

function readPlistString(raw, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = raw.match(new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([^<]+)</string>`));
  return match?.[1]?.trim() ?? '';
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

console.log(`Packaged runtime, version, and update configuration verification passed for ${asars.length} app.asar file(s).`);
