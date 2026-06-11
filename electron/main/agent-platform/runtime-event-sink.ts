import type {
  AgentCoreMessagePart,
  ProjectSessionRuntimeId,
  PromptStreamEvent,
  RuntimeDiagnosticSeverity,
  RuntimeRecoveryAction
} from '../../../shared/types';
import {
  recordActiveRunStreamDelta,
  updateActiveRunStatus
} from './run-registry';
import {
  makeStageHandler,
  makeToolResultHandler,
  makeToolUseHandler,
  makeUsageHandler
} from './stream-event-dispatcher';
import type { StageEvent, StreamContext } from './stream-types';
import type { GenericAgentPhase } from './types';

export interface RuntimeStreamMetadata {
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  upstreamModel?: string;
  diagnosticCode?: string;
  severity?: RuntimeDiagnosticSeverity;
  errorCode?: string;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
}

export interface RuntimeEventSinkOptions {
  initialMetadata?: RuntimeStreamMetadata;
  emitStageSideEvents?: boolean;
}

function stageMetadataPatch(stage: StageEvent): RuntimeStreamMetadata {
  return {
    runtimeId: stage.runtimeId,
    providerId: stage.providerId,
    model: stage.model,
    upstreamModel: stage.upstreamModel,
    diagnosticCode: stage.diagnosticCode,
    severity: stage.severity,
    errorCode: stage.errorCode,
    suggestedAction: stage.suggestedAction,
    recoveryActions: stage.recoveryActions
  };
}

function mergeMetadata(current: RuntimeStreamMetadata, patch: RuntimeStreamMetadata): RuntimeStreamMetadata {
  return {
    ...current,
    runtimeId: patch.runtimeId ?? current.runtimeId,
    providerId: patch.providerId ?? current.providerId,
    model: patch.model ?? current.model,
    upstreamModel: patch.upstreamModel ?? current.upstreamModel,
    diagnosticCode: patch.diagnosticCode ?? current.diagnosticCode,
    severity: patch.severity ?? current.severity,
    errorCode: patch.errorCode ?? current.errorCode,
    suggestedAction: patch.suggestedAction ?? current.suggestedAction,
    recoveryActions: patch.recoveryActions ?? current.recoveryActions
  };
}

function definedMetadataFields(metadata: RuntimeStreamMetadata): RuntimeStreamMetadata {
  return {
    runtimeId: metadata.runtimeId,
    providerId: metadata.providerId,
    model: metadata.model,
    upstreamModel: metadata.upstreamModel,
    diagnosticCode: metadata.diagnosticCode,
    severity: metadata.severity,
    errorCode: metadata.errorCode,
    suggestedAction: metadata.suggestedAction,
    recoveryActions: metadata.recoveryActions
  };
}

function metadataDispatchFields(metadata: RuntimeStreamMetadata): Record<string, unknown> {
  return {
    runtimeId: metadata.runtimeId,
    providerId: metadata.providerId,
    model: metadata.model,
    upstreamModel: metadata.upstreamModel,
    diagnosticCode: metadata.diagnosticCode,
    severity: metadata.severity,
    errorCode: metadata.errorCode,
    suggestedAction: metadata.suggestedAction,
    recoveryActions: metadata.recoveryActions
  };
}

function emitStageSideEvent(ctx: StreamContext, stage: StageEvent): void {
  if (stage.phase === 'context_compressed') {
    ctx.dispatchEvent({
      type: 'context_compressed',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      message: stage.summary || '上下文已压缩。',
      boundaryOrdinal: typeof stage.input?.boundaryOrdinal === 'number' ? stage.input.boundaryOrdinal : undefined,
      coveredMessageCount: typeof stage.input?.coveredMessageCount === 'number' ? stage.input.coveredMessageCount : undefined,
      startedAt: ctx.startedAt
    });
  }
  if (stage.phase === 'tool_timeout') {
    ctx.dispatchEvent({
      type: 'tool_timeout',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      toolUseId: typeof stage.input?.toolUseId === 'string' ? stage.input.toolUseId : undefined,
      toolName: typeof stage.input?.toolName === 'string' ? stage.input.toolName : undefined,
      elapsedSeconds: typeof stage.input?.elapsedSeconds === 'number' ? stage.input.elapsedSeconds : undefined,
      message: stage.summary || '工具执行超时。',
      startedAt: ctx.startedAt
    });
  }
}

export function createRuntimeEventSink(ctx: StreamContext, options: RuntimeEventSinkOptions = {}) {
  let metadata = options.initialMetadata ?? {};
  const onStage = makeStageHandler(ctx, {
    updateMetadata: (stage) => {
      metadata = mergeMetadata(metadata, stageMetadataPatch(stage));
    },
    extraDispatchFields: (stage) => metadataDispatchFields(stageMetadataPatch(stage)),
    onAfterDispatch: options.emitStageSideEvents
      ? (stage) => emitStageSideEvent(ctx, stage)
      : undefined
  });

  const onStatus = (phase: GenericAgentPhase, statusMessage: string): void => {
    updateActiveRunStatus(ctx.activeRunId, statusMessage);
    ctx.dispatchEvent({
      type: 'status',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      phase,
      message: statusMessage,
      ...definedMetadataFields(metadata),
      startedAt: ctx.startedAt
    });
  };

  const onTextDelta = (delta: string, content: string): void => {
    recordActiveRunStreamDelta(ctx.activeRunId, {
      kind: 'text',
      delta,
      content
    });
    ctx.dispatchEvent({
      type: 'delta',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      delta,
      content,
      startedAt: ctx.startedAt
    });
  };

  const onThinkingDelta = (delta: string, content: string): void => {
    recordActiveRunStreamDelta(ctx.activeRunId, {
      kind: 'thinking',
      delta,
      content
    });
    ctx.dispatchEvent({
      type: 'thinking',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      delta,
      content,
      startedAt: ctx.startedAt
    });
  };

  const emitTextSnapshot = (content: string): void => {
    onTextDelta(content, content);
  };

  const onAgentCoreParts = (parts: AgentCoreMessagePart[]): void => {
    ctx.dispatchEvent({
      type: 'agent_core_parts',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      parts,
      startedAt: ctx.startedAt
    });
  };

  return {
    getMetadata: (): RuntimeStreamMetadata => metadata,
    onStatus,
    onTextDelta,
    onThinkingDelta,
    onToolUse: makeToolUseHandler(ctx),
    onToolResult: makeToolResultHandler(ctx),
    onStage,
    onUsage: makeUsageHandler(ctx),
    onAgentCoreParts,
    emitTextSnapshot
  };
}
