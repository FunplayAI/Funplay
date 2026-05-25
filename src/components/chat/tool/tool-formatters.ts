import type {
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  ChatMessageMetadata
} from '../../../../shared/types';
import { localize } from '../../../i18n';
import type {
  StageExecutionEntry,
  StreamActivityEntry,
  ToolActivityKind,
  ToolExecutionEntry,
  WebCitationEntry
} from './tool-types';

export function formatToolStatus(language: 'zh-CN' | 'en-US', status: 'pending' | 'running' | 'completed' | 'failed'): string {
  const labels = {
    pending: localize(language, '等待执行', 'Pending'),
    running: localize(language, '执行中', 'Running'),
    completed: localize(language, '已完成', 'Completed'),
    failed: localize(language, '失败', 'Failed')
  };
  return labels[status];
}

export function formatCompletedProcessTitle(
  metadata: ChatMessageMetadata | undefined,
  fallbackFinishedAt: string,
  language: 'zh-CN' | 'en-US',
  options: { includeTokenUsage?: boolean } = {}
): string {
  const startedAt = metadata?.agentStartedAt;
  const finishedAt = metadata?.agentFinishedAt ?? fallbackFinishedAt;
  const duration = startedAt ? formatDuration(language, Date.parse(finishedAt) - Date.parse(startedAt)) : '';
  const processed = duration
    ? localize(language, `已处理 ${duration}`, `Processed ${duration}`)
    : localize(language, '已处理', 'Processed');
  const tokenUsage = options.includeTokenUsage ? formatTokenUsageSummary(metadata?.tokenUsage, language) : '';
  return tokenUsage ? `${processed} · ${tokenUsage}` : processed;
}

export function formatDuration(language: 'zh-CN' | 'en-US', durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '';
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return localize(language, `${seconds}s`, `${seconds}s`);
}

function formatTokenUsageSummary(
  usage: ChatMessageMetadata['tokenUsage'] | undefined,
  language: 'zh-CN' | 'en-US'
): string {
  if (!usage || usage.totalTokens <= 0) {
    return '';
  }

  const cacheTokens = usage.cacheCreationTokens + usage.cacheReadTokens;
  const zhSegments = [
    `输入 ${formatTokenCount(usage.inputTokens)}`,
    `输出 ${formatTokenCount(usage.outputTokens)}`,
    cacheTokens > 0 ? `缓存 ${formatTokenCount(cacheTokens)}` : '',
    usage.turns > 1 ? `${usage.turns} 次` : ''
  ].filter(Boolean);
  const enSegments = [
    `in ${formatTokenCount(usage.inputTokens)}`,
    `out ${formatTokenCount(usage.outputTokens)}`,
    cacheTokens > 0 ? `cache ${formatTokenCount(cacheTokens)}` : '',
    usage.turns > 1 ? `${usage.turns} calls` : ''
  ].filter(Boolean);

  return localize(
    language,
    `Token ${formatTokenCount(usage.totalTokens)}（${zhSegments.join(' · ')}）`,
    `${formatTokenCount(usage.totalTokens)} tokens (${enSegments.join(' · ')})`
  );
}

function formatTokenCount(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}m`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return `${value}`;
}

export function formatChangedFileMeta(file: AgentToolChangedFile, language: 'zh-CN' | 'en-US'): string {
  return [
    localize(language, formatChangedFileOperationZh(file.operation), file.operation.replace(/_/g, ' ')),
    typeof file.size === 'number' ? `${file.size} bytes` : '',
    typeof file.replacementCount === 'number' ? localize(language, `替换 ${file.replacementCount}`, `${file.replacementCount} replacements`) : '',
    typeof file.hunkCount === 'number' ? localize(language, `${file.hunkCount} 个 hunk`, `${file.hunkCount} hunks`) : ''
  ].filter(Boolean).join(' · ');
}

function formatChangedFileOperationZh(operation: AgentToolChangedFile['operation']): string {
  const labels: Record<AgentToolChangedFile['operation'], string> = {
    created: '已创建',
    modified: '已修改',
    directory_created: '已建目录',
    patched: '已应用 patch',
    restored: '已回滚',
    failed: '失败'
  };
  return labels[operation];
}

export function formatEditMetrics(edit: AgentToolEditMetrics, language: 'zh-CN' | 'en-US'): string {
  return [
    edit.strategy,
    edit.patchFirst ? localize(language, 'patch-first', 'patch-first') : localize(language, '直接编辑', 'direct edit'),
    localize(language, `预检 ${formatEditPreflightZh(edit.preflight)}`, `preflight ${edit.preflight}`),
    typeof edit.replacementCount === 'number' ? localize(language, `替换 ${edit.replacementCount}`, `${edit.replacementCount} replacements`) : '',
    typeof edit.hunkCount === 'number' ? localize(language, `${edit.hunkCount} 个 hunk`, `${edit.hunkCount} hunks`) : '',
    edit.failureKind && edit.failureKind !== 'unknown' ? localize(language, `失败类型 ${edit.failureKind}`, `failure ${edit.failureKind}`) : ''
  ].filter(Boolean).join(' · ');
}

function formatEditPreflightZh(preflight: AgentToolEditMetrics['preflight']): string {
  const labels: Record<AgentToolEditMetrics['preflight'], string> = {
    passed: '通过',
    failed: '失败',
    not_applicable: '不适用'
  };
  return labels[preflight];
}

export function formatBrowserMetrics(browser: AgentToolBrowserResult, language: 'zh-CN' | 'en-US'): string {
  return [
    browser.title,
    browser.url,
    browser.sessionId,
    browser.viewport ? `${browser.viewport.width}x${browser.viewport.height}` : '',
    typeof browser.consoleMessageCount === 'number' ? localize(language, `控制台 ${browser.consoleMessageCount}`, `${browser.consoleMessageCount} console`) : '',
    browser.screenshotPath
  ].filter(Boolean).join(' · ');
}

export function formatMcpMetrics(mcp: AgentToolMcpResult, language: 'zh-CN' | 'en-US'): string {
  return [
    mcp.operation,
    mcp.target,
    mcp.exposedName ? localize(language, `暴露为 ${mcp.exposedName}`, `as ${mcp.exposedName}`) : '',
    mcp.pluginKind ?? mcp.pluginId,
    mcp.policySummary,
    `${mcp.timeoutMs}ms`,
    typeof mcp.argsSize === 'number' ? `${mcp.argsSize} bytes` : '',
    typeof mcp.contentPartCount === 'number' ? localize(language, `${mcp.contentPartCount} 个内容块`, `${mcp.contentPartCount} content parts`) : '',
    mcp.schemaGuard === 'failed' && mcp.failureKind ? localize(language, `拦截 ${mcp.failureKind}`, `blocked ${mcp.failureKind}`) : ''
  ].filter(Boolean).join(' · ');
}

export function parseWebCitations(content: string): WebCitationEntry[] {
  if (!/^Tool:\s+web_(?:search|fetch)$/m.test(content)) {
    return [];
  }
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const citations: WebCitationEntry[] = [];
  let current: WebCitationEntry | null = null;

  for (const line of lines) {
    const citationMatch = line.match(/^\[(S\d+|F\d+)\]\s+(.+)$/);
    if (citationMatch) {
      if (current?.url) {
        citations.push(current);
      }
      current = {
        id: citationMatch[1],
        title: citationMatch[2].trim(),
        url: ''
      };
      continue;
    }
    if (!current) {
      continue;
    }
    const fieldMatch = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!fieldMatch) {
      continue;
    }
    const key = fieldMatch[1].toLowerCase();
    const value = fieldMatch[2].trim();
    if (key === 'url') current.url = value;
    if (key === 'provider') current.provider = value;
    if (key === 'published') current.publishedAt = value;
    if (key === 'snippet') current.snippet = value;
    if (key === 'description') current.description = value;
  }

  if (current?.url) {
    citations.push(current);
  }
  return citations;
}

export function formatCitationHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
  return url;
  }
}

export function formatStreamActivityTitle(activity: StreamActivityEntry, language: 'zh-CN' | 'en-US'): string {
  if (activity.title === 'tool_running') {
    return localize(language, '正在执行工具', 'Running tools');
  }
  if (activity.title === 'tool_completed') {
    return localize(language, '工具执行完成', 'Tools completed');
  }
  if (activity.title === 'tool_failed') {
    return localize(language, '工具执行失败', 'Tools failed');
  }
  if (activity.title === 'context_compressed') {
    return localize(language, '上下文已压缩', 'Context compressed');
  }
  if (activity.type === 'timeout') {
    return localize(language, '工具超时', 'Tool timed out');
  }
  return sanitizeStageSummary(activity.title) || localize(language, '运行事件', 'Runtime event');
}

export function formatStageStatus(language: 'zh-CN' | 'en-US', status: StageExecutionEntry['status']): string {
  const labels = {
    pending: localize(language, '等待', 'Pending'),
    running: localize(language, '进行中', 'Running'),
    completed: localize(language, '完成', 'Done'),
    failed: localize(language, '失败', 'Failed'),
    skipped: localize(language, '跳过', 'Skipped')
  };
  return labels[status];
}

export function sanitizeStageSummary(value: string): string {
  return value
    .replace(/\bstage:[\w:-]+\b/g, '')
    .replace(/^(阶段|Stage)\s*·\s*/i, '')
    .replace(/\s*·\s*·\s*/g, ' · ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function formatStageRuntimeMeta(stage: StageExecutionEntry): string {
  return [stage.runtimeId, stage.providerId, stage.model].filter(Boolean).join(' / ');
}

export function summarizeToolActivity(
  tools: ToolExecutionEntry[],
  language: 'zh-CN' | 'en-US',
  options: { includeDiagnosticMeta?: boolean } = {}
): { title: string; meta: string } {
  const counts: Record<ToolActivityKind, number> = {
    read: 0,
    search: 0,
    write: 0,
    command: 0,
    mcp: 0,
    task: 0,
    other: 0
  };

  for (const tool of tools) {
    counts[getToolActivityKind(tool)] += 1;
  }

  const failedCount = tools.filter((tool) => tool.status === 'failed' || tool.result?.isError).length;
  const runningCount = tools.filter((tool) => tool.status === 'running' || tool.status === 'pending').length;
  const lastTarget = tools.length > 0 ? formatToolActivityTarget(tools[tools.length - 1]) : '';
  const zhSegments = [
    counts.read ? `探索 ${counts.read} 个文件` : '',
    counts.search ? `搜索 ${counts.search} 次` : '',
    counts.write ? `编辑 ${counts.write} 个文件` : '',
    counts.command ? `运行 ${counts.command} 条命令` : '',
    counts.mcp ? `调用 ${counts.mcp} 个 MCP 工具` : '',
    counts.task ? `更新 ${counts.task} 次任务清单` : '',
    counts.other ? `处理 ${counts.other} 个工具` : ''
  ].filter(Boolean);
  const enSegments = [
    counts.read ? `${counts.read} file ${counts.read === 1 ? 'read' : 'reads'}` : '',
    counts.search ? `${counts.search} ${counts.search === 1 ? 'search' : 'searches'}` : '',
    counts.write ? `${counts.write} ${counts.write === 1 ? 'edit' : 'edits'}` : '',
    counts.command ? `${counts.command} ${counts.command === 1 ? 'command' : 'commands'}` : '',
    counts.mcp ? `${counts.mcp} MCP ${counts.mcp === 1 ? 'call' : 'calls'}` : '',
    counts.task ? `${counts.task} task list ${counts.task === 1 ? 'update' : 'updates'}` : '',
    counts.other ? `${counts.other} ${counts.other === 1 ? 'tool' : 'tools'}` : ''
  ].filter(Boolean);

  const title = localize(
    language,
    `${runningCount ? '正在' : '已'}${zhSegments.join('，') || '处理工具'}`,
    `${runningCount ? 'Running ' : 'Completed '}${enSegments.join(', ') || 'tool activity'}`
  );
  const meta = [
    runningCount ? localize(language, `${runningCount} 个进行中`, `${runningCount} running`) : '',
    options.includeDiagnosticMeta && failedCount ? localize(language, `${failedCount} 个失败`, `${failedCount} failed`) : '',
    options.includeDiagnosticMeta && lastTarget ? compactActivityTarget(lastTarget) : ''
  ].filter(Boolean).join(' · ');

  return { title, meta };
}

export function formatToolActivityLine(tool: ToolExecutionEntry, language: 'zh-CN' | 'en-US'): string {
  const kind = getToolActivityKind(tool);
  const target = compactActivityTarget(formatToolActivityTarget(tool) || tool.title || tool.name);

  if (tool.activity && kind === 'other') {
    return compactActivityTarget(tool.activity);
  }
  if (kind === 'command') {
    return localize(language, `已运行 ${target}`, `Ran ${target}`);
  }
  if (kind === 'read') {
    return localize(language, `读取 ${target}`, `Read ${target}`);
  }
  if (kind === 'search') {
    return localize(language, `搜索 ${target}`, `Searched ${target}`);
  }
  if (kind === 'write') {
    return localize(language, `编辑 ${target}`, `Edited ${target}`);
  }
  if (kind === 'mcp') {
    return localize(language, `调用 ${target}`, `Called ${target}`);
  }
  if (kind === 'task') {
    return localize(language, '更新任务清单', 'Updated task list');
  }

  return formatToolSummary(tool, language);
}

export function getToolActivityKind(tool: ToolExecutionEntry): ToolActivityKind {
  const lowerName = [tool.name, tool.title, tool.activity].filter(Boolean).join(' ').trim().toLowerCase();
  if (/update[_\s-]?todo[_\s-]?list|todo[_\s-]?write|todowrite|task[_\s-]?list|任务清单/.test(lowerName)) {
    return 'task';
  }
  if (/run[_\s-]?command|shell|terminal|exec/.test(lowerName)) {
    return 'command';
  }
  if (isWriteLikeTool(tool)) {
    return 'write';
  }
  if (/web[_\s-]?search|memory[_\s-]?search|search|find[_\s-]?files|grep|rg/.test(lowerName)) {
    return 'search';
  }
  if (/web[_\s-]?fetch|memory[_\s-]?(get|recent)|read[_\s-]?file|scan[_\s-]?file[_\s-]?tree|summarize[_\s-]?directory|inspect[_\s-]?workspace[_\s-]?context/.test(lowerName)) {
    return 'read';
  }
  if (/mcp|plugin/.test(lowerName)) {
    return 'mcp';
  }
  return 'other';
}

export function formatToolActivityTarget(tool: ToolExecutionEntry): string {
  const input = tool.input ?? {};
  return readStringField(input, ['command', 'cmd'])
    || readStringField(input, ['path', 'filePath', 'file_path'])
    || readStringField(input, ['url'])
    || readStringField(input, ['query'])
    || readStringField(input, ['title'])
    || readStringField(input, ['name'])
    || readStringField(input, ['toolName'])
    || readStringField(input, ['uri'])
    || readStringField(input, ['pluginName'])
    || tool.summary
    || renderToolPrimaryMeta(tool, 'zh-CN')
    || '';
}

export function compactActivityTarget(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 88) {
    return normalized;
  }
  return `${normalized.slice(0, 87)}…`;
}

export function formatToolSummary(tool: ToolExecutionEntry, language: 'zh-CN' | 'en-US'): string {
  const lowerName = tool.name.trim().toLowerCase();
  const labelMap: Array<[RegExp, string, string]> = [
    [/read[_\s-]?file/, '读取文件', 'Read file'],
    [/search[_\s-]?project[_\s-]?content/, '搜索项目内容', 'Search project'],
    [/web[_\s-]?search/, '网络搜索', 'Web search'],
    [/web[_\s-]?fetch/, '读取网页', 'Fetch web page'],
    [/funplay_memory_search/, '搜索记忆', 'Search memory'],
    [/funplay_memory_get/, '读取记忆', 'Read memory'],
    [/funplay_memory_recent/, '读取最近记忆', 'Read recent memory'],
    [/funplay_memory_remember/, '保存记忆', 'Save memory'],
    [/funplay_notify/, '发送通知', 'Send notification'],
    [/funplay_schedule_task/, '安排提醒', 'Schedule reminder'],
    [/funplay_list_tasks/, '查看提醒', 'List reminders'],
    [/funplay_cancel_task/, '取消提醒', 'Cancel reminder'],
    [/summarize[_\s-]?directory/, '汇总目录', 'Summarize directory'],
    [/create[_\s-]?directory/, '创建目录', 'Create directory'],
    [/update[_\s-]?todo[_\s-]?list|todo[_\s-]?write|todowrite|任务清单/, '任务清单', 'Task list'],
    [/scan[_\s-]?file[_\s-]?tree|inspect[_\s-]?workspace[_\s-]?context/, '扫描工作区', 'Inspect workspace'],
    [/write[_\s-]?file/, '写入文件', 'Write file'],
    [/call[_\s-]?mcp[_\s-]?tool/, '调用 MCP 工具', 'Call MCP tool'],
    [/read[_\s-]?mcp[_\s-]?resource/, '读取 MCP 资源', 'Read MCP resource'],
    [/observe_.*plugin/, '采集插件观测', 'Observe plugin']
  ];

  const matched = labelMap.find(([pattern]) => pattern.test(lowerName));
  if (matched) {
    return localize(language, matched[1], matched[2]);
  }

  return tool.title ?? tool.name;
}

export function renderToolPrimaryMeta(tool: ToolExecutionEntry, language: 'zh-CN' | 'en-US'): string | null {
  const input = tool.input ?? {};
  const path = readStringField(input, ['path', 'filePath', 'file_path']);
  if (path) {
    return path;
  }

  const query = readStringField(input, ['query']);
  if (query) {
    return query;
  }

  const toolName = readStringField(input, ['toolName']);
  if (toolName) {
    return toolName;
  }

  const uri = readStringField(input, ['uri']);
  if (uri) {
    return uri;
  }

  const pluginName = readStringField(input, ['pluginName']);
  if (pluginName) {
    return pluginName;
  }

  const content = typeof input.content === 'string' ? input.content : '';
  if (content) {
    return localize(language, `${content.length} 字符`, `${content.length} chars`);
  }

  return null;
}

export function summarizeToolInput(tool: ToolExecutionEntry, language: 'zh-CN' | 'en-US'): Array<{ label: string; value: string }> {
  const input = tool.input ?? {};
  const summary: Array<{ label: string; value: string }> = [];

  const path = readStringField(input, ['path', 'filePath', 'file_path']);
  if (path) {
    summary.push({
      label: localize(language, '目标', 'Target'),
      value: path
    });
  }

  const query = readStringField(input, ['query']);
  if (query) {
    summary.push({
      label: localize(language, '查询', 'Query'),
      value: query
    });
  }

  const toolName = readStringField(input, ['toolName']);
  if (toolName) {
    summary.push({
      label: localize(language, '工具', 'Tool'),
      value: toolName
    });
  }

  const uri = readStringField(input, ['uri']);
  if (uri) {
    summary.push({
      label: localize(language, '资源', 'Resource'),
      value: uri
    });
  }

  if (typeof input.content === 'string' && input.content) {
    summary.push({
      label: localize(language, '内容', 'Content'),
      value: localize(language, `${input.content.length} 字符`, `${input.content.length} chars`)
    });
  }

  const args = input.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    summary.push({
      label: localize(language, '参数', 'Args'),
      value: localize(language, `${Object.keys(args).length} 项`, `${Object.keys(args).length} fields`)
    });
  }

  return summary.slice(0, 4);
}

export function summarizeToolResult(
  tool: ToolExecutionEntry,
  language: 'zh-CN' | 'en-US'
): {
  preview: string;
  expandable: boolean;
} {
  const content = tool.result?.content?.trim() || '';
  if (!content) {
    return {
      preview: localize(language, '暂无输出。', 'No output.'),
      expandable: false
    };
  }

  if (isWriteLikeTool(tool) && tool.status !== 'failed' && !tool.result?.isError) {
    const path = renderToolPrimaryMeta(tool, language);
    const matchedWriteResult = content.match(/已写入\s+(.+?)\s+\((\d+)\s+bytes\)/i);
    if (matchedWriteResult) {
      return {
        preview: content,
        expandable: false
      };
    }
    if (path) {
      return {
        preview: localize(language, `已更新 ${path}`, `Updated ${path}`),
        expandable: content.length > 180
      };
    }
  }

  const normalized = content.replace(/\r\n/g, '\n').trim();
  const kind = getToolActivityKind(tool);
  if (kind === 'search') {
    const query = renderToolPrimaryMeta(tool, language);
    const citationCount = parseWebCitations(normalized).length;
    return {
      preview: citationCount
        ? localize(language, `找到 ${citationCount} 个来源，结论见最终回复。`, `Found ${citationCount} sources. See the final reply for conclusions.`)
        : query
          ? localize(language, `已完成搜索：${compactActivityTarget(query)}`, `Search completed: ${compactActivityTarget(query)}`)
          : localize(language, '搜索已完成，结论见最终回复。', 'Search completed. See the final reply for conclusions.'),
      expandable: true
    };
  }

  if (/web[_\s-]?fetch/i.test(tool.name)) {
    const target = renderToolPrimaryMeta(tool, language);
    return {
      preview: target
        ? localize(language, `已读取网页：${compactActivityTarget(target)}`, `Fetched web page: ${compactActivityTarget(target)}`)
        : localize(language, '网页读取已完成，结论见最终回复。', 'Web page fetched. See the final reply for conclusions.'),
      expandable: true
    };
  }

  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const previewLines = lines.slice(0, 3);
  const preview = truncateInlineText(previewLines.join('\n'), tool.result?.isError ? 320 : 220);

  return {
    preview,
    expandable: normalized.length > preview.length || lines.length > previewLines.length
  };
}

export function shouldExpandToolByDefault(tool: ToolExecutionEntry): boolean {
  if (tool.result?.media?.length) {
    return true;
  }
  return false;
}

export function isWriteLikeTool(tool: ToolExecutionEntry): boolean {
  return /(write|edit|create_directory|create_file|createfile|write_file|apply|patch|memory_remember|schedule_task|cancel_task)/i.test(tool.name);
}

export function formatAbsoluteTime(language: 'zh-CN' | 'en-US', value: string): string {
  return new Intl.DateTimeFormat(language, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function readStringField(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function truncateInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
