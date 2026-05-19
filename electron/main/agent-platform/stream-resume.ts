import type { AgentRuntimeResumeContext } from '../../../shared/types';
import { restoreFileCheckpoint } from './file-checkpoint-store';
import type { getActiveOrPersistedRun } from './run-registry';
import type { createStateAdapter } from './state-adapter';

export async function restoreFilesForResume(
  stateAdapter: ReturnType<typeof createStateAdapter>,
  projectId: string,
  checkpointSnapshotId?: string
): Promise<void> {
  if (!checkpointSnapshotId) {
    return;
  }

  const resolved = stateAdapter.resolveProjectContext(projectId);
  await restoreFileCheckpoint(resolved.current, checkpointSnapshotId);
}

export function buildResumeContextForRun(run: NonNullable<ReturnType<typeof getActiveOrPersistedRun>>): AgentRuntimeResumeContext {
  return {
    resumedFromRunId: run.id,
    strategy: run.resumeStrategy ?? (run.lastToolBoundary?.status === 'completed' ? 'resume_after_last_completed_tool' : 'restart_prompt'),
    previousStatus: run.status,
    coreState: run.coreState,
    originalInput: run.inputPreview ?? run.request.inputPreview ?? run.request.message,
    checkpointSnapshotId: run.checkpointSnapshotId,
    filesRestoredToCheckpoint: Boolean(run.checkpointSnapshotId),
    lastError: run.lastError,
    lastToolBoundary: run.lastToolBoundary,
    resumeCursor: run.resumeCursor,
    recentTimeline: run.timeline?.slice(-12)
  };
}
