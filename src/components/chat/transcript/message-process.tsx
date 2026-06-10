import { Fragment, useCallback, useMemo, useRef, type JSX, type ReactNode } from 'react';
import type { AgentCoreMessagePart, AgentPermissionImpact, ChatMessage } from '../../../../shared/types';
import { localize, useUiLanguage } from '../../../i18n';
import { renderChatContent } from './chat-markdown';
import {
  buildTranscriptViewItems,
  collapseCompletedToolGroups,
  type TranscriptViewItem
} from './transcript-view-model';
import {
  type ToolExecutionEntry,
  type StageExecutionEntry,
  type StreamActivityEntry,
  ToolActivityGroup,
  ToolStepSummaryRow,
  StreamActivityTrail,
  StageTimeline,
  buildCompletedMessageProcessTools,
  shouldExpandToolByDefault
} from '../tool-activity';

export function hasStructuredToolBlocks(message: ChatMessage): boolean {
  return Boolean(
    message.metadata?.agentCoreParts?.some(
      (part) => part.kind === 'tool_call' || part.kind === 'tool_result' || part.kind === 'tool_error'
    )
  );
}

export function hasRenderableProcessTimeline(message: ChatMessage): boolean {
  return Boolean(message.metadata?.agentProcessActivities?.length);
}

export function hasRenderableAgentCoreParts(message: ChatMessage): boolean {
  return Boolean(message.metadata?.agentCoreParts?.length);
}

export function buildMessageProcessTools(message: ChatMessage): ToolExecutionEntry[] {
  return buildCompletedMessageProcessTools(message);
}

type AssistantTextRenderMode = 'markdown' | 'plain' | 'streaming-hybrid';

export function renderAgentCoreParts(input: {
  parts: AgentCoreMessagePart[];
  developerMode: boolean;
  collapseCompletedToolGroups?: boolean;
  assistantTextRenderMode?: AssistantTextRenderMode;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): ReactNode[] {
  const items = buildTranscriptViewItems(input.parts);
  const renderItems = input.collapseCompletedToolGroups ? collapseCompletedToolGroups(items) : items;
  return renderItems
    .filter((item) => item.kind !== 'assistant_thinking' || input.developerMode)
    .map((item) => (
      <TranscriptItemRenderer
        key={`core-node-${item.id}`}
        item={item}
        developerMode={input.developerMode}
        assistantTextRenderMode={input.assistantTextRenderMode}
        openablePaths={input.openablePaths}
        searchQuery={input.searchQuery}
        onOpenPath={input.onOpenPath}
      />
    ));
}

export function TranscriptItemRenderer(props: {
  item: TranscriptViewItem;
  developerMode: boolean;
  assistantTextRenderMode?: AssistantTextRenderMode;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): JSX.Element | null {
  const { item } = props;
  if (item.kind === 'assistant_text') {
    return (
      <div
        className="chat-assistant-answer transcript-view-item"
        data-transcript-kind={item.displayKind}
        data-transcript-status={item.status}
      >
        {renderAssistantText({
          content: item.text,
          mode: props.assistantTextRenderMode,
          openablePaths: props.openablePaths,
          searchQuery: props.searchQuery,
          onOpenPath: props.onOpenPath
        })}
      </div>
    );
  }
  if (item.kind === 'assistant_thinking') {
    return props.developerMode ? (
      <AgentCoreContextBlock item={item} title={item.title} content={item.thinking} />
    ) : null;
  }
  if (item.kind === 'tool_group') {
    return (
      <div
        className="transcript-view-item tool"
        data-transcript-kind={item.displayKind}
        data-transcript-status={item.status}
      >
        <ToolStepSummaryRow
          tools={item.tools}
          stepKind={item.stepKind}
          stepSummary={item.stepSummary}
          status={item.status}
          failureCount={item.failureCount}
          runningCount={item.runningCount}
          openablePaths={props.openablePaths}
          searchQuery={props.searchQuery}
          onOpenPath={props.onOpenPath}
          renderContent={renderChatContent}
        />
      </div>
    );
  }
  if (item.kind === 'context_summary') {
    return <AgentCoreContextBlock item={item} title="上下文摘要" content={item.summary} />;
  }
  if (item.kind === 'todo_update') {
    return <AgentCoreTodoBlock item={item} items={item.items} />;
  }
  if (item.kind === 'permission_request') {
    return (
      <Fragment>
        <AgentCoreContextBlock
          item={item}
          title="等待权限确认"
          content={[item.toolName, item.reason].filter(Boolean).join('\n')}
          tone={item.risk === 'high' ? 'error' : undefined}
        />
        <PermissionImpactBlock impact={item.impact} />
      </Fragment>
    );
  }
  if (item.kind === 'user_input_request') {
    return <AgentCoreContextBlock item={item} title="等待用户回答" content={item.question} />;
  }
  if (item.kind === 'run_error') {
    return <AgentCoreContextBlock item={item} title="运行错误" content={item.error} tone="error" />;
  }
  if (item.kind === 'system_event' && (props.developerMode || item.status === 'failed' || item.compactSummary)) {
    return (
      <AgentCoreContextBlock
        item={item}
        title={item.title}
        content={item.summary ?? ''}
        tone={item.status === 'failed' ? 'error' : undefined}
      />
    );
  }
  return null;
}

export function renderProcessTimeline(input: {
  content: string;
  activityItems: StreamActivityEntry[];
  toolExecutions: ToolExecutionEntry[];
  visibleStages: StageExecutionEntry[];
  autoExpandActiveToolGroup?: boolean;
  developerMode?: boolean;
  assistantTextRenderMode?: AssistantTextRenderMode;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): ReactNode[] {
  const content = input.content ?? '';
  const toolMap = new Map(input.toolExecutions.map((tool) => [tool.id, tool]));
  const stageMap = new Map(input.visibleStages.map((stage) => [stage.stageId, stage]));
  const placedToolIds = new Set<string>();
  const placedStageIds = new Set<string>();
  const nodes: ReactNode[] = [];
  const activities = normalizeProcessActivities(input.activityItems, content.length);
  let cursor = 0;

  const pushText = (start: number, end: number): void => {
    if (end <= start) {
      return;
    }
    const slice = content.slice(start, end);
    if (!slice.trim()) {
      return;
    }
    nodes.push(
      <div className="chat-assistant-answer" key={`process-text-${nodes.length}-${start}-${end}`}>
        {renderAssistantText({
          content: slice,
          mode: input.assistantTextRenderMode,
          openablePaths: input.openablePaths,
          searchQuery: input.searchQuery,
          onOpenPath: input.onOpenPath
        })}
      </div>
    );
  };

  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index];
    const offset = clampProcessOffset(activity.offset, content.length);
    pushText(cursor, offset);
    cursor = Math.max(cursor, offset);

    if (activity.type === 'tool') {
      const toolActivities = [activity];
      while (
        activities[index + 1]?.type === 'tool' &&
        clampProcessOffset(activities[index + 1].offset, content.length) === offset
      ) {
        index += 1;
        toolActivities.push(activities[index]);
      }
      const tools = toolActivities
        .flatMap((item) => item.toolUseIds ?? [])
        .map((toolUseId) => toolMap.get(toolUseId))
        .filter((tool): tool is ToolExecutionEntry => Boolean(tool));
      for (const tool of tools) {
        placedToolIds.add(tool.id);
      }
      if (tools.length > 0) {
        const activeToolGroup = Boolean(input.autoExpandActiveToolGroup && offset === content.length);
        const hasAssistantTextAfterToolGroup = content.slice(offset).trim().length > 0;
        nodes.push(
          <ToolActivityGroup
            key={`process-tool-${toolActivities.map((item) => item.id).join(':')}`}
            tools={tools}
            defaultOpen={tools.some(shouldExpandToolByDefault)}
            active={activeToolGroup}
            collapseBeforeAssistantText={hasAssistantTextAfterToolGroup}
            showDiagnosticMeta={input.developerMode}
            openablePaths={input.openablePaths}
            searchQuery={input.searchQuery}
            onOpenPath={input.onOpenPath}
            renderContent={renderChatContent}
          />
        );
        continue;
      }
    }

    if (activity.type === 'stage' && activity.stageId && stageMap.has(activity.stageId)) {
      placedStageIds.add(activity.stageId);
      nodes.push(<StageTimeline key={`process-stage-${activity.id}`} stages={[stageMap.get(activity.stageId)!]} />);
      continue;
    }

    nodes.push(<StreamActivityTrail key={`process-activity-${activity.id}`} activities={[activity]} />);
  }

  pushText(cursor, content.length);

  const unplacedTools = input.toolExecutions.filter((tool) => !placedToolIds.has(tool.id));
  if (unplacedTools.length > 0) {
    nodes.push(
      <ToolActivityGroup
        key="process-unplaced-tools"
        tools={unplacedTools}
        defaultOpen={unplacedTools.some(shouldExpandToolByDefault)}
        active={Boolean(input.autoExpandActiveToolGroup && content.length === 0)}
        showDiagnosticMeta={input.developerMode}
        openablePaths={input.openablePaths}
        searchQuery={input.searchQuery}
        onOpenPath={input.onOpenPath}
        renderContent={renderChatContent}
      />
    );
  }

  const unplacedStages = input.visibleStages.filter((stage) => !placedStageIds.has(stage.stageId));
  if (unplacedStages.length > 0) {
    nodes.push(<StageTimeline key="process-unplaced-stages" stages={unplacedStages} />);
  }

  return nodes;
}

function renderAssistantText(input: {
  content: string;
  mode?: AssistantTextRenderMode;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): JSX.Element {
  if (input.mode === 'plain') {
    return renderPlainStreamingText(input.content);
  }
  if (input.mode === 'streaming-hybrid') {
    return (
      <StreamingHybridAssistantText
        content={input.content}
        openablePaths={input.openablePaths}
        searchQuery={input.searchQuery}
        onOpenPath={input.onOpenPath}
      />
    );
  }
  return renderChatContent(input.content, input.openablePaths, input.searchQuery, input.onOpenPath);
}

export function renderPlainStreamingText(content: string): JSX.Element {
  return (
    <div className="chat-rich-text-block chat-streaming-text-block">
      <div className="chat-rich-text-line chat-streaming-text-line">{content}</div>
    </div>
  );
}

function StreamingHybridAssistantText(props: {
  content: string;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const segments = splitStreamingMarkdownContent(props.content);
  const onOpenPathRef = useRef(props.onOpenPath);
  onOpenPathRef.current = props.onOpenPath;
  const stableOnOpenPath = useCallback((path: string) => onOpenPathRef.current(path), []);
  const openablePathsKey = props.openablePaths.join('\0');
  const stableOpenablePaths = useMemo(() => props.openablePaths, [openablePathsKey]);
  const markdownPrefix = useMemo(() => {
    if (!segments.markdownPrefix.trim()) {
      return null;
    }
    return renderChatContent(segments.markdownPrefix, stableOpenablePaths, props.searchQuery, stableOnOpenPath);
  }, [segments.markdownPrefix, stableOpenablePaths, props.searchQuery, stableOnOpenPath]);

  if (!markdownPrefix) {
    return renderPlainStreamingText(props.content);
  }

  return (
    <>
      <div className="chat-streaming-markdown-prefix">{markdownPrefix}</div>
      {segments.liveTail.trim() ? renderPlainStreamingText(segments.liveTail) : null}
    </>
  );
}

function splitStreamingMarkdownContent(content: string): { markdownPrefix: string; liveTail: string } {
  const boundary = findLastStableMarkdownBoundary(content);
  if (boundary <= 0) {
    return { markdownPrefix: '', liveTail: content };
  }
  return {
    markdownPrefix: content.slice(0, boundary).trimEnd(),
    liveTail: content.slice(boundary).replace(/^\n+/, '')
  };
}

function findLastStableMarkdownBoundary(content: string): number {
  let bestBoundary = 0;
  const boundaryPattern = /\n{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = boundaryPattern.exec(content)) !== null) {
    const boundary = match.index + match[0].length;
    if (!hasOpenMarkdownFence(content.slice(0, boundary))) {
      bestBoundary = boundary;
    }
  }
  return bestBoundary;
}

function hasOpenMarkdownFence(content: string): boolean {
  let fenceMarker: '```' | '~~~' | null = null;
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart();
    if (!fenceMarker) {
      if (trimmed.startsWith('```')) {
        fenceMarker = '```';
      } else if (trimmed.startsWith('~~~')) {
        fenceMarker = '~~~';
      }
      continue;
    }
    if (trimmed.startsWith(fenceMarker)) {
      fenceMarker = null;
    }
  }
  return Boolean(fenceMarker);
}

function normalizeProcessActivities(
  activityItems: StreamActivityEntry[],
  contentLength: number
): StreamActivityEntry[] {
  const byId = new Map<string, StreamActivityEntry>();
  for (const activity of activityItems) {
    const existing = byId.get(activity.id);
    byId.set(activity.id, existing ? { ...activity, createdAt: existing.createdAt } : activity);
  }
  return [...byId.values()].sort((left, right) => {
    const leftOffset = clampProcessOffset(left.offset, contentLength);
    const rightOffset = clampProcessOffset(right.offset, contentLength);
    if (leftOffset !== rightOffset) {
      return leftOffset - rightOffset;
    }
    const timeOrder = left.createdAt.localeCompare(right.createdAt);
    if (timeOrder !== 0) {
      return timeOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function clampProcessOffset(offset: number, contentLength: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.min(contentLength, Math.floor(offset)));
}

function AgentCoreContextBlock(props: {
  item?: TranscriptViewItem;
  title: string;
  content: string;
  tone?: 'error';
}): JSX.Element {
  return (
    <div
      className={`chat-content-block transcript-view-item ${props.tone === 'error' ? 'tool-result error' : 'fallback'}`}
      data-transcript-kind={props.item?.displayKind}
      data-transcript-status={props.item?.status}
    >
      <div className="chat-content-block-title">{props.title}</div>
      <div className="chat-content-block-body">{props.content}</div>
    </div>
  );
}

function AgentCoreTodoBlock(props: {
  item?: TranscriptViewItem;
  items: Extract<AgentCoreMessagePart, { kind: 'todo_update' }>['items'];
}): JSX.Element {
  const language = useUiLanguage();
  const labels = {
    pending: localize(language, '待处理', 'Pending'),
    in_progress: localize(language, '进行中', 'In progress'),
    completed: localize(language, '已完成', 'Completed'),
    cancelled: localize(language, '已取消', 'Cancelled')
  };
  return (
    <div
      className="chat-content-block transcript-view-item tool"
      data-transcript-kind={props.item?.displayKind}
      data-transcript-status={props.item?.status}
    >
      <div className="chat-content-block-title">{localize(language, '任务清单', 'Task List')}</div>
      <div className="chat-content-block-body">
        <div className="chat-rich-list-block">
          {props.items.map((item) => (
            <div key={item.id} className="chat-rich-list-line">
              <span>•</span>
              <div>
                {labels[item.status]} · {item.title}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PermissionImpactBlock(props: { impact?: AgentPermissionImpact }): JSX.Element | null {
  const language = useUiLanguage();
  const impact = props.impact;
  if (!impact) {
    return null;
  }

  const entries = [
    impact.toolTitle || impact.toolName
      ? localize(
          language,
          `工具：${impact.toolTitle || impact.toolName}`,
          `Tool: ${impact.toolTitle || impact.toolName}`
        )
      : '',
    impact.paths?.length
      ? localize(language, `路径：${impact.paths.join(' · ')}`, `Paths: ${impact.paths.join(' · ')}`)
      : '',
    impact.commands?.length
      ? localize(language, `命令：${impact.commands.join(' · ')}`, `Commands: ${impact.commands.join(' · ')}`)
      : '',
    impact.mcp?.pluginName || impact.mcp?.pluginId || impact.mcp?.toolName
      ? localize(
          language,
          `MCP：${[impact.mcp.pluginName ?? impact.mcp.pluginId, impact.mcp.toolName].filter(Boolean).join(' / ')}`,
          `MCP: ${[impact.mcp.pluginName ?? impact.mcp.pluginId, impact.mcp.toolName].filter(Boolean).join(' / ')}`
        )
      : '',
    impact.mcp?.permission || impact.mcp?.risk || impact.mcp?.policySource
      ? localize(
          language,
          `MCP 策略：${[impact.mcp.permission, impact.mcp.risk, impact.mcp.policySource].filter(Boolean).join(' / ')}`,
          `MCP policy: ${[impact.mcp.permission, impact.mcp.risk, impact.mcp.policySource].filter(Boolean).join(' / ')}`
        )
      : '',
    impact.cwd ? localize(language, `目录：${impact.cwd}`, `Directory: ${impact.cwd}`) : '',
    impact.reason ? localize(language, `原因：${impact.reason}`, `Reason: ${impact.reason}`) : '',
    impact.permissionPolicy
      ? localize(language, `权限策略：${impact.permissionPolicy}`, `Permission: ${impact.permissionPolicy}`)
      : '',
    impact.checkpointPolicy
      ? localize(language, `恢复策略：${impact.checkpointPolicy}`, `Recovery: ${impact.checkpointPolicy}`)
      : ''
  ].filter(Boolean);
  const detailEntries = impact.inputSummary?.filter(Boolean).slice(0, 4) ?? [];
  if (entries.length === 0 && detailEntries.length === 0) {
    return null;
  }

  return (
    <div className="chat-permission-impact">
      {entries.map((entry) => (
        <span key={entry}>{entry}</span>
      ))}
      {detailEntries.map((entry) => (
        <span key={`detail:${entry}`}>{entry}</span>
      ))}
    </div>
  );
}
