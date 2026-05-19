import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = process.cwd();
const packageName = '@anthropic-ai/claude-agent-sdk-darwin-x64';
const binaryPath = join(packageRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-x64', 'claude');
const sdkPackagePath = join(packageRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');

if (process.platform !== 'darwin') {
  console.log('Skipping darwin-x64 Claude SDK package check outside macOS.');
  process.exit(0);
}

if (existsSync(binaryPath)) {
  console.log('Claude SDK darwin-x64 package is present.');
  process.exit(0);
}

if (!existsSync(sdkPackagePath)) {
  console.error(`Claude Agent SDK package not found at ${sdkPackagePath}. Run npm install first.`);
  process.exit(1);
}

const sdkPackage = JSON.parse(readFileSync(sdkPackagePath, 'utf8'));
const sdkVersion = typeof sdkPackage.version === 'string' ? sdkPackage.version : '';

if (!sdkVersion) {
  console.error('Could not resolve @anthropic-ai/claude-agent-sdk version.');
  process.exit(1);
}

console.log(`Installing ${packageName}@${sdkVersion} for macOS universal packaging...`);

const result = spawnSync(
  'npm',
  ['install', '--force', '--no-save', '--no-package-lock', `${packageName}@${sdkVersion}`],
  {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: 'inherit'
  }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(binaryPath)) {
  console.error(`Expected Claude SDK x64 binary was not installed at ${binaryPath}.`);
  process.exit(1);
}

console.log('Claude SDK darwin-x64 package is present.');
