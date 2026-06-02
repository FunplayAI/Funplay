import type {
  AiProvider,
  AiProviderApiMode,
  AiProviderAuthStyle,
  AiProviderMeta,
  AiProviderModel,
  AiProviderModelCapabilities,
  AiProviderPreset,
  AiProviderProtocol,
  AiProviderRoleModels,
  OpenAiCompatibleChatTokenParameter,
  OpenAiCompatibleInterleavedReasoningField,
  OpenAiCompatibleReasoningRequestStyle,
  OpenAiCompatibleSchemaTransform,
  OpenAiCompatibleToolChoiceMode
} from './types';

export interface ResolvedOpenAiCompatibleProviderProfile {
  apiMode: AiProviderApiMode;
  supportsChatCompletions: boolean;
  supportsResponses: boolean;
  streamingToolCalls: boolean;
  reasoningContent: boolean;
  interleavedReasoningField?: OpenAiCompatibleInterleavedReasoningField;
  chatTokenParameter: OpenAiCompatibleChatTokenParameter;
  toolChoiceModes: OpenAiCompatibleToolChoiceMode[];
  omitToolChoice: boolean;
  schemaTransform: OpenAiCompatibleSchemaTransform;
  reasoningRequestStyle: OpenAiCompatibleReasoningRequestStyle;
  nativeWebSearch: boolean;
}

export interface ResolvedProviderTokenLimits {
  modelId?: string;
  displayName?: string;
  configuredContextWindowTokens?: number;
  configuredMaxOutputTokens?: number;
  presetContextWindowTokens?: number;
  presetMaxOutputTokens?: number;
  effectiveContextWindowTokens?: number;
  effectiveMaxOutputTokens?: number;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-compatible',
    apiMode: 'responses',
    authStyle: 'api_key',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1',
    availableModels: [
      { modelId: 'gpt-5.4', displayName: 'GPT-5.4', capabilities: { toolUse: true, vision: true, contextWindow: 1_050_000, maxOutputTokens: 128_000 } },
      { modelId: 'gpt-4.1', displayName: 'GPT-4.1', capabilities: { toolUse: true, vision: true, contextWindow: 1_047_576, maxOutputTokens: 32_768 } }
    ],
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: true,
      streamingToolCalls: true,
      chatTokenParameter: 'auto',
      toolChoiceModes: ['auto', 'none', 'required'],
      nativeWebSearch: true
    },
    providerMeta: {
      apiKeyUrl: 'https://platform.openai.com/api-keys',
      docsUrl: 'https://platform.openai.com/docs',
      billingModel: 'pay_as_you_go'
    },
    apiKeyHint: '需要 OpenAI API Key',
    description: '官方 OpenAI API，适合通用文本生成。'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    authStyle: 'api_key',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4.1-mini',
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: false,
      streamingToolCalls: true,
      chatTokenParameter: 'max_tokens',
      toolChoiceModes: ['auto', 'none', 'required']
    },
    apiKeyHint: '需要 OpenRouter API Key',
    description: '统一代理多家模型，适合快速尝试不同模型。'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    upstreamModel: 'claude-sonnet-4-20250514',
    defaultRoleModels: {
      default: 'claude-sonnet-4-20250514',
      reasoning: 'claude-opus-4-7',
      small: 'claude-haiku-4-5-20251001',
      haiku: 'claude-haiku-4-5-20251001',
      sonnet: 'claude-sonnet-4-20250514',
      opus: 'claude-opus-4-7'
    },
    availableModels: [
      {
        modelId: 'claude-sonnet-4-20250514',
        displayName: 'Claude Sonnet 4',
        role: 'sonnet',
        capabilities: { reasoning: true, toolUse: true, vision: true, contextWindow: 200000, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }
      },
      {
        modelId: 'claude-opus-4-7',
        displayName: 'Claude Opus 4.7',
        role: 'opus',
        capabilities: { reasoning: true, toolUse: true, vision: true, contextWindow: 1000000, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true }
      },
      {
        modelId: 'claude-haiku-4-5-20251001',
        displayName: 'Claude Haiku 4.5',
        role: 'haiku',
        capabilities: { toolUse: true, vision: true, contextWindow: 200000 }
      }
    ],
    providerMeta: {
      apiKeyUrl: 'https://console.anthropic.com/settings/keys',
      docsUrl: 'https://docs.anthropic.com/claude-code/setup',
      statusPageUrl: 'https://status.anthropic.com',
      billingModel: 'pay_as_you_go'
    },
    apiKeyHint: '需要 Anthropic API Key',
    description: '原生 Anthropic 协议。'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'google',
    authStyle: 'api_key',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-pro',
    availableModels: [
      { modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', capabilities: { reasoning: true, toolUse: true, vision: true, contextWindow: 1_048_576, maxOutputTokens: 65_536 } },
      { modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', capabilities: { reasoning: true, toolUse: true, vision: true, contextWindow: 1_048_576, maxOutputTokens: 65_536 } }
    ],
    apiKeyHint: '需要 Google AI API Key',
    description: 'Google Gemini 官方 API。'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    authStyle: 'api_key',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    availableModels: [
      { modelId: 'deepseek-chat', upstreamModelId: 'deepseek-v4-flash', displayName: 'DeepSeek Chat', capabilities: { toolUse: true, contextWindow: 1_000_000, maxOutputTokens: 384_000 } },
      { modelId: 'deepseek-reasoner', upstreamModelId: 'deepseek-v4-flash', displayName: 'DeepSeek Reasoner', capabilities: { reasoning: true, toolUse: true, contextWindow: 1_000_000, maxOutputTokens: 384_000 } },
      { modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', capabilities: { toolUse: true, contextWindow: 1_000_000, maxOutputTokens: 384_000 } },
      { modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', capabilities: { reasoning: true, toolUse: true, contextWindow: 1_000_000, maxOutputTokens: 384_000 } }
    ],
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: false,
      streamingToolCalls: true,
      reasoningContent: true,
      interleavedReasoningField: 'reasoning_content',
      chatTokenParameter: 'max_tokens',
      toolChoiceModes: ['auto']
    },
    apiKeyHint: '需要 DeepSeek API Key',
    description: '适合低成本文本与推理场景。'
  },
  {
    id: 'qwen-dashscope',
    name: 'Alibaba Qwen',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    authStyle: 'api_key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    availableModels: [
      { modelId: 'qwen-plus', displayName: 'Qwen Plus', capabilities: { toolUse: true, vision: true } },
      { modelId: 'qwen-turbo', displayName: 'Qwen Turbo', capabilities: { toolUse: true } }
    ],
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: true,
      streamingToolCalls: true,
      chatTokenParameter: 'max_tokens',
      toolChoiceModes: ['auto'],
      reasoningRequestStyle: 'dashscope-enable-thinking'
    },
    providerMeta: {
      apiKeyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/use-qwen-by-calling-api',
      billingModel: 'pay_as_you_go'
    },
    apiKeyHint: '需要阿里云百炼 API Key',
    description: '阿里云百炼 OpenAI 兼容通道，默认使用千问系列模型。'
  },
  {
    id: 'kimi-moonshot',
    name: 'Kimi',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    authStyle: 'api_key',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.6',
    availableModels: [
      { modelId: 'kimi-k2.6', displayName: 'Kimi K2.6', capabilities: { reasoning: true, toolUse: true, vision: true } },
      { modelId: 'kimi-k2.5', displayName: 'Kimi K2.5', capabilities: { reasoning: true, toolUse: true, vision: true, contextWindow: 262_144, maxOutputTokens: 32_768 } }
    ],
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: false,
      streamingToolCalls: true,
      chatTokenParameter: 'max_completion_tokens',
      toolChoiceModes: ['auto'],
      schemaTransform: 'moonshot'
    },
    providerMeta: {
      apiKeyUrl: 'https://platform.kimi.com/console/api-keys',
      docsUrl: 'https://platform.kimi.com/docs/api/overview',
      billingModel: 'pay_as_you_go'
    },
    apiKeyHint: '需要 Kimi / Moonshot API Key',
    description: 'Moonshot Kimi OpenAI Chat Completions 兼容通道。'
  },
  {
    id: 'zhipu-glm',
    name: 'Zhipu GLM',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    authStyle: 'api_key',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.1',
    availableModels: [
      { modelId: 'glm-5.1', displayName: 'GLM 5.1', capabilities: { reasoning: true, toolUse: true, vision: true, contextWindow: 200_000, maxOutputTokens: 128_000 } },
      { modelId: 'glm-4.6', displayName: 'GLM 4.6', capabilities: { reasoning: true, toolUse: true, vision: true, contextWindow: 200_000, maxOutputTokens: 128_000 } }
    ],
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: false,
      streamingToolCalls: true,
      reasoningContent: true,
      interleavedReasoningField: 'reasoning_content',
      chatTokenParameter: 'max_tokens',
      toolChoiceModes: ['auto'],
      reasoningRequestStyle: 'zhipu-thinking'
    },
    providerMeta: {
      apiKeyUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
      docsUrl: 'https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8',
      billingModel: 'pay_as_you_go'
    },
    apiKeyHint: '需要智谱 BigModel API Key',
    description: '智谱 GLM OpenAI Chat Completions 兼容通道。'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    authStyle: 'api_key',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V2.5',
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: false,
      streamingToolCalls: true,
      chatTokenParameter: 'max_tokens',
      toolChoiceModes: ['auto']
    },
    providerMeta: {
      apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
      docsUrl: 'https://docs.siliconflow.cn/cn/userguide/guides/function-calling',
      billingModel: 'pay_as_you_go'
    },
    apiKeyHint: '需要 SiliconFlow API Key',
    description: '硅基流动模型聚合通道，适合接入多种国内外开源模型。'
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    authStyle: 'api_key',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    availableModels: [
      { modelId: 'mimo-v2.5-pro', displayName: 'MiMo V2.5 Pro', capabilities: { reasoning: true, toolUse: true, contextWindow: 1_000_000, maxOutputTokens: 131072 } },
      { modelId: 'mimo-v2.5', displayName: 'MiMo V2.5', capabilities: { reasoning: true, toolUse: true, vision: true, contextWindow: 1_000_000, maxOutputTokens: 32768 } },
      { modelId: 'mimo-v2-pro', displayName: 'MiMo V2 Pro', capabilities: { reasoning: true, toolUse: true, contextWindow: 131072, maxOutputTokens: 131072 } },
      { modelId: 'mimo-v2-omni', displayName: 'MiMo V2 Omni', capabilities: { reasoning: true, toolUse: true, vision: true, contextWindow: 32768, maxOutputTokens: 32768 } },
      { modelId: 'mimo-v2-flash', displayName: 'MiMo V2 Flash', capabilities: { toolUse: true, contextWindow: 65536, maxOutputTokens: 65536 } }
    ],
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: false,
      streamingToolCalls: true,
      reasoningContent: true,
      interleavedReasoningField: 'reasoning_content',
      chatTokenParameter: 'max_completion_tokens',
      toolChoiceModes: ['auto'],
      omitToolChoice: true
    },
    providerMeta: {
      apiKeyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
      docsUrl: 'https://platform.xiaomimimo.com/docs/zh-CN/api/chat/openai-api',
      billingModel: 'pay_as_you_go'
    },
    apiKeyHint: '需要 Xiaomi MiMo API Key',
    description: '小米 MiMo OpenAI Chat Completions 兼容通道，支持流式工具调用和 reasoning_content。'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    authStyle: 'api_key',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M3',
    availableModels: [
      { modelId: 'MiniMax-M3', displayName: 'MiniMax M3', capabilities: { reasoning: true, toolUse: true, contextWindow: 1_000_000, maxOutputTokens: 40960 } },
      { modelId: 'MiniMax-M2', displayName: 'MiniMax M2', capabilities: { reasoning: true, toolUse: true, contextWindow: 1_000_000, maxOutputTokens: 40960 } }
    ],
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: false,
      streamingToolCalls: true,
      reasoningContent: true,
      interleavedReasoningField: 'reasoning_content',
      chatTokenParameter: 'max_tokens',
      toolChoiceModes: ['auto']
    },
    providerMeta: {
      apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
      docsUrl: 'https://platform.minimaxi.com/docs/api-reference/text-chat-openai',
      billingModel: 'pay_as_you_go'
    },
    apiKeyHint: '需要 MiniMax API Key',
    description: 'MiniMax OpenAI Chat Completions 兼容通道（api.minimaxi.com/v1），支持流式工具调用。注意用 OpenAI 兼容端点，不要用 text-chat-anthropic。'
  },
  {
    id: 'custom-openai',
    name: 'Custom OpenAI-Compatible',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    baseUrl: '',
    defaultModel: '',
    openAiCompatible: {
      supportsChatCompletions: true,
      supportsResponses: true,
      streamingToolCalls: true,
      chatTokenParameter: 'auto',
      toolChoiceModes: ['auto', 'none', 'required']
    },
    apiKeyHint: '按你的服务商要求填写',
    description: '任意兼容 OpenAI Chat/Responses 风格接口的端点。'
  }
];

export function inferOpenAiCompatibleApiMode(input: {
  name?: string;
  baseUrl?: string;
  protocol?: AiProviderProtocol;
  apiMode?: AiProviderApiMode | null;
}): AiProviderApiMode {
  if (input.apiMode) {
    return input.apiMode;
  }

  const preset = findAiProviderPreset({
    name: input.name,
    baseUrl: input.baseUrl,
    protocol: input.protocol ?? 'openai-compatible'
  });
  if (preset?.apiMode) {
    return preset.apiMode;
  }

  const marker = `${input.name ?? ''} ${input.baseUrl ?? ''}`.toLowerCase();
  if (marker.includes('packy') || marker.includes('api.openai.com')) {
    return 'responses';
  }
  return 'chat';
}

export function normalizeProviderAuthStyle(input: {
  authStyle?: AiProviderAuthStyle | null;
  protocol?: AiProviderProtocol;
  baseUrl?: string;
}): AiProviderAuthStyle {
  if (input.authStyle) {
    return input.authStyle;
  }
  if (input.protocol === 'bedrock' || input.protocol === 'vertex') {
    return 'env_only';
  }
  return 'api_key';
}

export function findAiProviderPreset(input: {
  presetId?: string;
  name?: string;
  protocol?: AiProviderProtocol;
  baseUrl?: string;
}): AiProviderPreset | undefined {
  if (input.presetId) {
    const byId = AI_PROVIDER_PRESETS.find((preset) => preset.id === input.presetId);
    if (byId) {
      return byId;
    }
  }
  const baseUrl = input.baseUrl?.replace(/\/+$/, '').toLowerCase();
  const name = input.name?.toLowerCase();
  return AI_PROVIDER_PRESETS.find((preset) => {
    if (input.protocol && preset.protocol !== input.protocol) {
      return false;
    }
    if (baseUrl && preset.baseUrl && preset.baseUrl.replace(/\/+$/, '').toLowerCase() === baseUrl) {
      return true;
    }
    return Boolean(name && preset.name.toLowerCase() === name);
  });
}

export function getProviderPresetDefaults(input: Pick<AiProvider, 'name' | 'protocol' | 'baseUrl'>): {
  authStyle: AiProviderAuthStyle;
  upstreamModel?: string;
  headers?: Record<string, string>;
  envOverrides?: Record<string, string>;
  roleModels?: AiProviderRoleModels;
  availableModels?: AiProviderModel[];
  sdkProxyOnly?: boolean;
  providerMeta?: AiProviderMeta;
} {
  const preset = findAiProviderPreset(input);
  return {
    authStyle: normalizeProviderAuthStyle({ authStyle: preset?.authStyle, protocol: input.protocol, baseUrl: input.baseUrl }),
    upstreamModel: preset?.upstreamModel,
    headers: preset?.defaultHeaders,
    envOverrides: preset?.defaultEnvOverrides,
    roleModels: preset?.defaultRoleModels,
    availableModels: preset?.availableModels,
    sdkProxyOnly: preset?.sdkProxyOnly,
    providerMeta: preset?.providerMeta
  };
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function mergeProviderModelCapabilities(
  presetCapabilities?: AiProviderModelCapabilities,
  providerCapabilities?: AiProviderModelCapabilities
): AiProviderModelCapabilities | undefined {
  if (!presetCapabilities && !providerCapabilities) {
    return undefined;
  }
  return {
    ...(providerCapabilities ?? {}),
    ...(presetCapabilities ?? {})
  };
}

export function resolveProviderAvailableModels(input: Pick<AiProvider, 'name' | 'protocol' | 'baseUrl' | 'availableModels'>): AiProviderModel[] {
  const presetModels = findAiProviderPreset(input)?.availableModels ?? [];
  const providerModels = input.availableModels ?? [];
  const merged = new Map<string, AiProviderModel>();

  for (const model of presetModels) {
    merged.set(model.modelId, { ...model });
  }
  for (const model of providerModels) {
    const existing = merged.get(model.modelId);
    merged.set(model.modelId, {
      ...(existing ?? {}),
      ...model,
      capabilities: mergeProviderModelCapabilities(existing?.capabilities, model.capabilities)
    });
  }

  return [...merged.values()];
}

export function resolveProviderModelMetadata(
  provider: Pick<AiProvider, 'name' | 'protocol' | 'baseUrl' | 'model' | 'upstreamModel' | 'availableModels'>
): AiProviderModel | undefined {
  const model = provider.model.trim().toLowerCase();
  const upstreamModel = provider.upstreamModel?.trim().toLowerCase();
  return resolveProviderAvailableModels(provider).find((entry) => {
    const modelId = entry.modelId.trim().toLowerCase();
    const upstreamModelId = entry.upstreamModelId?.trim().toLowerCase();
    return (
      modelId === model ||
      (upstreamModel ? modelId === upstreamModel : false) ||
      (upstreamModelId ? upstreamModelId === model : false) ||
      (upstreamModel && upstreamModelId ? upstreamModelId === upstreamModel : false)
    );
  });
}

export function resolveProviderTokenLimits(
  provider: Pick<AiProvider, 'name' | 'protocol' | 'baseUrl' | 'model' | 'upstreamModel' | 'availableModels' | 'contextWindowTokens' | 'maxOutputTokens'>
): ResolvedProviderTokenLimits {
  const model = resolveProviderModelMetadata(provider);
  const configuredContextWindowTokens = normalizePositiveInteger(provider.contextWindowTokens);
  const configuredMaxOutputTokens = normalizePositiveInteger(provider.maxOutputTokens);
  const presetContextWindowTokens = normalizePositiveInteger(model?.capabilities?.contextWindow);
  const presetMaxOutputTokens = normalizePositiveInteger(model?.capabilities?.maxOutputTokens);

  return {
    modelId: model?.modelId,
    displayName: model?.displayName,
    configuredContextWindowTokens,
    configuredMaxOutputTokens,
    presetContextWindowTokens,
    presetMaxOutputTokens,
    effectiveContextWindowTokens: configuredContextWindowTokens ?? presetContextWindowTokens,
    effectiveMaxOutputTokens: configuredMaxOutputTokens ?? presetMaxOutputTokens
  };
}

export function resolveOpenAiCompatibleProviderProfile(input: {
  name?: string;
  protocol?: AiProviderProtocol;
  baseUrl?: string;
  apiMode?: AiProviderApiMode | null;
}): ResolvedOpenAiCompatibleProviderProfile {
  const preset = findAiProviderPreset({
    name: input.name,
    protocol: input.protocol ?? 'openai-compatible',
    baseUrl: input.baseUrl
  });
  const configured = preset?.openAiCompatible;
  const apiMode = inferOpenAiCompatibleApiMode(input);
  const toolChoiceModes: OpenAiCompatibleToolChoiceMode[] = configured?.toolChoiceModes?.length
    ? configured.toolChoiceModes
    : ['auto'];

  return {
    apiMode,
    supportsChatCompletions: configured?.supportsChatCompletions ?? true,
    supportsResponses: configured?.supportsResponses ?? apiMode === 'responses',
    streamingToolCalls: configured?.streamingToolCalls ?? true,
    reasoningContent: configured?.reasoningContent ?? false,
    interleavedReasoningField: configured?.interleavedReasoningField,
    chatTokenParameter: configured?.chatTokenParameter ?? 'auto',
    toolChoiceModes,
    omitToolChoice: configured?.omitToolChoice ?? false,
    schemaTransform: configured?.schemaTransform ?? 'default',
    reasoningRequestStyle: configured?.reasoningRequestStyle ?? 'none',
    nativeWebSearch: configured?.nativeWebSearch ?? false
  };
}

function modelUsesMaxCompletionTokens(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    /(^|[/:-])(o1|o3|o4)([-:/]|$)/.test(normalized) ||
    /(^|[/:-])gpt-5/.test(normalized) ||
    /(^|[/:-])mimo-v/.test(normalized)
  );
}

export function resolveOpenAiCompatibleChatTokenParameter(input: {
  name?: string;
  protocol?: AiProviderProtocol;
  baseUrl?: string;
  apiMode?: AiProviderApiMode | null;
  model?: string;
}): Exclude<OpenAiCompatibleChatTokenParameter, 'auto'> {
  const profile = resolveOpenAiCompatibleProviderProfile(input);
  if (profile.chatTokenParameter === 'max_completion_tokens') {
    return 'max_completion_tokens';
  }
  if (profile.chatTokenParameter === 'max_tokens') {
    return 'max_tokens';
  }
  return modelUsesMaxCompletionTokens(input.model ?? '') ? 'max_completion_tokens' : 'max_tokens';
}

export function resolveProviderUpstreamModel(provider: Pick<AiProvider, 'model' | 'upstreamModel' | 'availableModels'>): string {
  const model = provider.model.trim();
  if (provider.upstreamModel?.trim()) {
    return provider.upstreamModel.trim();
  }
  const match = provider.availableModels?.find((entry) => entry.modelId === model);
  return match?.upstreamModelId?.trim() || model;
}
