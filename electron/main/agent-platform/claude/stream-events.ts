import { existsSync, readFileSync, statSync } from 'node:fs';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatMediaBlock, AiProvider } from '../../../../shared/types';
import type { GenericAgentRuntimeParams } from '../types';
import type {
  ClaudeContentBlock,
  ClaudeAssistantEvent,
  ClaudeUserEvent,
  ClaudeStreamEvent,
  ClaudeResultEvent,
  ClaudeRuntimeDiagnostic,
  ClaudeRuntimeState
} from './types';
import { MEDIA_RESULT_MARKER } from './constants';

export function stripMediaMarker(content: string): { text: string; media: ChatMediaBlock[] } {
  const markerIndex = content.indexOf(MEDIA_RESULT_MARKER);
  if (markerIndex < 0) {
    return { text: content, media: [] };
  }

  const text = content.slice(0, markerIndex).trim();
  const payload = content.slice(markerIndex + MEDIA_RESULT_MARKER.length).trim();
  try {
    const parsed = JSON.parse(payload) as Array<{
      type?: string;
      mimeType?: string;
      localPath?: string;
      mediaId?: string;
      title?: string;
    }>;
    const media = Array.isArray(parsed)
      ? parsed
          .filter((item) => item && typeof item === 'object')
          .map((item): ChatMediaBlock => ({
            type: item.type === 'audio' ? 'audio' : item.type === 'file' ? 'file' : 'image',
            mimeType: item.mimeType,
            localPath: item.localPath,
            mediaId: item.mediaId,
            title: item.title,
            data: item.localPath ? readLocalMediaData(item.localPath) : undefined
          }))
      : [];
    return { text, media };
  } catch {
    return { text, media: [] };
  }
}

export function readLocalMediaData(localPath: string): string | undefined {
  try {
    if (!existsSync(localPath)) {
      return undefined;
    }
    const file = statSync(localPath);
    if (!file.isFile() || file.size > 12 * 1024 * 1024) {
      return undefined;
    }
    return readFileSync(localPath).toString('base64');
  } catch {
    return undefined;
  }
}

export function extractTextFromContent(content?: string | ClaudeContentBlock[]): string {
  if (!content) {
    return '';
  }

  if (typeof content === 'string') {
    return stripMediaMarker(content).text;
  }

  return content
    .map((block) => {
      if (block.type === 'text') {
        return block.text ? stripMediaMarker(block.text).text : '';
      }
      if (block.type === 'thinking') {
        return block.thinking ?? '';
      }
      return extractTextFromContent(block.content);
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function extractMediaFromContent(content?: string | ClaudeContentBlock[]): ChatMediaBlock[] {
  if (!content) {
    return [];
  }

  if (typeof content === 'string') {
    return stripMediaMarker(content).media;
  }

  const media: ChatMediaBlock[] = [];
  for (const block of content) {
    if ((block.type === 'image' || block.type === 'audio') && block.data) {
      media.push({
        type: block.type === 'audio' ? 'audio' : 'image',
        data: block.data,
        mimeType: block.mimeType || block.media_type || (block.type === 'audio' ? 'audio/wav' : 'image/png'),
        title: block.title
      });
    }

    if (block.type === 'image' && block.source) {
      const localPath = block.source.url && !/^https?:/i.test(block.source.url) ? block.source.url : undefined;
      media.push({
        type: 'image',
        data: block.source.data || (localPath ? readLocalMediaData(localPath) : undefined),
        localPath,
        mimeType: block.source.media_type || 'image/png',
        title: block.title
      });
    }

    if (block.localPath && (block.type === 'image' || block.type === 'audio' || block.type === 'file')) {
      media.push({
        type: block.type === 'audio' ? 'audio' : block.type === 'file' ? 'file' : 'image',
        localPath: block.localPath,
        mimeType: block.mimeType || block.media_type,
        mediaId: block.mediaId,
        title: block.title,
        data: readLocalMediaData(block.localPath)
      });
    }

    media.push(...extractMediaFromContent(block.content));
  }

  return media;
}

export function mergeIncrementalText(current: string, incoming: string): string {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }
  if (incoming === current) {
    return current;
  }
  if (incoming.startsWith(current)) {
    return incoming;
  }
  if (current.startsWith(incoming)) {
    return current;
  }
  if (current.endsWith(incoming)) {
    return current;
  }
  if (shouldReplaceWithCorrectedFullText(current, incoming)) {
    return incoming;
  }
  const trailingRevision = replaceTrailingRevision(current, incoming);
  if (trailingRevision) {
    return trailingRevision;
  }
  const overlapLength = findSuffixPrefixOverlap(current, incoming);
  if (overlapLength >= Math.min(80, Math.floor(incoming.length * 0.4))) {
    return `${current}${incoming.slice(overlapLength)}`;
  }
  return `${current}${incoming}`;
}

export function shouldReplaceWithCorrectedFullText(current: string, incoming: string): boolean {
  const minLength = Math.min(current.length, incoming.length);
  const maxLength = Math.max(current.length, incoming.length);
  if (minLength < 8) {
    return false;
  }

  const commonPrefixLength = getCommonPrefixLength(current, incoming);
  const relativePrefixThreshold = Math.floor(minLength * 0.6);
  const prefixThreshold = Math.min(160, Math.max(12, relativePrefixThreshold));
  if (commonPrefixLength < prefixThreshold) {
    return false;
  }

  const lengthDelta = Math.abs(current.length - incoming.length);
  return lengthDelta <= Math.max(240, Math.floor(maxLength * 0.35));
}

export function getCommonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[left.length - index - 1] === right[right.length - index - 1]) {
    index += 1;
  }
  return index;
}

export function normalizeStreamingComparableText(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[，。,.!?！？：:；;、（）()【】[\]`"'""'']/g, '')
    .replace(/^我(?=会|将|已经|已|先|现在|接下来|继续|主要|核心|开始|正在|准备|保持|保留|把|用|做|确认|处理|检查|看|读取|修改|补|完成)/, '');
}

export function isLikelyTrailingRevision(existingTail: string, incoming: string): boolean {
  const left = normalizeStreamingComparableText(existingTail);
  const right = normalizeStreamingComparableText(incoming);
  const minLength = Math.min(left.length, right.length);
  const maxLength = Math.max(left.length, right.length);
  if (minLength < 8) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (right.endsWith(left) && left.length / right.length >= 0.72) {
    return true;
  }
  if (left.endsWith(right) && right.length / left.length >= 0.82) {
    return true;
  }

  const commonPrefixLength = getCommonPrefixLength(left, right);
  const commonSuffixLength = getCommonSuffixLength(left, right);
  const coverage = (commonPrefixLength + commonSuffixLength) / maxLength;
  const lengthDelta = Math.abs(left.length - right.length);
  return coverage >= 0.86 && lengthDelta <= Math.max(12, Math.floor(maxLength * 0.18));
}

export function collectTrailingRevisionStarts(current: string, incomingLength: number): number[] {
  const starts = new Set<number>();
  const windowStart = Math.max(0, current.length - Math.max(1600, incomingLength * 2 + 64));
  if (current.length <= incomingLength + 64) {
    starts.add(0);
  }
  starts.add(Math.max(0, current.length - incomingLength - 16));
  starts.add(Math.max(0, current.length - incomingLength));

  for (let index = windowStart; index < current.length; index += 1) {
    const previous = current[index - 1];
    if (index === 0 || previous === '\n' || previous === '。' || previous === '！' || previous === '？' || previous === '!' || previous === '?') {
      starts.add(index);
    }
  }

  return [...starts]
    .filter((start) => start >= 0 && start < current.length)
    .sort((left, right) => right - left);
}

export function replaceTrailingRevision(current: string, incoming: string): string | undefined {
  const trimmedCurrent = current.trimEnd();
  const trailingWhitespace = current.slice(trimmedCurrent.length);
  const trimmedIncoming = incoming.trim();
  if (!trimmedCurrent || !trimmedIncoming) {
    return undefined;
  }

  for (const start of collectTrailingRevisionStarts(trimmedCurrent, trimmedIncoming.length)) {
    const existingTail = trimmedCurrent.slice(start).trimStart();
    if (isLikelyTrailingRevision(existingTail, trimmedIncoming)) {
      const leadingWhitespace = trimmedCurrent.slice(start).match(/^\s*/)?.[0] ?? '';
      return `${trimmedCurrent.slice(0, start)}${leadingWhitespace}${incoming}${trailingWhitespace}`;
    }
  }

  return undefined;
}

export function getCommonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

export function findSuffixPrefixOverlap(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let length = limit; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

export function normalizeToolInput(input: ClaudeContentBlock['input']): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      return parsed;
    } catch {
      return {
        raw: input
      };
    }
  }

  return input;
}

export function extractToolResultForCollector(block: ClaudeContentBlock): {
  content: string;
  media?: ChatMediaBlock[];
} {
  const resultContent = extractTextFromContent(block.content) || (block.is_error ? 'Tool execution failed.' : 'Tool execution completed.');
  const media = extractMediaFromContent(block.content);
  return {
    content: resultContent,
    media: media.length > 0 ? media : undefined
  };
}

export function applyToolResultBlock(
  block: ClaudeContentBlock,
  index: number,
  state: ClaudeRuntimeState,
  hooks: {
    onToolResult?: GenericAgentRuntimeParams['onToolResult'];
    onToolUse?: GenericAgentRuntimeParams['onToolUse'];
  }
): void {
  const toolUseId = block.tool_use_id ?? `claude_tool_result_${index}`;
  if (state.seenToolResults.has(toolUseId)) {
    return;
  }

  state.seenToolResults.add(toolUseId);
  const resultContent = extractTextFromContent(block.content) || (block.is_error ? 'Tool execution failed.' : 'Tool execution completed.');
  const media = extractMediaFromContent(block.content);
  const result: Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0] = {
    toolUseId,
    content: resultContent,
    isError: block.is_error
  };
  if (media.length > 0) {
    result.media = media;
  }
  hooks.onToolResult?.(result);
  hooks.onToolUse?.({
    toolUseId,
    name: state.toolNamesByUseId.get(toolUseId) ?? 'claude_tool',
    status: block.is_error ? 'failed' : 'completed'
  });
}

export function applyClaudeAssistantEvent(
  event: ClaudeAssistantEvent,
  state: ClaudeRuntimeState,
  hooks: {
    onTextDelta?: GenericAgentRuntimeParams['onTextDelta'];
    onThinkingDelta?: GenericAgentRuntimeParams['onThinkingDelta'];
    onToolUse?: GenericAgentRuntimeParams['onToolUse'];
    onToolResult?: GenericAgentRuntimeParams['onToolResult'];
  }
): void {
  const eventId = event.uuid ?? event.message?.id;
  if (eventId && state.seenAssistantEvents.has(eventId)) {
    return;
  }

  if (eventId) {
    state.seenAssistantEvents.add(eventId);
  }

  const blocks = event.message?.content ?? [];
  let nextText = state.text;
  let nextThinking = state.thinking;

  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text' && block.text) {
      nextText = mergeIncrementalText(nextText, block.text);
      continue;
    }

    if (block.type === 'thinking' && block.thinking) {
      nextThinking = mergeIncrementalText(nextThinking, block.thinking);
      continue;
    }

    if (block.type === 'tool_use') {
      const toolUseId = block.id ?? `claude_tool_${index}`;
      if (!state.seenToolUses.has(toolUseId)) {
        state.seenToolUses.add(toolUseId);
        const toolName = block.name ?? 'claude_tool';
        state.toolNamesByUseId.set(toolUseId, toolName);
        hooks.onToolUse?.({
          toolUseId,
          name: toolName,
          input: normalizeToolInput(block.input),
          status: 'running'
        });
      }
      continue;
    }

    if (block.type === 'tool_result') {
      applyToolResultBlock(block, index, state, hooks);
    }
  }

  if (nextThinking.length > state.thinking.length) {
    const delta = nextThinking.slice(state.thinking.length);
    hooks.onThinkingDelta?.(delta, nextThinking);
    state.thinking = nextThinking;
  }

  if (nextText !== state.text) {
    const delta = nextText.startsWith(state.text) ? nextText.slice(state.text.length) : nextText;
    hooks.onTextDelta?.(delta, nextText);
    state.text = nextText;
  }
}

export function applyClaudeUserEvent(
  event: ClaudeUserEvent,
  state: ClaudeRuntimeState,
  hooks: {
    onToolUse?: GenericAgentRuntimeParams['onToolUse'];
    onToolResult?: GenericAgentRuntimeParams['onToolResult'];
  }
): void {
  const content = event.message?.content;
  if (!Array.isArray(content)) {
    return;
  }

  for (const [index, block] of content.entries()) {
    if (block.type === 'tool_result') {
      applyToolResultBlock(block, index, state, hooks);
    }
  }
}

export function applyClaudeStreamEvent(
  event: ClaudeStreamEvent,
  state: ClaudeRuntimeState,
  hooks: {
    onTextDelta?: GenericAgentRuntimeParams['onTextDelta'];
    onThinkingDelta?: GenericAgentRuntimeParams['onThinkingDelta'];
  }
): void {
  const delta = event.event?.delta;
  if (event.event?.type !== 'content_block_delta' || !delta) {
    return;
  }

  if (delta.text) {
    const nextText = mergeIncrementalText(state.text, delta.text);
    if (nextText !== state.text) {
      const textDelta = nextText.startsWith(state.text) ? nextText.slice(state.text.length) : nextText;
      state.text = nextText;
      hooks.onTextDelta?.(textDelta, nextText);
    }
  }

  if (delta.thinking) {
    const nextThinking = mergeIncrementalText(state.thinking, delta.thinking);
    if (nextThinking.length > state.thinking.length) {
      const thinkingDelta = nextThinking.slice(state.thinking.length);
      state.thinking = nextThinking;
      hooks.onThinkingDelta?.(thinkingDelta, nextThinking);
    }
  }
}

export function sdkResultToClaudeResultEvent(message: SDKResultMessage): ClaudeResultEvent {
  const resultText = 'result' in message
    ? message.result
    : [
        message.subtype,
        Array.isArray(message.errors) ? message.errors.join('\n') : ''
      ].filter(Boolean).join('\n');

  return {
    type: 'result',
    subtype: message.subtype,
    result: resultText,
    is_error: message.is_error,
    session_id: message.session_id,
    terminal_reason: message.terminal_reason,
    usage: message.usage
  };
}

export function shouldRetryAsFreshClaudeSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(resume|session).*(not found|missing|invalid|corrupt|failed)|no conversation found/i.test(message);
}

export function isContextTooLongError(error: unknown, finalEvent?: ClaudeResultEvent): boolean {
  const message = [
    error instanceof Error ? error.message : String(error ?? ''),
    finalEvent?.subtype,
    finalEvent?.result
  ].filter(Boolean).join('\n');
  return /context.*(too|exceed|exceeded|long|length)|prompt.*too.*long|maximum context/i.test(message);
}

export function redactClaudeRuntimeErrorDetail(raw: string, provider?: AiProvider): string {
  let safe = raw;
  const secrets = [
    provider?.apiKey,
    ...Object.values(provider?.headers ?? {}),
    ...Object.values(provider?.envOverrides ?? {}),
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.CLAUDE_CODE_OAUTH_TOKEN
  ].filter((value): value is string => Boolean(value && value.length >= 6));
  for (const secret of secrets) {
    safe = safe.split(secret).join('[redacted]');
  }
  safe = safe
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'\\]+/gi, '$1[redacted]')
    .replace(/(x-api-key\s*[:=]\s*)[^\s"'\\]+/gi, '$1[redacted]')
    .replace(/((?:anthropic_api_key|anthropic_auth_token|claude_code_oauth_token|api_key|apikey)\s*[:=]\s*)[^\s"'\\]+/gi, '$1[redacted]');
  return safe;
}

export function classifyClaudeRuntimeError(input: {
  error?: unknown;
  finalEvent?: ClaudeResultEvent;
  stderr?: string;
  provider?: AiProvider;
}): ClaudeRuntimeDiagnostic {
  const raw = [
    input.error instanceof Error ? input.error.message : String(input.error ?? ''),
    input.finalEvent?.subtype,
    input.finalEvent?.terminal_reason,
    input.finalEvent?.result,
    input.stderr
  ].filter(Boolean).join('\n');
  const message = raw.toLowerCase();
  const redactedRaw = redactClaudeRuntimeErrorDetail(raw, input.provider);

  if (isContextTooLongError(input.error, input.finalEvent) || /prompt_too_long/.test(message)) {
    return {
      code: 'claude_context_too_long',
      summary: 'Claude Code runtime 报告上下文超过模型窗口。',
      suggestedAction: '已尝试压缩历史并重试；如果仍失败，请手动 /compact 或开启较大上下文模型。'
    };
  }
  if (shouldRetryAsFreshClaudeSession(input.error) || /stale session|resume session missing|no conversation found/.test(message)) {
    return {
      code: 'claude_stale_session',
      summary: 'Claude resume 会话已过期或本机会话文件不可用。',
      suggestedAction: '清空当前会话的 Claude resume session，并用 Funplay 摘要启动新 Claude 会话。'
    };
  }
  if (/rate.?limit|429|too many requests|overloaded|529/.test(message)) {
    return {
      code: 'claude_rate_limited',
      summary: 'Claude provider 返回限流或过载错误。',
      suggestedAction: '稍后重试，或切换到当前 provider 下额度更充足的模型。'
    };
  }
  if (/git bash|msys|mingw|bash\.exe/.test(message) && /(missing|not found|required|enoent|cannot find)/.test(message)) {
    return {
      code: 'claude_git_bash_missing',
      summary: 'Windows 环境缺少 Claude Code 需要的 Git Bash。',
      suggestedAction: '安装 Git for Windows，或设置 CLAUDE_CODE_GIT_BASH_PATH 指向 bash.exe。'
    };
  }
  if (/enoent|spawn .*claude|claude(?:_cli)?_missing|command not found|claude command not found|executable.*claude.*not found/.test(message)) {
    return {
      code: 'claude_cli_missing',
      summary: '本机未检测到可执行的 Claude Code CLI。',
      suggestedAction: '安装 Claude Code CLI，或通过 FUNPLAY_CLAUDE_CODE_CLI_PATH 指向可执行文件。',
      recoveryActions: [
        { label: '安装 Claude Code CLI', url: 'https://docs.anthropic.com/claude-code/setup' },
        { label: '指定 CLI 路径', command: 'FUNPLAY_CLAUDE_CODE_CLI_PATH=/absolute/path/to/claude' }
      ]
    };
  }
  if (/unknown option|unrecognized option|unsupported.*(version|option)|minimum.*version|upgrade.*claude|requires.*claude.*version|invalid.*flag/.test(message)) {
    return {
      code: 'claude_cli_version_unsupported',
      summary: '当前 Claude Code CLI 版本不支持 Funplay 使用的 SDK 参数。',
      suggestedAction: '升级 Claude Code CLI，并确认没有多个旧版本在 PATH 前面。'
    };
  }
  if (/multiple.*claude|version conflict|install conflict|using.*different.*claude|path.*precedence/.test(message)) {
    return {
      code: 'claude_cli_install_conflict',
      summary: '检测到多个 Claude Code 安装或 PATH 优先级冲突。',
      suggestedAction: '保留一个 Claude Code CLI，或用 FUNPLAY_CLAUDE_CODE_CLI_PATH 指向你希望 Funplay 使用的版本。'
    };
  }
  if (/tooltimeout|tool timeout|timed out|timeout/.test(message)) {
    return {
      code: 'claude_tool_timeout',
      summary: 'Claude 工具执行超过 Funplay 允许的时间。',
      suggestedAction: '拆小任务或增大 FUNPLAY_CLAUDE_TOOL_TIMEOUT_SECONDS 后重试。'
    };
  }
  if (/permission|denied|not allowed|bypass_permissions_disabled|write_permission_denied/.test(message)) {
    return {
      code: 'claude_permission_rejected',
      summary: 'Claude 工具调用被权限策略拒绝。',
      suggestedAction: '切换会话权限或对本次工具请求选择允许后重试。'
    };
  }
  if (/anthropic_auth_token|cc-switch|settings\.json|claude_config_dir|wrong endpoint|provider.*override/.test(message)) {
    return {
      code: 'claude_provider_env_polluted',
      summary: 'Claude 子进程疑似读取了不属于当前 provider 的本机配置。',
      suggestedAction: 'Funplay 会使用 shadow Claude home 隔离 provider；请检查 ~/.claude/settings.json 中的 env 覆盖项。'
    };
  }
  if (/(x-api-key|api key).*(bearer|authorization)|bearer.*(x-api-key|anthropic)|auth style|authentication style|oauth.*api key|api key.*oauth/.test(message)) {
    return {
      code: 'claude_auth_style_mismatch',
      summary: 'Claude provider 的认证方式和当前 runtime 期望不一致。',
      suggestedAction: '确认该 provider 使用 API key、auth token、env-only 或自定义 header 的哪一种认证，并在 provider 设置中切换到匹配的 authStyle。'
    };
  }
  if (/401|403|unauthorized|forbidden|invalid.*(api|key|token)|auth|login|required|x-api-key/.test(message)) {
    return {
      code: 'claude_auth_failed',
      summary: 'Claude provider 认证失败。',
      suggestedAction: '检查当前 provider 的 API key/token，确认没有被本机 Claude 配置覆盖。',
      recoveryActions: [
        { label: '检查 Anthropic API key', url: 'https://console.anthropic.com/settings/keys' }
      ]
    };
  }
  if (/unsupported.*(feature|thinking|vision|tool|mcp)|feature.*not.*supported|does not support/.test(message)) {
    return {
      code: 'claude_unsupported_feature',
      summary: '当前 provider 或模型不支持本轮启用的 Claude Runtime 特性。',
      suggestedAction: '关闭 thinking/context1m/vision 等高级选项，或切换到支持该特性的 Claude 模型。'
    };
  }
  if (/model.*(not found|invalid|unknown)|invalid.*model|unknown model|model_not_found/.test(message)) {
    return {
      code: 'claude_model_invalid',
      summary: 'Claude provider 的模型名不可用。',
      suggestedAction: `检查 provider=${input.provider?.name ?? 'unknown'} 的模型名；如使用代理，请确认 upstreamModel 是服务商真实模型 ID。`
    };
  }
  if (/base.?url|enotfound|econnrefused|fetch failed|bad_response_status_code|invalid url|unsupported protocol|404/.test(message)) {
    return {
      code: 'claude_base_url_invalid',
      summary: 'Claude provider 的 base URL 或网络连接不可用。',
      suggestedAction: `检查 provider=${input.provider?.name ?? 'unknown'} 的 base URL、网络代理和协议配置。`
    };
  }
  if (/provider.*invalid|protocol.*invalid/.test(message)) {
    return {
      code: 'claude_provider_invalid',
      summary: 'Claude provider 的 base URL 或模型配置不可用。',
      suggestedAction: `检查 provider=${input.provider?.name ?? 'unknown'} 的 base URL、模型名和协议配置。`
    };
  }
  if (/empty_response/.test(message)) {
    return {
      code: 'claude_empty_response',
      summary: 'Claude Code runtime 没有返回可显示内容。',
      suggestedAction: '查看运行阶段和 stderr，确认 provider、模型和工具调用是否正常完成。'
    };
  }

  return {
    code: 'claude_runtime_error',
    summary: redactedRaw.trim() || 'Claude Code runtime 执行失败。',
    suggestedAction: '查看 Claude runtime 阶段日志；若是 provider 问题，先运行 provider 连接测试。'
  };
}
