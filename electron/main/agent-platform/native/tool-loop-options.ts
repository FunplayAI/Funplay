import type { AiProvider } from '../../../../shared/types';
import type { OpenAiCompatibleToolCall } from '../../openai-compatible-client';
import {
  normalizeProviderContextWindowTokens,
  normalizeProviderMaxOutputTokens
} from '../../provider-runtime-options';
import type { NativeWorkspaceToolOutput } from './tool-executor';

export const NATIVE_PARTIAL_WRITE_CONTINUATION_LIMIT = 2;
export const NATIVE_EDIT_FAILURE_CONTINUATION_LIMIT = 4;
export const NATIVE_MAIN_TOOL_LOOP_MAX_OUTPUT_TOKENS = 32_000;
export const NEVER_STOP_ON_STEP_COUNT = (): false => false;

export function createInvalidMultiEditInputResult(toolCall: OpenAiCompatibleToolCall): NativeWorkspaceToolOutput | undefined {
  if (toolCall.name !== 'multi_edit') {
    return undefined;
  }
  const edits = toolCall.arguments.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    return undefined;
  }
  return {
    ok: false,
    isError: true,
    summary: [
      'multi_edit 参数无效：edits 至少需要 1 个编辑操作，未执行真实写入。',
      '恢复方式：先用 read_file 读取目标片段，再用 edit_file/multi_edit 提供逐字匹配的 oldText；如果 oldText 不确定，改用 preview_patch/patch_file。'
    ].join('\n'),
    edit: {
      strategy: 'multi_edit',
      patchFirst: false,
      preflight: 'failed',
      editCount: Array.isArray(edits) ? edits.length : 0,
      failureKind: 'unknown',
      recoveryHint: '不要调用空 edits 的 multi_edit；读取目标片段后构造至少 1 个精确编辑，或改用 unified patch。'
    }
  };
}

export function resolveNativeMainToolLoopMaxOutputTokens(provider?: AiProvider): number {
  const configured = Number(process.env.FUNPLAY_NATIVE_MAIN_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  const providerConfigured = normalizeProviderMaxOutputTokens(provider?.maxOutputTokens);
  if (providerConfigured) {
    return providerConfigured;
  }
  const modelCapabilities = provider?.availableModels?.find(
    (model) =>
      model.modelId === provider.model ||
      model.upstreamModelId === provider.model ||
      model.upstreamModelId === provider.upstreamModel
  )?.capabilities;
  const modelMaxOutputTokens = normalizeProviderMaxOutputTokens(modelCapabilities?.maxOutputTokens);
  if (modelMaxOutputTokens) {
    return modelMaxOutputTokens;
  }
  const providerContextWindow = normalizeProviderContextWindowTokens(provider?.contextWindowTokens);
  if (providerContextWindow) {
    return Math.max(4096, Math.min(NATIVE_MAIN_TOOL_LOOP_MAX_OUTPUT_TOKENS, Math.floor(providerContextWindow / 4)));
  }
  const contextWindow = normalizeProviderContextWindowTokens(modelCapabilities?.contextWindow);
  if (contextWindow && contextWindow < 96_000) {
    return Math.max(4096, Math.min(NATIVE_MAIN_TOOL_LOOP_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4)));
  }
  return NATIVE_MAIN_TOOL_LOOP_MAX_OUTPUT_TOKENS;
}
