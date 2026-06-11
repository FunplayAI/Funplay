import { inferOpenAiCompatibleApiMode } from '../../../../shared/provider-catalog';
import type { AiProvider, ProjectSessionRuntimeId, RuntimeDiagnosticSeverity, RuntimeRecoveryAction } from '../../../../shared/types';

export type NativeRuntimeDiagnosticCode =
  | 'native_missing_provider'
  | 'native_auth_failed'
  | 'native_auth_style_mismatch'
  | 'native_base_url_invalid'
  | 'native_model_invalid'
  | 'native_context_too_long'
  | 'native_rate_limited'
  | 'native_overloaded'
  | 'native_network_error'
  | 'native_provider_timeout'
  | 'native_empty_response'
  | 'native_provider_api_mode_unsupported'
  | 'native_tool_schema_invalid'
  | 'native_malformed_tool_arguments'
  | 'native_tool_loop_failed'
  | 'native_permission_rejected'
  | 'native_provider_unsupported';

export interface NativeRuntimeDiagnostic {
  code: NativeRuntimeDiagnosticCode;
  severity: RuntimeDiagnosticSeverity;
  summary: string;
  detail?: string;
  suggestedAction: string;
  recoveryActions?: RuntimeRecoveryAction[];
  providerId?: string;
  protocol?: AiProvider['protocol'];
  baseUrl?: string;
  model?: string;
  upstreamModel?: string;
  runtimeId: ProjectSessionRuntimeId;
}

function trimDetail(value: string, maxLength = 6000): string {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyErrorField(value: unknown): string | undefined {
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

function readErrorField(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] != null) {
      return record[key];
    }
  }
  return undefined;
}

export function redactNativeRuntimeErrorDetail(raw: string, provider?: AiProvider): string {
  let safe = raw;
  const secrets = [
    provider?.apiKey,
    ...Object.values(provider?.headers ?? {}),
    ...Object.values(provider?.envOverrides ?? {}),
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.OPENAI_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_VERTEX_API_KEY,
    process.env.AWS_SECRET_ACCESS_KEY,
    process.env.AWS_SESSION_TOKEN,
    process.env.AWS_BEARER_TOKEN_BEDROCK
  ].filter((value): value is string => Boolean(value && value.length >= 6));
  for (const secret of secrets) {
    safe = safe.split(secret).join('[redacted]');
  }
  return safe
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'\\]+/gi, '$1[redacted]')
    .replace(/(x-api-key\s*[:=]\s*)[^\s"'\\]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|secret[_-]?access[_-]?key|session[_-]?token)\s*[:=]\s*)[^\s"'\\]+/gi, '$1[redacted]');
}

export function extractNativeRuntimeErrorDetail(error: unknown, provider?: AiProvider): string {
  const lines: string[] = [];
  const errorRecord = isRecord(error) ? error : undefined;
  const causeRecord = errorRecord && isRecord(errorRecord.cause) ? errorRecord.cause : undefined;

  if (provider) {
    lines.push(`Provider: ${provider.name}`);
    lines.push(`Model: ${provider.model}`);
    if (provider.upstreamModel?.trim()) {
      lines.push(`Upstream Model: ${provider.upstreamModel.trim()}`);
    }
    lines.push(`Protocol: ${provider.protocol}`);
    if (provider.protocol === 'openai-compatible') {
      lines.push(`API Mode: ${inferOpenAiCompatibleApiMode(provider)}`);
    }
  }

  const message =
    (error instanceof Error ? error.message : undefined) ||
    stringifyErrorField(readErrorField(errorRecord ?? {}, ['message', 'error', 'detail'])) ||
    'Unknown error';
  lines.push(`Message: ${message}`);

  const statusCode = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['statusCode', 'status', 'responseStatusCode']) ??
      readErrorField(causeRecord ?? {}, ['statusCode', 'status', 'responseStatusCode'])
  );
  if (statusCode) {
    lines.push(`Status: ${statusCode}`);
  }

  const errorCode = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['code', 'errorCode', 'type']) ??
      readErrorField(causeRecord ?? {}, ['code', 'errorCode', 'type'])
  );
  if (errorCode) {
    lines.push(`Code: ${errorCode}`);
  }

  const requestUrl = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['requestUrl', 'url']) ??
      readErrorField(causeRecord ?? {}, ['requestUrl', 'url'])
  );
  if (requestUrl) {
    lines.push(`Request URL: ${requestUrl}`);
  }

  const responseBody = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['responseBody', 'body', 'data', 'responseText']) ??
      readErrorField(causeRecord ?? {}, ['responseBody', 'body', 'data', 'responseText'])
  );
  if (responseBody !== undefined) {
    lines.push('Response Body:');
    lines.push(responseBody);
  }

  const causeMessage = stringifyErrorField(readErrorField(causeRecord ?? {}, ['message', 'error', 'detail']));
  if (causeMessage && causeMessage !== message) {
    lines.push(`Cause: ${causeMessage}`);
  }

  return redactNativeRuntimeErrorDetail(trimDetail(lines.join('\n')), provider);
}

function diagnosticBase(provider?: AiProvider): Pick<NativeRuntimeDiagnostic, 'providerId' | 'protocol' | 'baseUrl' | 'model' | 'upstreamModel' | 'runtimeId'> {
  return {
    providerId: provider?.id,
    protocol: provider?.protocol,
    baseUrl: provider?.baseUrl,
    model: provider?.model,
    upstreamModel: provider?.upstreamModel,
    runtimeId: 'native'
  };
}

export function classifyNativeRuntimeError(input: {
  error?: unknown;
  provider?: AiProvider;
  detail?: string;
}): NativeRuntimeDiagnostic {
  const raw = input.detail ?? extractNativeRuntimeErrorDetail(input.error, input.provider);
  const message = raw.toLowerCase();
  const base = diagnosticBase(input.provider);
  const withBase = (diagnostic: Omit<NativeRuntimeDiagnostic, keyof ReturnType<typeof diagnosticBase>>): NativeRuntimeDiagnostic => ({
    ...base,
    ...diagnostic,
    detail: raw
  });

  if (!input.provider) {
    return withBase({
      code: 'native_missing_provider',
      severity: 'error',
      summary: '当前没有可用的 AI Provider。',
      suggestedAction: '到应用设置里配置并测试一个 AI Provider 后重试。'
    });
  }
  if (/context.*(too|exceed|exceeded|long|length)|prompt.*too.*long|maximum context|input.*too.*large/.test(message)) {
    return withBase({
      code: 'native_context_too_long',
      severity: 'error',
      summary: 'Native runtime 输入超过当前模型上下文窗口。',
      suggestedAction: 'Funplay 会尝试压缩历史后重试一次；如果仍失败，请手动 /compact 或切换更大上下文模型。'
    });
  }
  if (/429|rate.?limit|too many requests/.test(message)) {
    return withBase({
      code: 'native_rate_limited',
      severity: 'warn',
      summary: 'Provider 返回限流错误。',
      suggestedAction: '稍后重试，或切换到额度更充足的 provider/model。'
    });
  }
  if (/overloaded|529|503|502|504|bad gateway|cloudflare|origin_bad_gateway|origin_unavailable|retryable|temporarily unavailable|capacity/.test(message)) {
    return withBase({
      code: 'native_overloaded',
      severity: 'warn',
      summary: 'Provider 当前过载或暂时不可用。',
      suggestedAction: '稍后重试，或临时切换 provider/model。'
    });
  }
  if (/nativeprovidersteptimeouterror|provider step timed out|timed out after \d+s|timeout/.test(message)) {
    return withBase({
      code: 'native_provider_timeout',
      severity: 'warn',
      summary: 'Provider 单轮响应超时。',
      suggestedAction: '长任务已经放宽到更长的单轮等待时间；如果仍触发，请让 Agent 先拆分任务并更频繁调用工具，或切换响应更稳定的 provider/model。'
    });
  }
  if (/(x-api-key|api key).*(bearer|authorization)|bearer.*(x-api-key|api key)|auth style|authentication style|oauth.*api key|custom_header/.test(message)) {
    return withBase({
      code: 'native_auth_style_mismatch',
      severity: 'error',
      summary: 'Provider 认证方式与当前 native client 配置不匹配。',
      suggestedAction: '检查 provider 的 authStyle，应在 API key、auth token、env-only 或 custom header 中选择服务商真实要求的方式。'
    });
  }
  if (/401|403|unauthorized|forbidden|invalid.*(api|key|token)|authentication|auth.*failed|permission denied/.test(message)) {
    return withBase({
      code: 'native_auth_failed',
      severity: 'error',
      summary: 'Provider 认证失败。',
      suggestedAction: '检查 API key/token、账号额度和 provider 的认证方式。',
      recoveryActions: input.provider.providerMeta?.apiKeyUrl
        ? [{ label: '打开 API key 页面', url: input.provider.providerMeta.apiKeyUrl }]
        : undefined
    });
  }
  if (/model.*(not found|invalid|unknown|unsupported)|invalid.*model|unknown model|model_not_found/.test(message)) {
    return withBase({
      code: 'native_model_invalid',
      severity: 'error',
      summary: 'Provider 模型名不可用。',
      suggestedAction: '检查 model/upstreamModel 是否是该服务商真实支持的模型 ID。'
    });
  }
  if (/does not support the openai-compatible responses api|does not support openai-compatible chat completions mode|unsupported api mode|switch this provider to (chat completions|responses)/.test(message)) {
    return withBase({
      code: 'native_provider_api_mode_unsupported',
      severity: 'error',
      summary: 'Provider 当前 API mode 与服务商能力不匹配。',
      suggestedAction: '在 Provider 设置中切换 Chat Completions/Responses mode，或选择支持该协议模式的 provider。'
    });
  }
  if (/tool arguments are not valid json|工具调用参数 json 无法解析|malformed tool arguments|invalid json.*tool|tool.*invalid json/.test(message)) {
    return withBase({
      code: 'native_malformed_tool_arguments',
      severity: 'warn',
      summary: '模型返回了无法解析的工具参数。',
      suggestedAction: 'Funplay 会把这次工具调用作为错误结果回放给模型，不执行副作用；如果频繁发生，请降低任务复杂度或切换工具调用更稳定的模型。'
    });
  }
  if (/tool_choice|tool schema|function schema|schema.*(invalid|unsupported)|parameters.*(invalid|unsupported|required)|tools.*(invalid|unsupported|required)/.test(message)) {
    return withBase({
      code: 'native_tool_schema_invalid',
      severity: 'error',
      summary: 'Provider 不接受当前工具 schema 或工具调用参数格式。',
      suggestedAction: '检查 provider profile 的 tool_choice、schema transform 和 token 参数配置；必要时切换到已验证的 provider preset。'
    });
  }
  if (/econnreset|etimedout|eai_again|und_err_socket|und_err_connect_timeout|socket disconnected|socket hang up|tls connection|other side closed|terminated/.test(message)) {
    return withBase({
      code: 'native_network_error',
      severity: 'warn',
      summary: 'Provider 网络连接临时中断。',
      suggestedAction: 'Funplay 已对连接中断做自动重试；如果仍失败，请检查本机网络、代理或稍后重试。'
    });
  }
  if (/base.?url|invalid url|unsupported protocol|enotfound|econnrefused|fetch failed|network|dns|404/.test(message)) {
    return withBase({
      code: 'native_base_url_invalid',
      severity: 'error',
      summary: 'Provider base URL 或网络连接不可用。',
      suggestedAction: '检查 base URL 是否带正确路径、网络代理是否可用，以及当前协议是否匹配服务商。'
    });
  }
  if (/empty_response|empty response|no text|没有返回最终文字|did not return/.test(message)) {
    return withBase({
      code: 'native_empty_response',
      severity: 'warn',
      summary: 'Provider 没有返回可显示的最终文本。',
      suggestedAction: '检查模型是否支持当前 API mode 的流式输出和 tool calling，或切换到已验证的模型/协议。'
    });
  }
  if (/permission|write_permission_denied|not allowed|denied/.test(message)) {
    return withBase({
      code: 'native_permission_rejected',
      severity: 'warn',
      summary: 'Native 工具调用被权限策略拒绝。',
      suggestedAction: '切换会话权限，或对本次工具请求选择允许后重试。'
    });
  }
  if (/unsupported provider|not supported by native|protocol .* only supported/.test(message)) {
    return withBase({
      code: 'native_provider_unsupported',
      severity: 'error',
      summary: '当前 provider/协议不被 native runtime 支持。',
      suggestedAction: '切换到 native runtime 支持的 provider 或协议（anthropic / openai-compatible / google / bedrock / vertex）。'
    });
  }
  if (/tool loop|tool-calling|tool calling|tool call/.test(message)) {
    return withBase({
      code: 'native_tool_loop_failed',
      severity: 'error',
      summary: 'Native tool loop 执行失败。',
      suggestedAction: '查看失败工具和 provider 兼容性；OpenAI-compatible provider 可改用 chat/responses 适配模式。'
    });
  }

  return withBase({
    code: 'native_network_error',
    severity: 'error',
    summary: 'Native runtime 执行失败。',
    suggestedAction: '检查 provider 配置、网络连接和模型工具调用兼容性。'
  });
}

export function summarizeNativeRuntimeDiagnostic(diagnostic: NativeRuntimeDiagnostic): string {
  return diagnostic.summary || diagnostic.detail?.split('\n')[0] || 'Native runtime 执行失败。';
}
