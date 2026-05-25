import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { MCP_PLUGIN_PRESETS } from '../../shared/mcp-plugin-catalog';
import { AI_PROVIDER_PRESETS, inferOpenAiCompatibleApiMode, resolveProviderAvailableModels, resolveProviderTokenLimits } from '../../shared/provider-catalog';
import type { AiProvider, AiProviderApiMode, AiProviderAuthStyle, AiProviderInput, AiProviderProtocol, AiProviderRoleModels, McpPlugin, McpPluginInput, McpTransport } from '../../shared/types';
import { localize, useUiLanguage } from '../i18n';
import { Button, CheckboxField, IconButton, SelectField, TextAreaField, TextField, useDialogFocus } from './ui/index';

type ProviderDraft = AiProviderInput & { presetId: string };
type McpPluginDraft = Omit<McpPluginInput, 'args' | 'env' | 'toolPolicies'> & {
  presetId: string;
  argsText: string;
  envText: string;
  toolPoliciesText: string;
};

const emptyProviderDraft: ProviderDraft = {
  presetId: AI_PROVIDER_PRESETS[0].id,
  name: AI_PROVIDER_PRESETS[0].name,
  protocol: AI_PROVIDER_PRESETS[0].protocol,
  apiMode: AI_PROVIDER_PRESETS[0].apiMode ?? 'chat',
  authStyle: AI_PROVIDER_PRESETS[0].authStyle ?? 'api_key',
  baseUrl: AI_PROVIDER_PRESETS[0].baseUrl,
  apiKey: '',
  model: AI_PROVIDER_PRESETS[0].defaultModel,
  upstreamModel: AI_PROVIDER_PRESETS[0].upstreamModel,
  claudeCodeCompatible: false,
  claudeRoleModels: AI_PROVIDER_PRESETS[0].defaultRoleModels ?? {},
  headers: AI_PROVIDER_PRESETS[0].defaultHeaders,
  envOverrides: AI_PROVIDER_PRESETS[0].defaultEnvOverrides,
  availableModels: AI_PROVIDER_PRESETS[0].availableModels,
  sdkProxyOnly: AI_PROVIDER_PRESETS[0].sdkProxyOnly,
  providerMeta: AI_PROVIDER_PRESETS[0].providerMeta,
  contextWindowTokens: undefined,
  maxOutputTokens: undefined,
  requestTimeoutMs: undefined,
  chunkTimeoutMs: undefined,
  enabled: true,
  notes: ''
};

const emptyPluginDraft: McpPluginDraft = {
  presetId: MCP_PLUGIN_PRESETS[0].id,
  name: MCP_PLUGIN_PRESETS[0].name,
  kind: MCP_PLUGIN_PRESETS[0].kind,
  transport: MCP_PLUGIN_PRESETS[0].transport,
  baseUrl: MCP_PLUGIN_PRESETS[0].baseUrl,
  command: MCP_PLUGIN_PRESETS[0].command,
  cwd: '',
  argsText: (MCP_PLUGIN_PRESETS[0].args ?? []).join('\n'),
  envText: '',
  defaultToolPermission: 'infer',
  defaultToolRisk: 'infer',
  toolPoliciesText: '',
  enabled: true,
  notes: ''
};

function createProviderDraft(provider: AiProvider | null): ProviderDraft {
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

const claudeRoleModelFields: Array<{
  key: keyof AiProviderRoleModels;
  zh: string;
  en: string;
  placeholder: string;
}> = [
  { key: 'default', zh: '默认', en: 'Default', placeholder: 'gpt-5.4-xhigh' },
  { key: 'haiku', zh: '快速/Haiku', en: 'Fast / Haiku', placeholder: 'gpt-5.4-mini' },
  { key: 'sonnet', zh: '标准/Sonnet', en: 'Standard / Sonnet', placeholder: 'gpt-5.4-xhigh' },
  { key: 'opus', zh: '高阶/Opus', en: 'Advanced / Opus', placeholder: 'gpt-5.5' },
  { key: 'small', zh: '小模型', en: 'Small', placeholder: 'gpt-5.4-mini' },
  { key: 'reasoning', zh: '推理', en: 'Reasoning', placeholder: 'gpt-5.4-xhigh' }
];

function formatStringRecord(input?: Record<string, string>): string {
  return Object.entries(input ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function parseStringRecord(input: string): Record<string, string> | undefined {
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

function parseOptionalInteger(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

function formatCompactTokenLimit(value: number | undefined): string {
  if (!value) {
    return '--';
  }
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}K`;
  }
  return String(value);
}

function describeProviderPreset(language: 'zh-CN' | 'en-US', presetId: string, fallback: string): string {
  const map: Record<string, { zh: string; en: string }> = {
    openai: {
      zh: '官方 OpenAI API，适合通用文本生成。',
      en: 'Official OpenAI API for general text generation.'
    },
    openrouter: {
      zh: '统一代理多家模型，适合快速尝试不同模型。',
      en: 'A unified gateway for many models, great for quick experimentation.'
    },
    anthropic: {
      zh: '原生 Anthropic 协议。',
      en: 'Native Anthropic protocol.'
    },
    gemini: {
      zh: 'Google Gemini 官方 API。',
      en: 'Official Google Gemini API.'
    },
    deepseek: {
      zh: '适合低成本文本与推理场景。',
      en: 'Good for low-cost text and reasoning workloads.'
    },
    'qwen-dashscope': {
      zh: '阿里云百炼 OpenAI 兼容通道，默认使用千问系列模型。',
      en: 'Alibaba Cloud Model Studio OpenAI-compatible gateway for Qwen models.'
    },
    'kimi-moonshot': {
      zh: 'Moonshot Kimi OpenAI Chat Completions 兼容通道。',
      en: 'Moonshot Kimi OpenAI-compatible Chat Completions gateway.'
    },
    'zhipu-glm': {
      zh: '智谱 GLM OpenAI Chat Completions 兼容通道。',
      en: 'Zhipu GLM OpenAI-compatible Chat Completions gateway.'
    },
    siliconflow: {
      zh: '硅基流动模型聚合通道，适合接入多种国内外开源模型。',
      en: 'SiliconFlow model gateway for many domestic and international open models.'
    },
    'xiaomi-mimo': {
      zh: '小米 MiMo OpenAI Chat Completions 兼容通道，支持流式工具调用和 reasoning_content。',
      en: 'Xiaomi MiMo OpenAI-compatible Chat Completions gateway with streamed tools and reasoning_content.'
    },
    'custom-openai': {
      zh: '任意兼容 OpenAI Chat/Responses 风格接口的端点。',
      en: 'Any endpoint compatible with OpenAI Chat or Responses style APIs.'
    }
  };
  return map[presetId] ? localize(language, map[presetId].zh, map[presetId].en) : fallback;
}

function providerApiKeyHint(language: 'zh-CN' | 'en-US', presetId: string, fallback: string): string {
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

function formatPresetProtocol(language: 'zh-CN' | 'en-US', protocol: AiProviderProtocol, apiMode?: AiProviderApiMode): string {
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

function describeMcpPreset(language: 'zh-CN' | 'en-US', presetId: string, fallback: string): string {
  const map: Record<string, { zh: string; en: string }> = {
    'unity-mcp': {
      zh: 'GameBooom / FunseaAI Unity MCP 预设。',
      en: 'GameBooom / FunseaAI Unity MCP preset.'
    },
    'custom-engine-mcp': {
      zh: '任意兼容 MCP HTTP JSON-RPC 的 Server。',
      en: 'Any server compatible with MCP HTTP JSON-RPC.'
    },
    'custom-asset-mcp': {
      zh: '任意兼容 MCP HTTP JSON-RPC 的 Server。',
      en: 'Any server compatible with MCP HTTP JSON-RPC.'
    },
    'custom-mcp': {
      zh: '任意兼容 MCP HTTP JSON-RPC 的 Server。',
      en: 'Any server compatible with MCP HTTP JSON-RPC.'
    },
    'custom-stdio-mcp': {
      zh: '通过本地命令启动的 MCP stdio Server。',
      en: 'MCP stdio server launched from a local command.'
    }
  };
  return map[presetId] ? localize(language, map[presetId].zh, map[presetId].en) : fallback;
}

function parseLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseEnvLines(value: string): Record<string, string> | undefined {
  const entries: Record<string, string> = {};
  for (const line of parseLines(value)) {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const val = line.slice(separator + 1);
    if (key) {
      entries[key] = val;
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function formatToolPolicies(input?: McpPlugin['toolPolicies']): string {
  return input && Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : '';
}

function parseToolPolicies(input: string): McpPluginInput['toolPolicies'] {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool policies must be a JSON object.');
  }
  const permissionValues = new Set(['infer', 'allow', 'ask', 'deny']);
  const riskValues = new Set(['infer', 'read', 'write']);
  const output: NonNullable<McpPluginInput['toolPolicies']> = {};
  for (const [toolName, rawPolicy] of Object.entries(parsed as Record<string, unknown>)) {
    const normalizedToolName = toolName.trim();
    if (!normalizedToolName) {
      throw new Error('Tool policy names cannot be empty.');
    }
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
      throw new Error(`Tool policy for "${normalizedToolName}" must be an object.`);
    }
    const policy = rawPolicy as Record<string, unknown>;
    const next: NonNullable<McpPluginInput['toolPolicies']>[string] = {};
    if (policy.permission !== undefined) {
      if (typeof policy.permission !== 'string' || !permissionValues.has(policy.permission)) {
        throw new Error(`Tool policy "${normalizedToolName}" has invalid permission.`);
      }
      next.permission = policy.permission as NonNullable<McpPluginInput['defaultToolPermission']>;
    }
    if (policy.risk !== undefined) {
      if (typeof policy.risk !== 'string' || !riskValues.has(policy.risk)) {
        throw new Error(`Tool policy "${normalizedToolName}" has invalid risk.`);
      }
      next.risk = policy.risk as NonNullable<McpPluginInput['defaultToolRisk']>;
    }
    if (policy.notes !== undefined) {
      if (typeof policy.notes !== 'string') {
        throw new Error(`Tool policy "${normalizedToolName}" notes must be a string.`);
      }
      next.notes = policy.notes;
    }
    output[normalizedToolName] = next;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function ProviderEditor(props: {
  provider: AiProvider | null;
  onCancel?: () => void;
  onCreate: (input: AiProviderInput) => Promise<void>;
  onUpdate: (providerId: string, input: AiProviderInput) => Promise<void>;
}): JSX.Element {
  const language = useUiLanguage();
  const modelListId = useId();
  const upstreamModelListId = useId();
  const initialDraft = useMemo(() => createProviderDraft(props.provider), [props.provider?.id]);
  const [draft, setDraft] = useState<ProviderDraft>(initialDraft);
  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);
  const preset = AI_PROVIDER_PRESETS.find((item) => item.id === draft.presetId) ?? AI_PROVIDER_PRESETS[0];
  const presetDescription = describeProviderPreset(language, preset.id, preset.description);
  const apiKeyHint = providerApiKeyHint(language, preset.id, preset.apiKeyHint);
  const draftTokenLimits = useMemo(() => resolveProviderTokenLimits({
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    model: draft.model,
    upstreamModel: draft.upstreamModel,
    availableModels: draft.availableModels,
    contextWindowTokens: draft.contextWindowTokens,
    maxOutputTokens: draft.maxOutputTokens
  }), [
    draft.name,
    draft.protocol,
    draft.baseUrl,
    draft.model,
    draft.upstreamModel,
    draft.availableModels,
    draft.contextWindowTokens,
    draft.maxOutputTokens
  ]);
  const resolvedModelChoices = useMemo(() => resolveProviderAvailableModels({
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    availableModels: draft.availableModels
  }), [
    draft.name,
    draft.protocol,
    draft.baseUrl,
    draft.availableModels
  ]);
  const suggestedUpstreamModels = useMemo(() => {
    const values = new Set<string>();
    for (const model of resolvedModelChoices) {
      if (model.upstreamModelId?.trim()) {
        values.add(model.upstreamModelId.trim());
      }
      if (model.modelId.trim()) {
        values.add(model.modelId.trim());
      }
    }
    return [...values];
  }, [resolvedModelChoices]);
  const updateClaudeRoleModel = (key: keyof AiProviderRoleModels, value: string): void => {
    setDraft((current) => ({
      ...current,
      claudeRoleModels: {
        ...(current.claudeRoleModels ?? {}),
        [key]: value
      }
    }));
  };
  const applyProviderPreset = (presetId: string): void => {
    const next = AI_PROVIDER_PRESETS.find((item) => item.id === presetId);
    if (!next) return;
    setDraft((current) => ({
      ...current,
      presetId: next.id,
      name: props.provider ? current.name : next.name,
      protocol: next.protocol,
      authStyle: next.authStyle ?? (next.protocol === 'bedrock' || next.protocol === 'vertex' ? 'env_only' : 'api_key'),
      apiMode: next.protocol === 'openai-compatible' ? next.apiMode ?? current.apiMode ?? 'chat' : undefined,
      baseUrl: next.baseUrl,
      model: props.provider ? current.model : next.defaultModel,
      upstreamModel: next.upstreamModel,
      claudeCodeCompatible: next.protocol === 'anthropic' || Boolean(next.sdkProxyOnly),
      claudeRoleModels: next.defaultRoleModels ?? (next.protocol === 'anthropic' ? current.claudeRoleModels ?? {} : {}),
      headers: next.defaultHeaders,
      envOverrides: next.defaultEnvOverrides,
      availableModels: next.availableModels,
      sdkProxyOnly: next.sdkProxyOnly,
      providerMeta: next.providerMeta
    }));
  };

  return (
    <>
      <div className="provider-editor-section provider-preset-picker">
        <div className="provider-editor-section-header">
          <strong>{localize(language, '服务商预设', 'Provider Presets')}</strong>
          <span>{presetDescription}</span>
        </div>
        <div className="provider-preset-card-grid" role="list">
          {AI_PROVIDER_PRESETS.map((item) => (
            <Button
              key={item.id}
              size="compact"
              variant="ghost"
              className={`provider-preset-card ${draft.presetId === item.id ? 'active' : ''}`}
              onClick={() => applyProviderPreset(item.id)}
            >
              <strong>{item.name}</strong>
              <span>{describeProviderPreset(language, item.id, item.description)}</span>
              <em>{formatPresetProtocol(language, item.protocol, item.apiMode)} · {item.defaultModel}</em>
            </Button>
          ))}
        </div>
      </div>
      <div className="provider-editor-section provider-core-config">
        <div className="provider-editor-section-header">
          <strong>{localize(language, '核心配置', 'Core Configuration')}</strong>
          <span>{apiKeyHint}</span>
        </div>
        <TextField
          label={localize(language, '名称', 'Name')}
          value={draft.name}
          onValueChange={(value) => setDraft((current) => ({ ...current, name: value }))}
        />
        <TextField
          label="Base URL"
          value={draft.baseUrl}
          onValueChange={(value) => setDraft((current) => ({ ...current, baseUrl: value }))}
        />
        <TextField
          label="API Key"
          value={draft.apiKey}
          placeholder={apiKeyHint}
          onValueChange={(value) => setDraft((current) => ({ ...current, apiKey: value }))}
          helper={props.provider?.hasStoredApiKey
            ? localize(language, '留空将保留当前已保存的 API Key。', 'Leave blank to keep the currently saved API key.')
            : localize(language, '当前尚未保存 API Key。', 'No API key is currently saved.')}
        />
        <TextField
          label={localize(language, '默认模型', 'Default Model')}
          list={modelListId}
          value={draft.model}
          onValueChange={(value) => setDraft((current) => ({ ...current, model: value }))}
          helper={draftTokenLimits.modelId
            ? localize(
              language,
              `可直接输入自定义模型，也可从预设候选里选择。当前命中：${draftTokenLimits.displayName || draftTokenLimits.modelId}；默认上下文 ${formatCompactTokenLimit(draftTokenLimits.presetContextWindowTokens)}，默认单步输出 ${formatCompactTokenLimit(draftTokenLimits.presetMaxOutputTokens)}。`,
              `You can type a custom model or choose a preset suggestion. Current match: ${draftTokenLimits.displayName || draftTokenLimits.modelId}; default context ${formatCompactTokenLimit(draftTokenLimits.presetContextWindowTokens)}, default max output ${formatCompactTokenLimit(draftTokenLimits.presetMaxOutputTokens)}.`
            )
            : localize(
              language,
              '可直接输入自定义模型，也可从预设候选里选择。当前模型没有命中内置预设；如果是代理、自定义别名或新模型，建议按服务商文档填写上下文窗口和单步输出上限。',
              'You can type a custom model or choose a preset suggestion. This model does not match a built-in preset; for proxies, custom aliases, or newer models, set context window and max output limits from your provider docs.'
            )}
        />
        <datalist id={modelListId}>
          {resolvedModelChoices.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName || model.modelId}
            </option>
          ))}
        </datalist>
        {resolvedModelChoices.length ? (
          <div className="agent-settings-chip-grid" role="list">
            {resolvedModelChoices.map((model) => (
              <Button
                key={model.modelId}
                size="compact"
                variant="ghost"
                className={`agent-settings-chip-button ${draft.model.trim() === model.modelId ? 'active' : ''}`}
                onClick={() => setDraft((current) => ({ ...current, model: model.modelId }))}
                title={model.displayName || model.modelId}
              >
                {model.displayName || model.modelId}
              </Button>
            ))}
          </div>
        ) : null}
        <TextField
          label={localize(language, '上游模型 ID', 'Upstream Model ID')}
          list={upstreamModelListId}
          value={draft.upstreamModel ?? ''}
          onValueChange={(value) => setDraft((current) => ({ ...current, upstreamModel: value }))}
          helper={localize(language, '留空时使用默认模型；也可以手写真实上游模型 ID，或从已知候选里快速填入。', 'Leave this empty to use the default model; you can also type the real upstream model ID or pick a known suggestion.')}
        />
        <datalist id={upstreamModelListId}>
          {suggestedUpstreamModels.map((modelId) => (
            <option key={modelId} value={modelId} />
          ))}
        </datalist>
      </div>
      <details className="provider-advanced-section">
        <summary>
          <span>{localize(language, '高级协议配置', 'Advanced Protocol Configuration')}</span>
          <em>{formatPresetProtocol(language, draft.protocol, draft.apiMode)}</em>
        </summary>
        <SelectField
          label={localize(language, '协议', 'Protocol')}
          value={draft.protocol}
          options={[
            { value: 'openai-compatible', label: 'openai-compatible' },
            { value: 'anthropic', label: 'anthropic' },
            { value: 'google', label: 'google' },
            { value: 'bedrock', label: 'bedrock' },
            { value: 'vertex', label: 'vertex' }
          ]}
          onValueChange={(value) => {
            const protocol = value as AiProviderProtocol;
            setDraft((current) => ({
              ...current,
              protocol,
              authStyle: (protocol === 'bedrock' || protocol === 'vertex' ? 'env_only' : current.authStyle ?? 'api_key') as AiProviderAuthStyle,
              apiMode: protocol === 'openai-compatible' ? current.apiMode ?? 'chat' : undefined,
              claudeCodeCompatible: protocol === 'anthropic' || current.sdkProxyOnly,
              claudeRoleModels: protocol === 'anthropic' ? current.claudeRoleModels ?? {} : {}
            }));
          }}
        />
        {draft.protocol === 'openai-compatible' ? (
          <SelectField
            label={localize(language, '接口模式', 'API Mode')}
            value={draft.apiMode ?? 'chat'}
            options={[
              { value: 'responses', label: 'responses' },
              { value: 'chat', label: 'chat completions' }
            ]}
            onValueChange={(value) => setDraft((current) => ({ ...current, apiMode: value as AiProviderApiMode }))}
            helper={localize(
              language,
              '不同服务商支持的协议不同；OpenAI 官方推荐 responses，国内兼容通道通常推荐 chat completions。',
              'Different providers support different modes; official OpenAI prefers responses, while most domestic compatible gateways prefer chat completions.'
            )}
          />
        ) : null}
        <SelectField
          label={localize(language, '认证方式', 'Auth Style')}
          value={draft.authStyle ?? 'api_key'}
          options={[
            { value: 'api_key', label: 'api_key' },
            { value: 'auth_token', label: 'auth_token' },
            { value: 'env_only', label: 'env_only' },
            { value: 'custom_header', label: 'custom_header' }
          ]}
          onValueChange={(value) => setDraft((current) => ({ ...current, authStyle: value as AiProviderAuthStyle }))}
        />
        <CheckboxField
          label="SDK Proxy Only"
          description={localize(language, '只允许 Claude Code SDK/兼容链路使用该 Provider。', 'Only allow this provider through the Claude Code SDK/compatible path.')}
          checked={Boolean(draft.sdkProxyOnly)}
          onCheckedChange={(checked) => setDraft((current) => ({ ...current, sdkProxyOnly: checked }))}
        />
        <div className="provider-role-model-grid">
          <TextField
            className="compact"
            label={localize(language, '上下文窗口 tokens', 'Context Window tokens')}
            type="number"
            min={1024}
            max={2_000_000}
            step={1024}
            value={typeof draft.contextWindowTokens === 'number' ? String(draft.contextWindowTokens) : ''}
            placeholder={localize(language, '留空使用预设', 'Empty uses preset')}
            onValueChange={(value) => setDraft((current) => ({ ...current, contextWindowTokens: parseOptionalInteger(value) }))}
            helper={draftTokenLimits.presetContextWindowTokens
              ? localize(
                language,
                `用于判断何时压缩会话历史；留空时当前模型默认按 ${formatCompactTokenLimit(draftTokenLimits.presetContextWindowTokens)} 处理。`,
                `Used to decide when to compact history; when empty, the current model defaults to ${formatCompactTokenLimit(draftTokenLimits.presetContextWindowTokens)}.`
              )
              : localize(language, '用于判断何时压缩会话历史；代理或自定义模型建议按实际窗口填写。', 'Used to decide when to compact history; set the real window for proxy or custom models.')}
          />
          <TextField
            className="compact"
            label={localize(language, '单步输出上限 tokens', 'Max Output tokens')}
            type="number"
            min={1}
            max={1_000_000}
            step={1}
            value={typeof draft.maxOutputTokens === 'number' ? String(draft.maxOutputTokens) : ''}
            placeholder="32000"
            onValueChange={(value) => setDraft((current) => ({ ...current, maxOutputTokens: parseOptionalInteger(value) }))}
            helper={draftTokenLimits.presetMaxOutputTokens
              ? localize(
                language,
                `用于 Native Agent 每次流式请求的 max_tokens/max_output_tokens；留空时当前模型默认按 ${formatCompactTokenLimit(draftTokenLimits.presetMaxOutputTokens)} 处理。`,
                `Used for Native Agent max_tokens/max_output_tokens on each streamed request; when empty, the current model defaults to ${formatCompactTokenLimit(draftTokenLimits.presetMaxOutputTokens)}.`
              )
              : localize(language, '用于 Native Agent 每次流式请求的 max_tokens/max_output_tokens。', 'Used for Native Agent max_tokens/max_output_tokens on each streamed request.')}
          />
          <TextField
            className="compact"
            label={localize(language, '请求超时 ms', 'Request Timeout ms')}
            type="number"
            min={1}
            max={60 * 60 * 1000}
            step={1000}
            disabled={draft.requestTimeoutMs === false}
            value={typeof draft.requestTimeoutMs === 'number' ? String(draft.requestTimeoutMs) : ''}
            placeholder="300000"
            onValueChange={(value) => setDraft((current) => ({ ...current, requestTimeoutMs: parseOptionalInteger(value) }))}
          />
          <TextField
            className="compact"
            label={localize(language, 'SSE 分块超时 ms', 'SSE Chunk Timeout ms')}
            type="number"
            min={1}
            max={60 * 60 * 1000}
            step={1000}
            value={typeof draft.chunkTimeoutMs === 'number' ? String(draft.chunkTimeoutMs) : ''}
            placeholder={localize(language, '留空不限制', 'Empty for no limit')}
            onValueChange={(value) => setDraft((current) => ({ ...current, chunkTimeoutMs: parseOptionalInteger(value) }))}
          />
        </div>
        <CheckboxField
          label={localize(language, '禁用请求超时', 'Disable Request Timeout')}
          description={localize(language, '默认 300000ms；只有服务商自己稳定处理超长连接时才建议关闭。', 'Default is 300000ms; disable only when the provider reliably handles very long connections.')}
          checked={draft.requestTimeoutMs === false}
          onCheckedChange={(checked) => setDraft((current) => ({ ...current, requestTimeoutMs: checked ? false : undefined }))}
        />
        <TextAreaField
          label="Headers"
          value={formatStringRecord(draft.headers)}
          onValueChange={(value) => setDraft((current) => ({ ...current, headers: parseStringRecord(value) }))}
          placeholder="X-Custom-Header=value"
        />
        <TextAreaField
          label="Env Overrides"
          value={formatStringRecord(draft.envOverrides)}
          onValueChange={(value) => setDraft((current) => ({ ...current, envOverrides: parseStringRecord(value) }))}
          placeholder="CLAUDE_CODE_USE_BEDROCK=1"
        />
        {draft.protocol === 'anthropic' ? (
          <div className="fp-field provider-compat-section">
            <div className="provider-compat-title">
              {localize(language, 'Claude runtime 角色模型映射', 'Claude runtime role model mapping')}
            </div>
            <div className="helper-copy">
              {localize(
                language,
                'Anthropic 协议 Provider 默认使用 Claude runtime 内置 WebSearch/WebFetch；未填写的角色会自动使用默认模型。',
                'Anthropic-protocol providers use Claude runtime built-in WebSearch/WebFetch by default; empty roles fall back to the default model.'
              )}
            </div>
            <div className="provider-role-model-grid">
              {claudeRoleModelFields.map((field) => (
                <TextField
                  className="compact"
                  key={field.key}
                  label={localize(language, field.zh, field.en)}
                  value={draft.claudeRoleModels?.[field.key] ?? ''}
                  placeholder={field.placeholder}
                  onValueChange={(value) => updateClaudeRoleModel(field.key, value)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </details>
      <TextAreaField
        label={localize(language, '备注', 'Notes')}
        value={draft.notes}
        onValueChange={(value) => setDraft((current) => ({ ...current, notes: value }))}
      />
      <div className="modal-actions">
        {props.onCancel ? (
          <Button variant="secondary" onClick={props.onCancel}>
            {localize(language, '取消', 'Cancel')}
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={() => {
            const payload: AiProviderInput = {
              name: draft.name,
              protocol: draft.protocol,
              apiMode: draft.protocol === 'openai-compatible' ? draft.apiMode ?? 'chat' : undefined,
              authStyle: draft.authStyle,
              baseUrl: draft.baseUrl,
              apiKey: draft.apiKey,
              model: draft.model,
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
            if (props.provider) {
              void props.onUpdate(props.provider.id, payload);
            } else {
              void props.onCreate(payload);
            }
          }}
        >
          {localize(language, '保存', 'Save')}
        </Button>
      </div>
    </>
  );
}

export function McpPluginModal(props: {
  plugin: McpPlugin | null;
  projectId?: string;
  onClose: () => void;
  onCreate: (input: McpPluginInput) => Promise<void>;
  onUpdate: (pluginId: string, input: McpPluginInput) => Promise<void>;
}): JSX.Element {
  const language = useUiLanguage();
  const initialDraft = useMemo<McpPluginDraft>(() => props.plugin
    ? {
        presetId: 'custom-mcp',
        projectId: props.plugin.projectId,
        name: props.plugin.name,
        kind: props.plugin.kind,
        transport: props.plugin.transport,
        baseUrl: props.plugin.baseUrl,
        command: props.plugin.command || '',
        cwd: props.plugin.cwd || '',
        argsText: (props.plugin.args ?? []).join('\n'),
        envText: Object.entries(props.plugin.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
        defaultToolPermission: props.plugin.defaultToolPermission ?? 'infer',
        defaultToolRisk: props.plugin.defaultToolRisk ?? 'infer',
        toolPoliciesText: formatToolPolicies(props.plugin.toolPolicies),
        enabled: props.plugin.enabled,
        notes: props.plugin.notes || ''
      }
    : {
        ...emptyPluginDraft,
        projectId: props.projectId
      }, [props.plugin, props.projectId]);
  const [draft, setDraft] = useState<McpPluginDraft>(initialDraft);
  const [policyError, setPolicyError] = useState('');
  useEffect(() => {
    setDraft(initialDraft);
    setPolicyError('');
  }, [initialDraft]);
  const preset = MCP_PLUGIN_PRESETS.find((item) => item.id === draft.presetId) ?? MCP_PLUGIN_PRESETS[0];
  const presetDescription = describeMcpPreset(language, preset.id, preset.description);

  return (
    <ModalShell
      title={props.plugin ? localize(language, '编辑 MCP 插件', 'Edit MCP Plugin') : localize(language, '添加 MCP 插件', 'Add MCP Plugin')}
      subtitle={props.projectId ? localize(language, '这个 Server 只属于当前项目。', 'This server belongs only to the current project.') : localize(language, '这个 Server 会作为全局 MCP 供项目选择启用。', 'This server is registered globally and can be enabled by projects.')}
    >
      <SelectField
        label={localize(language, '预设', 'Preset')}
        value={draft.presetId}
        options={MCP_PLUGIN_PRESETS.map((item) => ({ value: item.id, label: item.name }))}
        helper={presetDescription}
        onValueChange={(value) => {
            const next = MCP_PLUGIN_PRESETS.find((item) => item.id === value);
            if (!next) return;
            setDraft((current) => ({
              ...current,
              presetId: next.id,
              projectId: props.projectId,
              name: props.plugin ? current.name : next.name,
              kind: next.kind,
              transport: next.transport,
              baseUrl: next.baseUrl,
              command: next.command,
              argsText: (next.args ?? []).join('\n'),
              envText: '',
              defaultToolPermission: 'infer',
              defaultToolRisk: 'infer',
              toolPoliciesText: ''
            }));
            setPolicyError('');
        }}
      />
      <TextField
        label={localize(language, '名称', 'Name')}
        value={draft.name}
        onValueChange={(value) => setDraft((current) => ({ ...current, name: value }))}
      />
      {draft.transport === 'stdio' ? (
        <>
          <TextField
            label="Command"
            value={draft.command ?? ''}
            onValueChange={(value) => setDraft((current) => ({ ...current, command: value }))}
          />
          <TextAreaField
            label="Arguments"
            value={draft.argsText}
            placeholder={'--flag\nvalue'}
            helper={localize(language, '每行一个参数。', 'One argument per line.')}
            onValueChange={(value) => setDraft((current) => ({ ...current, argsText: value }))}
          />
          <TextField
            label="CWD"
            value={draft.cwd ?? ''}
            onValueChange={(value) => setDraft((current) => ({ ...current, cwd: value }))}
          />
          <TextAreaField
            label="Environment"
            value={draft.envText}
            placeholder="KEY=value"
            helper={localize(language, '每行一个 KEY=value。', 'One KEY=value per line.')}
            onValueChange={(value) => setDraft((current) => ({ ...current, envText: value }))}
          />
        </>
      ) : (
        <TextField
          label="Base URL"
          value={draft.baseUrl}
          onValueChange={(value) => setDraft((current) => ({ ...current, baseUrl: value }))}
        />
      )}
      <div className="fp-field provider-compat-section">
        <div className="provider-compat-title">{localize(language, '工具权限策略', 'Tool Permission Policy')}</div>
        <div className="helper-copy">
          {localize(language, '默认使用自动推断；对高风险或特殊工具可用 JSON 覆盖。deny 会从 Agent 工具列表中隐藏并阻止通用调用。', 'Defaults use inference. Override high-risk or special tools with JSON. deny hides direct Agent tools and blocks generic calls.')}
        </div>
        <SelectField
          label={localize(language, '默认权限', 'Default Permission')}
          value={draft.defaultToolPermission ?? 'infer'}
          options={[
            { value: 'infer', label: localize(language, '自动推断', 'Infer') },
            { value: 'allow', label: localize(language, '允许', 'Allow') },
            { value: 'ask', label: localize(language, '询问确认', 'Ask') },
            { value: 'deny', label: localize(language, '拒绝', 'Deny') }
          ]}
          onValueChange={(value) => setDraft((current) => ({ ...current, defaultToolPermission: value as NonNullable<McpPluginInput['defaultToolPermission']> }))}
        />
        <SelectField
          label={localize(language, '默认风险', 'Default Risk')}
          value={draft.defaultToolRisk ?? 'infer'}
          options={[
            { value: 'infer', label: localize(language, '自动推断', 'Infer') },
            { value: 'read', label: localize(language, '只读', 'Read-only') },
            { value: 'write', label: localize(language, '可写入/高风险', 'Write / High risk') }
          ]}
          onValueChange={(value) => setDraft((current) => ({ ...current, defaultToolRisk: value as NonNullable<McpPluginInput['defaultToolRisk']> }))}
        />
        <TextAreaField
          label={localize(language, '工具覆盖 JSON', 'Tool Override JSON')}
          value={draft.toolPoliciesText}
          placeholder={'{\n  "unity.echo": { "permission": "ask", "risk": "write" }\n}'}
          helper={localize(language, '键是 MCP 原始工具名；permission 支持 infer/allow/ask/deny，risk 支持 infer/read/write。', 'Keys are original MCP tool names; permission supports infer/allow/ask/deny, risk supports infer/read/write.')}
          onValueChange={(value) => {
            setDraft((current) => ({ ...current, toolPoliciesText: value }));
            setPolicyError('');
          }}
        />
        {policyError ? <div className="helper-copy form-error">{policyError}</div> : null}
      </div>
      <CheckboxField
        label={localize(language, '启用 Server', 'Enable server')}
        description={localize(language, '停用后项目不能调用这个 MCP。', 'Disabled servers cannot be called by projects.')}
        checked={draft.enabled ?? true}
        onCheckedChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
      />
      <TextAreaField
        label={localize(language, '备注', 'Notes')}
        value={draft.notes}
        onValueChange={(value) => setDraft((current) => ({ ...current, notes: value }))}
      />
      <div className="modal-actions">
        <Button variant="secondary" onClick={props.onClose}>
          {localize(language, '取消', 'Cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            let toolPolicies: McpPluginInput['toolPolicies'];
            try {
              toolPolicies = parseToolPolicies(draft.toolPoliciesText);
            } catch (error) {
              setPolicyError(error instanceof Error ? error.message : localize(language, '工具策略 JSON 无效。', 'Invalid tool policy JSON.'));
              return;
            }
            const payload: McpPluginInput = {
              projectId: draft.projectId,
              name: draft.name,
              kind: draft.kind,
              transport: draft.transport as McpTransport,
              baseUrl: draft.baseUrl,
              command: draft.command,
              args: parseLines(draft.argsText),
              cwd: draft.cwd,
              env: parseEnvLines(draft.envText),
              defaultToolPermission: draft.defaultToolPermission ?? 'infer',
              defaultToolRisk: draft.defaultToolRisk ?? 'infer',
              toolPolicies,
              enabled: draft.enabled,
              notes: draft.notes
            };
            if (props.plugin) {
              void props.onUpdate(props.plugin.id, payload);
            } else {
              void props.onCreate(payload);
            }
          }}
        >
          {localize(language, '保存', 'Save')}
        </Button>
      </div>
    </ModalShell>
  );
}

export function ModalShell(props: { title: string; subtitle: string; children: ReactNode; className?: string; onClose?: () => void }): JSX.Element {
  const titleId = useId();
  const subtitleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus({
    enabled: true,
    containerRef: cardRef,
    onEscape: props.onClose
  });

  return (
    <div className="modal-backdrop" data-modal-state="open">
      <div
        ref={cardRef}
        className={`modal-card fp-modal ${props.className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <div className="page-title" id={titleId}>{props.title}</div>
            <div className="page-subtitle" id={subtitleId}>{props.subtitle}</div>
          </div>
          {props.onClose ? (
            <IconButton className="modal-close-button" icon={<X size={16} aria-hidden="true" />} label="Close" onClick={props.onClose} />
          ) : null}
        </div>
        <div className="modal-stack">{props.children}</div>
      </div>
    </div>
  );
}
