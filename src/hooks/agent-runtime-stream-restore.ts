import { runtimeEventToAgentCoreParts } from '../../shared/agent-core-v2';
import type {
  AgentPermissionImpact,
  AgentRuntimeEvent,
  AgentRuntimeStatus,
  RuntimeUsage
} from '../../shared/types';
import {
  listStreamSessions,
  seedStreamSession,
  type StreamPermissionState,
  type StreamSessionState,
  type StreamStageState,
  type StreamUserInputState
} from '../lib/stream-session-manager';

function collectAgentCoreParts(events: AgentRuntimeEvent[] | undefined): NonNullable<StreamSessionState['agentCoreParts']> {
  let sequence = 0;
  return (events ?? []).flatMap((event) => runtimeEventToAgentCoreParts(event, {
    startingSequence: sequence++
  }));
}

function latestUsage(events: AgentRuntimeEvent[] | undefined): RuntimeUsage | undefined {
  return (events ?? []).slice().reverse().find((event) => event.usage)?.usage;
}

function latestPendingPermission(events: AgentRuntimeEvent[] | undefined): StreamPermissionState | undefined {
  const pending = new Map<string, StreamPermissionState>();
  for (const event of events ?? []) {
    if (event.type === 'permission_request' && event.permissionRequest) {
      pending.set(event.permissionRequest.requestId, {
        requestId: event.permissionRequest.requestId,
        title: event.permissionRequest.title,
        detail: event.permissionRequest.detail,
        risk: event.permissionRequest.risk,
        toolName: event.permissionRequest.toolName,
        impact: event.permissionRequest.impact as AgentPermissionImpact | undefined
      });
      continue;
    }
    if (event.type === 'permission_resolved' && event.permissionResponse) {
      pending.delete(event.permissionResponse.requestId);
    }
  }
  return [...pending.values()].at(-1);
}

function latestPendingUserInput(events: AgentRuntimeEvent[] | undefined): StreamUserInputState | undefined {
  const pending = new Map<string, StreamUserInputState>();
  for (const event of events ?? []) {
    if (event.type === 'user_input_request' && event.userInputRequest) {
      pending.set(event.userInputRequest.requestId, {
        requestId: event.userInputRequest.requestId,
        title: event.userInputRequest.title ?? 'User input',
        question: event.userInputRequest.question,
        detail: event.userInputRequest.detail,
        options: event.userInputRequest.options,
        multiSelect: event.userInputRequest.multiSelect,
        allowFreeText: event.userInputRequest.allowFreeText,
        placeholder: event.userInputRequest.placeholder,
        toolName: event.userInputRequest.toolName
      });
      continue;
    }
    if (event.type === 'user_input_resolved' && event.userInputResponse) {
      pending.delete(event.userInputResponse.requestId);
    }
  }
  return [...pending.values()].at(-1);
}

function runtimeStages(status: AgentRuntimeStatus): StreamStageState[] {
  return (status.timeline ?? []).map((entry) => ({
    stageId: entry.id,
    phase: entry.phase,
    title: entry.title,
    target: entry.target,
    status: entry.status,
    summary: entry.summary,
    errorMessage: entry.errorMessage
  }));
}

export function createStreamSessionFromRuntimeStatus(status: AgentRuntimeStatus): StreamSessionState | null {
  if (status.status !== 'running' || !status.streamId || !status.sessionId) {
    return null;
  }

  const agentCoreParts = collectAgentCoreParts(status.events);
  return {
    streamId: status.streamId,
    projectId: status.projectId,
    sessionId: status.sessionId,
    prompt: status.inputPreview ?? '',
    content: '',
    thinkingContent: '',
    toolUses: [],
    toolResults: [],
    stages: runtimeStages(status),
    activityItems: [],
    agentCoreParts,
    agentCorePartsAuthoritative: agentCoreParts.length > 0 || undefined,
    lastUsage: latestUsage(status.events),
    usageTotals: status.usage,
    pendingPermission: latestPendingPermission(status.events),
    pendingUserInput: latestPendingUserInput(status.events),
    phase: 'streaming',
    statusMessage: status.statusMessage ?? 'Agent run is still running in the background.',
    startedAt: status.startedAt,
    kind: status.kind
  };
}

export function restoreMissingRuntimeStreams(statuses: AgentRuntimeStatus[]): void {
  const existingStreamIds = new Set(listStreamSessions().map((stream) => stream.streamId));
  for (const status of statuses) {
    if (status.streamId && existingStreamIds.has(status.streamId)) {
      continue;
    }
    const stream = createStreamSessionFromRuntimeStatus(status);
    if (!stream) {
      continue;
    }
    seedStreamSession(stream);
    existingStreamIds.add(stream.streamId);
  }
}
