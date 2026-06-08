import { access, copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { mergeMacUpdateMetadataFiles, verifyMacUpdateMetadataFile } from './merge-mac-update-metadata.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function fail(message) {
  throw new Error(message);
}

async function collectFiles(directory, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function hasAny(copiedNames, matcher) {
  return [...copiedNames].some((name) => {
    if (typeof matcher === 'function') {
      return matcher(name);
    }
    return matcher.test(name);
  });
}

function fileUrl(file) {
  return typeof file?.url === 'string' ? file.url : '';
}

function isRemoteUrl(value) {
  return /^[a-z]+:/i.test(value);
}

function localArtifactName(value) {
  return decodeURIComponent(value);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copySingleMatchingArtifact(releaseDir, copiedNames, matcher, targetName, label) {
  const candidates = [...copiedNames].filter((name) => matcher(name));
  if (candidates.includes(targetName)) {
    return;
  }
  if (candidates.length !== 1) {
    fail(`Missing ${label} ${targetName}; found ${candidates.length} candidate(s) to alias.`);
  }
  await copyFile(join(releaseDir, candidates[0]), join(releaseDir, targetName));
  copiedNames.add(targetName);
  console.log(`Added ${label} alias ${targetName} from ${candidates[0]}.`);
}

async function verifyWindowsUpdateMetadataFile(metadataPath, releaseDir, copiedNames) {
  const raw = await readFile(metadataPath, 'utf8');
  const metadata = yaml.load(raw);
  if (!metadata || typeof metadata !== 'object') {
    fail(`${metadataPath} is not a Windows update metadata object.`);
  }

  const files = Array.isArray(metadata.files) ? metadata.files : [];
  if (!files.length) {
    fail(`${metadataPath} is missing files.`);
  }

  const topLevelPath = typeof metadata.path === 'string' ? metadata.path : '';
  if (!topLevelPath) {
    fail(`${metadataPath} is missing path.`);
  }

  const topLevelFile = files.find((file) => fileUrl(file) === topLevelPath);
  if (!topLevelFile) {
    fail(`${metadataPath} top-level path is missing from files: ${topLevelPath}`);
  }
  if (metadata.sha512 && topLevelFile.sha512 !== metadata.sha512) {
    fail(`${metadataPath} top-level sha512 does not match files entry: ${topLevelPath}`);
  }

  const localUrls = files.map(fileUrl).filter((url) => url && !isRemoteUrl(url));
  if (!localUrls.some((url) => /\.exe$/i.test(url))) {
    fail(`${metadataPath} must reference a Windows installer .exe.`);
  }

  for (const url of localUrls) {
    const artifactName = localArtifactName(url);
    if (!copiedNames.has(artifactName)) {
      await copySingleMatchingArtifact(
        releaseDir,
        copiedNames,
        (name) => /\.exe$/i.test(name),
        artifactName,
        'Windows installer'
      );
    }

    const artifactPath = join(releaseDir, artifactName);
    if (!await exists(artifactPath)) {
      fail(`${metadataPath} references missing artifact ${artifactName}.`);
    }

    if (/\.exe$/i.test(artifactName)) {
      const blockmapName = `${artifactName}.blockmap`;
      if (!copiedNames.has(blockmapName)) {
        await copySingleMatchingArtifact(
          releaseDir,
          copiedNames,
          (name) => /\.exe\.blockmap$/i.test(name),
          blockmapName,
          'Windows installer blockmap'
        );
      }
      if (!await exists(join(releaseDir, blockmapName))) {
        fail(`${metadataPath} references ${artifactName}, but ${blockmapName} is missing.`);
      }
    }
  }
}

async function main(args) {
  const artifactsDir = resolve(repoRoot, args[0] ?? 'artifacts');
  const releaseDir = resolve(repoRoot, args[1] ?? 'release');
  const artifactsStats = await stat(artifactsDir).catch(() => null);
  if (!artifactsStats?.isDirectory()) {
    fail(`${artifactsDir} does not exist or is not a directory.`);
  }

  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  const sourceFiles = await collectFiles(artifactsDir);
  if (!sourceFiles.length) {
    fail(`${artifactsDir} does not contain any release artifact files.`);
  }

  const copied = new Map();
  for (const sourceFile of sourceFiles) {
    const name = basename(sourceFile);
    if (copied.has(name)) {
      fail(`Duplicate release artifact name ${name} from ${copied.get(name)} and ${sourceFile}.`);
    }
    await copyFile(sourceFile, join(releaseDir, name));
    copied.set(name, sourceFile);
  }

  const copiedNames = new Set(copied.keys());
  const requiredFiles = ['latest-mac-arm64.yml', 'latest-mac-x64.yml', 'latest.yml'];
  for (const requiredFile of requiredFiles) {
    if (!copiedNames.has(requiredFile)) {
      fail(`Missing release artifact ${requiredFile}.`);
    }
  }

  const requiredPatterns = [
    [/\.dmg$/i, 'macOS DMG'],
    [(name) => /-mac\.zip$/i.test(name) && !/-arm64-mac\.zip$/i.test(name), 'macOS Intel zip'],
    [/-arm64-mac\.zip$/i, 'macOS arm64 zip'],
    [/\.exe$/i, 'Windows installer']
  ];
  for (const [pattern, label] of requiredPatterns) {
    if (!hasAny(copiedNames, pattern)) {
      fail(`Missing ${label} release artifact.`);
    }
  }

  await verifyWindowsUpdateMetadataFile(join(releaseDir, 'latest.yml'), releaseDir, copiedNames);

  const arm64Metadata = join(releaseDir, 'latest-mac-arm64.yml');
  const x64Metadata = join(releaseDir, 'latest-mac-x64.yml');
  const latestMetadata = join(releaseDir, 'latest-mac.yml');

  await verifyMacUpdateMetadataFile(arm64Metadata, { requireSplit: false, checkArtifacts: true });
  await verifyMacUpdateMetadataFile(x64Metadata, { requireSplit: false, checkArtifacts: true });
  await mergeMacUpdateMetadataFiles([arm64Metadata, x64Metadata], latestMetadata);
  await verifyMacUpdateMetadataFile(latestMetadata, { checkArtifacts: true });

  console.log(`Prepared ${copiedNames.size + 1} release artifact(s) in ${releaseDir}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
