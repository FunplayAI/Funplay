import { generateText } from 'ai';
import { createLanguageModel } from '../../ai-provider';
import { generateOpenAiCompatibleText } from '../../openai-compatible-client';
import { createProviderRequestAbort } from '../../provider-runtime-options';
import { createNativeRuntimeSystemPrompt, createNativeRuntimeUserPrompt } from './prompt';
import { normalizeModelReplyText } from './text';
import { normalizeAiSdkUsage, normalizeOpenAiUsage } from '../usage';
import type { GenericAgentRuntimeParams } from '../types';
import {
  emitRuntimeStatus,
  emitRuntimeTextDelta,
  emitRuntimeThinkingDelta,
  emitRuntimeUsage
} from '../runtime-event-emitter';
import type { AgentCoreMessagePart } from '../../../../shared/types';

function trimDetail(value: string, maxLength = 4000): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function createModelOutputError(message: string, rawOutput: string, code = 'MODEL_OUTPUT_PARSE_ERROR'): Error {
  const error = new Error(message) as Error & {
    code?: string;
    responseBody?: string;
  };
  error.code = code;
  error.responseBody = trimDetail(rawOutput, 6000);
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim() ? trimDetail(value) : '<empty>';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return trimDetail(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

function describeGenerateTextResult(result: unknown): string {
  if (!isRecord(result)) {
    return stringifyUnknown(result) ?? '<unavailable>';
  }

  const response = isRecord(result.response) ? result.response : undefined;
  const details: Record<string, unknown> = {
    text: typeof result.text === 'string' ? result.text : undefined,
    textLength: typeof result.text === 'string' ? result.text.length : undefined,
    content: result.content,
    reasoningText: result.reasoningText,
    reasoning: result.reasoning,
    finishReason: result.finishReason,
    rawFinishReason: result.rawFinishReason,
    usage: result.usage,
    warnings: result.warnings,
    responseId: response?.id,
    responseModelId: response?.modelId,
    responseTimestamp: response?.timestamp,
    responseMessages: response?.messages,
    responseBody: response?.body,
    providerMetadata: result.providerMetadata
  };

  return trimDetail(safeStringify(details) ?? '<unavailable>', 6000);
}

function emitNativeDirectUsage(params: GenericAgentRuntimeParams, usage: unknown): void {
  const normalized = params.provider?.protocol === 'openai-compatible'
    ? normalizeOpenAiUsage(usage, {
        provider: params.provider?.id,
        model: params.provider?.model
      })
    : normalizeAiSdkUsage(usage as Parameters<typeof normalizeAiSdkUsage>[0], {
        provider: params.provider?.id,
        model: params.provider?.model
  });
  if (normalized) {
    emitRuntimeUsage(params, normalized);
  }
}

export function emitReplyAsDeltas(params: GenericAgentRuntimeParams, reply: string): void {
  const normalizedReply = normalizeModelReplyText(reply);
  const chunkSize = 160;
  let accumulated = '';
  for (let index = 0; index < normalizedReply.length; index += chunkSize) {
    const delta = normalizedReply.slice(index, index + chunkSize);
    accumulated += delta;
    emitRuntimeTextDelta(params, delta, accumulated);
  }
}

function emitDirectReplyAgentCoreParts(params: GenericAgentRuntimeParams, reply: string): void {
  const normalizedReply = normalizeModelReplyText(reply);
  if (!normalizedReply.trim()) {
    return;
  }
  const part: AgentCoreMessagePart = {
    id: `direct_reply:${params.turnId ?? params.activeRunId ?? 'turn'}:text`,
    kind: 'assistant_text',
    sequence: 0,
    createdAt: new Date().toISOString(),
    runId: params.activeRunId,
    turnId: params.turnId,
    text: normalizedReply,
    final: true
  };
  params.onAgentCoreParts?.([part]);
}

export async function runNativeDirectChatReply(params: GenericAgentRuntimeParams): Promise<string> {
  emitRuntimeStatus(params, 'streaming', '正在生成回复…');
  const providerAbort = createProviderRequestAbort(params.abortSignal, params.provider);
  try {
    if (params.provider?.protocol === 'openai-compatible') {
      let streamedText = false;
      const result = await generateOpenAiCompatibleText({
        provider: params.provider,
        system: createNativeRuntimeSystemPrompt(),
        prompt: [
          createNativeRuntimeUserPrompt(params),
          '',
          '请直接自然回复用户，不要输出工具决策 JSON，不要调用工具。'
        ].join('\n'),
        maxOutputTokens: 2048,
        abortSignal: providerAbort.signal,
        onDelta: (delta, accumulated) => {
          streamedText = true;
          emitRuntimeTextDelta(params, delta, accumulated);
        },
        onReasoningDelta: (delta, accumulated) => {
          emitRuntimeThinkingDelta(params, delta, accumulated);
        }
      });
      emitNativeDirectUsage(params, result.usage);
      const reply = normalizeModelReplyText(result.text);
      if (!streamedText) {
        emitReplyAsDeltas(params, reply);
      }
      emitDirectReplyAgentCoreParts(params, reply);
      return reply;
    }

    const model = createLanguageModel(params.provider!);
    const result = await generateText({
      model,
      system: createNativeRuntimeSystemPrompt(),
      prompt: [
        createNativeRuntimeUserPrompt(params),
        '',
        '请直接自然回复用户，不要输出工具决策 JSON，不要调用工具。'
      ].join('\n'),
      maxOutputTokens: 2048,
      experimental_include: {
        requestBody: true,
        responseBody: true
      },
      abortSignal: providerAbort.signal
    });
    emitNativeDirectUsage(params, result.usage);
    const reply = normalizeModelReplyText(result.text);
    if (!reply) {
      throw createModelOutputError('模型返回了空回复。', describeGenerateTextResult(result), 'MODEL_EMPTY_RESPONSE');
    }
    emitReplyAsDeltas(params, reply);
    emitDirectReplyAgentCoreParts(params, reply);
    return reply;
  } finally {
    providerAbort.dispose();
  }
}
