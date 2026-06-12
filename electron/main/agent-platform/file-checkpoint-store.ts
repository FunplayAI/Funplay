import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import type { Project } from '../../../shared/types';
import { clearFileCheckpointEntries, listFileCheckpointEntries, upsertFileCheckpointEntry } from '../store';
import { buildCompactUnifiedDiff } from '../project-file-service';
import { isPathInsideRoot } from '../path-guard';

interface FileSnapshot {
  path: string;
  existed: boolean;
  isBinary: boolean;
  /** UTF-8 text content; only set for text snapshots. */
  content?: string;
  /** Raw bytes; only set for binary snapshots. */
  binaryContent?: Buffer;
  byteLength?: number;
  contentHash?: string;
  /** File exceeded the capture byte cap: no content captured, rollback is a no-op. */
  tooLarge?: boolean;
}

const checkpoints = new Map<string, Map<string, FileSnapshot>>();
// Per-run content-address dedup: `${'b'|'t'}:${sha256}` -> first snapshot holding that blob.
const checkpointBlobIndexes = new Map<string, Map<string, FileSnapshot>>();

const DEFAULT_MAX_CHECKPOINT_FILE_BYTES = 25 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

// Extension hint for formats that are binary even without NUL bytes in the first 8KB.
const BINARY_FILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tga', '.psd', '.tif', '.tiff', '.exr', '.hdr',
  '.fbx', '.blend', '.glb', '.unitypackage', '.bytes', '.ress', '.bin', '.pak', '.bundle',
  '.wav', '.mp3', '.ogg', '.flac', '.aif', '.aiff', '.m4a',
  '.mp4', '.mov', '.avi', '.webm', '.mkv',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.zip', '.7z', '.rar', '.gz', '.tar', '.jar', '.apk', '.aab', '.ipa',
  '.dll', '.so', '.dylib', '.exe', '.pdb', '.wasm',
  '.pdf'
]);

export function resolveMaxCheckpointFileBytes(): number {
  const parsed = Number.parseInt(process.env.FUNPLAY_CHECKPOINT_MAX_FILE_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CHECKPOINT_FILE_BYTES;
}

function hasBinaryFileExtension(filePath: string): boolean {
  return BINARY_FILE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function looksBinary(filePath: string, content: Buffer): boolean {
  return hasBinaryFileExtension(filePath) || content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function hashContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function blobKey(isBinary: boolean, contentHash: string): string {
  return `${isBinary ? 'b' : 't'}:${contentHash}`;
}

function getBlobIndex(snapshotId: string): Map<string, FileSnapshot> {
  const existing = checkpointBlobIndexes.get(snapshotId);
  if (existing) {
    return existing;
  }
  const created = new Map<string, FileSnapshot>();
  checkpointBlobIndexes.set(snapshotId, created);
  return created;
}

function formatBinaryDiffPreview(beforeBytes: number, afterBytes: number): string {
  return `(二进制文件，${beforeBytes} bytes → ${afterBytes} bytes)`;
}

function resolveProjectRoot(project: Project): string {
  if (!project.engine?.projectPath) {
    throw new Error('当前项目还没有记录真实项目路径。');
  }
  return resolve(project.engine.projectPath.replace(/^~/, process.env.HOME ?? '~'));
}

function resolveProjectFilePath(project: Project, filePath: string): {
  resolvedFilePath: string;
  relativePath: string;
} {
  const rootPath = resolveProjectRoot(project);
  const normalizedInput = filePath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalizedInput || normalizedInput === '.' || normalizedInput.endsWith('/')) {
    throw new Error('非法文件路径。');
  }

  const resolvedFilePath = resolve(rootPath, normalizedInput);
  if (!isPathInsideRoot(rootPath, resolvedFilePath)) {
    throw new Error('非法文件路径。');
  }
  if (resolvedFilePath === rootPath) {
    throw new Error('目标不是一个文件。');
  }

  return {
    resolvedFilePath,
    relativePath: relative(rootPath, resolvedFilePath).split('\\').join('/')
  };
}

function persistSnapshot(snapshotId: string, snapshot: FileSnapshot, options: { dedupRef: boolean }): void {
  try {
    upsertFileCheckpointEntry({
      snapshotId,
      filePath: snapshot.path,
      existed: snapshot.existed,
      content: options.dedupRef
        ? undefined
        : snapshot.isBinary
          ? snapshot.binaryContent?.toString('base64')
          : snapshot.content,
      isBinary: snapshot.isBinary,
      byteLength: snapshot.byteLength,
      contentHash: snapshot.contentHash,
      tooLarge: snapshot.tooLarge
    });
  } catch {
    // The in-memory checkpoint map is authoritative for active runs and unit
    // tests; SQLite persistence is best-effort when the app store is available.
  }
}

function getSnapshotMap(snapshotId: string): Map<string, FileSnapshot> {
  return checkpoints.get(snapshotId) ?? new Map(
    listFileCheckpointEntries(snapshotId).map((entry) => [
      entry.path,
      {
        path: entry.path,
        existed: entry.existed,
        isBinary: entry.isBinary,
        content: entry.isBinary ? undefined : entry.content,
        binaryContent: entry.isBinary && entry.content !== undefined ? Buffer.from(entry.content, 'base64') : undefined,
        byteLength: entry.byteLength,
        contentHash: entry.contentHash,
        tooLarge: entry.tooLarge || undefined
      } satisfies FileSnapshot
    ])
  );
}

function captureSharedOrNewSnapshot(params: {
  snapshotId: string;
  relativePath: string;
  isBinary: boolean;
  raw: Buffer;
}): {
  snapshot: FileSnapshot;
  dedupRef: boolean;
} {
  const contentHash = hashContent(params.raw);
  const blobIndex = getBlobIndex(params.snapshotId);
  const shared = blobIndex.get(blobKey(params.isBinary, contentHash));
  if (shared) {
    return {
      snapshot: {
        path: params.relativePath,
        existed: true,
        isBinary: params.isBinary,
        content: shared.content,
        binaryContent: shared.binaryContent,
        byteLength: params.raw.byteLength,
        contentHash
      },
      dedupRef: true
    };
  }

  const snapshot: FileSnapshot = params.isBinary
    ? {
        path: params.relativePath,
        existed: true,
        isBinary: true,
        binaryContent: params.raw,
        byteLength: params.raw.byteLength,
        contentHash
      }
    : {
        path: params.relativePath,
        existed: true,
        isBinary: false,
        content: params.raw.toString('utf8'),
        byteLength: params.raw.byteLength,
        contentHash
      };
  blobIndex.set(blobKey(params.isBinary, contentHash), snapshot);
  return {
    snapshot,
    dedupRef: false
  };
}

export async function recordExternalFileCheckpoint(params: {
  snapshotId?: string;
  project: Project;
  filePath: string;
  existed: boolean;
  content?: string;
}): Promise<void> {
  if (!params.snapshotId) {
    return;
  }

  const { relativePath } = resolveProjectFilePath(params.project, params.filePath);
  const snapshotMap = checkpoints.get(params.snapshotId) ?? new Map<string, FileSnapshot>();
  if (snapshotMap.has(relativePath)) {
    checkpoints.set(params.snapshotId, snapshotMap);
    return;
  }

  let snapshot: FileSnapshot;
  let dedupRef = false;
  if (params.existed && params.content !== undefined) {
    const raw = Buffer.from(params.content, 'utf8');
    if (raw.byteLength > resolveMaxCheckpointFileBytes()) {
      snapshot = {
        path: relativePath,
        existed: true,
        isBinary: false,
        byteLength: raw.byteLength,
        tooLarge: true
      };
    } else {
      const captured = captureSharedOrNewSnapshot({
        snapshotId: params.snapshotId,
        relativePath,
        isBinary: false,
        raw
      });
      snapshot = captured.snapshot;
      dedupRef = captured.dedupRef;
    }
  } else {
    snapshot = {
      path: relativePath,
      existed: params.existed,
      isBinary: false,
      content: params.content
    };
  }

  snapshotMap.set(relativePath, snapshot);
  persistSnapshot(params.snapshotId, snapshot, { dedupRef });
  checkpoints.set(params.snapshotId, snapshotMap);
}

export async function recordFileCheckpoint(params: {
  snapshotId?: string;
  project: Project;
  filePath: string;
}): Promise<void> {
  if (!params.snapshotId) {
    return;
  }

  const { resolvedFilePath, relativePath } = resolveProjectFilePath(params.project, params.filePath);
  const snapshotMap = checkpoints.get(params.snapshotId) ?? new Map<string, FileSnapshot>();
  if (snapshotMap.has(relativePath)) {
    checkpoints.set(params.snapshotId, snapshotMap);
    return;
  }

  let snapshot: FileSnapshot;
  let dedupRef = false;
  try {
    const stats = await stat(resolvedFilePath);
    if (stats.size > resolveMaxCheckpointFileBytes()) {
      // Reading huge files risks OOM and bloats SQLite; record a marker entry instead.
      snapshot = {
        path: relativePath,
        existed: true,
        isBinary: hasBinaryFileExtension(relativePath),
        byteLength: stats.size,
        tooLarge: true
      };
    } else {
      const raw = await readFile(resolvedFilePath);
      const captured = captureSharedOrNewSnapshot({
        snapshotId: params.snapshotId,
        relativePath,
        isBinary: looksBinary(relativePath, raw),
        raw
      });
      snapshot = captured.snapshot;
      dedupRef = captured.dedupRef;
    }
  } catch {
    snapshot = {
      path: relativePath,
      existed: false,
      isBinary: false
    };
  }

  snapshotMap.set(relativePath, snapshot);
  persistSnapshot(params.snapshotId, snapshot, { dedupRef });
  checkpoints.set(params.snapshotId, snapshotMap);
}

export async function restoreFileCheckpoint(project: Project, snapshotId: string): Promise<{
  restoredFiles: string[];
  skippedFiles: string[];
  tooLargeFiles: string[];
}> {
  const snapshotMap = getSnapshotMap(snapshotId);
  if (snapshotMap.size === 0) {
    return {
      restoredFiles: [],
      skippedFiles: [],
      tooLargeFiles: []
    };
  }

  const restoredFiles: string[] = [];
  const skippedFiles: string[] = [];
  const tooLargeFiles: string[] = [];

  for (const snapshot of snapshotMap.values()) {
    if (snapshot.tooLarge) {
      // No content was captured for over-cap files; writing anything back would corrupt them.
      tooLargeFiles.push(snapshot.path);
      continue;
    }
    try {
      const { resolvedFilePath } = resolveProjectFilePath(project, snapshot.path);
      if (snapshot.existed) {
        await mkdir(dirname(resolvedFilePath), { recursive: true });
        if (snapshot.isBinary) {
          await writeFile(resolvedFilePath, snapshot.binaryContent ?? Buffer.alloc(0));
        } else {
          await writeFile(resolvedFilePath, snapshot.content ?? '', 'utf8');
        }
      } else {
        await rm(resolvedFilePath, { force: true });
      }
      restoredFiles.push(snapshot.path);
    } catch {
      skippedFiles.push(snapshot.path);
    }
  }

  return {
    restoredFiles,
    skippedFiles,
    tooLargeFiles
  };
}

export async function previewFileCheckpointChanges(project: Project, snapshotId: string): Promise<{
  snapshotId: string;
  changedFiles: Array<{
    path: string;
    status: 'added' | 'modified' | 'removed';
    diffPreview: string;
  }>;
  skippedFiles: string[];
  tooLargeFiles: string[];
}> {
  const snapshotMap = getSnapshotMap(snapshotId);
  const changedFiles: Array<{
    path: string;
    status: 'added' | 'modified' | 'removed';
    diffPreview: string;
  }> = [];
  const skippedFiles: string[] = [];
  const tooLargeFiles: string[] = [];

  for (const snapshot of snapshotMap.values()) {
    if (snapshot.tooLarge) {
      tooLargeFiles.push(snapshot.path);
      continue;
    }
    try {
      const { resolvedFilePath, relativePath } = resolveProjectFilePath(project, snapshot.path);
      let currentBytes: Buffer | undefined;
      try {
        currentBytes = await readFile(resolvedFilePath);
      } catch {
        currentBytes = undefined;
      }

      const isBinary = snapshot.isBinary || (currentBytes !== undefined && looksBinary(relativePath, currentBytes));
      const snapshotBytes = snapshot.isBinary
        ? snapshot.binaryContent ?? Buffer.alloc(0)
        : Buffer.from(snapshot.content ?? '', 'utf8');

      if (!snapshot.existed && currentBytes !== undefined) {
        changedFiles.push({
          path: relativePath,
          status: 'added',
          diffPreview: isBinary
            ? formatBinaryDiffPreview(0, currentBytes.byteLength)
            : buildCompactUnifiedDiff(relativePath, '', currentBytes.toString('utf8'))
        });
        continue;
      }

      if (snapshot.existed && currentBytes === undefined) {
        changedFiles.push({
          path: relativePath,
          status: 'removed',
          diffPreview: isBinary
            ? formatBinaryDiffPreview(snapshotBytes.byteLength, 0)
            : buildCompactUnifiedDiff(relativePath, snapshot.content ?? '', '')
        });
        continue;
      }

      if (snapshot.existed && currentBytes !== undefined) {
        if (isBinary) {
          if (!snapshotBytes.equals(currentBytes)) {
            changedFiles.push({
              path: relativePath,
              status: 'modified',
              diffPreview: formatBinaryDiffPreview(snapshotBytes.byteLength, currentBytes.byteLength)
            });
          }
          continue;
        }
        const currentText = currentBytes.toString('utf8');
        if (currentText !== (snapshot.content ?? '')) {
          changedFiles.push({
            path: relativePath,
            status: 'modified',
            diffPreview: buildCompactUnifiedDiff(relativePath, snapshot.content ?? '', currentText)
          });
        }
      }
    } catch {
      skippedFiles.push(snapshot.path);
    }
  }

  return {
    snapshotId,
    changedFiles,
    skippedFiles,
    tooLargeFiles
  };
}

export function clearFileCheckpoint(snapshotId: string): void {
  checkpoints.delete(snapshotId);
  checkpointBlobIndexes.delete(snapshotId);
  clearFileCheckpointEntries(snapshotId);
}
