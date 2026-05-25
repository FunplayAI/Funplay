import type {
  AgentCoreMessagePart,
  AgentOperationRecord,
  AgentOperationStatus,
  AgentToolTransactionSummary,
  ChatMessageProcessActivity,
  ChatMessageMetadata,
  ProjectSessionRuntimeId,
  RuntimeDiagnosticSeverity,
  RuntimeRecoveryAction
} from '../../../shared/types';

export interface ConversationOperationStageEvent {
  stageId?: string;
  phase?: string;
  title: string;
  target: string;
  status: AgentOperationStatus;
  input?: Record<string, unknown>;
  summary?: string;
  errorMessage?: string;
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  upstreamModel?: string;
  diagnosticCode?: string;
  severity?: RuntimeDiagnosticSeverity;
  errorCode?: string;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
  transaction?: AgentToolTransactionSummary;
}

function isTerminalStatus(status: AgentOperationStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'skipped';
}

function isInlineLifecycleHookStage(stage: ConversationOperationStageEvent): boolean {
  const stageId = stage.stageId ?? `stage:${stage.target}`;
  if (!stageId.includes('stage:lifecycle_hook:') && !stage.target.startsWith('hook:')) {
    return false;
  }
  const hookStatus = typeof stage.input?.status === 'string' ? stage.input.status : undefined;
  const actionType = typeof stage.input?.actionType === 'string' ? stage.input.actionType : undefined;
  return stage.status === 'failed' ||
    actionType === 'command' ||
    hookStatus === 'blocked' ||
    hookStatus === 'permission_denied' ||
    hookStatus === 'command_completed' ||
    hookStatus === 'command_failed' ||
    hookStatus === 'requires_permission';
}

function stageInputWithTransaction(stage: ConversationOperationStageEvent, existing?: AgentOperationRecord): Record<string, unknown> | undefined {
  if (!stage.transaction) {
    return stage.input ?? existing?.input;
  }
  return {
    ...(stage.input ?? existing?.input ?? {}),
    transaction: stage.transaction
  };
}

function toolResultInputWithTransaction(
  result: {
    transaction?: AgentToolTransactionSummary;
  },
  existing?: AgentOperationRecord
): Record<string, unknown> | undefined {
  if (!result.transaction) {
    return existing?.input;
  }
  return {
    ...(existing?.input ?? {}),
    transaction: result.transaction
  };
}

export function createConversationOperationLogCollector() {
  const operations = new Map<string, AgentOperationRecord>();

  const upsertOperation = (id: string, next: Omit<AgentOperationRecord, 'id' | 'startedAt' | 'finishedAt'>): void => {
    const existing = operations.get(id);
    operations.set(id, {
      id,
      ...next,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      finishedAt: isTerminalStatus(next.status) ? new Date().toISOString() : existing?.finishedAt
    });
  };

  return {
    onToolUse(tool: {
      toolUseId: string;
      name: string;
      title?: string;
      summary?: string;
      input?: Record<string, unknown>;
      status: 'pending' | 'running' | 'completed' | 'failed';
    }): void {
      const existing = operations.get(tool.toolUseId);
      upsertOperation(tool.toolUseId, {
        scope: 'conversation',
        title: tool.title ?? tool.name,
        target: tool.name,
        type: 'tool_call',
        input: tool.input,
        status: tool.status,
        summary: existing?.summary ?? tool.summary,
        errorMessage: existing?.errorMessage
      });
    },
    onToolResult(result: {
      toolUseId: string;
      content: string;
      isError?: boolean;
      transaction?: AgentToolTransactionSummary;
    }): void {
      const existing = operations.get(result.toolUseId);
      upsertOperation(result.toolUseId, {
        scope: 'conversation',
        title: existing?.title ?? 'tool_call',
        target: existing?.target ?? 'tool_call',
        type: existing?.type ?? 'tool_call',
        input: toolResultInputWithTransaction(result, existing),
        status: result.isError ? 'failed' : 'completed',
        summary: result.content,
        errorMessage: result.isError ? result.content : undefined,
        transaction: result.transaction ?? existing?.transaction
      });
    },
    onStage(stage: ConversationOperationStageEvent): void {
      const stageId = stage.stageId ?? `stage:${stage.target}`;
      const existing = operations.get(stageId);
      upsertOperation(stageId, {
        scope: 'conversation',
        phase: stage.phase,
        title: stage.title,
        target: stage.target,
        type: 'tool_call',
        status: stage.status,
        summary: stage.summary ?? existing?.summary,
        errorMessage: stage.errorMessage ?? existing?.errorMessage,
        input: stageInputWithTransaction(stage, existing),
        transaction: stage.transaction ?? existing?.transaction
      });
    },
    build(): AgentOperationRecord[] {
      return [...operations.values()].sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
    }
  };
}

export function createConversationProcessTranscriptCollector() {
  const activities = new Map<string, ChatMessageProcessActivity>();
  let text = '';

  const upsertActivity = (
    key: string,
    activity: Omit<ChatMessageProcessActivity, 'id' | 'offset' | 'createdAt'>,
    preferredOffset?: number
  ): void => {
    const existing = activities.get(key);
    activities.set(key, {
      ...activity,
      id: key,
      offset: existing?.offset ?? preferredOffset ?? text.length,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    });
  };

  return {
    onTextDelta(_delta: string, accumulated: string): void {
      text = accumulated;
    },
    onToolUse(tool: {
      toolUseId: string;
      name: string;
      title?: string;
      summary?: string;
      activity?: string;
      input?: Record<string, unknown>;
      status: 'pending' | 'running' | 'completed' | 'failed';
    }): void {
      upsertActivity(`tool:${tool.toolUseId}`, {
        type: 'tool',
        status: tool.status === 'failed' ? 'failed' : tool.status === 'completed' ? 'completed' : 'running',
        title: tool.status === 'failed' ? 'tool_failed' : tool.status === 'completed' ? 'tool_completed' : 'tool_running',
        summary: tool.activity ?? tool.summary ?? tool.title ?? tool.name,
        toolUseIds: [tool.toolUseId]
      });
    },
    onToolResult(result: {
      toolUseId: string;
      content: string;
      isError?: boolean;
      transaction?: AgentToolTransactionSummary;
    }): void {
      upsertActivity(`tool:${result.toolUseId}`, {
        type: 'tool',
        status: result.isError ? 'failed' : 'completed',
        title: result.isError ? 'tool_failed' : 'tool_completed',
        summary: result.content,
        toolUseIds: [result.toolUseId],
        transaction: result.transaction
      });
    },
    onStage(stage: ConversationOperationStageEvent): void {
      if (
        stage.status !== 'failed' &&
        stage.phase !== 'context_compressed' &&
        stage.phase !== 'tool_timeout' &&
        !isInlineLifecycleHookStage(stage)
      ) {
        return;
      }
      const stageId = stage.stageId ?? `stage:${stage.target}`;
      upsertActivity(`stage:${stageId}`, {
        type: stage.phase === 'tool_timeout' ? 'timeout' : stage.phase === 'context_compressed' ? 'context' : 'stage',
        status: stage.status === 'failed' ? 'failed' : stage.status === 'completed' ? 'completed' : 'running',
        title: stage.title,
        summary: stage.summary,
        stageId,
        transaction: stage.transaction
      });
    },
    build(finalMessage?: string): Partial<ChatMessageMetadata> {
      const agentProcessActivities = [...activities.values()].sort((left, right) => {
        if (left.offset !== right.offset) {
          return left.offset - right.offset;
        }
        const timeOrder = left.createdAt.localeCompare(right.createdAt);
        if (timeOrder !== 0) {
          return timeOrder;
        }
        return left.id.localeCompare(right.id);
      });
      if (agentProcessActivities.length === 0) {
        return {};
      }
      return {
        agentProcessText: text.trim() ? text : finalMessage,
        agentProcessActivities
      };
    }
  };
}

function partTime(part: AgentCoreMessagePart): string {
  return part.createdAt || new Date().toISOString();
}

export function projectConversationOperationLogFromAgentCoreParts(parts: AgentCoreMessagePart[]): AgentOperationRecord[] {
  const records = new Map<string, AgentOperationRecord>();
  for (const part of parts) {
    if (part.kind === 'tool_call') {
      records.set(part.toolUseId, {
        id: part.toolUseId,
        scope: 'conversation',
        title: part.title ?? part.name,
        target: part.summary ?? part.name,
        type: 'tool_call',
        input: part.input,
        status: part.status,
        summary: part.activity,
        startedAt: partTime(part),
        finishedAt: part.status === 'completed' || part.status === 'failed' ? partTime(part) : undefined
      });
      continue;
    }
    if (part.kind === 'tool_result' || part.kind === 'tool_error') {
      const existing = records.get(part.toolUseId);
      const isError = part.kind === 'tool_error';
      const content = isError ? part.error : part.content;
      const transaction = part.transaction ?? existing?.transaction;
      records.set(part.toolUseId, {
        id: part.toolUseId,
        scope: 'conversation',
        title: existing?.title ?? part.toolName ?? 'tool_call',
        target: existing?.target ?? part.toolName ?? 'tool_call',
        type: existing?.type ?? 'tool_call',
        input: transaction ? { ...(existing?.input ?? {}), transaction } : existing?.input,
        status: isError ? 'failed' : 'completed',
        summary: content,
        errorMessage: isError ? content : undefined,
        transaction,
        startedAt: existing?.startedAt ?? partTime(part),
        finishedAt: partTime(part)
      });
    }
  }
  return [...records.values()].sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
}

export function projectConversationProcessMetadataFromAgentCoreParts(
  parts: AgentCoreMessagePart[],
  finalMessage?: string
): Partial<ChatMessageMetadata> {
  const collector = createConversationProcessTranscriptCollector();
  const assistantText = parts
    .filter((part): part is Extract<AgentCoreMessagePart, { kind: 'assistant_text' }> => part.kind === 'assistant_text')
    .map((part) => part.text)
    .join('\n\n')
    .trim();
  if (assistantText) {
    collector.onTextDelta(assistantText, assistantText);
  }
  for (const part of parts) {
    if (part.kind === 'tool_call') {
      collector.onToolUse({
        toolUseId: part.toolUseId,
        name: part.name,
        input: part.input,
        status: part.status
      });
      continue;
    }
    if (part.kind === 'tool_result' || part.kind === 'tool_error') {
      collector.onToolResult({
        toolUseId: part.toolUseId,
        content: part.kind === 'tool_error' ? part.error : part.content,
        isError: part.kind === 'tool_error',
        transaction: part.transaction
      });
    }
  }
  return collector.build(finalMessage);
}
