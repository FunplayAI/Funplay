import { AI_PROVIDER_PRESETS, inferOpenAiCompatibleApiMode } from '../../../shared/provider-catalog';
import type { AiProvider, AiProviderApiMode, AiProviderAuthStyle, AiProviderInput, AiProviderModel, AiProviderProtocol, AiProviderRoleModels } from '../../../shared/types';
import { localize } from '../../i18n';

export type ProviderDraft = AiProviderInput & { presetId: string };

export const MODEL_CANDIDATE_LIMIT = 100;

export const claudeRoleModelFields: Array<{
  key: keyof AiProviderRoleModels;
  zh: string;
  en: string;
  placeholder: string;
}> = [
  { key: 'default', zh: '默认', en: 'Default', placeholder: 'gpt-5.5-xhigh' },
  { key: 'haiku', zh: '快速/Haiku', en: 'Fast / Haiku', placeholder: 'gpt-5.5-mini' },
  { key: 'sonnet', zh: '标准/Sonnet', en: 'Standard / Sonnet', placeholder: 'gpt-5.5-xhigh' },
  { key: 'opus', zh: '高阶/Opus', en: 'Advanced / Opus', placeholder: 'gpt-5.5' },
  { key: 'small', zh: '小模型', en: 'Small', placeholder: 'gpt-5.5-mini' },
  { key: 'reasoning', zh: '推理', en: 'Reasoning', placeholder: 'gpt-5.5-xhigh' }
];

const defaultPreset = AI_PROVIDER_PRESETS[0];

export const emptyProviderDraft: ProviderDraft = {
  presetId: defaultPreset.id,
  name: defaultPreset.name,
  protocol: defaultPreset.protocol,
  apiMode: defaultPreset.apiMode ?? 'chat',
  authStyle: defaultPreset.authStyle ?? 'api_key',
  baseUrl: defaultPreset.baseUrl,
  apiKey: '',
  model: defaultPreset.defaultModel,
  upstreamModel: defaultPreset.upstreamModel,
  claudeCodeCompatible: false,
  claudeRoleModels: defaultPreset.defaultRoleModels ?? {},
  headers: defaultPreset.defaultHeaders,
  envOverrides: defaultPreset.defaultEnvOverrides,
  availableModels: defaultPreset.availableModels,
  sdkProxyOnly: defaultPreset.sdkProxyOnly,
  providerMeta: defaultPreset.providerMeta,
  contextWindowTokens: undefined,
  maxOutputTokens: undefined,
  requestTimeoutMs: undefined,
  chunkTimeoutMs: undefined,
  enabled: true,
  notes: ''
};

export function createProviderDraft(provider: AiProvider | null): ProviderDraft {
  return provider
    ? {
        presetId: 'custom-openai',
        name: provider.name,
        protocol: provider.protocol,
        apiMode: inferOpenAiCompatibleApiMode(provider),
        authStyle: provider.authStyle ?? 'api_key',
        baseUrl: provider.baseUrl,
        apiKey: '',
        model: provider.model,
        upstreamModel: provider.upstreamModel,
        claudeCodeCompatible: provider.claudeCodeCompatible ?? provider.protocol === 'anthropic',
        claudeRoleModels: provider.claudeRoleModels ?? {},
        headers: provider.headers ?? {},
        envOverrides: provider.envOverrides ?? {},
        availableModels: provider.availableModels,
        sdkProxyOnly: provider.sdkProxyOnly,
        providerMeta: provider.providerMeta,
        contextWindowTokens: provider.contextWindowTokens,
        maxOutputTokens: provider.maxOutputTokens,
        requestTimeoutMs: provider.requestTimeoutMs,
        chunkTimeoutMs: provider.chunkTimeoutMs,
        enabled: provider.enabled,
        notes: provider.notes || ''
      }
    : emptyProviderDraft;
}

export function createProviderInputFromDraft(draft: ProviderDraft, options?: { modelFallback?: string }): AiProviderInput {
  return {
    name: draft.name,
    protocol: draft.protocol,
    apiMode: draft.protocol === 'openai-compatible' ? draft.apiMode ?? 'chat' : undefined,
    authStyle: draft.authStyle,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    model: draft.model.trim() || options?.modelFallback || draft.model,
    upstreamModel: draft.upstreamModel,
    claudeCodeCompatible: draft.protocol === 'anthropic' || draft.sdkProxyOnly ? true : undefined,
    claudeRoleModels: draft.protocol === 'anthropic' ? draft.claudeRoleModels : undefined,
    headers: draft.headers,
    envOverrides: draft.envOverrides,
    availableModels: draft.availableModels,
    sdkProxyOnly: draft.sdkProxyOnly,
    providerMeta: draft.providerMeta,
    contextWindowTokens: draft.contextWindowTokens,
    maxOutputTokens: draft.maxOutputTokens,
    requestTimeoutMs: draft.requestTimeoutMs,
    chunkTimeoutMs: draft.chunkTimeoutMs,
    enabled: draft.enabled,
    notes: draft.notes
  };
}

export function mergeProviderModelCandidates(current: AiProviderModel[] | undefined, fetched: AiProviderModel[]): AiProviderModel[] {
  const byId = new Map<string, AiProviderModel>();
  for (const model of [...(current ?? []), ...fetched]) {
    const modelId = model.modelId.trim();
    if (!modelId || byId.has(modelId)) continue;
    byId.set(modelId, {
      ...model,
      modelId,
      upstreamModelId: model.upstreamModelId?.trim() || undefined,
      displayName: model.displayName?.trim() || undefined
    });
    if (byId.size >= MODEL_CANDIDATE_LIMIT) break;
  }
  return [...byId.values()];
}

export function formatStringRecord(input?: Record<string, string>): string {
  return Object.entries(input ?? {}).map(([key, value]) => `${key}=${value}`).join('\n');
}

export function parseStringRecord(input: string): Record<string, string> | undefined {
  const entries = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      return separator >= 0
        ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
        : [line, ''];
    })
    .filter(([key, value]) => key && value);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function parseOptionalInteger(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

export function formatCompactTokenLimit(value: number | undefined): string {
  if (!value) return '--';
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

export function describeProviderPreset(language: 'zh-CN' | 'en-US', presetId: string, fallback: string): string {
  const map: Record<string, { zh: string; en: string }> = {
    openai: { zh: '官方 OpenAI API，适合通用文本生成。', en: 'Official OpenAI API for general text generation.' },
    openrouter: { zh: '统一代理多家模型，适合快速尝试不同模型。', en: 'A unified gateway for many models, great for quick experimentation.' },
    anthropic: { zh: '原生 Anthropic 协议。', en: 'Native Anthropic protocol.' },
    gemini: { zh: 'Google Gemini 官方 API。', en: 'Official Google Gemini API.' },
    deepseek: { zh: '适合低成本文本与推理场景。', en: 'Good for low-cost text and reasoning workloads.' },
    'qwen-dashscope': { zh: '阿里云百炼 OpenAI 兼容通道，默认使用千问系列模型。', en: 'Alibaba Cloud Model Studio OpenAI-compatible gateway for Qwen models.' },
    'kimi-moonshot': { zh: 'Moonshot Kimi OpenAI Chat Completions 兼容通道。', en: 'Moonshot Kimi OpenAI-compatible Chat Completions gateway.' },
    'zhipu-glm': { zh: '智谱 GLM OpenAI Chat Completions 兼容通道。', en: 'Zhipu GLM OpenAI-compatible Chat Completions gateway.' },
    siliconflow: { zh: '硅基流动模型聚合通道，适合接入多种国内外开源模型。', en: 'SiliconFlow model gateway for many domestic and international open models.' },
    'xiaomi-mimo': { zh: '小米 MiMo OpenAI Chat Completions 兼容通道，支持流式工具调用和 reasoning_content。', en: 'Xiaomi MiMo OpenAI-compatible Chat Completions gateway with streamed tools and reasoning_content.' },
    'custom-openai': { zh: '任意兼容 OpenAI Chat/Responses 风格接口的端点。', en: 'Any endpoint compatible with OpenAI Chat or Responses style APIs.' }
  };
  return map[presetId] ? localize(language, map[presetId].zh, map[presetId].en) : fallback;
}

export function providerApiKeyHint(language: 'zh-CN' | 'en-US', presetId: string, fallback: string): string {
  const map: Record<string, { zh: string; en: string }> = {
    openai: { zh: '需要 OpenAI API Key', en: 'Requires an OpenAI API key' },
    openrouter: { zh: '需要 OpenRouter API Key', en: 'Requires an OpenRouter API key' },
    anthropic: { zh: '需要 Anthropic API Key', en: 'Requires an Anthropic API key' },
    gemini: { zh: '需要 Google AI API Key', en: 'Requires a Google AI API key' },
    deepseek: { zh: '需要 DeepSeek API Key', en: 'Requires a DeepSeek API key' },
    'qwen-dashscope': { zh: '需要阿里云百炼 API Key', en: 'Requires an Alibaba Cloud Model Studio API key' },
    'kimi-moonshot': { zh: '需要 Kimi / Moonshot API Key', en: 'Requires a Kimi / Moonshot API key' },
    'zhipu-glm': { zh: '需要智谱 BigModel API Key', en: 'Requires a Zhipu BigModel API key' },
    siliconflow: { zh: '需要 SiliconFlow API Key', en: 'Requires a SiliconFlow API key' },
    'xiaomi-mimo': { zh: '需要 Xiaomi MiMo API Key', en: 'Requires a Xiaomi MiMo API key' },
    'custom-openai': { zh: '按你的服务商要求填写', en: 'Fill this according to your provider requirements' }
  };
  return map[presetId] ? localize(language, map[presetId].zh, map[presetId].en) : fallback;
}

export function formatPresetProtocol(language: 'zh-CN' | 'en-US', protocol: AiProviderProtocol, apiMode?: AiProviderApiMode): string {
  if (protocol === 'openai-compatible') {
    return apiMode === 'responses'
      ? localize(language, 'OpenAI 兼容 / Responses', 'OpenAI Compatible / Responses')
      : localize(language, 'OpenAI 兼容 / Chat', 'OpenAI Compatible / Chat');
  }
  const labels: Record<AiProviderProtocol, string> = {
    'openai-compatible': 'OpenAI Compatible',
    anthropic: 'Anthropic',
    google: 'Google',
    bedrock: 'Bedrock',
    vertex: 'Vertex'
  };
  return labels[protocol];
}

export function authStyleForProtocol(protocol: AiProviderProtocol, current?: AiProviderAuthStyle): AiProviderAuthStyle {
  return protocol === 'bedrock' || protocol === 'vertex' ? 'env_only' : current ?? 'api_key';
}
