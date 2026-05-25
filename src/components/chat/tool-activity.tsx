import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react';
import { FolderOpen, ExternalLink } from 'lucide-react';
import type { ChatMediaBlock, ChatMessageMetadata } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Button } from '../ui/index';
import type {
  StageExecutionEntry,
  StreamActivityEntry,
  ToolExecutionEntry,
  WebCitationEntry
} from './tool/tool-types';
import {
  formatBrowserMetrics,
  formatChangedFileMeta,
  formatCitationHost,
  formatEditMetrics,
  formatMcpMetrics,
  formatStageRuntimeMeta,
  formatStageStatus,
  formatStreamActivityTitle,
  formatToolActivityLine,
  formatToolStatus,
  parseWebCitations,
  sanitizeStageSummary,
  summarizeToolActivity,
  summarizeToolInput,
  summarizeToolResult
} from './tool/tool-formatters';
import { ToolDetailOverlay, type UiDisclosureItem } from './tool/tool-disclosure';

// Barrel — keep the historical `./tool-activity` public surface stable for
// ConversationMessage, the transcript modules, and the render tests. The
// types / formatters / builders were extracted into ./tool/* by U47-4.
export * from './tool/tool-types';
export * from './tool/tool-formatters';
export * from './tool/tool-builders';

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

export function ToolActivityGroup(props: {
  tools: ToolExecutionEntry[];
  defaultOpen?: boolean;
  active?: boolean;
  autoCollapseWhenInactive?: boolean;
  collapseBeforeAssistantText?: boolean;
  showDiagnosticMeta?: boolean;
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
  const summary = summarizeToolActivity(props.tools, language, { includeDiagnosticMeta: props.showDiagnosticMeta });
  const openByDefault = props.defaultOpen;
  const shouldCollapseBeforeAssistantText = Boolean(props.collapseBeforeAssistantText && !props.active);
  const [expanded, setExpanded] = useState(() => (shouldCollapseBeforeAssistantText ? false : Boolean(props.active) || openByDefault));
  const [manualCollapseOverride, setManualCollapseOverride] = useState(false);
  const wasActiveRef = useRef(Boolean(props.active));
  const renderedExpanded = shouldCollapseBeforeAssistantText && !manualCollapseOverride ? false : expanded;

  useEffect(() => {
    if (groupState === 'failed' && props.showDiagnosticMeta) {
      setExpanded(true);
    }
  }, [groupState, props.showDiagnosticMeta]);

  useEffect(() => {
    if (props.active) {
      setExpanded(true);
      setManualCollapseOverride(false);
      wasActiveRef.current = true;
      return;
    }
    if (wasActiveRef.current && props.autoCollapseWhenInactive !== false) {
      setExpanded(Boolean(groupState === 'failed' && props.showDiagnosticMeta));
      setManualCollapseOverride(false);
      wasActiveRef.current = false;
    }
  }, [groupState, props.active, props.autoCollapseWhenInactive, props.showDiagnosticMeta]);

  useEffect(() => {
    if (!shouldCollapseBeforeAssistantText) {
      setManualCollapseOverride(false);
    }
  }, [shouldCollapseBeforeAssistantText]);

  if (props.tools.length === 0) {
    return null;
  }

  return (
    <div className={`chat-tool-activity ${groupState} ${renderedExpanded ? 'expanded' : 'collapsed'} ${props.active ? 'active' : ''}`}>
      <Button
        variant="ghost"
        className="chat-tool-activity-summary"
        aria-expanded={renderedExpanded}
        aria-controls={detailId}
        onClick={() => {
          const nextExpanded = !renderedExpanded;
          setExpanded(nextExpanded);
          if (shouldCollapseBeforeAssistantText) {
            setManualCollapseOverride(true);
          }
        }}
      >
        <span className="chat-tool-activity-copy">
          <strong>{summary.title}</strong>
          {summary.meta ? <em>{summary.meta}</em> : null}
        </span>
        <ChevronDownIcon className="chat-tool-activity-chevron" />
      </Button>
      <div id={detailId} className="chat-tool-activity-detail-shell" aria-hidden={!renderedExpanded}>
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
          <ToolDetailOverlay items={buildToolDisclosureItems(props.tool, resultSummary.preview, language)} />
        </div>
      ) : (
        <ToolDetailOverlay items={buildToolDisclosureItems(props.tool, '', language)} />
      )}
    </div>
  );
}

function buildToolDisclosureItems(tool: ToolExecutionEntry, resultPreview: string, language: 'zh-CN' | 'en-US'): UiDisclosureItem[] {
  const inputText = JSON.stringify(tool.input ?? {}, null, 2);
  const items: UiDisclosureItem[] = [
    {
      id: `${tool.id}:input`,
      title: localize(language, '调用参数', 'Input'),
      compactSummary: tool.title ?? tool.name,
      status: tool.status,
      copyText: inputText,
      rawDebugText: inputText,
      detail: <pre>{inputText}</pre>
    }
  ];
  if (tool.result) {
    const resultText = tool.result.content || resultPreview || '';
    const rawText = JSON.stringify(tool.result, null, 2);
    items.push({
      id: `${tool.id}:result`,
      title: tool.result.isError ? localize(language, '错误结果', 'Error result') : localize(language, '结果摘要', 'Result'),
      compactSummary: resultPreview || resultText.slice(0, 120),
      status: tool.result.isError || tool.status === 'failed' ? 'failed' : tool.status,
      copyText: resultText,
      rawDebugText: rawText,
      detail: <pre>{resultText}</pre>
    });
  }
  return items;
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
              <Button key={`${file.operation}:${file.path}`} size="compact" variant="ghost" onClick={() => props.onOpenPath(file.path)}>
                <span>{file.path}</span>
                <em>{formatChangedFileMeta(file, language)}</em>
              </Button>
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
                <Button size="sm" variant="secondary" leadingIcon={<ExternalLink size={13} aria-hidden="true" />} onClick={() => props.onOpenPath!(item.localPath!)}>
                  {localize(language, '打开', 'Open')}
                </Button>
                {props.onRevealPath ? (
                  <Button size="sm" variant="secondary" leadingIcon={<FolderOpen size={13} aria-hidden="true" />} onClick={() => props.onRevealPath!(item.localPath!)}>
                    {localize(language, '显示位置', 'Show')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
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
