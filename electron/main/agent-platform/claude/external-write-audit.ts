import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ProjectFileEntry } from '../../../../shared/types';
import { listProjectFilesForProject } from '../../project-file-service';
import { recordExternalFileCheckpoint } from '../file-checkpoint-store';
import type { GenericAgentRuntimeParams } from '../types';
import type { ExternalWriteBaseline } from './types';
import {
  EXTERNAL_WRITE_BINARY_EXTENSIONS,
  EXTERNAL_WRITE_SINGLE_FILE_MAX_BYTES,
  EXTERNAL_WRITE_SKIP_DIRS,
  EXTERNAL_WRITE_TOTAL_MAX_BYTES
} from './constants';
import { resolveClaudeCodeExecutable, shouldSpawnClaudeCommandWithShell } from './runtime';

export function ensureClaudeCliInstalled(): boolean {
  const executable = resolveClaudeCodeExecutable();
  const result = spawnSync(executable.command, ['--version'], {
    encoding: 'utf8',
    shell: shouldSpawnClaudeCommandWithShell(executable.command)
  });
  return result.status === 0;
}

export function buildPermissionDeniedReply(): string {
  return '当前消息包含写入意图，但 Claude Code runtime 没有拿到写入权限。我可以先给出修改方案，或者你把权限切到可写后再让我执行。';
}

export function mapFileSnapshot(files: ProjectFileEntry[]): Map<string, Pick<ProjectFileEntry, 'size' | 'modifiedAt'>> {
  return new Map(
    files
      .filter((file) => file.type !== 'directory')
      .map((file) => [file.path, {
        size: file.size,
        modifiedAt: file.modifiedAt
      }])
  );
}

export function diffFileSnapshots(before: Map<string, Pick<ProjectFileEntry, 'size' | 'modifiedAt'>>, after: Map<string, Pick<ProjectFileEntry, 'size' | 'modifiedAt'>>): {
  added: string[];
  modified: string[];
  removed: string[];
} {
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const modified = [...after.entries()]
    .filter(([path, file]) => {
      const previous = before.get(path);
      return previous && (previous.size !== file.size || previous.modifiedAt !== file.modifiedAt);
    })
    .map(([path]) => path)
    .sort();
  return {
    added,
    modified,
    removed
  };
}

export function shouldSkipExternalWritePath(path: string): boolean {
  return path.split('/').some((part) => EXTERNAL_WRITE_SKIP_DIRS.has(part));
}

export function isProbablyTextFile(path: string): boolean {
  return !EXTERNAL_WRITE_BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

export function resolveProjectRootPath(project: GenericAgentRuntimeParams['project']): string | undefined {
  const projectPath = project.engine?.projectPath?.trim();
  return projectPath ? projectPath.replace(/^~/, process.env.HOME ?? '~') : undefined;
}

export async function captureExternalWriteBaseline(params: GenericAgentRuntimeParams): Promise<ExternalWriteBaseline | undefined> {
  if (!params.checkpointSnapshotId) {
    return undefined;
  }

  const rootPath = resolveProjectRootPath(params.project);
  if (!rootPath) {
    return undefined;
  }

  const files = await listProjectFilesForProject(params.project);
  const baseline: ExternalWriteBaseline = {
    files: new Map(),
    skippedFiles: [],
    totalBytes: 0
  };

  for (const file of files.filter((entry) => entry.type !== 'directory')) {
    if (shouldSkipExternalWritePath(file.path)) {
      continue;
    }

    if (file.size > EXTERNAL_WRITE_SINGLE_FILE_MAX_BYTES) {
      baseline.files.set(file.path, {
        existed: true,
        rollbackSupported: false,
        reason: 'single_file_limit'
      });
      baseline.skippedFiles.push(file.path);
      continue;
    }

    if (!isProbablyTextFile(file.path) || baseline.totalBytes + file.size > EXTERNAL_WRITE_TOTAL_MAX_BYTES) {
      baseline.files.set(file.path, {
        existed: true,
        rollbackSupported: false,
        reason: !isProbablyTextFile(file.path) ? 'binary_or_unsupported' : 'total_size_limit'
      });
      baseline.skippedFiles.push(file.path);
      continue;
    }

    try {
      const content = readFileSync(join(rootPath, file.path), 'utf8');
      baseline.totalBytes += Buffer.byteLength(content, 'utf8');
      baseline.files.set(file.path, {
        existed: true,
        content,
        rollbackSupported: true
      });
    } catch {
      baseline.files.set(file.path, {
        existed: true,
        rollbackSupported: false,
        reason: 'read_failed'
      });
      baseline.skippedFiles.push(file.path);
    }
  }

  return baseline;
}

export async function recordExternalWriteRollbackCheckpoint(params: GenericAgentRuntimeParams, baseline: ExternalWriteBaseline | undefined, diff: {
  added: string[];
  modified: string[];
  removed: string[];
}): Promise<{
  rollbackFiles: string[];
  auditOnlyFiles: string[];
}> {
  if (!baseline || !params.checkpointSnapshotId) {
    return { rollbackFiles: [], auditOnlyFiles: [] };
  }

  const rollbackFiles: string[] = [];
  const auditOnlyFiles = new Set<string>();
  for (const filePath of diff.added) {
    if (shouldSkipExternalWritePath(filePath)) {
      auditOnlyFiles.add(filePath);
      continue;
    }
    await recordExternalFileCheckpoint({
      snapshotId: params.checkpointSnapshotId,
      project: params.project,
      filePath,
      existed: false
    });
    rollbackFiles.push(filePath);
  }

  for (const filePath of [...diff.modified, ...diff.removed]) {
    const entry = baseline.files.get(filePath);
    if (!entry?.rollbackSupported) {
      auditOnlyFiles.add(filePath);
      continue;
    }
    await recordExternalFileCheckpoint({
      snapshotId: params.checkpointSnapshotId,
      project: params.project,
      filePath,
      existed: entry.existed,
      content: entry.content
    });
    rollbackFiles.push(filePath);
  }

  for (const filePath of baseline.skippedFiles) {
    if (diff.modified.includes(filePath) || diff.removed.includes(filePath)) {
      auditOnlyFiles.add(filePath);
    }
  }

  return {
    rollbackFiles: [...new Set(rollbackFiles)].sort(),
    auditOnlyFiles: [...auditOnlyFiles].sort()
  };
}
