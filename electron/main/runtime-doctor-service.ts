import type {
  AiProvider,
  AiProviderAuthStyle,
  AppState,
  RuntimeDoctorFinding,
  RuntimeDoctorProbe,
  RuntimeDoctorResult,
  RuntimeRepairAction
} from '../../shared/types';
import { ensureProjectSessions, getActiveProjectSession } from '../../shared/project-sessions';
import {
  inferOpenAiCompatibleApiMode,
  resolveOpenAiCompatibleChatTokenParameter,
  resolveOpenAiCompatibleProviderProfile
} from '../../shared/provider-catalog';
import { sanitizeProviderForRenderer } from './provider-secret-store';
import { resolveProviderForRuntime, toNativeProviderConfig } from './agent-platform/provider-resolver';
import { classifyNativeRuntimeError, redactNativeRuntimeErrorDetail } from './agent-platform/native/diagnostics';
import { testProviderConnection } from './text-generator';
import { nowIso } from '../../shared/utils';

interface RuntimeDoctorOptions {
  providerId?: string;
  projectId?: string;
  live?: boolean;
}

interface RuntimeRepairInput {
  actionId: string;
  providerId?: string;
  projectId?: string;
  sessionId?: string;
  authStyle?: AiProviderAuthStyle;
  url?: string;
}

let lastRuntimeDiagnosis: Record<string, unknown> | undefined;

function severityRank(value: RuntimeDoctorFinding['severity']): number {
  switch (value) {
    case 'error':
      return 2;
    case 'warn':
      return 1;
    default:
      return 0;
  }
}

function maxSeverity(findings: RuntimeDoctorFinding[]): RuntimeDoctorFinding['severity'] {
  return findings.reduce<RuntimeDoctorFinding['severity']>(
    (current, finding) => (severityRank(finding.severity) > severityRank(current) ? finding.severity : current),
    'ok'
  );
}

function createProbe(id: string, title: string, startedAt: number, findings: RuntimeDoctorFinding[]): RuntimeDoctorProbe {
  return {
    id,
    title,
    severity: maxSeverity(findings),
    findings,
    durationMs: Date.now() - startedAt
  };
}

function providerFinding(provider: AiProvider | undefined, finding: RuntimeDoctorFinding): RuntimeDoctorFinding {
  return {
    providerId: provider?.id,
    protocol: provider?.protocol,
    baseUrl: provider?.baseUrl || undefined,
    model: provider?.model || undefined,
    upstreamModel: provider?.upstreamModel || undefined,
    runtimeId: 'native',
    ...finding
  };
}

function resolveDoctorProvider(state: AppState, options: RuntimeDoctorOptions): AiProvider | undefined {
  const project = options.projectId ? state.projects.find((item) => item.id === options.projectId) : undefined;
  return resolveProviderForRuntime({
    state,
    project,
    explicitProviderId: options.providerId
  }).provider;
}

function buildProviderProbe(state: AppState, options: RuntimeDoctorOptions, provider?: AiProvider): RuntimeDoctorProbe {
  const startedAt = Date.now();
  const resolved = resolveProviderForRuntime({
    state,
    project: options.projectId ? state.projects.find((item) => item.id === options.projectId) : undefined,
    explicitProviderId: options.providerId
  });
  const nativeConfig = toNativeProviderConfig(resolved);
  const findings: RuntimeDoctorFinding[] = [
    providerFinding(provider, {
      severity: nativeConfig.canUseNative ? 'ok' : 'error',
      code: nativeConfig.canUseNative ? 'provider_runtime_resolved' : 'provider_native_unavailable',
      summary: nativeConfig.canUseNative
        ? 'Provider 可以进入 Native runtime。'
        : 'Provider 当前不能进入 Native runtime。',
      detail: [
        `provider=${resolved.providerName ?? '(none)'}`,
        `protocol=${resolved.protocol}`,
        `authStyle=${resolved.authStyle}`,
        `model=${resolved.model ?? '(default)'}`,
        `upstreamModel=${resolved.upstreamModel ?? '(default)'}`,
        `baseUrl=${resolved.baseUrl ?? '(default)'}`,
        nativeConfig.nativeUnsupportedReason ? `reason=${nativeConfig.nativeUnsupportedReason}` : ''
      ].filter(Boolean).join('\n'),
      suggestedAction: nativeConfig.canUseNative
        ? undefined
        : '切换到 Native runtime 支持的 provider/protocol（anthropic、openai-compatible、google、bedrock、vertex），并确认认证方式正确。'
    })
  ];

  if (provider && resolved.authStyle !== 'env_only' && !provider.hasStoredApiKey && !provider.apiKey.trim()) {
    findings.push(providerFinding(provider, {
      severity: 'error',
      code: 'provider_auth_missing',
      summary: 'Provider 缺少 API key/token。',
      suggestedAction: '在 Provider 设置中保存 API key/token，或切换为 env_only/auth_token 等正确认证方式。',
      recoveryActions: provider.providerMeta?.apiKeyUrl
        ? [{ label: '打开 API Key 页面', url: provider.providerMeta.apiKeyUrl }]
        : undefined
    }));
  }

  const defaultProviderMissing = state.aiSettings.defaultProviderId &&
    !state.providers.some((item) => item.id === state.aiSettings.defaultProviderId && item.enabled);
  if (defaultProviderMissing) {
    findings.push({
      severity: 'warn',
      code: 'provider_default_missing',
      summary: '默认 Provider 已不存在或已禁用。',
      suggestedAction: '重新选择默认 Provider，避免 runtime 解析到非预期配置。',
      recoveryActions: provider ? [{ label: '设为默认 Provider', command: 'providers:repair set-default-provider' }] : undefined
    });
  }

  if (provider && !resolved.model?.trim()) {
    findings.push(providerFinding(provider, {
      severity: 'error',
      code: 'provider_model_missing',
      summary: 'Provider 未配置模型。',
      suggestedAction: '在 Provider 设置中填写模型 ID；如使用别名，请同时配置 upstream model。'
    }));
  }

  const providerMarker = `${provider?.id ?? ''} ${provider?.name ?? ''} ${provider?.baseUrl ?? ''}`.toLowerCase();
  const looksOfficialAnthropic = providerMarker.includes('api.anthropic.com') || providerMarker.trim() === 'anthropic anthropic';
  if (provider && provider.protocol === 'anthropic' && resolved.authStyle !== 'env_only' && !resolved.baseUrl && !looksOfficialAnthropic) {
    findings.push(providerFinding(provider, {
      severity: 'warn',
      code: 'provider_anthropic_proxy_base_url_missing',
      summary: 'Anthropic-compatible 第三方 Provider 没有 base URL。',
      suggestedAction: '如果这不是官方 Anthropic，请填写代理服务商的 Anthropic API base URL。'
    }));
  }

  if (provider && resolved.authStyle === 'custom_header' && Object.keys(resolved.headers).length === 0) {
    findings.push(providerFinding(provider, {
      severity: 'error',
      code: 'provider_custom_header_missing',
      summary: 'Provider 使用 custom_header，但没有配置 headers。',
      suggestedAction: '添加服务商要求的 Authorization/x-api-key 等 header，或切换为 api_key/auth_token。'
    }));
  }

  return createProbe('provider', 'Provider/model', startedAt, findings);
}

function buildAuthProbe(provider?: AiProvider): RuntimeDoctorProbe {
  const startedAt = Date.now();
  const resolved = resolveProviderForRuntime({ explicitProvider: provider });
  const findings: RuntimeDoctorFinding[] = [];

  if (!provider) {
    findings.push({
      severity: 'warn',
      code: 'auth_provider_missing',
      summary: '未配置可用的 AI Provider。',
      suggestedAction: '在 Provider 设置中添加并启用一个 Provider，Native runtime 需要数据库内的 Provider 配置。',
      runtimeId: 'native'
    });
    return createProbe('auth', 'Auth source', startedAt, findings);
  }

  const hasSecret = Boolean(provider.apiKey.trim() || provider.hasStoredApiKey);
  if (resolved.authStyle === 'api_key' || resolved.authStyle === 'auth_token') {
    findings.push(providerFinding(provider, {
      severity: hasSecret ? 'ok' : 'error',
      code: hasSecret ? 'auth_secret_ready' : 'auth_secret_missing',
      summary: hasSecret
        ? `Provider 使用 ${resolved.authStyle}，secret 已配置。`
        : `Provider 使用 ${resolved.authStyle}，但没有 API key/token。`,
      suggestedAction: hasSecret
        ? undefined
        : '在 Provider 设置中保存 API key/token。'
    }));
  } else if (resolved.authStyle === 'custom_header') {
    findings.push(providerFinding(provider, {
      severity: Object.keys(resolved.headers).length > 0 ? 'ok' : 'error',
      code: Object.keys(resolved.headers).length > 0 ? 'auth_custom_header_ready' : 'auth_custom_header_missing',
      summary: Object.keys(resolved.headers).length > 0
        ? 'Provider 使用 custom_header，headers 已配置。'
        : 'Provider 使用 custom_header，但没有 headers。',
      suggestedAction: '确认 headers 中包含服务商要求的认证字段，诊断导出会自动隐藏敏感值。'
    }));
  } else {
    const envKeys = Object.keys(resolved.envOverrides).filter((key) => Boolean(resolved.envOverrides[key]));
    const credentialHints = [
      ...envKeys,
      ...['AWS_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION', 'ANTHROPIC_PROJECT_ID']
        .filter((key) => Boolean(process.env[key]))
    ];
    findings.push(providerFinding(provider, {
      severity: credentialHints.length > 0 ? 'ok' : 'warn',
      code: credentialHints.length > 0 ? 'auth_env_only_ready' : 'auth_env_only_unverified',
      summary: credentialHints.length > 0
        ? 'env_only Provider 检测到环境配置线索。'
        : 'env_only Provider 没有检测到明显环境认证线索。',
      detail: JSON.stringify({ envKeys: credentialHints }, null, 2),
      suggestedAction: credentialHints.length > 0
        ? undefined
        : '确认 AWS/Google 等所需环境变量或本机凭据已配置。'
    }));
  }

  return createProbe('auth', 'Auth source', startedAt, findings);
}

function buildFeatureProbe(provider?: AiProvider): RuntimeDoctorProbe {
  const startedAt = Date.now();
  const model = provider?.availableModels?.find((item) => item.modelId === provider.model || item.upstreamModelId === provider.upstreamModel);
  const capabilities = model?.capabilities;
  return createProbe('features', 'Runtime features', startedAt, [
    providerFinding(provider, {
      severity: 'ok',
      code: 'feature_matrix',
      summary: '已解析 runtime 特性矩阵。',
      detail: JSON.stringify({
        thinking: Boolean(capabilities?.reasoning ?? provider?.protocol === 'anthropic'),
        contextWindow: capabilities?.contextWindow ?? (provider?.model?.includes('opus-4-7') ? 1_000_000 : 200_000),
        context1m: Boolean((capabilities?.contextWindow ?? 0) >= 1_000_000 || provider?.model?.includes('opus-4-7')),
        vision: Boolean(capabilities?.vision ?? provider?.protocol === 'anthropic'),
        toolUse: Boolean(capabilities?.toolUse ?? true),
        mcp: true
      }, null, 2)
    })
  ]);
}

function buildNativeOpenAiCompatibleProbe(provider?: AiProvider): RuntimeDoctorProbe {
  const startedAt = Date.now();
  if (!provider || provider.protocol !== 'openai-compatible') {
    return createProbe('native-openai-compatible', 'Native OpenAI compatibility', startedAt, [
      providerFinding(provider, {
        severity: 'ok',
        code: 'native_openai_compat_probe_skipped',
        summary: '当前 Provider 不是 OpenAI-compatible，跳过 native 协议探针。',
        runtimeId: 'native'
      })
    ]);
  }

  const apiMode = inferOpenAiCompatibleApiMode(provider);
  const profile = resolveOpenAiCompatibleProviderProfile(provider);
  const apiModeSupported = apiMode === 'responses' ? profile.supportsResponses : profile.supportsChatCompletions;
  const findings: RuntimeDoctorFinding[] = [
    providerFinding(provider, {
      severity: apiModeSupported ? 'ok' : 'error',
      code: apiModeSupported ? 'native_api_mode_supported' : 'native_api_mode_unsupported',
      summary: apiModeSupported
        ? `Provider 支持当前 Native API mode：${apiMode}。`
        : `Provider 不支持当前 Native API mode：${apiMode}。`,
      detail: JSON.stringify({
        apiMode,
        supportsChatCompletions: profile.supportsChatCompletions,
        supportsResponses: profile.supportsResponses
      }, null, 2),
      suggestedAction: apiModeSupported
        ? undefined
        : apiMode === 'responses'
          ? '把 Provider API mode 切换为 Chat Completions，或选择支持 Responses API 的 Provider。'
          : '把 Provider API mode 切换为 Responses，或选择支持 Chat Completions 的 Provider。',
      runtimeId: 'native'
    }),
    providerFinding(provider, {
      severity: profile.streamingToolCalls ? 'ok' : 'error',
      code: profile.streamingToolCalls ? 'native_streaming_tools_supported' : 'native_streaming_tools_unsupported',
      summary: profile.streamingToolCalls
        ? 'Provider profile 声明支持流式工具调用。'
        : 'Provider profile 未声明支持流式工具调用。',
      suggestedAction: profile.streamingToolCalls
        ? undefined
        : 'Native runtime 已移除非流式 JSON fallback；请选择支持流式 tool calling 的模型或 Provider。',
      runtimeId: 'native'
    }),
    providerFinding(provider, {
      severity: 'ok',
      code: 'native_tool_choice_profile',
      summary: profile.omitToolChoice
        ? 'Provider profile 会省略 tool_choice 以兼容该服务商。'
        : `Provider profile 允许 tool_choice：${profile.toolChoiceModes.join(', ')}。`,
      detail: JSON.stringify({
        omitToolChoice: profile.omitToolChoice,
        toolChoiceModes: profile.toolChoiceModes,
        schemaTransform: profile.schemaTransform,
        reasoningRequestStyle: profile.reasoningRequestStyle,
        reasoningContent: profile.reasoningContent,
        interleavedReasoningField: profile.interleavedReasoningField
      }, null, 2),
      runtimeId: 'native'
    })
  ];

  if (apiMode === 'chat') {
    findings.push(providerFinding(provider, {
      severity: 'ok',
      code: 'native_chat_token_parameter',
      summary: `Chat Completions token 参数：${resolveOpenAiCompatibleChatTokenParameter(provider)}。`,
      runtimeId: 'native'
    }));
  }

  if (provider.name.toLowerCase().includes('custom') || !provider.baseUrl.trim()) {
    findings.push(providerFinding(provider, {
      severity: provider.baseUrl.trim() ? 'warn' : 'error',
      code: provider.baseUrl.trim() ? 'native_custom_provider_needs_live_probe' : 'native_custom_provider_base_url_missing',
      summary: provider.baseUrl.trim()
        ? 'Custom OpenAI-compatible Provider 使用通用 profile，建议运行 live probe 验证。'
        : 'Custom OpenAI-compatible Provider 缺少 base URL。',
      suggestedAction: provider.baseUrl.trim()
        ? '用真实 key 运行 Provider doctor live probe，确认流式输出、tool calling 和 token 参数都可用。'
        : '填写服务商兼容 OpenAI 的 base URL，通常以 /v1 结尾。',
      runtimeId: 'native'
    }));
  }

  return createProbe('native-openai-compatible', 'Native OpenAI compatibility', startedAt, findings);
}

async function buildNetworkProbe(provider?: AiProvider, live?: boolean): Promise<RuntimeDoctorProbe> {
  const startedAt = Date.now();
  const resolved = resolveProviderForRuntime({ explicitProvider: provider });
  if (!provider || resolved.authStyle === 'env_only' || !resolved.baseUrl) {
    return createProbe('network', 'Network/provider', startedAt, [
      providerFinding(provider, {
        severity: 'ok',
        code: 'network_probe_skipped',
        summary: '该 Provider 不需要 base URL 网络探针，或当前未配置 base URL。'
      })
    ]);
  }

  let url: URL;
  try {
    url = new URL(resolved.baseUrl);
  } catch {
    return createProbe('network', 'Network/provider', startedAt, [
      providerFinding(provider, {
        severity: 'error',
        code: 'provider_base_url_invalid',
        summary: 'Provider base URL 不是合法 URL。',
        detail: resolved.baseUrl,
        suggestedAction: '检查 base URL，确保包含 https:// 或 http://。'
      })
    ]);
  }

  if (!live) {
    return createProbe('network', 'Network/provider', startedAt, [
      providerFinding(provider, {
        severity: 'ok',
        code: 'network_url_valid',
        summary: 'Provider base URL 格式有效；未开启 live 网络探针。',
        detail: url.origin
      })
    ]);
  }

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000)
    });
    const severity: RuntimeDoctorFinding['severity'] = response.status >= 500 || response.status === 429 ? 'warn' : 'ok';
    return createProbe('network', 'Network/provider', startedAt, [
      providerFinding(provider, {
        severity,
        code: response.status === 429 ? 'provider_rate_limit_or_overload' : 'network_provider_reachable',
        summary: `Provider endpoint 可达，HTTP ${response.status}。`,
        detail: JSON.stringify({
          url: url.origin,
          status: response.status,
          statusText: response.statusText
        }, null, 2),
        suggestedAction: response.status === 429
          ? '稍后重试，或检查服务商额度/限速。'
          : undefined
      })
    ]);
  } catch (error) {
    return createProbe('network', 'Network/provider', startedAt, [
      providerFinding(provider, {
        severity: 'warn',
        code: 'network_provider_unreachable',
        summary: 'Provider endpoint 网络探针失败。',
        detail: error instanceof Error ? redactNativeRuntimeErrorDetail(error.message, provider) : undefined,
        suggestedAction: '检查网络、代理、base URL 或服务商状态页。',
        recoveryActions: provider.providerMeta?.statusPageUrl
          ? [{ label: '打开服务商状态页', url: provider.providerMeta.statusPageUrl }]
          : undefined
      })
    ]);
  }
}

function buildContextProbe(state: AppState, options: RuntimeDoctorOptions): RuntimeDoctorProbe {
  const startedAt = Date.now();
  const project = options.projectId ? state.projects.find((item) => item.id === options.projectId) : undefined;
  if (!project) {
    return createProbe('context-session', 'Context/session', startedAt, [
      {
        severity: 'ok',
        code: 'context_no_project',
        summary: '未指定项目，跳过 session/context 检查。'
      }
    ]);
  }
  const ensured = ensureProjectSessions(project);
  const session = getActiveProjectSession(ensured);
  const coverage = session.runtimeOverrides?.nativeContextSummaryCoverage;
  const findings: RuntimeDoctorFinding[] = [
    {
      severity: 'ok',
      code: 'context_boundary_state',
      summary: '已读取 Native context handoff 状态。',
      detail: JSON.stringify({
        sessionId: session.id,
        nativeContextSummary: session.runtimeOverrides?.nativeContextSummary ? '[present]' : undefined,
        boundaryRowId: coverage?.boundaryRowId,
        boundaryOrdinal: coverage?.boundaryOrdinal,
        turnCount: coverage?.turnCount,
        strategy: coverage?.strategy
      }, null, 2),
      runtimeId: 'native'
    }
  ];
  return createProbe('context-session', 'Context/session', startedAt, findings);
}

async function buildLiveProbe(provider?: AiProvider, live?: boolean): Promise<RuntimeDoctorProbe> {
  const startedAt = Date.now();
  if (!provider || !live) {
    return createProbe('live-native', 'Live native probe', startedAt, [
      providerFinding(provider, {
        severity: 'ok',
        code: 'live_probe_skipped',
        summary: 'Live native probe 未开启。',
        suggestedAction: '需要真实连通性验证时，从诊断面板重新运行 live probe。'
      })
    ]);
  }

  try {
    const text = await testProviderConnection(provider);
    return createProbe('live-native', 'Live native probe', startedAt, [
      providerFinding(provider, {
        severity: 'ok',
        code: 'live_native_ok',
        summary: 'Native provider live probe 成功。',
        detail: JSON.stringify({
          responsePreview: text.slice(0, 200),
          model: provider.upstreamModel || provider.model,
          baseUrl: provider.baseUrl || '(default)',
          durationMs: Date.now() - startedAt
        }, null, 2)
      })
    ]);
  } catch (error) {
    const diagnostic = classifyNativeRuntimeError({ error, provider });
    lastRuntimeDiagnosis = {
      generatedAt: nowIso(),
      providerId: provider?.id,
      code: diagnostic.code,
      summary: diagnostic.summary,
      suggestedAction: diagnostic.suggestedAction,
      detail: error instanceof Error ? redactNativeRuntimeErrorDetail(error.message, provider) : undefined
    };
    return createProbe('live-native', 'Live native probe', startedAt, [
      providerFinding(provider, {
        severity: 'error',
        code: diagnostic.code,
        summary: diagnostic.summary,
        detail: error instanceof Error ? redactNativeRuntimeErrorDetail(error.message, provider) : undefined,
        suggestedAction: diagnostic.suggestedAction,
        recoveryActions: diagnostic.recoveryActions
      })
    ]);
  }
}

function collectRepairs(provider?: AiProvider): RuntimeRepairAction[] {
  const repairs: RuntimeRepairAction[] = [];
  if (provider) {
    repairs.push({
      id: 'set-default-provider',
      label: '设为默认 Provider',
      description: '把该 Provider 设为全局默认 provider。',
      addresses: ['provider_runtime_resolved', 'provider_auth_missing'],
      params: { providerId: provider.id }
    });
    repairs.push({
      id: 'switch-auth-style-api-key',
      label: '切换为 API key',
      description: '把 provider authStyle 设置为 api_key。',
      addresses: ['native_auth_style_mismatch', 'provider_auth_missing'],
      params: { providerId: provider.id, authStyle: 'api_key' }
    });
    repairs.push({
      id: 'switch-auth-style-auth-token',
      label: '切换为 auth token',
      description: '把 provider authStyle 设置为 auth_token。',
      addresses: ['native_auth_style_mismatch'],
      params: { providerId: provider.id, authStyle: 'auth_token' }
    });
  }
  return repairs;
}

export async function runRuntimeDoctor(state: AppState, options: RuntimeDoctorOptions = {}): Promise<RuntimeDoctorResult> {
  const startedAt = Date.now();
  const provider = resolveDoctorProvider(state, options);
  const probes = [
    buildProviderProbe(state, options, provider),
    buildAuthProbe(provider),
    buildFeatureProbe(provider),
    buildNativeOpenAiCompatibleProbe(provider),
    buildContextProbe(state, options),
    await buildNetworkProbe(provider, options.live),
    await buildLiveProbe(provider, options.live)
  ];
  const allFindings = probes.flatMap((probe) => probe.findings);
  return {
    overallSeverity: maxSeverity(allFindings),
    probes,
    repairs: collectRepairs(provider),
    generatedAt: nowIso(),
    durationMs: Date.now() - startedAt,
    providerId: provider?.id,
    runtimeId: 'native'
  };
}

export function repairRuntimeDoctor(state: AppState, input: RuntimeRepairInput): { success: true; stateChanged: boolean } {
  switch (input.actionId) {
    case 'set-default-provider': {
      const providerId = input.providerId?.trim();
      const provider = providerId ? state.providers.find((item) => item.id === providerId && item.enabled) : undefined;
      if (!provider) {
        throw new Error('Provider not found or disabled.');
      }
      state.aiSettings.defaultProviderId = provider.id;
      state.providers = state.providers.map((item) => ({
        ...item,
        isDefault: item.id === provider.id,
        updatedAt: item.id === provider.id ? nowIso() : item.updatedAt
      }));
      return { success: true, stateChanged: true };
    }
    case 'switch-auth-style-api-key':
    case 'switch-auth-style-auth-token':
    case 'switch-auth-style': {
      const providerId = input.providerId?.trim();
      const authStyle = input.authStyle ?? (input.actionId === 'switch-auth-style-auth-token' ? 'auth_token' : 'api_key');
      const index = providerId ? state.providers.findIndex((item) => item.id === providerId) : -1;
      if (index < 0) {
        throw new Error('Provider not found.');
      }
      state.providers[index] = {
        ...state.providers[index],
        authStyle,
        updatedAt: nowIso()
      };
      return { success: true, stateChanged: true };
    }
    default:
      return { success: true, stateChanged: false };
  }
}

export async function exportRuntimeDiagnostics(state: AppState, options: RuntimeDoctorOptions = {}): Promise<string> {
  const doctor = await runRuntimeDoctor(state, options);
  return JSON.stringify({
    doctor,
    providers: state.providers.map((provider) => sanitizeProviderForRenderer(provider)),
    aiSettings: state.aiSettings,
    agentSettings: state.agentSettings,
    lastRuntimeDiagnosis,
    exportedAt: nowIso()
  }, null, 2);
}
