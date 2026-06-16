import type { AiProvider, RuntimeDoctorFinding, RuntimeDoctorResult } from '../../../shared/types';
import { localize, type UiLanguage } from '../../i18n';

export interface ProviderRepairGuidance {
  key: string;
  severity: RuntimeDoctorFinding['severity'];
  title: string;
  detail: string;
  action: string;
}

export function buildProviderRepairGuidance(result: RuntimeDoctorResult | null, provider: AiProvider, language: UiLanguage): ProviderRepairGuidance[] {
  if (!result) {
    return [];
  }

  const items = new Map<string, ProviderRepairGuidance>();
  for (const finding of result.probes.flatMap((probe) => probe.findings)) {
    if (finding.severity === 'ok') {
      continue;
    }
    const guidance = mapProviderFindingToGuidance(finding, provider, language);
    const existing = items.get(guidance.key);
    if (!existing || severityRank(guidance.severity) > severityRank(existing.severity)) {
      items.set(guidance.key, guidance);
    }
  }

  return [...items.values()]
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, 4);
}

function severityRank(severity: RuntimeDoctorFinding['severity']): number {
  if (severity === 'error') return 2;
  if (severity === 'warn') return 1;
  return 0;
}

function mapProviderFindingToGuidance(finding: RuntimeDoctorFinding, provider: AiProvider, language: UiLanguage): ProviderRepairGuidance {
  const code = finding.code;
  if ([
    'provider_auth_missing',
    'native_auth_failed',
    'native_auth_style_mismatch',
    'provider_custom_header_missing',
    'auth_ambiguous_env'
  ].includes(code)) {
    return {
      key: 'auth',
      severity: finding.severity,
      title: localize(language, '补全认证配置', 'Fix Authentication'),
      detail: localize(language, `${provider.name} 需要有效 API Key、Token 或正确的认证方式。`, `${provider.name} needs a valid API key, token, or matching auth style.`),
      action: finding.suggestedAction ?? localize(language, '在 Provider 设置中保存密钥后重新诊断。', 'Save credentials in Provider settings, then run doctor again.')
    };
  }
  if ([
    'native_api_mode_unsupported',
    'native_provider_api_mode_unsupported',
    'native_empty_response'
  ].includes(code)) {
    return {
      key: 'api-mode',
      severity: finding.severity,
      title: localize(language, '切换 API Mode', 'Switch API Mode'),
      detail: localize(language, 'OpenAI 官方优先 Responses；多数国内兼容通道优先 Chat Completions。', 'Official OpenAI usually prefers Responses; most domestic compatible gateways prefer Chat Completions.'),
      action: finding.suggestedAction ?? localize(language, '切换 Chat Completions / Responses 后重试。', 'Switch Chat Completions / Responses, then retry.')
    };
  }
  if (['provider_model_missing', 'native_model_invalid'].includes(code)) {
    return {
      key: 'model',
      severity: finding.severity,
      title: localize(language, '校正模型 ID', 'Fix Model ID'),
      detail: localize(language, `当前模型：${provider.model || '未配置'}`, `Current model: ${provider.model || 'not configured'}`),
      action: finding.suggestedAction ?? localize(language, '填写服务商真实支持的 model 或 upstreamModel。', 'Use a model or upstreamModel actually supported by the provider.')
    };
  }
  if ([
    'provider_base_url_invalid',
    'native_base_url_invalid',
    'network_provider_unreachable',
    'native_network_error'
  ].includes(code)) {
    return {
      key: 'network',
      severity: finding.severity,
      title: localize(language, '检查 Base URL 与网络', 'Check Base URL And Network'),
      detail: localize(language, `当前地址：${provider.baseUrl || '未配置'}`, `Current URL: ${provider.baseUrl || 'not configured'}`),
      action: finding.suggestedAction ?? localize(language, '确认 URL 包含 /v1 等服务商要求路径，并检查代理或服务商状态。', 'Confirm the URL includes required paths such as /v1, then check proxy or provider status.')
    };
  }
  if ([
    'native_tool_schema_invalid',
    'native_malformed_tool_arguments',
    'native_tool_loop_failed'
  ].includes(code)) {
    return {
      key: 'tools',
      severity: finding.severity,
      title: localize(language, '调整工具调用兼容性', 'Adjust Tool-Calling Compatibility'),
      detail: localize(language, '模型或通道没有稳定接受当前工具 schema。', 'The model or gateway is not reliably accepting the current tool schema.'),
      action: finding.suggestedAction ?? localize(language, '优先使用已验证 Provider 预设，或切换工具调用更稳定的模型。', 'Prefer a verified provider preset, or switch to a model with more stable tool calling.')
    };
  }
  if (['native_rate_limited', 'native_overloaded', 'provider_rate_limit_or_overload'].includes(code)) {
    return {
      key: 'capacity',
      severity: finding.severity,
      title: localize(language, '检查额度与限速', 'Check Quota And Rate Limits'),
      detail: localize(language, '服务商返回限速、过载或额度相关信号。', 'The provider returned rate-limit, overload, or quota signals.'),
      action: finding.suggestedAction ?? localize(language, '稍后重试，或检查服务商控制台额度。', 'Retry later, or check quota in the provider console.')
    };
  }
  if (code === 'provider_default_missing') {
    return {
      key: 'default-provider',
      severity: finding.severity,
      title: localize(language, '设置默认 Provider', 'Set Default Provider'),
      detail: localize(language, '当前默认 Provider 不可用或已停用。', 'The current default provider is unavailable or disabled.'),
      action: finding.suggestedAction ?? localize(language, '选择一个启用的 Provider 作为默认。', 'Choose an enabled provider as default.')
    };
  }
  return {
    key: code,
    severity: finding.severity,
    title: finding.summary,
    detail: finding.detail?.split('\n')[0] ?? code,
    action: finding.suggestedAction ?? localize(language, '根据诊断详情修复后重新运行诊断。', 'Fix according to the diagnostic details, then run doctor again.')
  };
}
