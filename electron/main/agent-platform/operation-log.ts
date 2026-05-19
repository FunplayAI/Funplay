import type {
  AgentOperationRecord,
  AgentOperationStatus,
  AgentToolTransactionSummary,
  ChatMessageProcessActivity,
  ChatMessageMetadata,
  GameAgentAction,
  ProjectSessionRuntimeId,
  RuntimeDiagnosticSeverity,
  RuntimeRecoveryAction
} from '../../../shared/types';
import { makeId } from '../../../shared/utils';

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
      input?: Record<string, unknown>;
      status: 'pending' | 'running' | 'completed' | 'failed';
    }): void {
      const existing = operations.get(tool.toolUseId);
      upsertOperation(tool.toolUseId, {
        scope: 'conversation',
        title: tool.name,
        target: tool.name,
        type: 'tool_call',
        input: tool.input,
        status: tool.status,
        summary: existing?.summary,
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
      input?: Record<string, unknown>;
      status: 'pending' | 'running' | 'completed' | 'failed';
    }): void {
      upsertActivity(`tool:${tool.toolUseId}`, {
        type: 'tool',
        status: tool.status === 'failed' ? 'failed' : tool.status === 'completed' ? 'completed' : 'running',
        title: tool.status === 'failed' ? 'tool_failed' : tool.status === 'completed' ? 'tool_completed' : 'tool_running',
        summary: tool.name,
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

export function createExecutionPlanOperationLogCollector() {
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
    onStage(stage: ConversationOperationStageEvent): void {
      const stageId = stage.stageId ?? `stage:${stage.target}`;
      const existing = operations.get(stageId);
      upsertOperation(stageId, {
        scope: 'execution-plan',
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

export function buildExecutionOperationLog(actions: GameAgentAction[]): AgentOperationRecord[] {
  return actions.flatMap<AgentOperationRecord>((action) => {
    const operations = action.operations.length
      ? action.operations
      : [
          ...(action.readResources?.map((resource) => ({
            type: 'resource_read' as const,
            target: resource
          })) ?? []),
          ...(action.executedTools?.map((tool) => ({
            type: 'tool_call' as const,
            target: tool,
            arguments: {}
          })) ?? [])
        ];

    if (operations.length === 0) {
      return [
        {
          id: makeId('oplog'),
          scope: 'execution-plan',
          phase: 'execute',
          title: action.title,
          pluginKind: action.pluginKind,
          pluginId: action.pluginId,
          target: action.pluginKind,
          type: 'tool_call',
          input: undefined,
          status: action.status === 'planned' || action.status === 'suggested' ? 'skipped' : action.status,
          summary: action.outputSummary,
          errorMessage: action.errorMessage,
          startedAt: action.lastRunAt,
          finishedAt: action.lastRunAt
        }
      ];
    }

    return operations.map((operation, index) => ({
      id: `${action.id}:${index}`,
      scope: 'execution-plan' as const,
      phase: 'execute',
      title: action.title,
      pluginKind: action.pluginKind,
      pluginId: action.pluginId,
      target: operation.target,
      type: operation.type,
      input: operation.type === 'tool_call' ? operation.arguments : undefined,
      status: action.status === 'planned' || action.status === 'suggested' ? 'skipped' : action.status,
      summary: [
        action.outputSummary,
        action.repairSummary ? `repair: ${action.repairSummary}` : '',
        action.rollbackSummary ? `rollback: ${action.rollbackSummary}` : ''
      ]
        .filter(Boolean)
        .join('\n\n'),
      errorMessage: action.errorMessage,
      startedAt: action.lastRunAt,
      finishedAt: action.lastRunAt
    }));
  });
}
