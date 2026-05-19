import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react';
import type {
  AgentCoreMessagePart,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTransactionSummary,
  ChatContentBlock,
  ChatMediaBlock,
  ChatMessageMetadata,
  ChatMessageProcessActivity,
  ProjectSessionRuntimeId,
  RuntimeRecoveryAction
} from '../../../shared/types';
import { agentCorePartsToChatContentBlocks } from '../../../shared/agent-core-v2';
import { localize, useUiLanguage } from '../../i18n';

export interface ToolExecutionEntry {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input?: Record<string, unknown>;
  result?: {
    content: string;
    isError?: boolean;
    media?: ChatMediaBlock[];
    changedFiles?: AgentToolChangedFile[];
    browser?: AgentToolBrowserResult;
    edit?: AgentToolEditMetrics;
    mcp?: AgentToolMcpResult;
    artifacts?: AgentToolArtifact[];
    transaction?: AgentToolTransactionSummary;
  };
}

export interface StageExecutionEntry {
  stageId: string;
  phase?: string;
  title: string;
  target: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input?: Record<string, unknown>;
  summary?: string;
  errorMessage?: string;
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  errorCode?: string;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
  transaction?: AgentToolTransactionSummary;
}

export type StreamActivityEntry = ChatMessageProcessActivity;

export interface WebCitationEntry {
  id: string;
  title: string;
  url: string;
  provider?: string;
  snippet?: string;
  publishedAt?: string;
  description?: string;
}

export type RenderableChatEntry =
  | {
      type: 'block';
      block: ChatContentBlock;
      key: string;
    }
  | {
      type: 'tool';
      tool: ToolExecutionEntry;
      key: string;
    };

export type ToolActivityKind = 'read' | 'search' | 'write' | 'command' | 'mcp' | 'task' | 'other';

export function formatToolStatus(language: 'zh-CN' | 'en-US', status: 'pending' | 'running' | 'completed' | 'failed'): string {
  const labels = {
    pending: localize(language, '等待执行', 'Pending'),
    running: localize(language, '执行中', 'Running'),
    completed: localize(language, '已完成', 'Completed'),
    failed: localize(language, '失败', 'Failed')
  };
  return labels[status];
}

export function AssistantMetadataPanel(props: { metadata: ChatMessageMetadata | undefined; developerMode: boolean }): JSX.Element | null {
  const language = useUiLanguage();
  if (!props.developerMode || !props.metadata || props.metadata.intent !== 'fallback') {
    return null;
  }

  return (
    <div className="chat-message-panel fallback">
      <div className="chat-message-panel-title">{localize(language, '当前使用本地回退', 'Local Fallback')}</div>
      {props.metadata.activitySummary ? <div className="chat-message-panel-copy">{props.metadata.activitySummary}</div> : null}
      {props.metadata.executionSummary ? <div className="chat-message-panel-note">{props.metadata.executionSummary}</div> : null}
    </div>
  );
}

export function formatCompletedProcessTitle(
  metadata: ChatMessageMetadata | undefined,
  fallbackFinishedAt: string,
  language: 'zh-CN' | 'en-US'
): string {
  const startedAt = metadata?.agentStartedAt;
  const finishedAt = metadata?.agentFinishedAt ?? fallbackFinishedAt;
  const duration = startedAt ? formatDuration(language, Date.parse(finishedAt) - Date.parse(startedAt)) : '';
  const processed = duration
    ? localize(language, `已处理 ${duration}`, `Processed ${duration}`)
    : localize(language, '已处理', 'Processed');
  const tokenUsage = formatTokenUsageSummary(metadata?.tokenUsage, language);
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

export function buildCompletedMessageProcessTools(message: {
  metadata?: {
    operationLog?: import('../../../shared/types').AgentOperationRecord[];
    agentCoreParts?: AgentCoreMessagePart[];
  };
  contentBlocks?: ChatContentBlock[];
  agentCoreParts?: AgentCoreMessagePart[];
}): ToolExecutionEntry[] {
  const agentCoreParts = message.agentCoreParts ?? message.metadata?.agentCoreParts;
  if (agentCoreParts?.length) {
    return buildToolsFromContentBlocks(agentCorePartsToChatContentBlocks(agentCoreParts));
  }

  const operationLogTools = buildToolsFromOperationLog(message.metadata?.operationLog);
  if (operationLogTools.length > 0) {
    return operationLogTools;
  }
  return buildToolsFromContentBlocks(message.contentBlocks);
}

export function buildToolsFromOperationLog(operationLog: import('../../../shared/types').AgentOperationRecord[] | undefined): ToolExecutionEntry[] {
  if (!operationLog?.length) {
    return [];
  }

  return operationLog
    .filter((record) => record.type === 'tool_call' && !record.id.startsWith('stage:') && !record.target.startsWith('stage:'))
    .map((record) => ({
      id: record.id,
      name: record.title || record.target,
      input: record.input,
      status: normalizeOperationStatus(record.status),
      result: record.summary || record.errorMessage
        ? {
            content: record.summary || record.errorMessage || '',
            isError: record.status === 'failed',
            transaction: record.transaction ?? (record.input?.transaction as AgentToolTransactionSummary | undefined)
          }
        : undefined
    }));
}

export function normalizeOperationStatus(status: import('../../../shared/types').AgentOperationRecord['status']): ToolExecutionEntry['status'] {
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  if (status === 'pending') return 'pending';
  return 'completed';
}

export function buildToolsFromContentBlocks(blocks: ChatContentBlock[] | undefined): ToolExecutionEntry[] {
  if (!blocks?.length) {
    return [];
  }

  return pairHistoricalToolExecutions(blocks)
    .filter((entry): entry is Extract<RenderableChatEntry, { type: 'tool' }> => entry.type === 'tool')
    .map((entry) => entry.tool);
}

export function ToolActivityGroup(props: {
  tools: ToolExecutionEntry[];
  defaultOpen?: boolean;
  active?: boolean;
  autoCollapseWhenInactive?: boolean;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
  renderContent: (content: string, openablePaths: string[], searchQuery: string, onOpenPath: (path: string) => void) => ReactNode;
}): JSX.Element | null {
  const language = useUiLanguage();
  const detailId = useId();
  const groupState = props.tools.some((tool) => tool.status === 'failed' || tool.result?.isError)
    ? 'failed'
    : props.tools.some((tool) => tool.status === 'running' || tool.status === 'pending')
      ? 'running'
      : 'completed';
  const summary = summarizeToolActivity(props.tools, language);
  const openByDefault = props.defaultOpen || groupState === 'failed';
  const [expanded, setExpanded] = useState(() => Boolean(props.active) || openByDefault);
  const wasActiveRef = useRef(Boolean(props.active));

  useEffect(() => {
    if (groupState === 'failed') {
      setExpanded(true);
    }
  }, [groupState]);

  useEffect(() => {
    if (props.active) {
      setExpanded(true);
      wasActiveRef.current = true;
      return;
    }
    if (wasActiveRef.current && props.autoCollapseWhenInactive !== false) {
      setExpanded(groupState === 'failed');
      wasActiveRef.current = false;
    }
  }, [groupState, props.active, props.autoCollapseWhenInactive]);

  if (props.tools.length === 0) {
    return null;
  }

  return (
    <div className={`chat-tool-activity ${groupState} ${expanded ? 'expanded' : 'collapsed'} ${props.active ? 'active' : ''}`}>
      <button
        type="button"
        className="chat-tool-activity-summary"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="chat-tool-activity-copy">
          <strong>{summary.title}</strong>
          {summary.meta ? <em>{summary.meta}</em> : null}
        </span>
        <ChevronDownIcon className="chat-tool-activity-chevron" />
      </button>
      <div id={detailId} className="chat-tool-activity-detail-shell" aria-hidden={!expanded}>
        <div className="chat-tool-activity-detail">
          {props.tools.map((tool) => (
            <ToolActivityRow
              key={tool.id}
              tool={tool}
              openablePaths={props.openablePaths}
              searchQuery={props.searchQuery}
              onOpenPath={props.onOpenPath}
              renderContent={props.renderContent}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChevronDownIcon(props: { className: string }): JSX.Element {
  return (
    <svg className={props.className} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path d="M5.5 7.75L10 12.25L14.5 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ToolActivityRow(props: {
  tool: ToolExecutionEntry;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
  renderContent: (content: string, openablePaths: string[], searchQuery: string, onOpenPath: (path: string) => void) => ReactNode;
}): JSX.Element {
  const language = useUiLanguage();
  const resultSummary = summarizeToolResult(props.tool, language);
  const statusLabel = formatToolStatus(language, props.tool.status);
  const webCitations = props.tool.result ? parseWebCitations(props.tool.result.content) : [];

  return (
    <div className={`chat-tool-activity-row ${props.tool.status}`}>
      <div className="chat-tool-activity-row-main">
        <span>{formatToolActivityLine(props.tool, language)}</span>
        <em>{statusLabel}</em>
      </div>

      {props.tool.result ? (
        <div className={`chat-tool-activity-result ${props.tool.result.isError ? 'error' : ''}`}>
          {props.renderContent(resultSummary.preview, props.openablePaths, props.searchQuery, props.onOpenPath)}
          <ToolResultMetadataPanel result={props.tool.result} onOpenPath={props.onOpenPath} />
          {webCitations.length > 0 ? <WebCitationPanel citations={webCitations} /> : null}
          <MediaResultGrid media={props.tool.result.media} compact />
        </div>
      ) : null}
    </div>
  );
}

export function ToolResultMetadataPanel(props: {
  result: NonNullable<ToolExecutionEntry['result']>;
  onOpenPath: (path: string) => void;
}): JSX.Element | null {
  const language = useUiLanguage();
  const changedFiles = props.result.changedFiles?.filter((file) => file.path) ?? [];
  const artifacts = props.result.artifacts?.filter((artifact) => artifact.path || artifact.title) ?? [];
  const browser = props.result.browser;
  const edit = props.result.edit;
  if (changedFiles.length === 0 && artifacts.length === 0 && !browser && !edit) {
    return null;
  }

  return (
    <div className="chat-tool-result-metadata">
      {changedFiles.length > 0 ? (
        <div className="chat-tool-result-section">
          <strong>{localize(language, '变更文件', 'Changed Files')}</strong>
          <div className="chat-tool-result-file-list">
            {changedFiles.slice(0, 6).map((file) => (
              <button key={`${file.operation}:${file.path}`} type="button" onClick={() => props.onOpenPath(file.path)}>
                <span>{file.path}</span>
                <em>{formatChangedFileMeta(file, language)}</em>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {edit ? (
        <div className="chat-tool-result-section">
          <strong>{localize(language, '编辑指标', 'Edit Metrics')}</strong>
          <span>{formatEditMetrics(edit, language)}</span>
          {edit.recoveryHint ? <em>{edit.recoveryHint}</em> : null}
        </div>
      ) : null}
      {browser ? (
        <div className="chat-tool-result-section">
          <strong>{localize(language, '浏览器验证', 'Browser Verification')}</strong>
          <span>{formatBrowserMetrics(browser, language)}</span>
        </div>
      ) : null}
      {props.result.mcp ? (
        <div className="chat-tool-result-section">
          <strong>MCP</strong>
          <span>{formatMcpMetrics(props.result.mcp, language)}</span>
        </div>
      ) : null}
      {artifacts.length > 0 ? (
        <div className="chat-tool-result-section">
          <strong>{localize(language, '产物', 'Artifacts')}</strong>
          <span>{artifacts.map((artifact) => artifact.path ?? artifact.title ?? artifact.type).join(' · ')}</span>
        </div>
      ) : null}
    </div>
  );
}

function formatChangedFileMeta(file: AgentToolChangedFile, language: 'zh-CN' | 'en-US'): string {
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

function formatEditMetrics(edit: AgentToolEditMetrics, language: 'zh-CN' | 'en-US'): string {
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

function formatBrowserMetrics(browser: AgentToolBrowserResult, language: 'zh-CN' | 'en-US'): string {
  return [
    browser.title,
    browser.url,
    browser.sessionId,
    browser.viewport ? `${browser.viewport.width}x${browser.viewport.height}` : '',
    typeof browser.consoleMessageCount === 'number' ? localize(language, `控制台 ${browser.consoleMessageCount}`, `${browser.consoleMessageCount} console`) : '',
    browser.screenshotPath
  ].filter(Boolean).join(' · ');
}

function formatMcpMetrics(mcp: AgentToolMcpResult, language: 'zh-CN' | 'en-US'): string {
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

export function WebCitationPanel(props: { citations: WebCitationEntry[] }): JSX.Element {
  const language = useUiLanguage();
  const visibleCitations = props.citations.slice(0, 6);
  return (
    <div className="chat-web-citation-panel">
      <div className="chat-web-citation-heading">
        <strong>{localize(language, '搜索来源', 'Search Sources')}</strong>
        <span>{localize(language, `${props.citations.length} 个引用`, `${props.citations.length} citations`)}</span>
      </div>
      <div className="chat-web-citation-list">
        {visibleCitations.map((citation) => (
          <a key={`${citation.id}:${citation.url}`} className="chat-web-citation-card" href={citation.url} target="_blank" rel="noreferrer">
            <span className="chat-web-citation-index">{citation.id}</span>
            <span className="chat-web-citation-copy">
              <strong>{citation.title || citation.url}</strong>
              <em>{[formatCitationHost(citation.url), citation.provider, citation.publishedAt].filter(Boolean).join(' · ')}</em>
              {citation.snippet || citation.description ? <small>{citation.snippet || citation.description}</small> : null}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
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

export function StreamActivityTrail(props: { activities: StreamActivityEntry[] }): JSX.Element | null {
  const language = useUiLanguage();
  const visibleActivities = props.activities.slice(-6);
  if (visibleActivities.length === 0) {
    return null;
  }

  return (
    <div className="chat-stream-activity-trail" aria-label={localize(language, '运行事件', 'Runtime events')}>
      <div className="chat-stream-activity-heading">{localize(language, '运行事件', 'Runtime events')}</div>
      <div className="chat-stream-activity-list">
        {visibleActivities.map((activity) => (
          <div key={activity.id} className={`chat-stream-activity-item ${activity.status}`}>
            <span className={`chat-stage-progress-dot ${activity.status === 'failed' ? 'failed' : activity.status === 'running' ? 'running' : 'completed'}`} aria-hidden="true" />
            <span>
              <strong>{formatStreamActivityTitle(activity, language)}</strong>
              {activity.summary ? <em>{sanitizeStageSummary(activity.summary)}</em> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatStreamActivityTitle(activity: StreamActivityEntry, language: 'zh-CN' | 'en-US'): string {
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

export function StageTimeline(props: { stages: StageExecutionEntry[] }): JSX.Element {
  const language = useUiLanguage();
  const visibleStages = props.stages.slice(-8);
  const completedCount = props.stages.filter((stage) => stage.status === 'completed').length;
  const failedStage = [...props.stages].reverse().find((stage) => stage.status === 'failed');
  const activeStage = [...props.stages].reverse().find((stage) => stage.status === 'running' || stage.status === 'pending');
  const skippedCount = props.stages.filter((stage) => stage.status === 'skipped').length;
  const summaryStage = failedStage ?? activeStage ?? [...props.stages].reverse().find((stage) => stage.status === 'completed') ?? props.stages.at(-1);
  const state = failedStage ? 'failed' : activeStage ? 'running' : 'completed';
  const title = failedStage
    ? localize(language, `阶段失败：${failedStage.title}`, `Stage failed: ${failedStage.title}`)
    : activeStage
      ? localize(language, `正在处理：${activeStage.title}`, `Working on: ${activeStage.title}`)
      : localize(language, `已处理 ${completedCount} 个阶段`, `Processed ${completedCount} stages`);
  const meta = [
    completedCount ? localize(language, `完成 ${completedCount}`, `${completedCount} done`) : '',
    activeStage ? localize(language, '运行中', 'running') : '',
    skippedCount ? localize(language, `跳过 ${skippedCount}`, `${skippedCount} skipped`) : '',
    summaryStage?.summary ? sanitizeStageSummary(summaryStage.summary) : ''
  ].filter(Boolean).join(' · ');

  return (
    <details className={`chat-stage-progress ${state}`} open={state === 'failed'} aria-label={localize(language, '运行阶段', 'Run stages')}>
      <summary className="chat-stage-progress-summary">
        <span className={`chat-stage-progress-dot ${state}`} aria-hidden="true" />
        <span className="chat-stage-progress-copy">
          <strong>{title}</strong>
          {meta ? <em>{meta}</em> : null}
        </span>
        <span className="chat-stage-progress-action">{localize(language, '详情', 'Details')}</span>
      </summary>
      <div className="chat-stage-progress-detail">
        {visibleStages.map((stage) => (
          <div key={stage.stageId} className={`chat-stage-progress-row ${stage.status}`}>
            <span>{stage.title}</span>
            <em>
              {[
                formatStageStatus(language, stage.status),
                formatStageRuntimeMeta(stage),
                stage.summary ? sanitizeStageSummary(stage.summary) : '',
                stage.errorMessage ? sanitizeStageSummary(stage.errorMessage) : '',
                stage.errorCode ? sanitizeStageSummary(stage.errorCode) : '',
                stage.suggestedAction ? sanitizeStageSummary(stage.suggestedAction) : '',
                stage.recoveryActions?.length ? stage.recoveryActions.map((action) => action.label).join(' / ') : ''
              ].filter(Boolean).join(' · ')}
            </em>
          </div>
        ))}
      </div>
    </details>
  );
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

export function ToolInputPreview(props: {
  tool: ToolExecutionEntry;
  renderContent: (content: string, openablePaths: string[], searchQuery: string, onOpenPath: (path: string) => void) => ReactNode;
}): JSX.Element {
  const language = useUiLanguage();
  const compactSummary = summarizeToolInput(props.tool, language);
  const hasCompactSummary = compactSummary.length > 0;

  return (
    <div className="chat-tool-input-preview">
      {hasCompactSummary ? (
        <div className="chat-tool-meta-row">
          {compactSummary.map((item) => (
            <span key={item.label}>
              <strong>{item.label}</strong>
              {item.value}
            </span>
          ))}
        </div>
      ) : null}
      <details className="chat-tool-subdetail">
        <summary>{localize(language, '查看完整输入', 'View full input')}</summary>
        <div className="chat-tool-subdetail-body">
          <pre className="chat-tool-json compact">{JSON.stringify(props.tool.input, null, 2)}</pre>
        </div>
      </details>
    </div>
  );
}

export function MediaResultGrid(props: {
  media?: ChatMediaBlock[];
  compact?: boolean;
  onOpenPath?: (path: string) => void;
  onRevealPath?: (path: string) => void;
}): JSX.Element | null {
  const language = useUiLanguage();
  const media = props.media?.filter((item) => item.data || item.localPath || item.title) ?? [];
  if (media.length === 0) {
    return null;
  }

  return (
    <div className={`chat-media-grid ${props.compact ? 'compact' : ''}`}>
      {media.map((item, index) => {
        const label = item.title || item.localPath?.split('/').pop() || item.mimeType || item.type;
        if (item.type === 'image' && item.data) {
          const src = item.data.startsWith('data:')
            ? item.data
            : `data:${item.mimeType || 'image/png'};base64,${item.data}`;
          return (
            <figure key={`${item.mediaId ?? item.localPath ?? item.type}-${index}`} className="chat-media-card image">
              <img src={src} alt={label} />
              <figcaption>{label}</figcaption>
            </figure>
          );
        }

        if (item.type === 'audio' && item.data) {
          const src = item.data.startsWith('data:')
            ? item.data
            : `data:${item.mimeType || 'audio/wav'};base64,${item.data}`;
          return (
            <div key={`${item.mediaId ?? item.localPath ?? item.type}-${index}`} className="chat-media-card audio">
              <span>{label}</span>
              <audio controls src={src} />
            </div>
          );
        }

        return (
          <div key={`${item.mediaId ?? item.localPath ?? item.type}-${index}`} className="chat-media-card file">
            <strong>{item.type === 'image' ? localize(language, '图片', 'Image') : item.type === 'audio' ? localize(language, '音频', 'Audio') : localize(language, '文件', 'File')}</strong>
            <span>{label}</span>
            {item.mimeType ? <small>{item.mimeType}</small> : null}
            {item.localPath ? <em>{item.localPath}</em> : null}
            {item.localPath && props.onOpenPath ? (
              <div className="chat-media-actions">
                <button className="prototype-secondary small" onClick={() => props.onOpenPath!(item.localPath!)}>
                  {localize(language, '打开', 'Open')}
                </button>
                {props.onRevealPath ? (
                  <button className="prototype-secondary small" onClick={() => props.onRevealPath!(item.localPath!)}>
                    {localize(language, '显示位置', 'Show')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function pairStreamingToolExecutions(
  toolUses: Array<{
    toolUseId: string;
    name: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }>,
  toolResults: Array<{
    toolUseId: string;
    content: string;
    isError?: boolean;
    media?: ChatMediaBlock[];
    changedFiles?: AgentToolChangedFile[];
    browser?: AgentToolBrowserResult;
    edit?: AgentToolEditMetrics;
    mcp?: AgentToolMcpResult;
    artifacts?: AgentToolArtifact[];
    transaction?: AgentToolTransactionSummary;
  }>
): ToolExecutionEntry[] {
  const resultMap = new Map(toolResults.map((result) => [result.toolUseId, result]));

  return toolUses.map((tool) => {
    const result = resultMap.get(tool.toolUseId);
    return {
      id: tool.toolUseId,
      name: tool.name,
      status: result?.isError ? 'failed' : tool.status,
      input: tool.input,
      result: result
        ? {
            content: result.content,
            isError: result.isError,
            media: result.media,
            changedFiles: result.changedFiles,
            browser: result.browser,
            edit: result.edit,
            mcp: result.mcp,
            artifacts: result.artifacts,
            transaction: result.transaction
          }
        : undefined
    };
  });
}

export function pairHistoricalToolExecutions(blocks: ChatContentBlock[]): RenderableChatEntry[] {
  const resultsByToolId = new Map<string, Extract<ChatContentBlock, { type: 'tool_result' }>>();
  const consumedToolResultIds = new Set<string>();

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      resultsByToolId.set(block.toolUseId, block);
    }
  }

  const entries: RenderableChatEntry[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];

    if (block.type === 'tool_use') {
      const result = resultsByToolId.get(block.toolUseId);
      if (result) {
        consumedToolResultIds.add(result.toolUseId);
      }

      entries.push({
        type: 'tool',
        key: block.id ?? `tool-${block.toolUseId}-${index}`,
        tool: {
          id: block.toolUseId,
          name: block.name,
          status: result?.isError ? 'failed' : block.status ?? 'completed',
          input: block.input,
          result: result
            ? {
                content: result.content,
                isError: result.isError,
                media: result.media,
                changedFiles: result.changedFiles,
                browser: result.browser,
                edit: result.edit,
                mcp: result.mcp,
                artifacts: result.artifacts,
                transaction: result.transaction
              }
            : undefined
        }
      });
      continue;
    }

    if (block.type === 'tool_result' && consumedToolResultIds.has(block.toolUseId)) {
      continue;
    }

    entries.push({
      type: 'block',
      key: block.id ?? `${block.type}-${index}`,
      block
    });
  }

  return entries;
}

export function summarizeToolActivity(tools: ToolExecutionEntry[], language: 'zh-CN' | 'en-US'): { title: string; meta: string } {
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

  const zhPrefix = failedCount ? '有操作失败：' : runningCount ? '正在' : '已';
  const enPrefix = failedCount ? 'Some actions failed: ' : runningCount ? 'Running ' : 'Completed ';
  const title = localize(
    language,
    `${zhPrefix}${zhSegments.join('，') || '处理工具'}`,
    `${enPrefix}${enSegments.join(', ') || 'tool activity'}`
  );
  const meta = [
    runningCount ? localize(language, `${runningCount} 个进行中`, `${runningCount} running`) : '',
    failedCount ? localize(language, `${failedCount} 个失败`, `${failedCount} failed`) : '',
    lastTarget ? compactActivityTarget(lastTarget) : ''
  ].filter(Boolean).join(' · ');

  return { title, meta };
}

export function formatToolActivityLine(tool: ToolExecutionEntry, language: 'zh-CN' | 'en-US'): string {
  const kind = getToolActivityKind(tool);
  const target = compactActivityTarget(formatToolActivityTarget(tool) || tool.name);

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
  const lowerName = tool.name.trim().toLowerCase();
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

  return tool.name;
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
  if (tool.status === 'failed' || tool.result?.isError) {
    return true;
  }
  if (tool.result?.media?.length) {
    return true;
  }
  return false;
}

export function isWriteLikeTool(tool: ToolExecutionEntry): boolean {
  return /(write|edit|create_directory|create_file|createfile|write_file|apply|patch|memory_remember|schedule_task|cancel_task)/i.test(tool.name);
}

export function highlightSearchText(text: string, query: string): ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, cursor);
    if (matchIndex === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    parts.push(
      <mark key={`mark-${matchIndex}`} className="chat-search-mark">
        {text.slice(matchIndex, matchIndex + normalizedQuery.length)}
      </mark>
    );
    cursor = matchIndex + normalizedQuery.length;
  }

  return <>{parts}</>;
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
