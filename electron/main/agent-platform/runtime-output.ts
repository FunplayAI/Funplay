import type {
  AgentCoreMessagePart,
  ChatContentBlock,
  ChatMessageMetadata,
  ProjectSessionRuntimeId
} from '../../../shared/types';
import type { GenericAgentRuntimeParams, GenericAgentRuntimeOutputEvent, GenericAgentRuntimeResult } from './types';
import type { ConversationOperationStageEvent } from './operation-log';
import { createRuntimeEventResultProjection } from './runtime-event-result';

type RuntimeToolUse = Parameters<NonNullable<GenericAgentRuntimeParams['onToolUse']>>[0];
type RuntimeToolResult = Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0];
type RuntimeUsage = Parameters<NonNullable<GenericAgentRuntimeParams['onUsage']>>[0];

function normalizeRuntimeId(runtimeId?: ProjectSessionRuntimeId): ProjectSessionRuntimeId | undefined {
  return runtimeId === 'native' ? runtimeId : undefined;
}

function normalizeStageEvent(stage: ConversationOperationStageEvent) {
  return {
    stageId: stage.stageId ?? `stage:${stage.target}`,
    phase: stage.phase,
    title: stage.title,
    target: stage.target,
    status: stage.status,
    input: stage.input,
    summary: stage.summary,
    errorMessage: stage.errorMessage,
    runtimeId: normalizeRuntimeId(stage.runtimeId),
    providerId: stage.providerId,
    model: stage.model,
    upstreamModel: stage.upstreamModel,
    diagnosticCode: stage.diagnosticCode,
    severity: stage.severity,
    errorCode: stage.errorCode,
    suggestedAction: stage.suggestedAction,
    recoveryActions: stage.recoveryActions,
    transaction: stage.transaction
  };
}

function getFinalBlockText(block: ChatContentBlock): string {
  if (block.type === 'text') {
    return block.text;
  }
  if (block.type === 'thinking') {
    return block.thinking;
  }
  if (block.type === 'fallback') {
    return block.text;
  }
  if (block.type === 'tool_result') {
    return block.content;
  }
  return '';
}

function createResultFromFinalBlock(finalBlock: ChatContentBlock, finalMessage?: string): GenericAgentRuntimeResult {
  const fallbackDetail = finalBlock.type === 'fallback' ? finalBlock.reason : undefined;
  return {
    assistantMessage: finalMessage ?? getFinalBlockText(finalBlock),
    assistantMetadata: undefined,
    assistantIntent: finalBlock.type === 'fallback' ? 'fallback' : 'chat',
    fallbackDetail,
    status: finalBlock.type === 'fallback' ? 'fallback' : 'completed',
    steps: []
  };
}

export function createConversationRuntimeOutputCollector(params: GenericAgentRuntimeParams) {
  const projection = createRuntimeEventResultProjection(params);
  let finalBlock: ChatContentBlock | undefined;
  let projectedResult: GenericAgentRuntimeResult | undefined;

  const observeAndEmit = (event: GenericAgentRuntimeOutputEvent): void => {
    projection.observe(event);
    params.emitRuntimeEvent?.(event);
  };

  const buildProjectedResult = (finalMessage?: string): GenericAgentRuntimeResult => {
    if (!finalBlock) {
      const fallbackBlock: ChatContentBlock = {
        type: 'text',
        text: finalMessage ?? ''
      };
      finalBlock = fallbackBlock;
    }
    projectedResult = projection.buildProjectedResult(createResultFromFinalBlock(finalBlock, finalMessage), {
      createdAt: new Date().toISOString()
    });
    return projectedResult;
  };

  return {
    onTextDelta(delta: string, accumulated: string): void {
      observeAndEmit({ type: 'text_delta', delta, accumulated });
      params.onTextDelta?.(delta, accumulated);
    },
    onThinking(delta: string, accumulated: string): void {
      observeAndEmit({ type: 'thinking_delta', delta, accumulated });
      params.onThinkingDelta?.(delta, accumulated);
    },
    onToolUse(tool: RuntimeToolUse): void {
      observeAndEmit({ type: 'tool_use', tool });
      params.onToolUse?.(tool);
    },
    onToolResult(result: RuntimeToolResult): void {
      observeAndEmit({ type: 'tool_result', result });
      params.onToolResult?.(result);
    },
    onStage(stage: ConversationOperationStageEvent): void {
      const normalized = normalizeStageEvent(stage);
      observeAndEmit({ type: 'stage', stage: normalized });
      params.onStage?.(normalized);
    },
    onUsage(usage: RuntimeUsage): void {
      observeAndEmit({ type: 'usage', usage });
      params.onUsage?.(usage);
    },
    onAgentCoreParts(parts: AgentCoreMessagePart[]): void {
      observeAndEmit({ type: 'agent_core_parts', parts });
    },
    captureFinalBlock(block: ChatContentBlock): void {
      finalBlock = block;
    },
    buildMetadata(finalMessage?: string, block?: ChatContentBlock): Partial<ChatMessageMetadata> {
      if (block) {
        finalBlock = block;
      }
      return buildProjectedResult(finalMessage).assistantMetadata ?? {};
    },
    buildOperationLog() {
      return projectedResult?.operationLog ?? buildProjectedResult().operationLog ?? [];
    }
  };
}
