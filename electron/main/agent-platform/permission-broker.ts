import type { GenericAgentRuntimeParams } from './types';
import type { AgentToolDefinition, AgentToolRisk } from './tool-registry';
import type { AgentPermissionImpact, AgentPermissionRule } from '../../../shared/types';
import { toProjectRelativePermissionPath } from './permission-session-store';
import { describeRunCommandSandboxStatus } from './system-shell';

export type AgentToolPermissionDecision = 'allow' | 'deny';

export interface AgentPermissionContext {
  permission: GenericAgentRuntimeParams['permission'];
  requestPermission?: GenericAgentRuntimeParams['requestPermission'];
}

export interface AgentToolPermissionSubject {
  name: string;
  title: string;
  risk: AgentToolRisk;
  readOnly: boolean;
  permissionPolicy: AgentToolDefinition['permissionPolicy'];
  checkpointPolicy: AgentToolDefinition['checkpointPolicy'];
}

export interface AgentToolPermissionRequest {
  tool: AgentToolPermissionSubject;
  input?: Record<string, unknown>;
  title?: string;
  detail?: string;
  risk?: AgentToolRisk;
  mcp?: NonNullable<AgentPermissionImpact['mcp']>;
}

function normalizeCommandForRuleMatch(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function commandPrefixMatches(commands: string[] | undefined, prefix: string): boolean {
  if (!commands?.length) {
    return false;
  }
  const normalizedPrefix = normalizeCommandForRuleMatch(prefix);
  return commands.some((command) => {
    const normalized = normalizeCommandForRuleMatch(command);
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix} `);
  });
}

/** Minimal glob: '**' crosses directory separators, '*' stays within one segment. */
export function matchesPermissionPathGlob(path: string, glob: string): boolean {
  const crossSegment = '\u0001';
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, crossSegment)
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

function pathGlobMatches(paths: string[] | undefined, glob: string, projectPath?: string): boolean {
  if (!paths?.length) {
    return false;
  }
  return paths.every((path) => matchesPermissionPathGlob(toProjectRelativePermissionPath(path, projectPath), glob));
}

function ruleMatches(
  rule: AgentPermissionRule,
  toolName: string,
  impact: AgentPermissionImpact,
  projectPath?: string
): boolean {
  if (rule.toolName !== '*' && rule.toolName !== toolName) {
    return false;
  }
  if (rule.commandPrefix && !commandPrefixMatches(impact.commands, rule.commandPrefix)) {
    return false;
  }
  if (rule.pathGlob && !pathGlobMatches(impact.paths, rule.pathGlob, projectPath)) {
    return false;
  }
  return true;
}

/** Deny wins over allow; 'ask' rules never short-circuit (they fall through to the prompt). */
export function evaluatePermissionRules(
  rules: AgentPermissionRule[] | undefined,
  toolName: string,
  impact: AgentPermissionImpact,
  projectPath?: string
): 'allow' | 'deny' | undefined {
  if (!rules?.length) {
    return undefined;
  }
  let allowed = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, toolName, impact, projectPath)) {
      continue;
    }
    if (rule.action === 'deny') {
      return 'deny';
    }
    if (rule.action === 'allow') {
      allowed = true;
    }
  }
  return allowed ? 'allow' : undefined;
}

function isToolPreApproved(context: AgentPermissionContext, toolName: string, mcpPermissionKey?: string): boolean {
  const allowedTools = context.permission.allowedWriteTools ?? [];
  const allowedMcpTools = context.permission.allowedMcpTools ?? [];
  return (
    context.permission.allowWriteTools ||
    allowedTools.includes('*') ||
    allowedTools.includes(toolName) ||
    Boolean(mcpPermissionKey && (allowedMcpTools.includes('*') || allowedMcpTools.includes(mcpPermissionKey))) ||
    (context.permission.allowSessionWriteTools && allowedTools.length === 0)
  );
}

const PLAN_CONFIRMABLE_TOOL_NAMES = new Set([
  'run_command',
  'terminal_start',
  'terminal_write',
  'terminal_stop',
  'browser_open',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_close'
]);

function formatPermissionDetail(request: AgentToolPermissionRequest): string {
  const impact = buildPermissionImpact(request);
  return request.detail ??
    [
      `工具：${request.tool.name}`,
      `权限策略：${request.tool.permissionPolicy}`,
      `检查点策略：${request.tool.checkpointPolicy}`,
      impact.paths?.length ? `路径：${impact.paths.join(' · ')}` : '',
      impact.commands?.length ? `命令：${impact.commands.join(' · ')}` : '',
      request.tool.name === 'run_command' ? `沙箱：${describeRunCommandSandboxStatus(request.input?.unsandboxed === true)}` : '',
      impact.mcp?.pluginName || impact.mcp?.pluginId ? `MCP Server：${impact.mcp.pluginName ?? impact.mcp.pluginId}` : '',
      impact.mcp?.toolName ? `MCP Tool：${impact.mcp.toolName}` : '',
      impact.mcp?.permission ? `MCP 策略：${impact.mcp.permission}/${impact.mcp.risk ?? 'infer'}` : '',
      impact.cwd ? `目录：${impact.cwd}` : '',
      impact.reason ? `原因：${impact.reason}` : '',
      impact.inputSummary?.length ? `输入摘要：${impact.inputSummary.join('；')}` : '',
      '允许后，本轮才会执行该写入型或高风险工具。'
    ].filter(Boolean).join('\n');
}

const LARGE_INPUT_KEYS = new Set([
  'content',
  'data',
  'base64',
  'patch',
  'oldText',
  'newText',
  'edits',
  'input'
]);

function readInputString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function collectInputStrings(input: Record<string, unknown> | undefined, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) {
      values.push(value.trim());
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          values.push(item.trim());
        } else if (item && typeof item === 'object') {
          const path = readInputString(item as Record<string, unknown>, 'path') ??
            readInputString(item as Record<string, unknown>, 'filePath');
          if (path) {
            values.push(path);
          }
        }
      }
    }
  }
  return [...new Set(values)].slice(0, 8);
}

function formatInputSummaryValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} items`;
  }
  if (value && typeof value === 'object') {
    return `${Object.keys(value as Record<string, unknown>).length} fields`;
  }
  return '';
}

function buildPermissionImpact(request: AgentToolPermissionRequest): AgentPermissionImpact {
  const input = request.input;
  const commands = collectInputStrings(input, ['command']).slice(0, 3);
  const paths = collectInputStrings(input, [
    'path',
    'filePath',
    'targetPath',
    'sourcePath',
    'directory',
    'paths',
    'files'
  ]);
  const inputSummary = Object.entries(input ?? {})
    .filter(([key, value]) => !LARGE_INPUT_KEYS.has(key) && value !== undefined && value !== null)
    .slice(0, 8)
    .map(([key, value]) => {
      const summary = formatInputSummaryValue(value);
      return summary ? `${key}: ${summary}` : '';
    })
    .filter(Boolean);

  return {
    toolName: request.tool.name,
    toolTitle: request.tool.title,
    permissionPolicy: request.tool.permissionPolicy,
    checkpointPolicy: request.tool.checkpointPolicy,
    readOnly: request.tool.readOnly,
    mcp: request.mcp,
    cwd: readInputString(input, 'cwd'),
    paths,
    commands,
    reason: readInputString(input, 'reason') ?? readInputString(input, 'decisionReason'),
    inputSummary
  };
}

export async function resolveAgentToolPermission(
  context: AgentPermissionContext | undefined,
  request: AgentToolPermissionRequest
): Promise<AgentToolPermissionDecision> {
  if (request.tool.permissionPolicy === 'always' || (request.tool.readOnly && request.tool.permissionPolicy !== 'ask')) {
    return 'allow';
  }

  if (!context) {
    return 'deny';
  }

  const ruleVerdict = evaluatePermissionRules(
    context.permission.rules,
    request.tool.name,
    buildPermissionImpact(request),
    context.permission.projectPath
  );
  if (ruleVerdict === 'deny') {
    return 'deny';
  }

  if (context.permission.mode === 'read-only' && !PLAN_CONFIRMABLE_TOOL_NAMES.has(request.tool.name)) {
    return 'deny';
  }

  if (context.permission.mode === 'read-only' && !context.requestPermission) {
    return 'deny';
  }

  if (context.permission.mode === 'read-only') {
    const decision = await context.requestPermission?.({
      title: request.title ?? `允许 Agent 执行工具：${request.tool.title}？`,
      detail: formatPermissionDetail(request),
      risk: request.risk ?? request.tool.risk,
      toolName: request.tool.name,
      impact: buildPermissionImpact(request)
    });

    return decision === 'allow' || decision === 'allow_session' ? 'allow' : 'deny';
  }

  if (ruleVerdict === 'allow') {
    return 'allow';
  }

  if (isToolPreApproved(context, request.tool.name, request.mcp?.permissionKey)) {
    return 'allow';
  }

  if (!context.requestPermission) {
    return 'deny';
  }

  const decision = await context.requestPermission({
    title: request.title ?? `允许 Agent 执行工具：${request.tool.title}？`,
    detail: formatPermissionDetail(request),
    risk: request.risk ?? request.tool.risk,
    toolName: request.tool.name,
    impact: buildPermissionImpact(request)
  });

  return decision === 'allow' || decision === 'allow_session' ? 'allow' : 'deny';
}
