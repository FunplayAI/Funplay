import type {
  AgentCoreProviderFinishReason,
  AgentCoreProviderStepResult,
  AgentCoreProviderToolCall,
  RuntimeUsage
} from '../../../shared/types';
import type { OpenAiCompatibleToolCall, OpenAiCompatibleToolStepResult } from '../openai-compatible-types';
import { normalizeAiSdkUsage, normalizeOpenAiUsage } from './usage';

interface ProviderStepAdapterOptions {
  providerId?: string;
  model?: string;
}

interface AiSdkProviderToolCallLike {
  toolCallId?: string;
  toolName: string;
  input?: unknown;
}

interface AiSdkProviderStepLike {
  text?: string;
  thinking?: string;
  finishReason?: string;
  usage?: unknown;
  toolCalls?: AiSdkProviderToolCallLike[];
}

function normalizeInput(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeAgentCoreProviderFinishReason(raw: string | undefined, options: {
  hasToolCalls?: boolean;
  isError?: boolean;
} = {}): AgentCoreProviderFinishReason {
  if (options.isError) {
    return 'error';
  }
  if (options.hasToolCalls) {
    return 'tool_calls';
  }
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return 'unknown';
  }
  if (value === 'stop' || value === 'end_turn' || value === 'success' || value === 'complete' || value === 'completed') {
    return 'stop';
  }
  if (value === 'length' || value === 'max_tokens' || value === 'max_output_tokens' || value === 'model_length') {
    return 'length';
  }
  if (value === 'tool_calls' || value === 'function_call' || value === 'tool_use') {
    return 'tool_calls';
  }
  if (value === 'content_filter' || value === 'safety' || value === 'blocked') {
    return 'content_filter';
  }
  if (value === 'error' || value === 'failed' || value === 'failure') {
    return 'error';
  }
  return 'unknown';
}

function openAiToolCallToAgentCore(toolCall: OpenAiCompatibleToolCall): AgentCoreProviderToolCall {
  return {
    toolUseId: toolCall.id,
    providerCallId: toolCall.id,
    name: toolCall.name,
    input: toolCall.arguments
  };
}

function aiSdkToolCallToAgentCore(toolCall: AiSdkProviderToolCallLike): AgentCoreProviderToolCall {
  return {
    toolUseId: toolCall.toolCallId ?? toolCall.toolName,
    providerCallId: toolCall.toolCallId,
    name: toolCall.toolName,
    input: normalizeInput(toolCall.input)
  };
}

function usageOrUndefined(usage: RuntimeUsage | null): RuntimeUsage | undefined {
  return usage ?? undefined;
}

export function openAiCompatibleStepToAgentCoreProviderStepResult(
  step: OpenAiCompatibleToolStepResult,
  options: ProviderStepAdapterOptions = {}
): AgentCoreProviderStepResult {
  return {
    text: step.text,
    thinking: step.reasoningContent,
    toolCalls: step.toolCalls.map(openAiToolCallToAgentCore),
    finishReason: normalizeAgentCoreProviderFinishReason(step.finishReason ?? step.rawFinishReason, {
      hasToolCalls: step.toolCalls.length > 0
    }),
    usage: usageOrUndefined(normalizeOpenAiUsage(step.usage, {
      provider: options.providerId,
      model: options.model
    })),
    warnings: step.toolCallRepair ? [`tool_call_repair:${step.toolCallRepair.type}`] : undefined,
    rawMetadata: {
      rawFinishReason: step.rawFinishReason ?? step.finishReason,
      responseId: step.responseId,
      responseModelId: step.responseModelId,
      streamed: step.streamed,
      responseOutputItemCount: step.responseOutputItems?.length
    }
  };
}

export function aiSdkStepToAgentCoreProviderStepResult(
  step: AiSdkProviderStepLike,
  options: ProviderStepAdapterOptions = {}
): AgentCoreProviderStepResult {
  const toolCalls = (step.toolCalls ?? []).map(aiSdkToolCallToAgentCore);
  return {
    text: step.text,
    thinking: step.thinking,
    toolCalls,
    finishReason: normalizeAgentCoreProviderFinishReason(step.finishReason, {
      hasToolCalls: toolCalls.length > 0
    }),
    usage: usageOrUndefined(normalizeAiSdkUsage(step.usage as Parameters<typeof normalizeAiSdkUsage>[0], {
      provider: options.providerId,
      model: options.model
    })),
    rawMetadata: {
      rawFinishReason: step.finishReason
    }
  };
}
