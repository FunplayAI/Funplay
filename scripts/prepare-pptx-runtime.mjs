#!/usr/bin/env node
import { access, cp, mkdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = join(repoRoot, 'resources', 'runtime');
const checkOnly = process.argv.includes('--check');

const libreOfficeTargets = [
  join(runtimeRoot, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'),
  join(runtimeRoot, 'LibreOffice', 'program', 'soffice')
];
const popplerTarget = join(runtimeRoot, 'poppler', 'bin', 'pdftoppm');

const libreOfficeSources = [
  process.env.FUNPLAY_LIBREOFFICE_SOURCE,
  process.env.FUNPLAY_LIBREOFFICE_PATH ? sourceFromLibreOfficeExecutable(process.env.FUNPLAY_LIBREOFFICE_PATH) : undefined,
  '/Applications/LibreOffice.app',
  '/opt/homebrew-cask/Caskroom/libreoffice/latest/LibreOffice.app'
].filter(Boolean);

const popplerSources = [
  process.env.FUNPLAY_POPPLER_SOURCE,
  process.env.FUNPLAY_PDFTOPPM_PATH ? resolve(process.env.FUNPLAY_PDFTOPPM_PATH, '../..') : undefined,
  '/opt/homebrew/opt/poppler',
  '/usr/local/opt/poppler'
].filter(Boolean);

const runtimeStatus = {
  libreOffice: await firstExistingExecutable(libreOfficeTargets),
  poppler: await pathIsExecutable(popplerTarget) ? popplerTarget : undefined
};
const systemStatus = {
  libreOffice: await firstExistingExecutable([
    process.env.FUNPLAY_LIBREOFFICE_PATH,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice'
  ]) ?? await firstAvailableCommand(['soffice', 'libreoffice'], ['--version']),
  poppler: await firstExistingExecutable([
    process.env.FUNPLAY_PDFTOPPM_PATH,
    '/opt/homebrew/bin/pdftoppm',
    '/usr/local/bin/pdftoppm'
  ]) ?? await firstAvailableCommand(['pdftoppm'], ['-v'])
};

if (checkOnly) {
  printStatus(runtimeStatus, systemStatus);
  process.exit(isReady(runtimeStatus) || isReady(systemStatus) ? 0 : 1);
}

await mkdir(runtimeRoot, { recursive: true });

let installedLibreOffice = runtimeStatus.libreOffice;
if (!installedLibreOffice) {
  const source = await firstExistingDirectory(libreOfficeSources);
  if (source) {
    const target = source.endsWith('.app')
      ? join(runtimeRoot, 'LibreOffice.app')
      : join(runtimeRoot, 'LibreOffice');
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true, force: true, dereference: true });
    installedLibreOffice = await firstExistingExecutable(libreOfficeTargets);
  }
}

let installedPoppler = runtimeStatus.poppler;
if (!installedPoppler) {
  const source = await firstExistingDirectory(popplerSources);
  if (source) {
    const target = join(runtimeRoot, 'poppler');
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true, force: true, dereference: true });
    installedPoppler = await pathIsExecutable(popplerTarget) ? popplerTarget : undefined;
  }
}

printStatus({
  libreOffice: installedLibreOffice,
  poppler: installedPoppler
}, systemStatus);

if (!installedLibreOffice || !installedPoppler) {
  const missing = [
    installedLibreOffice ? undefined : 'LibreOffice',
    installedPoppler ? undefined : 'Poppler pdftoppm'
  ].filter(Boolean).join(' and ');
  console.error(`Missing ${missing}. Install locally or set FUNPLAY_LIBREOFFICE_SOURCE / FUNPLAY_POPPLER_SOURCE, then rerun npm run runtime:pptx:prepare.`);
  process.exit(1);
}

function printStatus(bundledStatus, detectedSystemStatus = systemStatus) {
  const bundledReady = isReady(bundledStatus);
  const systemReady = isReady(detectedSystemStatus);
  console.log(JSON.stringify({
    runtimeRoot,
    bundled: {
      libreOffice: bundledStatus.libreOffice ?? null,
      poppler: bundledStatus.poppler ?? null,
      ready: bundledReady
    },
    system: {
      libreOffice: detectedSystemStatus.libreOffice ?? null,
      poppler: detectedSystemStatus.poppler ?? null,
      ready: systemReady
    },
    ready: bundledReady || systemReady
  }, null, 2));
}

function isReady(status) {
  return Boolean(status.libreOffice && status.poppler);
}

async function firstExistingExecutable(paths) {
  for (const candidate of paths) {
    if (await pathIsExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function pathIsExecutable(path) {
  if (!path) {
    return false;
  }

  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingDirectory(paths) {
  for (const candidate of paths) {
    if (!candidate) {
      continue;
    }
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Continue scanning configured candidates.
    }
  }
  return undefined;
}

async function firstAvailableCommand(commands, args) {
  for (const command of commands) {
    if (await commandRuns(command, args)) {
      return command;
    }
  }
  return undefined;
}

async function commandRuns(command, args) {
  return await new Promise((resolveResult) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'ignore']
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
    }, 1500);
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(false);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(code === 0);
    });
  });
}

function sourceFromLibreOfficeExecutable(executablePath) {
  const normalizedPath = resolve(executablePath);
  const appMarker = '.app/Contents/MacOS/soffice';
  if (normalizedPath.endsWith(appMarker)) {
    return `${normalizedPath.slice(0, -appMarker.length)}.app`;
  }
  if (normalizedPath.endsWith('/program/soffice')) {
    return resolve(normalizedPath, '../..');
  }
  return resolve(normalizedPath, '..');
}
