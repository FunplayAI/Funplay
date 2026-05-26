import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function fail(message, details = []) {
  console.error(message);
  for (const detail of details) {
    console.error(`- ${detail}`);
  }
  process.exitCode = 1;
}

async function readText(path) {
  return readFile(resolve(repoRoot, path), 'utf8');
}

async function exists(path) {
  try {
    await access(resolve(repoRoot, path));
    return true;
  } catch {
    return false;
  }
}

async function gitTrackedExisting(paths) {
  const result = spawnSync('git', ['ls-files', '--', ...paths], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return [];
  }
  const tracked = result.stdout.split(/\r?\n/).filter(Boolean);
  const existing = [];
  for (const path of tracked) {
    if (await exists(path)) {
      existing.push(path);
    }
  }
  return existing;
}

const requiredFiles = [
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/feature_request.md',
  '.github/workflows/release.yml',
  '.github/workflows/runtime-maturity-gate.yml'
];

const missingFiles = [];
for (const file of requiredFiles) {
  if (!await exists(file)) {
    missingFiles.push(file);
  }
}
if (missingFiles.length) {
  fail('Release audit failed: required public repository files are missing.', missingFiles);
}

const packageJson = JSON.parse(await readText('package.json'));
const publish = packageJson.build?.publish?.[0];
if (publish?.provider !== 'github' || publish.owner !== 'FunplayAI' || publish.repo !== 'Funplay') {
  fail('Release audit failed: package.json#build.publish must use GitHub Releases for FunplayAI/Funplay.');
}
if (publish?.releaseType !== 'release') {
  fail('Release audit failed: GitHub releaseType must publish public releases after the release workflow passes.');
}

const scripts = packageJson.scripts ?? {};
for (const scriptName of ['release:audit', 'release:gate', 'dist:mac:split', 'dist:win:x64', 'release:verify-mac-updates']) {
  if (!scripts[scriptName]) {
    fail(`Release audit failed: missing package script ${scriptName}.`);
  }
}
for (const scriptName of ['dist:mac:arm64', 'dist:mac:x64', 'dist:win:x64']) {
  if (!scripts[scriptName]?.includes('--publish never')) {
    fail(`Release audit failed: ${scriptName} must pass --publish never; GitHub Actions uploads final assets explicitly.`);
  }
}

const gitignore = await readText('.gitignore');
for (const pattern of ['docs/', 'AGENTS.md', 'CLAUDE.md']) {
  if (!gitignore.split(/\r?\n/).includes(pattern)) {
    fail(`Release audit failed: .gitignore must include ${pattern}.`);
  }
}

const forbiddenTracked = await gitTrackedExisting(['docs', 'AGENTS.md', 'CLAUDE.md']);
if (forbiddenTracked.length) {
  fail('Release audit failed: internal docs or agent instruction files are still tracked.', forbiddenTracked);
}

const updateService = await readText('electron/main/update-service.ts');
const appSettings = await readText('src/components/modals/AppSettingsModal.tsx');
const readme = await readText('README.md');
const readmeZhCn = await readText('README.zh-CN.md');
const workflow = await readText('.github/workflows/release.yml');
const searchable = [
  ['electron/main/update-service.ts', updateService],
  ['src/components/modals/AppSettingsModal.tsx', appSettings],
  ['README.md', readme],
  ['README.zh-CN.md', readmeZhCn],
  ['.github/workflows/release.yml', workflow],
  ['package.json', JSON.stringify(packageJson, null, 2)]
];
for (const [path, source] of searchable) {
  for (const forbidden of ['FUNPLAY_UPDATE_FEED_URL', 'FUNPLAY_UPDATE_ALLOW_DEV', 'provider": "generic"', 'Aliyun', 'OSS']) {
    if (source.includes(forbidden)) {
      fail(`Release audit failed: forbidden private update feed reference ${forbidden} remains in ${path}.`);
    }
  }
}

if (!workflow.includes('gh release') || !workflow.includes('dist:mac:split') || !workflow.includes('dist:win:x64')) {
  fail('Release audit failed: release workflow must build macOS split artifacts, Windows x64, and publish through gh release.');
}
if (!workflow.includes('Import macOS signing certificate') || !workflow.includes('Developer ID Application')) {
  fail('Release audit failed: release workflow must import and validate a Developer ID Application certificate before notarization.');
}
if (workflow.includes('-t cert -f pkcs12')) {
  fail('Release audit failed: macOS .p12 import must not force certificate-only import.');
}

console.log('Release config audit passed.');
