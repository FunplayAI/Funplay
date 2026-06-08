import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function fail(message) {
  throw new Error(message);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function fileUrl(file) {
  return typeof file?.url === 'string' ? file.url : '';
}

function isZipUrl(url) {
  return /\.zip(?:$|[?#])/i.test(url);
}

function isUniversalUrl(url) {
  return /(?:^|[-_/])universal(?:[-_.]|$)/i.test(url);
}

function isArm64Url(url) {
  return /(?:^|[-_/])arm64(?:[-_.]|$)/i.test(url);
}

function isIntelZipUrl(url) {
  return isZipUrl(url) && !isArm64Url(url) && !isUniversalUrl(url);
}

function normalizeMetadata(metadata, sourcePath) {
  if (!metadata || typeof metadata !== 'object') {
    fail(`${sourcePath} is not a mac update metadata object.`);
  }

  const version = typeof metadata.version === 'string' ? metadata.version : '';
  if (!version) {
    fail(`${sourcePath} is missing version.`);
  }

  const files = asArray(metadata.files).map((file) => ({ ...file }));
  if (!files.length) {
    fail(`${sourcePath} is missing files.`);
  }

  for (const file of files) {
    const url = fileUrl(file);
    if (!url) {
      fail(`${sourcePath} has a file entry without url.`);
    }
    if (!file.sha512) {
      fail(`${sourcePath} file ${url} is missing sha512.`);
    }
    if (isUniversalUrl(url)) {
      fail(`${sourcePath} contains a universal mac artifact: ${url}`);
    }
  }

  const path = typeof metadata.path === 'string' ? metadata.path : '';
  if (path && isUniversalUrl(path)) {
    fail(`${sourcePath} contains a universal mac path: ${path}`);
  }

  return {
    version,
    files,
    path,
    sha512: typeof metadata.sha512 === 'string' ? metadata.sha512 : '',
    releaseDate: typeof metadata.releaseDate === 'string' ? metadata.releaseDate : ''
  };
}

export async function readMacUpdateMetadata(inputPath) {
  const absolutePath = resolve(repoRoot, inputPath);
  const raw = await readFile(absolutePath, 'utf8');
  return normalizeMetadata(yaml.load(raw), absolutePath);
}

function latestReleaseDate(values) {
  const dates = values
    .map((value) => value.releaseDate)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return dates[0] ?? new Date().toISOString();
}

function selectCompatibilityZip(files) {
  return files.find((file) => isIntelZipUrl(fileUrl(file))) ?? files.find((file) => isZipUrl(fileUrl(file))) ?? files[0];
}

export function verifyMacUpdateMetadata(metadata, options = {}) {
  const normalized = normalizeMetadata(metadata, options.sourcePath ?? 'mac update metadata');
  const urls = normalized.files.map(fileUrl);
  const arm64Zip = urls.find((url) => isZipUrl(url) && isArm64Url(url));
  const intelZip = urls.find(isIntelZipUrl);
  const zipCount = urls.filter(isZipUrl).length;

  if (options.requireSplit !== false) {
    if (!arm64Zip) {
      fail('mac update metadata must include an arm64 zip artifact.');
    }
    if (!intelZip) {
      fail('mac update metadata must include an Intel/x64 zip artifact.');
    }
  } else if (!zipCount) {
    fail('mac update metadata must include at least one zip artifact.');
  }

  const compatibility = selectCompatibilityZip(normalized.files);
  if (!compatibility || !fileUrl(compatibility)) {
    fail('mac update metadata must expose a top-level compatibility zip path.');
  }
  if (!normalized.path || !isZipUrl(normalized.path)) {
    fail('mac update metadata top-level path must point to a zip artifact.');
  }
  const topLevelFile = normalized.files.find((file) => fileUrl(file) === normalized.path);
  if (!topLevelFile) {
    fail(`mac update metadata top-level path is missing from files: ${normalized.path}`);
  }
  if (normalized.sha512 && topLevelFile.sha512 !== normalized.sha512) {
    fail(`mac update metadata top-level sha512 does not match files entry: ${normalized.path}`);
  }
  if (options.requireSplit !== false && normalized.path !== intelZip) {
    fail('mac update metadata top-level path must point to the Intel/x64 zip for compatibility.');
  }

  return {
    arm64Zip,
    intelZip,
    compatibilityPath: fileUrl(compatibility)
  };
}

export function mergeMacUpdateMetadataEntries(entries) {
  if (entries.length < 2) {
    fail('merge requires at least two mac update metadata files.');
  }

  const version = entries[0].version;
  for (const entry of entries) {
    if (entry.version !== version) {
      fail(`mac update metadata versions do not match: ${version} vs ${entry.version}`);
    }
  }

  const files = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const file of entry.files) {
      const url = fileUrl(file);
      if (seen.has(url)) continue;
      seen.add(url);
      files.push({ ...file });
    }
  }

  const compatibility = selectCompatibilityZip(files);
  const merged = {
    version,
    files,
    path: fileUrl(compatibility),
    sha512: compatibility?.sha512,
    releaseDate: latestReleaseDate(entries)
  };

  verifyMacUpdateMetadata(merged, { sourcePath: 'merged mac update metadata' });
  return merged;
}

export async function mergeMacUpdateMetadataFiles(inputPaths, outputPath) {
  const entries = [];
  for (const inputPath of inputPaths) {
    entries.push(await readMacUpdateMetadata(inputPath));
  }
  const merged = mergeMacUpdateMetadataEntries(entries);
  if (outputPath) {
    const absoluteOutputPath = resolve(repoRoot, outputPath);
    await writeFile(absoluteOutputPath, yaml.dump(merged, { lineWidth: 140, quotingType: "'" }), 'utf8');
  }
  return merged;
}

export async function verifyMacUpdateMetadataFile(inputPath, options = {}) {
  const absolutePath = resolve(repoRoot, inputPath);
  const raw = await readFile(absolutePath, 'utf8');
  const metadata = yaml.load(raw);
  const result = verifyMacUpdateMetadata(metadata, { ...options, sourcePath: absolutePath });

  if (options.checkArtifacts) {
    const baseDir = dirname(absolutePath);
    const normalized = normalizeMetadata(metadata, absolutePath);
    for (const file of normalized.files) {
      const url = fileUrl(file);
      if (/^[a-z]+:/i.test(url)) continue;
      const artifactPath = resolve(baseDir, decodeURIComponent(url));
      await access(artifactPath);
      if (isZipUrl(url)) {
        await access(`${artifactPath}.blockmap`);
      }
    }
  }

  return result;
}

function parseArgs(args) {
  const command = args[0];
  if (command === '--verify') {
    return {
      mode: 'verify',
      inputPath: args[1],
      checkArtifacts: args.includes('--check-artifacts'),
      requireSplit: !args.includes('--single-arch')
    };
  }

  if (command === '--merge') {
    const outputIndex = args.indexOf('--output');
    const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : 'release/latest-mac.yml';
    const inputPaths = args.slice(1).filter((arg, index) => {
      const absoluteIndex = index + 1;
      return arg !== '--output' && absoluteIndex !== outputIndex + 1;
    });
    return {
      mode: 'merge',
      inputPaths,
      outputPath
    };
  }

  fail('Usage: merge-mac-update-metadata.mjs --merge <arm64.yml> <x64.yml> --output <latest-mac.yml> | --verify <latest-mac.yml> [--check-artifacts]');
}

async function main(args) {
  const parsed = parseArgs(args);
  if (parsed.mode === 'verify') {
    if (!parsed.inputPath) {
      fail('--verify requires a metadata path.');
    }
    await verifyMacUpdateMetadataFile(parsed.inputPath, {
      checkArtifacts: parsed.checkArtifacts,
      requireSplit: parsed.requireSplit
    });
    console.log(`Verified mac update metadata: ${parsed.inputPath}`);
    return;
  }

  if (parsed.inputPaths.length < 2) {
    fail('--merge requires at least two metadata paths.');
  }
  await mergeMacUpdateMetadataFiles(parsed.inputPaths, parsed.outputPath);
  console.log(`Merged mac update metadata: ${parsed.outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
