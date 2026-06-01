import type { AgentVerificationTrigger } from '../../../shared/types';
import type { WorkspaceToolAction, WorkspaceToolActionResult } from './workspace-tools';
import type {
  AgentToolDefinition,
  AgentToolLanguageFamily,
  AgentToolProtocolResult,
  AgentToolResultMappingContext,
  AgentToolSideEffectClassification
} from './tool-registry-core';
import { updateAgentToolDefinition } from './tool-registry-core';
import { inferMcpToolReadOnly } from './mcp-policy';

type ToolName = WorkspaceToolAction['type'];
type ToolInput = Record<string, unknown>;
type ProtocolKind = 'general' | 'command' | 'terminal' | 'edit' | 'mcp';

interface ToolContractSpec {
  label: string;
  activity: string;
  aliases?: string[];
  family?: AgentToolLanguageFamily;
  canonicalName?: string;
  usageHint?: string;
  failureHint?: string;
  resultHint?: string;
  protocolKind?: ProtocolKind;
  target?: (input: ToolInput | undefined) => string | undefined;
  classifier?: (input: ToolInput) => unknown;
  sideEffect?: (input: ToolInput | undefined) => AgentToolSideEffectClassification;
  isConcurrencySafe: (input: ToolInput | undefined) => boolean;
}

const COMMAND_RESULT_MAX_CHARS = 8_000;
const TERMINAL_RESULT_MAX_CHARS = 8_000;
const EDIT_RESULT_MAX_CHARS = 6_000;
const MCP_RESULT_MAX_CHARS = 9_000;
const CLASSIFIER_PREVIEW_CHARS = 640;

function asString(input: ToolInput | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(input: ToolInput | undefined, key: string): number | undefined {
  const value = input?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(input: ToolInput | undefined, key: string): boolean | undefined {
  const value = input?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value ?? {})?.length ?? 0;
  } catch {
    return 0;
  }
}

function compactText(value: string, maxChars: number, label: string): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = `\n\n[${label} truncated by Funplay: original ${value.length} chars]\n\n`;
  const tailChars = Math.min(1600, Math.floor(maxChars / 3));
  const headChars = Math.max(0, maxChars - marker.length - tailChars);
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
}

function previewText(value: string | undefined, maxChars = CLASSIFIER_PREVIEW_CHARS): {
  length: number;
  preview: string;
  truncated?: boolean;
} | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return {
    length: value.length,
    preview: value.length > maxChars ? value.slice(0, maxChars) : value,
    truncated: value.length > maxChars || undefined
  };
}

function compactClassifierValue(value: unknown, maxChars = CLASSIFIER_PREVIEW_CHARS): unknown {
  if (typeof value === 'string') {
    return previewText(value, maxChars);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      count: value.length,
      items: value.slice(0, 8).map((item) => compactClassifierValue(item, Math.floor(maxChars / 2)))
    };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 16);
    return Object.fromEntries(entries.map(([key, item]) => [key, compactClassifierValue(item, Math.floor(maxChars / 2))]));
  }
  return String(value);
}

function stringifyCompactValue(value: unknown, maxChars = 1200): string {
  let text: string;
  try {
    text = JSON.stringify(compactClassifierValue(value), null, 2);
  } catch {
    text = String(value);
  }
  return compactText(text, maxChars, 'tool permission detail');
}

function inferLanguageFamily(name: ToolName, spec: ToolContractSpec): AgentToolLanguageFamily {
  if (spec.family) {
    return spec.family;
  }
  if (spec.protocolKind === 'command') {
    return 'command';
  }
  if (spec.protocolKind === 'terminal') {
    return 'terminal';
  }
  if (spec.protocolKind === 'edit') {
    return name.startsWith('checkpoint_') ? 'checkpoint' : 'edit';
  }
  if (spec.protocolKind === 'mcp') {
    return 'mcp';
  }
  if (name.startsWith('browser_')) {
    return 'browser';
  }
  if (name.startsWith('web_')) {
    return 'web';
  }
  if (name.startsWith('funplay_memory_')) {
    return 'memory';
  }
  if (name.startsWith('funplay_')) {
    return 'notification';
  }
  if (name.includes('subagent')) {
    return 'subagent';
  }
  if (name.includes('engine')) {
    return 'engine';
  }
  if (name.includes('game')) {
    return 'game';
  }
  if (name.includes('search') || name.includes('find')) {
    return 'search';
  }
  if (name.includes('read') || name.includes('scan') || name.includes('list') || name.includes('summarize')) {
    return 'read';
  }
  return 'generic';
}

function genericClassifier(toolName: ToolName, input: ToolInput): unknown {
  return {
    tool: toolName,
    input: compactClassifierValue(input)
  };
}

function noSideEffect(): AgentToolSideEffectClassification {
  return {
    kind: 'none',
    confidence: 'none',
    evidence: []
  };
}

function activeSideEffect(kind: Exclude<AgentToolSideEffectClassification['kind'], 'none'>, trigger: AgentVerificationTrigger, evidence: string[]): AgentToolSideEffectClassification {
  return {
    kind,
    confidence: 'high',
    verificationTrigger: trigger,
    evidence
  };
}

function activeWriteSideEffect(toolName: ToolName, input: ToolInput | undefined): AgentToolSideEffectClassification {
  const target = targetFrom('path', 'fileName', 'title', 'jobId')(input);
  return activeSideEffect('workspace_write', 'active_write', [
    `tool:${toolName}`,
    target ? `target:${target}` : 'workspace_write_tool'
  ]);
}

function activeEngineSideEffect(toolName: ToolName, input: ToolInput | undefined): AgentToolSideEffectClassification {
  const target = targetFrom('platform', 'projectPath')(input);
  return activeSideEffect('engine', 'active_engine', [
    `tool:${toolName}`,
    target ? `target:${target}` : 'engine_side_effect_tool'
  ]);
}

function externalSideEffect(evidence: string[]): AgentToolSideEffectClassification {
  return {
    kind: 'external',
    confidence: 'medium',
    evidence
  };
}

function mcpSideEffect(input: ToolInput | undefined): AgentToolSideEffectClassification {
  const toolName = asString(input, 'toolName') ?? 'unknown';
  if (inferMcpToolReadOnly(toolName)) {
    return noSideEffect();
  }
  return externalSideEffect([
    'tool:mcp',
    `mcp:${toolName}`
  ]);
}

function classifyCommandWorkspaceMutation(command: string | undefined): {
  mutatesWorkspace: boolean;
  confidence: AgentToolSideEffectClassification['confidence'];
  reasons: string[];
} {
  const normalized = (command ?? '').trim();
  if (!normalized) {
    return {
      mutatesWorkspace: false,
      confidence: 'none',
      reasons: []
    };
  }

  const lower = normalized.toLowerCase();
  const checks: Array<[RegExp, string, 'raw' | 'lower']> = [
    [/(^|[^0-9])>>?\s*(?!&|\/dev\/null\b)\S/, 'stdout_redirection', 'lower'],
    [/\btee\s+(?:-a\s+)?(?:\.?\/)?[^\s|;&]+/, 'tee_file_write', 'lower'],
    [/\b(?:touch|mkdir|rm|rmdir|mv|cp)\b/, 'filesystem_command', 'lower'],
    [/\b(?:sed|perl)\b[^|;&]*\s-i(?:\s|$)/, 'in_place_edit', 'lower'],
    [/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|fs\.promises\.writeFile)\b/, 'node_file_write', 'raw'],
    [/\b(?:Path\([^)]*\)\.write_text|open\([^)]*,\s*['"][wa])/, 'python_file_write', 'raw'],
    [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|ci)\b/, 'package_dependency_write', 'lower'],
    [/\bgit\s+(?:apply|checkout|restore|reset|clean)\b/, 'git_worktree_mutation', 'lower']
  ];
  const reasons = checks
    .filter(([pattern, , source]) => pattern.test(source === 'raw' ? normalized : lower))
    .map(([, reason]) => reason);

  return {
    mutatesWorkspace: reasons.length > 0,
    confidence: reasons.length > 0 ? 'high' : 'none',
    reasons
  };
}

function commandSafety(command: string | undefined): {
  risk: 'low' | 'medium' | 'high';
  reasons: string[];
} {
  const text = (command ?? '').trim();
  const lower = text.toLowerCase();
  const highRiskPatterns: Array<[RegExp, string]> = [
    [/\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/, 'recursive_force_delete'],
    [/\bsudo\b/, 'sudo'],
    [/\b(chmod|chown)\s+-r\b/, 'recursive_permission_change'],
    [/\b(git\s+reset\s+--hard|git\s+clean\s+-[^\s]*[fd])\b/, 'destructive_git'],
    [/\b(dd|mkfs|diskutil\s+erase|launchctl)\b/, 'system_mutation'],
    [/\b(curl|wget)\b[^|;&]*(\|\s*(sh|bash|zsh)|>\s*\/)/, 'remote_script_or_system_write'],
    [/\b(npm|pnpm|yarn)\s+publish\b|\b(deploy|release)\b/, 'publish_or_deploy']
  ];
  const mediumRiskPatterns: Array<[RegExp, string]> = [
    [/\b(npm|pnpm|yarn|bun|pip|uv|cargo|go|brew)\s+(install|add|update|upgrade)\b/, 'dependency_change'],
    [/\b(docker|podman|kubectl|gh|aws|gcloud|az)\b/, 'external_system'],
    [/\b(mv|cp|mkdir|touch|tee|sed\s+-i|perl\s+-pi)\b|(^|[^>])>\s*[^&]/, 'filesystem_mutation'],
    [/\b(npm|pnpm|yarn|bun)\s+run\s+(build|dev|start|watch)\b/, 'build_or_long_running'],
    [/\bkill(all)?\b|\bpkill\b/, 'process_control']
  ];
  const lowRiskPatterns = [
    /^\s*(pwd|ls|find|rg|grep|cat|head|tail|wc|git\s+(status|diff|log|show|branch))\b/,
    /^\s*(node|npm|pnpm|yarn|bun)\s+(--version|-v|test\b)/,
    /^\s*sed\s+-n\b/
  ];
  const high = highRiskPatterns.filter(([pattern]) => pattern.test(lower)).map(([, reason]) => reason);
  if (high.length > 0) {
    return { risk: 'high', reasons: high };
  }
  const medium = mediumRiskPatterns.filter(([pattern]) => pattern.test(lower)).map(([, reason]) => reason);
  if (medium.length > 0) {
    return { risk: 'medium', reasons: medium };
  }
  if (lowRiskPatterns.some((pattern) => pattern.test(lower))) {
    return { risk: 'low', reasons: ['read_or_test_command'] };
  }
  return { risk: 'medium', reasons: ['unclassified_shell'] };
}

function commandClassifier(input: ToolInput): unknown {
  const command = asString(input, 'command') ?? asString(input, 'input') ?? '';
  return {
    toolClass: 'command',
    command,
    cwd: asString(input, 'cwd'),
    timeoutMs: asNumber(input, 'timeoutMs'),
    safety: commandSafety(command),
    workspaceMutation: classifyCommandWorkspaceMutation(command)
  };
}

function terminalClassifier(input: ToolInput): unknown {
  const command = asString(input, 'command') ?? asString(input, 'input') ?? '';
  return {
    toolClass: 'terminal',
    sessionId: asString(input, 'sessionId'),
    command: command || undefined,
    input: asString(input, 'input') ? previewText(asString(input, 'input')) : undefined,
    signal: asString(input, 'signal'),
    cwd: asString(input, 'cwd'),
    safety: command ? commandSafety(command) : { risk: 'medium', reasons: ['interactive_terminal'] },
    workspaceMutation: classifyCommandWorkspaceMutation(command)
  };
}

function commandSideEffect(input: ToolInput | undefined): AgentToolSideEffectClassification {
  const command = asString(input, 'command') ?? asString(input, 'input') ?? '';
  const workspaceMutation = classifyCommandWorkspaceMutation(command);
  if (workspaceMutation.mutatesWorkspace) {
    return activeSideEffect('workspace_write', 'active_write', [
      'tool:command',
      ...workspaceMutation.reasons.map((reason) => `command:${reason}`)
    ]);
  }
  const safety = commandSafety(command);
  if (safety.risk !== 'low') {
    return externalSideEffect([
      'tool:command',
      ...safety.reasons.map((reason) => `command:${reason}`)
    ]);
  }
  return noSideEffect();
}

function terminalSideEffect(input: ToolInput | undefined): AgentToolSideEffectClassification {
  const command = asString(input, 'command') ?? asString(input, 'input') ?? '';
  const workspaceMutation = classifyCommandWorkspaceMutation(command);
  if (workspaceMutation.mutatesWorkspace) {
    return activeSideEffect('workspace_write', 'active_write', [
      'tool:terminal',
      ...workspaceMutation.reasons.map((reason) => `command:${reason}`)
    ]);
  }
  if (!command.trim()) {
    return externalSideEffect(['tool:terminal', 'interactive_terminal']);
  }
  const safety = commandSafety(command);
  if (safety.risk !== 'low') {
    return externalSideEffect([
      'tool:terminal',
      ...safety.reasons.map((reason) => `command:${reason}`)
    ]);
  }
  return noSideEffect();
}

function patchStats(patch: string | undefined): {
  length: number;
  hunkCount: number;
  addedLines: number;
  removedLines: number;
  preview?: ReturnType<typeof previewText>;
} {
  const text = patch ?? '';
  const lines = text.split(/\r?\n/);
  return {
    length: text.length,
    hunkCount: lines.filter((line) => line.startsWith('@@')).length,
    addedLines: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    removedLines: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
    preview: previewText(text)
  };
}

function editClassifier(toolName: ToolName, input: ToolInput): unknown {
  const edits = Array.isArray(input.edits) ? input.edits : undefined;
  return {
    toolClass: 'edit',
    tool: toolName,
    path: asString(input, 'path'),
    replaceAll: asBoolean(input, 'replaceAll'),
    oldText: previewText(asString(input, 'oldText')),
    newText: previewText(asString(input, 'newText')),
    content: previewText(asString(input, 'content')),
    patch: patchStats(asString(input, 'patch')),
    edits: edits
      ? {
          count: edits.length,
          totalOldTextChars: edits.reduce((sum, item) => sum + (typeof item === 'object' && item && typeof (item as ToolInput).oldText === 'string' ? String((item as ToolInput).oldText).length : 0), 0),
          totalNewTextChars: edits.reduce((sum, item) => sum + (typeof item === 'object' && item && typeof (item as ToolInput).newText === 'string' ? String((item as ToolInput).newText).length : 0), 0)
        }
      : undefined
  };
}

function mcpClassifier(input: ToolInput): unknown {
  const toolName = asString(input, 'toolName') ?? 'unknown';
  const args = input.args && typeof input.args === 'object' ? input.args : {};
  return {
    toolClass: 'mcp',
    pluginId: asString(input, 'pluginId'),
    pluginKind: asString(input, 'pluginKind'),
    toolName,
    inferredReadOnly: inferMcpToolReadOnly(toolName),
    argsSize: jsonSize(args),
    args: compactClassifierValue(args)
  };
}

function targetFrom(...keys: string[]): (input: ToolInput | undefined) => string | undefined {
  return (input) => keys.map((key) => asString(input, key)).find(Boolean);
}

function targetCommand(input: ToolInput | undefined): string | undefined {
  return asString(input, 'command') ?? asString(input, 'input');
}

function targetMcp(input: ToolInput | undefined): string | undefined {
  const plugin = asString(input, 'pluginId') ?? asString(input, 'pluginKind');
  const tool = asString(input, 'toolName') ?? asString(input, 'uri');
  return [plugin, tool].filter(Boolean).join(' / ') || undefined;
}

function targetBrowser(input: ToolInput | undefined): string | undefined {
  return asString(input, 'url') ?? asString(input, 'sessionId') ?? asString(input, 'selector') ?? asString(input, 'text');
}

function changedFilesText(result: WorkspaceToolActionResult): string[] {
  return (result.changedFiles ?? []).map((file) => [
    file.operation,
    file.path,
    typeof file.replacementCount === 'number' ? `replacements=${file.replacementCount}` : '',
    typeof file.addedLines === 'number' ? `+${file.addedLines}` : '',
    typeof file.removedLines === 'number' ? `-${file.removedLines}` : '',
    file.error ? `error=${file.error}` : ''
  ].filter(Boolean).join(' '));
}

function resultFailure(result: WorkspaceToolActionResult): {
  failureKind?: string;
  recoveryHint?: string;
} {
  const extended = result as WorkspaceToolActionResult & {
    failureKind?: string;
    recoveryHint?: string;
  };
  return {
    failureKind: extended.failureKind ?? result.edit?.failureKind ?? result.mcp?.failureKind,
    recoveryHint: extended.recoveryHint ?? result.edit?.recoveryHint
  };
}

function formatCommandProtocolResult(result: WorkspaceToolActionResult, maxChars: number): string {
  const command = result.command;
  if (!command) {
    return compactText(result.summary, maxChars, 'command result');
  }
  return compactText([
    `Command: ${command.command}`,
    `CWD: ${command.cwd}`,
    command.exitCode !== undefined ? `Exit code: ${command.exitCode}` : '',
    command.signal ? `Signal: ${command.signal}` : '',
    command.timedOut ? 'Timed out: true' : '',
    command.outputTruncated ? 'Output truncated: true' : '',
    command.stdout ? `stdout:\n${compactText(command.stdout, Math.floor(maxChars / 2), 'stdout')}` : '',
    command.stderr ? `stderr:\n${compactText(command.stderr, Math.floor(maxChars / 3), 'stderr')}` : '',
    !command.stdout && !command.stderr ? result.summary : ''
  ].filter(Boolean).join('\n'), maxChars, 'command protocol result');
}

function formatTerminalProtocolResult(result: WorkspaceToolActionResult, maxChars: number): string {
  const terminal = result.terminal;
  if (!terminal) {
    return compactText(result.summary, maxChars, 'terminal result');
  }
  return compactText([
    terminal.sessionId ? `Terminal: ${terminal.sessionId}` : '',
    terminal.name ? `Name: ${terminal.name}` : '',
    terminal.status ? `Status: ${terminal.status}` : '',
    terminal.command ? `Command: ${terminal.command}` : '',
    terminal.cwd ? `CWD: ${terminal.cwd}` : '',
    terminal.pid ? `PID: ${terminal.pid}` : '',
    terminal.exitCode !== undefined ? `Exit code: ${terminal.exitCode}` : '',
    terminal.signal ? `Signal: ${terminal.signal}` : '',
    terminal.detectedPorts?.length ? `Ports: ${terminal.detectedPorts.join(', ')}` : '',
    terminal.nextSeq !== undefined ? `Next seq: ${terminal.nextSeq}` : '',
    terminal.logTail ? `Log tail:\n${compactText(terminal.logTail, Math.floor(maxChars / 2), 'terminal log tail')}` : '',
    result.summary
  ].filter(Boolean).join('\n'), maxChars, 'terminal protocol result');
}

function formatEditProtocolResult(result: WorkspaceToolActionResult, maxChars: number): string {
  const edit = result.edit;
  return compactText([
    edit ? `Edit: ${edit.strategy}, preflight=${edit.preflight}, patchFirst=${edit.patchFirst}` : '',
    edit?.changedFileCount !== undefined ? `Changed files: ${edit.changedFileCount}` : '',
    edit?.replacementCount !== undefined ? `Replacements: ${edit.replacementCount}` : '',
    edit?.editCount !== undefined ? `Edits: ${edit.editCount}` : '',
    edit?.hunkCount !== undefined ? `Hunks: ${edit.hunkCount}` : '',
    edit?.addedLines !== undefined || edit?.removedLines !== undefined ? `Line delta: +${edit.addedLines ?? 0} -${edit.removedLines ?? 0}` : '',
    changedFilesText(result).length ? `Files:\n${changedFilesText(result).join('\n')}` : '',
    result.summary
  ].filter(Boolean).join('\n'), maxChars, 'edit protocol result');
}

function formatMcpProtocolResult(result: WorkspaceToolActionResult, maxChars: number): string {
  const mcp = result.mcp;
  if (!mcp) {
    return compactText(result.summary, maxChars, 'mcp result');
  }
  return compactText([
    `MCP operation: ${mcp.operation}`,
    `Target: ${mcp.target}`,
    mcp.exposedName ? `Exposed name: ${mcp.exposedName}` : '',
    mcp.pluginId ? `Plugin: ${mcp.pluginId}` : '',
    mcp.pluginKind ? `Plugin kind: ${mcp.pluginKind}` : '',
    mcp.policySummary ? `Policy: ${mcp.policySummary}` : '',
    `Schema guard: ${mcp.schemaGuard}`,
    mcp.argsSize !== undefined ? `Args size: ${mcp.argsSize}` : '',
    mcp.contentPartCount !== undefined ? `Content parts: ${mcp.contentPartCount}` : '',
    mcp.failureKind ? `Failure: ${mcp.failureKind}` : '',
    result.summary
  ].filter(Boolean).join('\n'), maxChars, 'mcp protocol result');
}

function protocolContent(kind: ProtocolKind, result: WorkspaceToolActionResult): string {
  if (kind === 'command') {
    return formatCommandProtocolResult(result, COMMAND_RESULT_MAX_CHARS);
  }
  if (kind === 'terminal') {
    return formatTerminalProtocolResult(result, TERMINAL_RESULT_MAX_CHARS);
  }
  if (kind === 'edit') {
    return formatEditProtocolResult(result, EDIT_RESULT_MAX_CHARS);
  }
  if (kind === 'mcp') {
    return formatMcpProtocolResult(result, MCP_RESULT_MAX_CHARS);
  }
  return result.summary;
}

function resultSearchText(spec: ToolContractSpec, result: WorkspaceToolActionResult): string {
  return compactText([
    spec.label,
    spec.resultHint,
    result.summary,
    result.command?.command ? `Command: ${result.command.command}` : '',
    result.command?.stdout ? `stdout:\n${result.command.stdout}` : '',
    result.command?.stderr ? `stderr:\n${result.command.stderr}` : '',
    result.terminal?.logTail ? `terminal:\n${result.terminal.logTail}` : '',
    changedFilesText(result).length ? `changed files:\n${changedFilesText(result).join('\n')}` : '',
    result.mcp?.target ? `MCP target: ${result.mcp.target}` : ''
  ].filter(Boolean).join('\n'), 10_000, 'tool search text');
}

function createProtocolResult(
  spec: ToolContractSpec,
  result: WorkspaceToolActionResult
): AgentToolProtocolResult {
  const failure = resultFailure(result);
  return {
    content: protocolContent(spec.protocolKind ?? 'general', result),
    isError: result.isError,
    failureKind: failure.failureKind,
    recoveryHint: failure.recoveryHint,
    media: result.media,
    changedFiles: result.changedFiles,
    command: result.command,
    terminal: result.terminal,
    browser: result.browser,
    edit: result.edit,
    mcp: result.mcp,
    artifacts: result.artifacts,
    searchText: resultSearchText(spec, result)
  };
}

function formatTarget(spec: ToolContractSpec, input: ToolInput | undefined): string | undefined {
  return spec.target?.(input);
}

function formatUseSummary(spec: ToolContractSpec, input: ToolInput | undefined): string {
  const target = formatTarget(spec, input);
  return target ? `${spec.label}: ${target}` : spec.label;
}

function formatPermissionDetail(name: ToolName, spec: ToolContractSpec, input: ToolInput): string {
  const target = formatTarget(spec, input);
  const classifier = spec.classifier?.(input) ?? genericClassifier(name, input);
  return [
    `工具：${spec.label}`,
    target ? `目标：${target}` : '',
    spec.usageHint ? `用途：${spec.usageHint}` : '',
    spec.failureHint ? `失败恢复：${spec.failureHint}` : '',
    `安全/语义输入：${stringifyCompactValue(classifier)}`
  ].filter(Boolean).join('\n');
}

function createContractSupplement(name: ToolName, spec: ToolContractSpec): Partial<AgentToolDefinition<ToolInput>> {
  return {
    aliases: spec.aliases,
    toolLanguage: {
      family: inferLanguageFamily(name, spec),
      canonicalName: spec.canonicalName,
      aliases: spec.aliases,
      usageHint: spec.usageHint,
      failureHint: spec.failureHint,
      resultHint: spec.resultHint
    },
    render: (input) => {
      const target = formatTarget(spec, input as ToolInput | undefined);
      return {
        title: spec.label,
        summary: target,
        activity: target ? `${spec.activity} ${target}` : spec.activity
      };
    },
    progress: (input, context) => {
      const target = formatTarget(spec, input as ToolInput | undefined);
      const suffix = target ? ` ${target}` : '';
      if (context.phase === 'queued') {
        return { activity: `Queued ${spec.label}`, summary: target };
      }
      if (context.phase === 'completed') {
        return { activity: `Completed ${spec.label}`, summary: target };
      }
      if (context.phase === 'failed') {
        return { activity: `Failed ${spec.label}`, summary: target };
      }
      return { activity: `${spec.activity}${suffix}`, summary: target };
    },
    userFacingName: (input) => formatUseSummary(spec, input as ToolInput | undefined),
    getActivityDescription: (input) => {
      const target = formatTarget(spec, input as ToolInput | undefined);
      return target ? `${spec.activity} ${target}` : spec.activity;
    },
    getToolUseSummary: (input) => formatTarget(spec, input as ToolInput | undefined) ?? spec.label,
    toAutoClassifierInput: (input) => spec.classifier?.(input as ToolInput) ?? genericClassifier(name, input as ToolInput),
    classifySideEffect: (input) => spec.sideEffect?.(input as ToolInput | undefined) ?? noSideEffect(),
    getPermissionDetail: (input) => formatPermissionDetail(name, spec, input as ToolInput),
    mapToolResultToProtocolResult: (result: WorkspaceToolActionResult, _context: AgentToolResultMappingContext<ToolInput>) =>
      createProtocolResult(spec, result),
    extractSearchText: (result: WorkspaceToolActionResult) => resultSearchText(spec, result),
    isConcurrencySafe: (input) => spec.isConcurrencySafe(input as ToolInput | undefined)
  };
}

const alwaysSafe = (): boolean => true;
const neverSafe = (): boolean => false;
const safeCommandOnly = (input: ToolInput | undefined): boolean => commandSafety(targetCommand(input)).risk === 'low';
const safeMcpIfReadOnly = (input: ToolInput | undefined): boolean => inferMcpToolReadOnly(asString(input, 'toolName') ?? '');

const toolContractSpecs = {
  ask_user: {
    label: 'Ask user',
    activity: 'Waiting for user input',
    aliases: ['AskUserQuestion'],
    family: 'interaction',
    canonicalName: 'AskUserQuestion',
    usageHint: 'Ask exactly one concise question only when progress depends on a user decision.',
    target: targetFrom('question'),
    isConcurrencySafe: neverSafe
  },
  update_todo_list: {
    label: 'Update todo list',
    activity: 'Updating todo list',
    aliases: ['TodoWrite', 'Todo'],
    family: 'planning',
    canonicalName: 'TodoWrite',
    usageHint: 'Maintain the short visible task ledger for multi-step work; keep exactly one item in_progress.',
    classifier: (input) => ({
      toolClass: 'todo',
      items: compactClassifierValue(input.todos ?? input.items)
    }),
    isConcurrencySafe: neverSafe
  },
  scan_file_tree: { label: 'Scan file tree', activity: 'Scanning file tree', aliases: ['LS', 'List'], family: 'read', canonicalName: 'LS', usageHint: 'List a shallow project tree before choosing exact files to read.', isConcurrencySafe: alwaysSafe },
  read_file: { label: 'Read file', activity: 'Reading file', aliases: ['Read'], family: 'read', canonicalName: 'Read', usageHint: 'Read exact source text before editing or citing code.', failureHint: 'If the path is missing, scan the tree or find files before retrying.', target: targetFrom('path'), isConcurrencySafe: alwaysSafe },
  read_document: { label: 'Read document', activity: 'Reading document', aliases: ['ReadDocument'], family: 'read', canonicalName: 'Read', usageHint: 'Read non-code project documents or media-backed text files.', target: targetFrom('path'), isConcurrencySafe: alwaysSafe },
  find_files: { label: 'Find files', activity: 'Finding files', aliases: ['Glob'], family: 'search', canonicalName: 'Glob', usageHint: 'Find files by name/path pattern; use before Grep when the file location is unknown.', target: targetFrom('pattern'), isConcurrencySafe: alwaysSafe },
  search_project_content: { label: 'Search project', activity: 'Searching project', aliases: ['Grep'], family: 'search', canonicalName: 'Grep', usageHint: 'Search code text with a focused query before opening matching files.', target: targetFrom('query'), isConcurrencySafe: alwaysSafe },
  summarize_directory: { label: 'Summarize directory', activity: 'Summarizing directory', aliases: ['DirectorySummary'], family: 'read', canonicalName: 'LS', usageHint: 'Summarize a directory when a full tree is too noisy.', target: targetFrom('path'), isConcurrencySafe: alwaysSafe },
  web_search: { label: 'Web search', activity: 'Searching web', aliases: ['WebSearch'], family: 'web', canonicalName: 'WebSearch', usageHint: 'Search the web when current external facts are required; prefer official sources for technical topics.', target: targetFrom('query'), isConcurrencySafe: alwaysSafe },
  web_fetch: { label: 'Web fetch', activity: 'Fetching web page', aliases: ['WebFetch'], family: 'web', canonicalName: 'WebFetch', usageHint: 'Fetch a known URL after search or when the user supplied the exact source.', target: targetFrom('url'), isConcurrencySafe: alwaysSafe },
  media_attach_file: { label: 'Attach media', activity: 'Attaching media', family: 'media', usageHint: 'Attach an existing local media file into the conversation context.', target: targetFrom('filePath'), isConcurrencySafe: alwaysSafe },
  media_save_base64: { label: 'Save media', activity: 'Saving media', family: 'media', usageHint: 'Persist generated or captured media as a project attachment.', target: targetFrom('fileName', 'title'), sideEffect: (input) => activeWriteSideEffect('media_save_base64', input), isConcurrencySafe: neverSafe },
  image_generate: { label: 'Generate image', activity: 'Generating image', aliases: ['ImageGenerate'], family: 'media', canonicalName: 'ImageGenerate', usageHint: 'Generate bitmap art or assets when the user asks for visual creation.', target: targetFrom('prompt'), sideEffect: (input) => activeWriteSideEffect('image_generate', input), isConcurrencySafe: neverSafe },
  list_asset_generation_capabilities: { label: 'List asset generators', activity: 'Listing asset generators', aliases: ['ListAssetGeneration'], family: 'media', usageHint: 'Discover available asset generation providers before creating 2D, 3D, animation, or audio assets.', target: targetFrom('kind'), isConcurrencySafe: alwaysSafe },
  generate_asset: { label: 'Generate asset', activity: 'Generating asset', aliases: ['AssetGenerate'], family: 'media', usageHint: 'Generate project assets through the unified Asset Generation Center instead of ad hoc file writes.', target: targetFrom('title', 'kind'), classifier: (input) => ({ toolClass: 'asset_generation', kind: asString(input, 'kind'), title: asString(input, 'title'), prompt: previewText(asString(input, 'prompt')) }), sideEffect: (input) => activeWriteSideEffect('generate_asset', input), isConcurrencySafe: neverSafe },
  import_generated_asset: { label: 'Import generated asset', activity: 'Importing generated asset', aliases: ['AssetImport'], family: 'media', usageHint: 'Mark a generated asset job as imported after verifying or using its outputs.', target: targetFrom('jobId'), sideEffect: (input) => activeWriteSideEffect('import_generated_asset', input), isConcurrencySafe: neverSafe },
  inspect_game_project: { label: 'Inspect game project', activity: 'Inspecting game project', family: 'game', usageHint: 'Detect Web/Unity/game project structure and the right verification path.', isConcurrencySafe: alwaysSafe },
  diagnose_engine_status: { label: 'Diagnose engine', activity: 'Diagnosing engine status', family: 'engine', usageHint: 'Check engine hub/editor/project/MCP status before opening or operating an engine project.', target: targetFrom('platform', 'projectPath'), isConcurrencySafe: alwaysSafe },
  refresh_engine_runtime_state: { label: 'Refresh engine state', activity: 'Refreshing engine state', family: 'engine', usageHint: 'Refresh known runtime state after opening Unity or engine MCP.', target: targetFrom('platform', 'projectPath'), sideEffect: (input) => activeEngineSideEffect('refresh_engine_runtime_state', input), isConcurrencySafe: alwaysSafe },
  open_engine_hub: { label: 'Open engine hub', activity: 'Opening engine hub', family: 'engine', usageHint: 'Open the installed engine hub application.', target: targetFrom('platform'), sideEffect: (input) => activeEngineSideEffect('open_engine_hub', input), isConcurrencySafe: neverSafe },
  open_engine_project: { label: 'Open engine project', activity: 'Opening engine project', family: 'engine', usageHint: 'Open the project with the matching engine version when available.', target: targetFrom('projectPath', 'platform'), sideEffect: (input) => activeEngineSideEffect('open_engine_project', input), isConcurrencySafe: neverSafe },
  install_engine_bridge: { label: 'Install engine bridge', activity: 'Installing engine bridge', family: 'engine', usageHint: 'Install the project bridge required for engine MCP/tooling.', target: targetFrom('projectPath', 'platform'), sideEffect: (input) => activeEngineSideEffect('install_engine_bridge', input), isConcurrencySafe: neverSafe },
  list_agent_skills: { label: 'List skills', activity: 'Listing skills', family: 'read', usageHint: 'Discover available local skills before reading a specific skill.', target: targetFrom('query'), isConcurrencySafe: alwaysSafe },
  read_agent_skill: { label: 'Read skill', activity: 'Reading skill', family: 'read', usageHint: 'Read a skill instruction file only when it applies to the task.', target: targetFrom('skillName', 'skillId'), isConcurrencySafe: alwaysSafe },
  list_agent_skill_files: { label: 'List skill files', activity: 'Listing skill files', family: 'read', usageHint: 'Inspect extra files in a skill without loading them all.', target: targetFrom('skillName', 'skillId'), isConcurrencySafe: alwaysSafe },
  read_agent_skill_file: { label: 'Read skill file', activity: 'Reading skill file', family: 'read', usageHint: 'Read one specific supporting skill file when needed.', target: targetFrom('filePath', 'skillName', 'skillId'), isConcurrencySafe: alwaysSafe },
  create_directory: { label: 'Create directory', activity: 'Creating directory', aliases: ['Mkdir'], family: 'edit', canonicalName: 'Mkdir', usageHint: 'Create only the directory needed for the user task.', protocolKind: 'edit', target: targetFrom('path'), classifier: (input) => editClassifier('create_directory', input), sideEffect: (input) => activeWriteSideEffect('create_directory', input), isConcurrencySafe: neverSafe },
  write_file: { label: 'Write file', activity: 'Writing file', aliases: ['Write'], family: 'edit', canonicalName: 'Write', usageHint: 'Create or fully replace a file when old contents are irrelevant or already known.', protocolKind: 'edit', target: targetFrom('path'), classifier: (input) => editClassifier('write_file', input), sideEffect: (input) => activeWriteSideEffect('write_file', input), isConcurrencySafe: neverSafe },
  edit_file: { label: 'Edit file', activity: 'Editing file', aliases: ['Edit'], family: 'edit', canonicalName: 'Edit', usageHint: 'Replace a unique exact oldText read from the file; prefer MultiEdit for multiple replacements.', failureHint: 'If oldText is not unique or stale, read the file again or switch to patch_file.', protocolKind: 'edit', target: targetFrom('path'), classifier: (input) => editClassifier('edit_file', input), sideEffect: (input) => activeWriteSideEffect('edit_file', input), isConcurrencySafe: neverSafe },
  multi_edit: { label: 'Multi edit', activity: 'Editing file', aliases: ['MultiEdit'], family: 'edit', canonicalName: 'MultiEdit', usageHint: 'Apply several ordered exact replacements to the same file.', failureHint: 'Do not call with an empty edits array; re-read the file if any replacement fails.', protocolKind: 'edit', target: targetFrom('path'), classifier: (input) => editClassifier('multi_edit', input), sideEffect: (input) => activeWriteSideEffect('multi_edit', input), isConcurrencySafe: neverSafe },
  preview_file_diff: { label: 'Preview diff', activity: 'Previewing diff', family: 'edit', usageHint: 'Preview a single-file rewrite before committing a risky write_file/edit_file change.', protocolKind: 'edit', target: targetFrom('path'), classifier: (input) => editClassifier('preview_file_diff', input), isConcurrencySafe: alwaysSafe },
  preview_patch: { label: 'Preview patch', activity: 'Previewing patch', aliases: ['PreviewPatch'], family: 'edit', canonicalName: 'PreviewPatch', usageHint: 'Validate a unified diff before patch_file when possible.', protocolKind: 'edit', target: targetFrom('path'), classifier: (input) => editClassifier('preview_patch', input), isConcurrencySafe: alwaysSafe },
  patch_file: { label: 'Patch file', activity: 'Patching file', aliases: ['ApplyPatch', 'Patch'], family: 'edit', canonicalName: 'ApplyPatch', usageHint: 'Apply a unified diff for structural or multi-file edits.', failureHint: 'If the patch does not apply, read the affected files and regenerate a tighter diff.', protocolKind: 'edit', target: targetFrom('path'), classifier: (input) => editClassifier('patch_file', input), sideEffect: (input) => activeWriteSideEffect('patch_file', input), isConcurrencySafe: neverSafe },
  run_command: { label: 'Run command', activity: 'Running command', aliases: ['Bash', 'Shell'], family: 'command', canonicalName: 'Bash', usageHint: 'Run a finite shell command for inspection, build, test, or diagnostics; use terminal_start for long-running servers.', failureHint: 'If a command times out or is interactive, restart it through terminal_start.', protocolKind: 'command', target: targetCommand, classifier: commandClassifier, sideEffect: commandSideEffect, isConcurrencySafe: safeCommandOnly },
  terminal_start: { label: 'Start terminal', activity: 'Starting terminal', aliases: ['TerminalStart'], family: 'terminal', usageHint: 'Start a long-running dev server or interactive process.', protocolKind: 'terminal', target: targetCommand, classifier: terminalClassifier, sideEffect: terminalSideEffect, isConcurrencySafe: neverSafe },
  terminal_read: { label: 'Read terminal', activity: 'Reading terminal', aliases: ['TerminalRead'], family: 'terminal', usageHint: 'Poll an existing terminal session for logs and detected ports.', protocolKind: 'terminal', target: targetFrom('sessionId'), isConcurrencySafe: alwaysSafe },
  terminal_write: { label: 'Write terminal', activity: 'Writing terminal', aliases: ['TerminalWrite'], family: 'terminal', usageHint: 'Send input to an existing terminal session.', protocolKind: 'terminal', target: targetFrom('sessionId'), classifier: terminalClassifier, sideEffect: terminalSideEffect, isConcurrencySafe: neverSafe },
  terminal_list: { label: 'List terminals', activity: 'Listing terminals', aliases: ['TerminalList'], family: 'terminal', usageHint: 'Find currently running terminal sessions before reading or stopping one.', protocolKind: 'terminal', isConcurrencySafe: alwaysSafe },
  terminal_stop: { label: 'Stop terminal', activity: 'Stopping terminal', aliases: ['TerminalStop'], family: 'terminal', usageHint: 'Stop a long-running session when it is no longer needed.', protocolKind: 'terminal', target: targetFrom('sessionId'), classifier: terminalClassifier, sideEffect: () => externalSideEffect(['tool:terminal', 'terminal_stop']), isConcurrencySafe: neverSafe },
  browser_open: { label: 'Open browser', activity: 'Opening browser', family: 'browser', usageHint: 'Open a browser session for local UI verification.', target: targetBrowser, sideEffect: () => externalSideEffect(['tool:browser', 'browser_open']), isConcurrencySafe: neverSafe },
  browser_navigate: { label: 'Navigate browser', activity: 'Navigating browser', family: 'browser', usageHint: 'Navigate an existing browser session to a URL.', target: targetBrowser, sideEffect: () => externalSideEffect(['tool:browser', 'browser_navigate']), isConcurrencySafe: neverSafe },
  browser_snapshot: { label: 'Read browser snapshot', activity: 'Reading browser snapshot', family: 'browser', usageHint: 'Inspect DOM/accessibility state before clicking or asserting UI.', target: targetBrowser, isConcurrencySafe: alwaysSafe },
  browser_screenshot: { label: 'Capture browser screenshot', activity: 'Capturing browser screenshot', family: 'browser', usageHint: 'Capture visual evidence after rendering or interaction.', target: targetBrowser, isConcurrencySafe: alwaysSafe },
  browser_click: { label: 'Click browser', activity: 'Clicking browser', family: 'browser', usageHint: 'Click a known selector or coordinate in a browser session.', target: targetBrowser, sideEffect: () => externalSideEffect(['tool:browser', 'browser_click']), isConcurrencySafe: neverSafe },
  browser_type: { label: 'Type in browser', activity: 'Typing in browser', family: 'browser', usageHint: 'Type into a focused or selected browser input.', target: targetBrowser, sideEffect: () => externalSideEffect(['tool:browser', 'browser_type']), isConcurrencySafe: neverSafe },
  browser_console: { label: 'Read browser console', activity: 'Reading browser console', family: 'browser', usageHint: 'Check client-side errors after opening or interacting with the app.', target: targetBrowser, isConcurrencySafe: alwaysSafe },
  browser_list: { label: 'List browsers', activity: 'Listing browsers', family: 'browser', usageHint: 'Find active browser sessions.', isConcurrencySafe: alwaysSafe },
  browser_close: { label: 'Close browser', activity: 'Closing browser', family: 'browser', usageHint: 'Close an unneeded browser session.', target: targetBrowser, sideEffect: () => externalSideEffect(['tool:browser', 'browser_close']), isConcurrencySafe: neverSafe },
  checkpoint_diff: { label: 'Checkpoint diff', activity: 'Reading checkpoint diff', aliases: ['CheckpointDiff'], family: 'checkpoint', usageHint: 'Summarize file changes since the current checkpoint.', isConcurrencySafe: alwaysSafe },
  checkpoint_rollback: { label: 'Checkpoint rollback', activity: 'Rolling back checkpoint', aliases: ['CheckpointRollback'], family: 'checkpoint', usageHint: 'Rollback only when explicitly needed or after a failed risky edit path.', protocolKind: 'edit', sideEffect: (input) => activeWriteSideEffect('checkpoint_rollback', input), isConcurrencySafe: neverSafe },
  list_mcp_tools: { label: 'List MCP tools', activity: 'Listing MCP tools', aliases: ['ListMcpTools'], family: 'mcp', usageHint: 'Discover MCP capabilities when direct mcp__server__tool aliases are not available.', protocolKind: 'mcp', target: targetMcp, classifier: mcpClassifier, isConcurrencySafe: alwaysSafe },
  list_mcp_resources: { label: 'List MCP resources', activity: 'Listing MCP resources', aliases: ['ListMcpResources'], family: 'mcp', usageHint: 'Discover MCP resources before reading one.', protocolKind: 'mcp', target: targetMcp, classifier: mcpClassifier, isConcurrencySafe: alwaysSafe },
  read_mcp_resource: { label: 'Read MCP resource', activity: 'Reading MCP resource', aliases: ['ReadMcpResource'], family: 'mcp', usageHint: 'Read a specific MCP resource URI.', protocolKind: 'mcp', target: targetMcp, classifier: mcpClassifier, isConcurrencySafe: alwaysSafe },
  call_mcp_tool: { label: 'Call MCP tool', activity: 'Calling MCP tool', aliases: ['CallMcpTool'], family: 'mcp', usageHint: 'Fallback MCP call entry when a direct dynamic mcp__server__tool is absent.', failureHint: 'If the tool is unknown, list MCP tools and retry with the exact name/schema.', protocolKind: 'mcp', target: targetMcp, classifier: mcpClassifier, sideEffect: mcpSideEffect, isConcurrencySafe: safeMcpIfReadOnly },
  funplay_memory_search: { label: 'Search memory', activity: 'Searching memory', family: 'memory', usageHint: 'Search durable project/user memory before re-deriving stable context.', target: targetFrom('query'), isConcurrencySafe: alwaysSafe },
  funplay_memory_get: { label: 'Read memory', activity: 'Reading memory', family: 'memory', usageHint: 'Read one durable memory entry.', target: targetFrom('filePath'), isConcurrencySafe: alwaysSafe },
  funplay_memory_recent: { label: 'Recent memory', activity: 'Reading recent memory', family: 'memory', usageHint: 'List recent durable memory entries.', isConcurrencySafe: alwaysSafe },
  funplay_memory_remember: { label: 'Remember', activity: 'Writing memory', family: 'memory', usageHint: 'Persist stable user preferences, project facts, decisions, or task state only.', target: targetFrom('note'), sideEffect: () => externalSideEffect(['tool:memory', 'memory_write']), isConcurrencySafe: neverSafe },
  funplay_notify: { label: 'Notify', activity: 'Sending notification', family: 'notification', usageHint: 'Notify the user only when explicitly requested or when an automation fires.', target: targetFrom('title'), sideEffect: () => externalSideEffect(['tool:notification', 'send_notification']), isConcurrencySafe: neverSafe },
  funplay_schedule_task: { label: 'Schedule task', activity: 'Scheduling task', aliases: ['ScheduleTask'], family: 'notification', usageHint: 'Create a future reminder or automation when the user asks for one.', target: targetFrom('name'), sideEffect: () => externalSideEffect(['tool:notification', 'schedule_task']), isConcurrencySafe: neverSafe },
  funplay_list_tasks: { label: 'List tasks', activity: 'Listing tasks', family: 'notification', usageHint: 'List scheduled tasks or automations.', target: targetFrom('status'), isConcurrencySafe: alwaysSafe },
  funplay_cancel_task: { label: 'Cancel task', activity: 'Cancelling task', family: 'notification', usageHint: 'Cancel a scheduled task by id.', target: targetFrom('taskId'), sideEffect: () => externalSideEffect(['tool:notification', 'cancel_task']), isConcurrencySafe: neverSafe },
  run_subagent: { label: 'Run subagent', activity: 'Running subagent', aliases: ['Task'], family: 'subagent', canonicalName: 'Task', usageHint: 'Delegate a bounded side investigation or implementation slice; keep the main critical path local.', target: targetFrom('task'), isConcurrencySafe: neverSafe },
  run_subagents: { label: 'Run subagents', activity: 'Running subagents', aliases: ['TaskGroup'], family: 'subagent', canonicalName: 'Task', usageHint: 'Run 2-4 independent side investigations in parallel when their scopes do not overlap.', target: targetFrom('scope'), isConcurrencySafe: neverSafe },
  subagent_start: { label: 'Start subagent', activity: 'Starting subagent', aliases: ['TaskStart'], family: 'subagent', canonicalName: 'TaskStart', usageHint: 'Start a longer background subtask that can be polled later.', target: targetFrom('task', 'name'), isConcurrencySafe: neverSafe },
  subagent_status: { label: 'Read subagent status', activity: 'Reading subagent status', aliases: ['TaskStatus'], family: 'subagent', canonicalName: 'TaskStatus', usageHint: 'Read a background subtask result.', target: targetFrom('taskId'), isConcurrencySafe: alwaysSafe }
} satisfies Partial<Record<ToolName, ToolContractSpec>>;

for (const [name, spec] of Object.entries(toolContractSpecs) as Array<[ToolName, ToolContractSpec]>) {
  updateAgentToolDefinition(name, createContractSupplement(name, spec));
}
