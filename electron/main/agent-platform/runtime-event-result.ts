import {
  agentCorePartsToVisibleAssistantText
} from '../../../shared/agent-core-v2';
import type {
  AgentCoreMessagePart,
  AgentOperationRecord,
  AgentSkillActivation
} from '../../../shared/types';
import type {
  GenericAgentRuntimeParams,
  GenericAgentRuntimeResult,
  GenericAgentRuntimeStreamEvent
} from './types';
import {
  createConversationOperationLogCollector,
  projectConversationOperationLogFromAgentCoreParts,
  projectConversationProcessMetadataFromAgentCoreParts
} from './operation-log';

function createPartBase(
  params: GenericAgentRuntimeParams,
  kind: AgentCoreMessagePart['kind'],
  id: string,
  sequence: number,
  createdAt: string
) {
  return {
    id,
    kind,
    runId: params.activeRunId,
    turnId: params.turnId,
    sequence,
    createdAt
  };
}

function buildSkillActivationAgentCoreParts(
  skills: AgentSkillActivation[],
  options: { turnId?: string; createdAt: string }
): AgentCoreMessagePart[] {
  return skills.map((skill, index) => ({
    id: `skill_activation:${skill.id}`,
    kind: 'system_event',
    turnId: options.turnId,
    createdAt: options.createdAt,
    sequence: index,
    title: `Skill activated: ${skill.name}`,
    summary: [
      `Reason: ${skill.activationReason}`,
      `Trust: ${skill.trustLevel}`,
      `Permission: ${skill.permissionPolicy}`
    ].join(' · '),
    metadata: {
      type: 'skill_activation',
      skillId: skill.id,
      skillName: skill.name,
      activationReason: skill.activationReason,
      source: skill.source,
      sourcePath: skill.sourcePath,
      trustLevel: skill.trustLevel,
      verificationStatus: skill.verificationStatus,
      permissionPolicy: skill.permissionPolicy,
      scriptPolicy: skill.scriptPolicy
    }
  }));
}

function mergeAgentCoreParts(prefix: AgentCoreMessagePart[], parts: AgentCoreMessagePart[]): AgentCoreMessagePart[] {
  if (!prefix.length) {
    return parts;
  }
  return [
    ...prefix,
    ...parts.map((part) => ({
      ...part,
      sequence: part.sequence + prefix.length
    }))
  ];
}

function buildFallbackAgentCoreParts(
  params: GenericAgentRuntimeParams,
  result: GenericAgentRuntimeResult,
  options: { createdAt: string }
): AgentCoreMessagePart[] | undefined {
  if (result.assistantMetadata?.agentCoreParts?.length) {
    return result.assistantMetadata.agentCoreParts;
  }

  if (result.assistantIntent !== 'chat') {
    if (result.assistantIntent === 'fallback') {
      return [{
        ...createPartBase(params, 'run_error', `runtime_result_fallback:${params.turnId ?? params.activeRunId ?? 'turn'}`, 0, options.createdAt),
        kind: 'run_error',
        error: result.assistantMessage,
        recoverable: true,
        diagnosticCode: result.fallbackDetail ?? result.diagnosticCode
      }];
    }
    return undefined;
  }

  return undefined;
}

function mergeOperationLogs(
  hostRecords: AgentOperationRecord[],
  agentCoreRecords: AgentOperationRecord[]
): AgentOperationRecord[] {
  const merged = new Map<string, AgentOperationRecord>();
  for (const record of hostRecords) {
    merged.set(record.id, record);
  }
  for (const record of agentCoreRecords) {
    merged.set(record.id, record);
  }
  return [...merged.values()].sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
}

export function createRuntimeEventResultProjection(params: GenericAgentRuntimeParams) {
  let authoritativeAgentCoreParts: AgentCoreMessagePart[] | undefined;
  const operationLogCollector = createConversationOperationLogCollector();

  const observe = (event: GenericAgentRuntimeStreamEvent): void => {
    if (event.type === 'agent_core_parts') {
      authoritativeAgentCoreParts = event.parts;
    } else if (event.type === 'tool_use') {
      operationLogCollector.onToolUse(event.tool);
    } else if (event.type === 'tool_result') {
      operationLogCollector.onToolResult(event.result);
    } else if (event.type === 'stage') {
      operationLogCollector.onStage(event.stage);
    }
  };

  const buildStreamParts = (): AgentCoreMessagePart[] => {
    if (authoritativeAgentCoreParts?.length) {
      return authoritativeAgentCoreParts;
    }
    return [];
  };

  const buildProjectedResult = (
    result: GenericAgentRuntimeResult,
    options: { createdAt: string; activeSkills?: AgentSkillActivation[] }
  ): GenericAgentRuntimeResult => {
    const skillParts = buildSkillActivationAgentCoreParts(options.activeSkills ?? [], {
      turnId: params.turnId,
      createdAt: options.createdAt
    });
    const streamParts = buildStreamParts();
    const fallbackParts = streamParts.length > 0
      ? undefined
      : buildFallbackAgentCoreParts(params, result, { createdAt: options.createdAt });
    const agentCoreParts = mergeAgentCoreParts(skillParts, streamParts.length > 0 ? streamParts : fallbackParts ?? []);
    const projectedMessage = agentCorePartsToVisibleAssistantText(agentCoreParts).trim() || result.assistantMessage;
    const streamMetadata = projectConversationProcessMetadataFromAgentCoreParts(agentCoreParts, projectedMessage);
    const agentCoreOperationLog = projectConversationOperationLogFromAgentCoreParts(agentCoreParts);
    const hostOperationLog = operationLogCollector.build();
    const hasAuthoritativeLedger = agentCoreParts.length > 0;
    const operationLog = hasAuthoritativeLedger
      ? mergeOperationLogs(hostOperationLog, agentCoreOperationLog)
      : result.operationLog ?? [];

    return {
      ...result,
      assistantMessage: projectedMessage,
      assistantMetadata: {
        ...result.assistantMetadata,
        ...streamMetadata,
        agentCoreParts: hasAuthoritativeLedger ? agentCoreParts : result.assistantMetadata?.agentCoreParts
      },
      operationLog: operationLog.length > 0 ? operationLog : result.operationLog
    };
  };

  return {
    buildProjectedResult,
    observe
  };
}
