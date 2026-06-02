import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { Project } from '../../../shared/types';
import { clearFileCheckpointEntries, listFileCheckpointEntries, upsertFileCheckpointEntry } from '../store';
import { buildCompactUnifiedDiff } from '../project-file-service';
import { isPathInsideRoot } from '../path-guard';

interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

const checkpoints = new Map<string, Map<string, FileSnapshot>>();

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

function persistCheckpointEntry(record: {
  snapshotId: string;
  filePath: string;
  existed: boolean;
  content?: string;
}): void {
  try {
    upsertFileCheckpointEntry(record);
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
        content: entry.content
      }
    ])
  );
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

  const snapshot = {
    path: relativePath,
    existed: params.existed,
    content: params.content
  };
  snapshotMap.set(relativePath, snapshot);
  persistCheckpointEntry({
    snapshotId: params.snapshotId,
    filePath: relativePath,
    existed: params.existed,
    content: params.content
  });
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

  try {
    const content = await readFile(resolvedFilePath, 'utf8');
	    const snapshot = {
	      path: relativePath,
	      existed: true,
	      content
	    };
	    snapshotMap.set(relativePath, snapshot);
	    persistCheckpointEntry({
	      snapshotId: params.snapshotId,
	      filePath: relativePath,
	      existed: true,
      content
    });
  } catch {
	    const snapshot = {
	      path: relativePath,
	      existed: false
	    };
	    snapshotMap.set(relativePath, snapshot);
	    persistCheckpointEntry({
	      snapshotId: params.snapshotId,
	      filePath: relativePath,
      existed: false
    });
  }

  checkpoints.set(params.snapshotId, snapshotMap);
}

export async function restoreFileCheckpoint(project: Project, snapshotId: string): Promise<{
  restoredFiles: string[];
  skippedFiles: string[];
}> {
  const snapshotMap = getSnapshotMap(snapshotId);
  if (snapshotMap.size === 0) {
    return {
      restoredFiles: [],
      skippedFiles: []
    };
  }

  const restoredFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const snapshot of snapshotMap.values()) {
    try {
      const { resolvedFilePath } = resolveProjectFilePath(project, snapshot.path);
      if (snapshot.existed) {
        await mkdir(dirname(resolvedFilePath), { recursive: true });
        await writeFile(resolvedFilePath, snapshot.content ?? '', 'utf8');
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
    skippedFiles
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
}> {
  const snapshotMap = getSnapshotMap(snapshotId);
  const changedFiles: Array<{
    path: string;
    status: 'added' | 'modified' | 'removed';
    diffPreview: string;
  }> = [];
  const skippedFiles: string[] = [];

  for (const snapshot of snapshotMap.values()) {
    try {
      const { resolvedFilePath, relativePath } = resolveProjectFilePath(project, snapshot.path);
      let currentContent: string | undefined;
      try {
        currentContent = await readFile(resolvedFilePath, 'utf8');
      } catch {
        currentContent = undefined;
      }

      if (!snapshot.existed && currentContent !== undefined) {
        changedFiles.push({
          path: relativePath,
          status: 'added',
          diffPreview: buildCompactUnifiedDiff(relativePath, '', currentContent)
        });
        continue;
      }

      if (snapshot.existed && currentContent === undefined) {
        changedFiles.push({
          path: relativePath,
          status: 'removed',
          diffPreview: buildCompactUnifiedDiff(relativePath, snapshot.content ?? '', '')
        });
        continue;
      }

      if (snapshot.existed && currentContent !== undefined && currentContent !== (snapshot.content ?? '')) {
        changedFiles.push({
          path: relativePath,
          status: 'modified',
          diffPreview: buildCompactUnifiedDiff(relativePath, snapshot.content ?? '', currentContent)
        });
      }
    } catch {
      skippedFiles.push(snapshot.path);
    }
  }

  return {
    snapshotId,
    changedFiles,
    skippedFiles
  };
}

export function clearFileCheckpoint(snapshotId: string): void {
  checkpoints.delete(snapshotId);
  clearFileCheckpointEntries(snapshotId);
}
