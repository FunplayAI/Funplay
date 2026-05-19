import { runtimeEventToAgentCoreParts } from '../../../shared/agent-core-v2';
import type { AgentCoreMessagePart, AgentCorePartKind, AgentReplayAgentCoreDebugger, AgentReplayLog, AgentReplayMetrics, AgentRuntimeEvent, AgentRuntimeStatus, RuntimeUsageTotals } from '../../../shared/types';

const REPLAY_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\btp-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /\b(api[_-]?key|authorization|token)(\s*[:=]\s*)[^\s'",}]{8,}/gi
];

function latestUsageTotals(run: AgentRuntimeStatus): RuntimeUsageTotals | undefined {
  const usageEvents = (run.events ?? []).filter((event) => event.type === 'usage' && event.usageTotals);
  return usageEvents.at(-1)?.usageTotals ?? run.usage;
}

function redactString(value: string): {
  value: string;
  count: number;
} {
  let count = 0;
  let next = value;
  for (const pattern of REPLAY_SECRET_PATTERNS) {
    next = next.replace(pattern, (match, key, separator) => {
      count += 1;
      if (typeof key === 'string' && typeof separator === 'string') {
        return `${key}${separator}[REDACTED]`;
      }
      return match.toLowerCase().startsWith('bearer ') ? 'Bearer [REDACTED]' : '[REDACTED]';
    });
  }
  return {
    value: next,
    count
  };
}

function redactUnknown(value: unknown): {
  value: unknown;
  count: number;
} {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    let count = 0;
    const redacted = value.map((item) => {
      const result = redactUnknown(item);
      count += result.count;
      return result.value;
    });
    return {
      value: redacted,
      count
    };
  }
  if (value && typeof value === 'object') {
    let count = 0;
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = redactUnknown(item);
      count += result.count;
      redacted[key] = result.value;
    }
    return {
      value: redacted,
      count
    };
  }
  return {
    value,
    count: 0
  };
}

function countRepeatedToolResults(events: AgentRuntimeEvent[]): number {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'tool_result' || !event.toolResult?.toolUseId) {
      continue;
    }
    counts.set(event.toolResult.toolUseId, (counts.get(event.toolResult.toolUseId) ?? 0) + 1);
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function eventHaystack(event: AgentRuntimeEvent): string {
  return [
    event.type,
    event.statusMessage,
    event.error,
    event.timelineEntry?.phase,
    event.timelineEntry?.title,
    event.timelineEntry?.target,
    event.timelineEntry?.summary,
    event.toolBoundary?.phase,
    event.toolBoundary?.summary
  ].filter(Boolean).join(' ').toLowerCase();
}

export function buildAgentReplayMetrics(run: AgentRuntimeStatus): AgentReplayMetrics {
  const events = run.events ?? [];
  const usageTotals = latestUsageTotals(run);
  const usageEventCount = events.filter((event) => event.type === 'usage').length;
  const skillActivationCount = events.filter((event) => event.type === 'skill_activation' && event.skillActivation).length;
  const hookEventCount = events.filter((event) => event.type === 'hook' && event.hook).length;
  const toolUseIds = new Set(events
    .filter((event) => event.type === 'tool_use' && event.toolUse?.toolUseId)
    .map((event) => event.toolUse?.toolUseId as string));
  const toolResultEvents = events.filter((event) => event.type === 'tool_result');
  const recoveryEvents = events.filter((event) => {
    const haystack = eventHaystack(event);
    return /\b(retry|recover|replay|duplicate)\b|重试|恢复|回放|重复/.test(haystack);
  });
  const apiRetryCount = events.filter((event) => /api_retry|api retry|接口重试/.test(eventHaystack(event))).length;
  const contextRetryCount = events.filter((event) => /context_retry|context retry|上下文重试/.test(eventHaystack(event))).length;
  const tokenTurns = usageTotals?.turns ?? 0;
  const totalTokens = usageTotals?.totalTokens ?? 0;

  return {
    eventCount: events.length,
    usageEventCount,
    totalTokens,
    inputTokens: usageTotals?.inputTokens ?? 0,
    outputTokens: usageTotals?.outputTokens ?? 0,
    cacheCreationTokens: usageTotals?.cacheCreationTokens ?? 0,
    cacheReadTokens: usageTotals?.cacheReadTokens ?? 0,
    tokenTurns,
    averageTokensPerTurn: tokenTurns > 0 ? totalTokens / tokenTurns : undefined,
    toolCallCount: toolUseIds.size,
    toolResultCount: toolResultEvents.length,
    failedToolResultCount: toolResultEvents.filter((event) => event.toolResult?.isError).length,
    toolRetryCount: countRepeatedToolResults(events),
    recoveryEventCount: recoveryEvents.length,
    apiRetryCount,
    contextRetryCount,
    skillActivationCount,
    hookEventCount
  };
}

function sortAgentCoreParts(parts: AgentCoreMessagePart[]): AgentCoreMessagePart[] {
  return [...parts].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

function countAgentCoreParts(parts: AgentCoreMessagePart[]): Partial<Record<AgentCorePartKind, number>> {
  return parts.reduce<Partial<Record<AgentCorePartKind, number>>>((counts, part) => {
    counts[part.kind] = (counts[part.kind] ?? 0) + 1;
    return counts;
  }, {});
}

function buildDebuggerProviderSteps(events: AgentRuntimeEvent[]): AgentReplayAgentCoreDebugger['providerSteps'] {
  return events
    .filter((event) => event.providerStep)
    .map((event) => ({
      eventId: event.id,
      createdAt: event.createdAt,
      finishReason: event.providerStep?.finishReason,
      toolCallCount: event.providerStep?.toolCalls.length ?? 0,
      hasText: Boolean(event.providerStep?.text?.trim()),
      hasThinking: Boolean(event.providerStep?.thinking?.trim()),
      warningCount: event.providerStep?.warnings?.length ?? 0
    }));
}

function buildDebuggerToolTransactions(events: AgentRuntimeEvent[]): AgentReplayAgentCoreDebugger['toolTransactions'] {
  const transactions = new Map<string, AgentReplayAgentCoreDebugger['toolTransactions'][number]>();
  for (const event of events) {
    const hookTransaction = event.hook?.transaction;
    if (hookTransaction?.toolUseId) {
      transactions.set(hookTransaction.toolUseId, {
        ...transactions.get(hookTransaction.toolUseId),
        toolUseId: hookTransaction.toolUseId,
        toolName: hookTransaction.toolName,
        toolClass: hookTransaction.toolClass,
        phase: hookTransaction.phase,
        status: hookTransaction.status,
        startedAt: hookTransaction.startedAt,
        completedAt: hookTransaction.updatedAt,
        failed: hookTransaction.status === 'failed' || hookTransaction.status === 'cancelled',
        eventCount: hookTransaction.eventCount,
        checkpointSnapshotId: hookTransaction.checkpoint?.snapshotId
      });
      continue;
    }
    if (event.toolUse?.toolUseId) {
      transactions.set(event.toolUse.toolUseId, {
        ...transactions.get(event.toolUse.toolUseId),
        toolUseId: event.toolUse.toolUseId,
        toolName: event.toolUse.name,
        status: event.toolUse.status,
        startedAt: transactions.get(event.toolUse.toolUseId)?.startedAt ?? event.createdAt
      });
      continue;
    }
    if (event.toolResult?.toolUseId) {
      const transaction = event.toolResult.transaction;
      transactions.set(event.toolResult.toolUseId, {
        ...transactions.get(event.toolResult.toolUseId),
        toolUseId: event.toolResult.toolUseId,
        toolName: event.toolResult.toolName ?? transaction?.toolName ?? transactions.get(event.toolResult.toolUseId)?.toolName,
        toolClass: transaction?.toolClass ?? transactions.get(event.toolResult.toolUseId)?.toolClass,
        phase: transaction?.phase ?? transactions.get(event.toolResult.toolUseId)?.phase,
        status: transaction?.status ?? (event.toolResult.isError ? 'failed' : 'completed'),
        startedAt: transaction?.startedAt ?? transactions.get(event.toolResult.toolUseId)?.startedAt,
        completedAt: transaction?.updatedAt ?? event.createdAt,
        failed: transaction ? transaction.status === 'failed' || transaction.status === 'cancelled' : Boolean(event.toolResult.isError),
        eventCount: transaction?.eventCount ?? transactions.get(event.toolResult.toolUseId)?.eventCount,
        changedFileCount: event.toolResult.changedFiles?.length,
        failureKind: event.toolResult.edit?.failureKind ?? event.toolResult.mcp?.failureKind,
        checkpointSnapshotId: transaction?.checkpoint?.snapshotId ?? transactions.get(event.toolResult.toolUseId)?.checkpointSnapshotId
      });
      continue;
    }
    if (event.toolBoundary?.toolUseId) {
      const transaction = event.toolBoundary.transaction;
      transactions.set(event.toolBoundary.toolUseId, {
        ...transactions.get(event.toolBoundary.toolUseId),
        toolUseId: event.toolBoundary.toolUseId,
        toolName: event.toolBoundary.toolName ?? transaction?.toolName ?? transactions.get(event.toolBoundary.toolUseId)?.toolName,
        toolClass: transaction?.toolClass ?? transactions.get(event.toolBoundary.toolUseId)?.toolClass,
        phase: transaction?.phase ?? transactions.get(event.toolBoundary.toolUseId)?.phase,
        status: transaction?.status ?? event.toolBoundary.status,
        startedAt: transaction?.startedAt ?? transactions.get(event.toolBoundary.toolUseId)?.startedAt,
        completedAt: transaction?.updatedAt ?? event.toolBoundary.completedAt ?? transactions.get(event.toolBoundary.toolUseId)?.completedAt,
        failed: transaction ? transaction.status === 'failed' || transaction.status === 'cancelled' : transactions.get(event.toolBoundary.toolUseId)?.failed,
        eventCount: transaction?.eventCount ?? transactions.get(event.toolBoundary.toolUseId)?.eventCount,
        checkpointSnapshotId: transaction?.checkpoint?.snapshotId ?? event.toolBoundary.checkpointSnapshotId ?? transactions.get(event.toolBoundary.toolUseId)?.checkpointSnapshotId
      });
    }
  }
  return [...transactions.values()];
}

function buildDebuggerPermissionDecisions(events: AgentRuntimeEvent[]): AgentReplayAgentCoreDebugger['permissionDecisions'] {
  return events
    .filter((event) => {
      const haystack = eventHaystack(event);
      return /permission|权限|授权|拒绝|允许/.test(haystack) || Boolean(event.metadata?.permissionDecision);
    })
    .map((event) => ({
      eventId: event.id,
      createdAt: event.createdAt,
      summary: event.statusMessage ?? event.timelineEntry?.summary ?? event.error,
      decision: typeof event.metadata?.permissionDecision === 'string' ? event.metadata.permissionDecision : undefined
    }));
}

function buildDebuggerCompressionPoints(events: AgentRuntimeEvent[]): AgentReplayAgentCoreDebugger['compressionPoints'] {
  return events
    .filter((event) => event.type === 'context_summary' && event.contextSummary)
    .map((event) => ({
      eventId: event.id,
      createdAt: event.createdAt,
      summary: event.contextSummary?.summary ?? '',
      coverage: event.contextSummary?.coverage as Record<string, unknown> | undefined
    }));
}

function buildDebuggerHookEvents(events: AgentRuntimeEvent[]): AgentReplayAgentCoreDebugger['hookEvents'] {
  return events
    .filter((event) => event.type === 'hook' && event.hook)
    .map((event) => ({
      eventId: event.id,
      createdAt: event.createdAt,
      hookId: event.hook?.id ?? event.id,
      event: event.hook?.event ?? 'Notification',
      actionType: event.hook?.actionType ?? 'audit',
      status: event.hook?.status ?? 'skipped',
      summary: event.hook?.summary ?? event.statusMessage ?? 'Lifecycle hook event.',
      transaction: event.hook?.transaction
    }));
}

export function buildAgentCoreDebugger(run: AgentRuntimeStatus): AgentReplayAgentCoreDebugger {
  const events = run.events ?? [];
  const parts = sortAgentCoreParts((run.events ?? []).flatMap((event, index) => runtimeEventToAgentCoreParts(event, {
    runId: run.id,
    startingSequence: index
  })));
  const state = run.coreState;
  return {
    state,
    transitions: state?.history ?? [],
    parts,
    partCounts: countAgentCoreParts(parts),
    providerSteps: buildDebuggerProviderSteps(events),
    toolTransactions: buildDebuggerToolTransactions(events),
    permissionDecisions: buildDebuggerPermissionDecisions(events),
    compressionPoints: buildDebuggerCompressionPoints(events),
    hookEvents: buildDebuggerHookEvents(events),
    resumeCursor: run.resumeCursor
  };
}

export function buildAgentReplayLog(run: AgentRuntimeStatus, exportedAt = new Date().toISOString()): AgentReplayLog {
  const replayRun: AgentRuntimeStatus = {
    id: run.id,
    kind: run.kind,
    projectId: run.projectId,
    sessionId: run.sessionId,
    runtimeId: run.runtimeId,
    providerId: run.providerId,
    model: run.model,
    permissionMode: run.permissionMode,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    status: run.status,
    statusMessage: run.statusMessage,
    streamId: run.streamId,
    checkpointSnapshotId: run.checkpointSnapshotId,
    canResume: run.canResume,
    inputPreview: run.inputPreview,
    lastError: run.lastError,
    resumedFromRunId: run.resumedFromRunId,
    timeline: run.timeline,
    lastToolBoundary: run.lastToolBoundary,
    resumeStrategy: run.resumeStrategy,
    resumeCursor: run.resumeCursor,
    taskGraph: run.taskGraph,
    verification: run.verification,
    usage: run.usage,
    coreState: run.coreState,
    events: run.events
  };
  const toolBoundaries = run.lastToolBoundary ? [run.lastToolBoundary] : [];
  const metrics = buildAgentReplayMetrics(run);

  return {
    id: `replay_${run.id}_${exportedAt.replace(/[:.]/g, '-')}`,
    runId: run.id,
    exportedAt,
    run: replayRun,
    taskGraph: run.taskGraph,
    verification: run.verification,
    timeline: run.timeline ?? [],
    events: run.events ?? [],
    lastToolBoundary: run.lastToolBoundary,
    toolBoundaries,
    usage: run.usage,
    metrics,
    recovery: {
      canResume: run.canResume,
      resumeStrategy: run.resumeStrategy,
      resumeCursor: run.resumeCursor,
      checkpointSnapshotId: run.checkpointSnapshotId,
      resumedFromRunId: run.resumedFromRunId,
      lastError: run.lastError
    },
    agentCore: buildAgentCoreDebugger(run)
  };
}

export function buildRedactedAgentReplayLog(run: AgentRuntimeStatus, exportedAt = new Date().toISOString()): AgentReplayLog {
  const redacted = redactUnknown(run);
  const log = buildAgentReplayLog(redacted.value as AgentRuntimeStatus, exportedAt);
  return {
    ...log,
    redacted: true,
    redactionSummary: {
      replacementCount: redacted.count
    }
  };
}
