import type { PromptStreamEvent } from '../../../shared/types';
import type { GenericAgentRuntimeParams } from './types';

export interface StreamContext {
  streamId: string;
  projectId: string;
  sessionId: string;
  startedAt: string;
  controller: AbortController;
  activeRunId: string;
  toolNamesByUseId: Map<string, string>;
  checkpointSnapshotId?: string;
  dispatchEvent: (event: PromptStreamEvent) => void;
}

export type StageEvent = Parameters<NonNullable<GenericAgentRuntimeParams['onStage']>>[0];
