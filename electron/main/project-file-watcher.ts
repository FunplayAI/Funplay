import { existsSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import type { AppState, ProjectFileTreeChangedEvent } from '../../shared/types';

interface ProjectWatcherEntry {
  projectId: string;
  projectPath: string;
  watcher: FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
}

const watcherEntries = new Map<string, ProjectWatcherEntry>();

function resolveUserPath(projectPath: string): string {
  return resolve(projectPath.replace(/^~/, process.env.HOME ?? '~'));
}

function emitDebouncedProjectChange(
  entry: ProjectWatcherEntry,
  dispatchEvent: (payload: ProjectFileTreeChangedEvent) => void
): void {
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
  }

  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    dispatchEvent({
      projectId: entry.projectId,
      projectPath: entry.projectPath,
      changedAt: new Date().toISOString()
    });
  }, 180);
}

function closeWatcher(entry: ProjectWatcherEntry): void {
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
  }
  entry.watcher.close();
}

function shouldWatchProject(projectPath?: string): projectPath is string {
  return !!projectPath?.trim() && existsSync(resolveUserPath(projectPath));
}

export function syncProjectFileWatchers(
  state: AppState,
  dispatchEvent: (payload: ProjectFileTreeChangedEvent) => void
): void {
  const nextWatchTargets = new Map<string, string>();

  for (const project of state.projects) {
    const projectPath = project.engine?.projectPath;
    if (!shouldWatchProject(projectPath)) {
      continue;
    }
    nextWatchTargets.set(project.id, resolveUserPath(projectPath));
  }

  for (const [projectId, entry] of watcherEntries.entries()) {
    const nextPath = nextWatchTargets.get(projectId);
    if (!nextPath || nextPath !== entry.projectPath) {
      closeWatcher(entry);
      watcherEntries.delete(projectId);
    }
  }

  for (const [projectId, projectPath] of nextWatchTargets.entries()) {
    if (watcherEntries.has(projectId)) {
      continue;
    }

    try {
      const watcher = watch(projectPath, { recursive: true }, () => {
        const entry = watcherEntries.get(projectId);
        if (!entry) {
          return;
        }
        emitDebouncedProjectChange(entry, dispatchEvent);
      });

      watcher.on('error', () => {
        const entry = watcherEntries.get(projectId);
        if (!entry) {
          return;
        }
        closeWatcher(entry);
        watcherEntries.delete(projectId);
      });

      watcherEntries.set(projectId, {
        projectId,
        projectPath,
        watcher,
        debounceTimer: null
      });
    } catch {
      // Ignore watcher setup failures; file tree can still be refreshed manually or via event bus.
    }
  }
}

export function disposeProjectFileWatchers(): void {
  for (const entry of watcherEntries.values()) {
    closeWatcher(entry);
  }
  watcherEntries.clear();
}
