import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeMacUpdateMetadataFiles, readMacUpdateMetadata, verifyMacUpdateMetadataFile } from './merge-mac-update-metadata.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseDir = join(repoRoot, 'release');
const cacheDir = join(repoRoot, 'out', 'mac-split-release-cache');
const arm64CacheDir = join(cacheDir, 'arm64');
const arm64Metadata = join(releaseDir, 'latest-mac-arm64.yml');
const x64Metadata = join(releaseDir, 'latest-mac-x64.yml');
const latestMetadata = join(releaseDir, 'latest-mac.yml');

function run(command) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, {
      cwd: repoRoot,
      shell: true,
      stdio: 'inherit'
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`Command failed with exit code ${code}: ${command}`));
    });
  });
}

async function copyIfExists(sourcePath, targetPath) {
  try {
    await access(sourcePath);
  } catch {
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function copyReferencedArtifacts(metadataPath, targetDir) {
  const metadata = await readMacUpdateMetadata(metadataPath);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await copyFile(metadataPath, join(targetDir, 'latest-mac.yml'));

  for (const file of metadata.files) {
    if (/^[a-z]+:/i.test(file.url)) continue;
    const artifactName = decodeURIComponent(file.url);
    const sourcePath = join(releaseDir, artifactName);
    const targetPath = join(targetDir, artifactName);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await copyIfExists(`${sourcePath}.blockmap`, `${targetPath}.blockmap`);
  }
}

async function restoreReferencedArtifacts(sourceDir, metadataPath) {
  const metadata = await readMacUpdateMetadata(metadataPath);
  for (const file of metadata.files) {
    if (/^[a-z]+:/i.test(file.url)) continue;
    const artifactName = decodeURIComponent(file.url);
    const sourcePath = join(sourceDir, artifactName);
    const targetPath = join(releaseDir, artifactName);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await copyIfExists(`${sourcePath}.blockmap`, `${targetPath}.blockmap`);
  }
}

async function main() {
  await rm(cacheDir, { recursive: true, force: true });
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  await run('npm run dist:mac:arm64');
  await run('npm run release:verify-runtime-deps');
  await copyFile(latestMetadata, arm64Metadata);
  await verifyMacUpdateMetadataFile(arm64Metadata, { requireSplit: false, checkArtifacts: true });
  await copyReferencedArtifacts(arm64Metadata, arm64CacheDir);

  await run('npm run dist:mac:x64');
  await run('npm run release:verify-runtime-deps');
  await copyFile(join(arm64CacheDir, 'latest-mac.yml'), arm64Metadata);
  await restoreReferencedArtifacts(arm64CacheDir, arm64Metadata);
  await copyFile(latestMetadata, x64Metadata);
  await verifyMacUpdateMetadataFile(x64Metadata, { requireSplit: false, checkArtifacts: true });

  await mergeMacUpdateMetadataFiles([arm64Metadata, x64Metadata], latestMetadata);
  await verifyMacUpdateMetadataFile(latestMetadata, { checkArtifacts: true });
  console.log('Split-arch mac release metadata is ready: release/latest-mac.yml');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
