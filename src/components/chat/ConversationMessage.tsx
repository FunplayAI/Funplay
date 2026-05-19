import { Fragment, useState, type JSX, type ReactNode } from 'react';
import type {
  AgentCoreMessagePart,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTransactionSummary,
  AgentPermissionImpact,
  AgentUserInputOption,
  ChatContentBlock,
  ChatMediaBlock,
  ChatMessage
} from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { getVisibleRuntimeStages } from './runtime-display';
import { renderChatInline, revealLocalFilePath } from './inline-renderer';
import {
  type ToolExecutionEntry,
  type StageExecutionEntry,
  type StreamActivityEntry,
  ToolActivityGroup,
  StreamActivityTrail,
  ChevronDownIcon,
  AssistantMetadataPanel,
  StageTimeline,
  MediaResultGrid,
  pairStreamingToolExecutions,
  pairHistoricalToolExecutions,
  buildCompletedMessageProcessTools,
  buildToolsFromContentBlocks,
  shouldExpandToolByDefault,
  formatCompletedProcessTitle,
  formatAbsoluteTime,
  highlightSearchText
} from './tool-activity';

interface ParsedCodeBlock {
  type: 'code';
  language?: string;
  content: string;
}

interface ParsedHeadingBlock {
  type: 'heading';
  level: 1 | 2 | 3 | 4;
  text: string;
}

interface ParsedParagraphBlock {
  type: 'paragraph';
  text: string;
}

interface ParsedListBlock {
  type: 'list';
  items: string[];
}

interface ParsedQuoteBlock {
  type: 'quote';
  text: string;
}

interface ParsedDividerBlock {
  type: 'divider';
}

interface ParsedTableBlock {
  type: 'table';
  headers: string[];
  rows: string[][];
}

type ParsedChatBlock = ParsedCodeBlock | ParsedHeadingBlock | ParsedParagraphBlock | ParsedListBlock | ParsedQuoteBlock | ParsedDividerBlock | ParsedTableBlock;

const TOOL_RESULT_SUMMARY_CHARS = 900;
const TOOL_RESULT_SUMMARY_LINES = 8;
const PSEUDO_TOOL_TEXT_LINE_PATTERNS = [
  /^\s*\[Previous tool call\](?:\s|$)/i,
  /^\s*\[Previous tool result\](?:\s|$)/i,
  /^\s*Previous tool call\b/i,
  /^\s*Previous tool result\b/i,
  /^\s*\[Tool\]\s+\S+/i,
  /^\s*\[Tool Result\](?:\s|$)/i
];

export function ChatTranscriptMessage(props: {
  message: ChatMessage;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
  developerMode: boolean;
  rewindSnapshotId?: string;
  onRestoreCheckpoint?: (snapshotId: string) => void;
  highlighted?: boolean;
}): JSX.Element {
  const language = useUiLanguage();
  const isAssistant = props.message.role === 'assistant';
  const copyText = getMessagePlainText(props.message, props.developerMode);

  return (
    <div
      className={`chat-transcript-row ${props.message.role} ${props.highlighted ? 'restored-target' : ''}`}
      data-message-id={props.message.id}
    >
      <div className={`chat-transcript-avatar ${props.message.role}`}>{isAssistant ? 'AI' : 'You'}</div>
      <div className={`chat-transcript-bubble ${props.message.role}`}>
        <div className="chat-transcript-meta">
          {isAssistant ? (
            <CompletedMessageProcessSummary
              message={props.message}
              developerMode={props.developerMode}
              openablePaths={props.openablePaths}
              onOpenPath={props.onOpenPath}
            />
          ) : (
            <span className="chat-transcript-author">{localize(language, '你', 'You')}</span>
          )}
          <div className="chat-transcript-meta-right">
            <span className="chat-transcript-time">{formatAbsoluteTime(language, props.message.createdAt)}</span>
            {!isAssistant && props.rewindSnapshotId && props.onRestoreCheckpoint ? (
              <button
                className="chat-transcript-rewind"
                onClick={() => props.onRestoreCheckpoint?.(props.rewindSnapshotId!)}
                aria-label={localize(language, '回退到这里', 'Rewind to here')}
                title={localize(language, '回退到这里', 'Rewind to here')}
              >
                {localize(language, '回退到这里', 'Rewind to here')}
              </button>
            ) : null}
            <button
              className="chat-transcript-copy"
              onClick={() => navigator.clipboard.writeText(copyText).catch(() => {})}
              aria-label={localize(language, '复制消息', 'Copy message')}
              title={localize(language, '复制消息', 'Copy message')}
            >
              {localize(language, '复制', 'Copy')}
            </button>
          </div>
        </div>
        <div className="chat-transcript-content">
          {renderChatMessageBlocks(props.message, props.openablePaths, props.searchQuery, props.onOpenPath, props.developerMode)}
        </div>
        {isAssistant ? <AssistantMetadataPanel metadata={props.message.metadata} developerMode={props.developerMode} /> : null}
      </div>
    </div>
  );
}

function CompletedMessageProcessSummary(props: {
  message: ChatMessage;
  developerMode: boolean;
  openablePaths: string[];
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const processTools = buildCompletedMessageProcessTools(props.message);
  const title = formatCompletedProcessTitle(props.message.metadata, props.message.createdAt, language);
  const rendersProcessInline = hasRenderableProcessTimeline(props.message) || hasStructuredToolBlocks(props.message);

  if (processTools.length === 0 || rendersProcessInline) {
    return <span className="chat-transcript-author">{title}</span>;
  }

  return (
    <details className="chat-completed-process">
      <summary className="chat-completed-process-summary">
        <span>{title}</span>
        <ChevronDownIcon className="chat-completed-process-chevron" />
      </summary>
      <div className="chat-completed-process-detail">
        <ToolActivityGroup
          tools={processTools}
          defaultOpen
          openablePaths={props.openablePaths}
          searchQuery=""
          onOpenPath={props.onOpenPath}
          renderContent={renderChatContent}
        />
        {!props.developerMode ? null : (
          <div className="chat-completed-process-note">
            {localize(language, '开发者模式：正文只渲染最终回复，工具过程来自结构化历史块。', 'Developer mode: the body renders only the final reply; tool activity comes from structured history blocks.')}
          </div>
        )}
      </div>
    </details>
  );
}

export function PendingTranscriptMessage(props: { prompt: string }): JSX.Element {
  const language = useUiLanguage();
  if (!props.prompt.trim()) {
    return <></>;
  }

  const now = new Date().toISOString();

  return (
    <>
      <div className="chat-transcript-row user pending">
        <div className="chat-transcript-avatar user">You</div>
        <div className="chat-transcript-bubble user pending">
          <div className="chat-transcript-meta">
            <span className="chat-transcript-author">{localize(language, '你', 'You')}</span>
            <span className="chat-transcript-time">{formatAbsoluteTime(language, now)}</span>
          </div>
          <div className="chat-transcript-content">
            <div className="chat-rich-text-line">{props.prompt}</div>
          </div>
        </div>
      </div>

      <div className="chat-transcript-row assistant pending">
        <div className="chat-transcript-avatar assistant">AI</div>
        <div className="chat-transcript-bubble assistant pending">
          <div className="chat-transcript-meta">
            <span className="chat-transcript-author">{localize(language, '正在处理', 'Processing')}</span>
            <span className="chat-transcript-time">{localize(language, '生成中…', 'Generating…')}</span>
          </div>
          <div className="chat-pending-stack" aria-live="polite">
            <div className="chat-pending-line strong">{localize(language, '正在准备回复…', 'Preparing response…')}</div>
            <div className="chat-pending-line">
              {localize(language, '运行状态会在输入框上方持续更新。', 'Runtime status will update above the input box.')}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function StreamingTranscriptMessage(props: {
  prompt: string;
  content: string;
  thinkingContent: string;
  toolUses: Array<{
    toolUseId: string;
    name: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }>;
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
  }>;
  stages: StageExecutionEntry[];
  activityItems: StreamActivityEntry[];
  agentCoreParts?: AgentCoreMessagePart[];
  pendingPermission?: {
    requestId: string;
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    impact?: AgentPermissionImpact;
  };
  pendingUserInput?: {
    requestId: string;
    title: string;
    question: string;
    detail?: string;
    options?: AgentUserInputOption[];
    multiSelect?: boolean;
    allowFreeText?: boolean;
    placeholder?: string;
  };
  statusMessage: string;
  developerMode: boolean;
  openablePaths: string[];
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const now = new Date().toISOString();
  const toolExecutions = pairStreamingToolExecutions(props.toolUses, props.toolResults);
  const visibleStages = getVisibleRuntimeStages(props.stages, props.developerMode);
  const agentCoreTimeline = props.agentCoreParts?.length
    ? renderAgentCoreParts({
        parts: props.agentCoreParts,
        developerMode: props.developerMode,
        openablePaths: props.openablePaths,
        searchQuery: '',
        onOpenPath: props.onOpenPath
      })
    : [];
  const processTimeline = renderProcessTimeline({
    content: props.content,
    activityItems: props.activityItems,
    toolExecutions,
    visibleStages,
    autoExpandActiveToolGroup: true,
    openablePaths: props.openablePaths,
    searchQuery: '',
    onOpenPath: props.onOpenPath
  });
  const hasAgentCoreTimeline = agentCoreTimeline.length > 0;
  const hasProcessTimeline = processTimeline.length > 0;

  return (
    <>
      <div className="chat-transcript-row user pending">
        <div className="chat-transcript-avatar user">You</div>
        <div className="chat-transcript-bubble user pending">
          <div className="chat-transcript-meta">
            <span className="chat-transcript-author">{localize(language, '你', 'You')}</span>
            <span className="chat-transcript-time">{formatAbsoluteTime(language, now)}</span>
          </div>
          <div className="chat-transcript-content">
            <div className="chat-rich-text-line">{props.prompt}</div>
          </div>
        </div>
      </div>

      <div className="chat-transcript-row assistant pending">
        <div className="chat-transcript-avatar assistant">AI</div>
        <div className="chat-transcript-bubble assistant pending">
          <div className="chat-transcript-meta">
            <span className="chat-transcript-author">{localize(language, '正在处理', 'Processing')}</span>
            <span className="chat-transcript-time">{props.statusMessage || localize(language, '生成中…', 'Generating…')}</span>
          </div>
          <div className="chat-transcript-content">
            {props.pendingPermission ? (
              <div className={`chat-content-block permission ${props.pendingPermission.risk}`}>
                <div className="chat-content-block-title">{localize(language, '等待权限确认', 'Permission Required')}</div>
                <div className="chat-content-block-body">
                  <strong>{props.pendingPermission.title}</strong>
                  <span>{props.pendingPermission.detail}</span>
                  <PermissionImpactBlock impact={props.pendingPermission.impact} />
                </div>
              </div>
            ) : null}
            {props.pendingUserInput ? (
              <div className="chat-content-block permission">
                <div className="chat-content-block-title">{localize(language, '等待用户回答', 'Waiting for User')}</div>
                <div className="chat-content-block-body">
                  <strong>{props.pendingUserInput.title}</strong>
                  <span>{props.pendingUserInput.question}</span>
                </div>
              </div>
            ) : null}
            {hasAgentCoreTimeline ? agentCoreTimeline : hasProcessTimeline ? processTimeline : (
              <div className="chat-pending-stack" aria-live="polite">
                <div className="chat-pending-line strong">{props.statusMessage || localize(language, '正在准备回复…', 'Preparing response…')}</div>
                <div className="chat-pending-line">{localize(language, '消息会实时出现在这里；系统会根据当前会话与工作区上下文持续生成。', 'The reply will stream here in real time based on the current session and workspace context.')}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function hasStructuredToolBlocks(message: ChatMessage): boolean {
  return Boolean(message.contentBlocks?.some((block) => block.type === 'tool_use' || block.type === 'tool_result'));
}

function hasRenderableProcessTimeline(message: ChatMessage): boolean {
  return Boolean(message.metadata?.agentProcessActivities?.length);
}

function hasRenderableAgentCoreParts(message: ChatMessage): boolean {
  return Boolean(message.metadata?.agentCoreParts?.length);
}

function buildMessageProcessTools(message: ChatMessage): ToolExecutionEntry[] {
  const contentBlockTools = buildToolsFromContentBlocks(message.contentBlocks);
  if (contentBlockTools.length > 0) {
    return contentBlockTools;
  }
  return buildCompletedMessageProcessTools(message);
}

function orderAgentCoreParts(parts: AgentCoreMessagePart[]): AgentCoreMessagePart[] {
  return [...parts].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

function renderAgentCoreParts(input: {
  parts: AgentCoreMessagePart[];
  developerMode: boolean;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): ReactNode[] {
  const entries: Array<
    | { type: 'node'; node: ReactNode; key: string }
    | { type: 'tool'; tool: ToolExecutionEntry; key: string }
  > = [];
  const toolsById = new Map<string, ToolExecutionEntry>();

  for (const part of orderAgentCoreParts(input.parts)) {
    if (part.kind === 'assistant_text') {
      entries.push({
        type: 'node',
        key: part.id,
        node: renderChatContent(part.text, input.openablePaths, input.searchQuery, input.onOpenPath)
      });
      continue;
    }
    if (part.kind === 'assistant_thinking') {
      if (input.developerMode) {
        entries.push({
          type: 'node',
          key: part.id,
          node: <AgentCoreContextBlock title="Thinking" content={part.thinking} />
        });
      }
      continue;
    }
    if (part.kind === 'tool_call') {
      const tool: ToolExecutionEntry = {
        id: part.toolUseId,
        name: part.name,
        status: part.status,
        input: part.input
      };
      toolsById.set(part.toolUseId, tool);
      entries.push({
        type: 'tool',
        key: part.id,
        tool
      });
      continue;
    }
    if (part.kind === 'tool_result' || part.kind === 'tool_error') {
      const existing = toolsById.get(part.toolUseId);
      const tool = existing ?? {
        id: part.toolUseId,
        name: part.toolName ?? part.toolUseId,
        status: part.kind === 'tool_error' ? 'failed' as const : 'completed' as const
      };
      tool.status = part.kind === 'tool_error' ? 'failed' : 'completed';
      tool.result = {
        content: part.kind === 'tool_error' ? part.error : part.content,
        isError: part.kind === 'tool_error',
        changedFiles: part.changedFiles,
        browser: part.browser,
        edit: part.edit,
        mcp: part.mcp,
        artifacts: part.artifacts,
        transaction: part.transaction
      };
      if (!existing) {
        toolsById.set(part.toolUseId, tool);
        entries.push({
          type: 'tool',
          key: part.id,
          tool
        });
      }
      continue;
    }
    if (part.kind === 'context_summary') {
      entries.push({
        type: 'node',
        key: part.id,
        node: <AgentCoreContextBlock title="上下文摘要" content={part.summary} />
      });
      continue;
    }
    if (part.kind === 'todo_update') {
      entries.push({
        type: 'node',
        key: part.id,
        node: <AgentCoreTodoBlock items={part.items} />
      });
      continue;
    }
    if (part.kind === 'run_error') {
      entries.push({
        type: 'node',
        key: part.id,
        node: <AgentCoreContextBlock title="运行错误" content={part.error} tone="error" />
      });
      continue;
    }
    if (part.kind === 'system_event' && part.metadata?.type === 'skill_activation') {
      entries.push({
        type: 'node',
        key: part.id,
        node: <AgentCoreContextBlock title="已激活 Skill" content={[part.title, part.summary].filter(Boolean).join('\n')} />
      });
    }
  }

  const nodes: ReactNode[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === 'node') {
      nodes.push(<Fragment key={`core-node-${entry.key}`}>{entry.node}</Fragment>);
      continue;
    }
    const tools: ToolExecutionEntry[] = [entry.tool];
    const groupKey = entry.key;
    while (entries[index + 1]?.type === 'tool') {
      index += 1;
      const nextEntry = entries[index];
      if (nextEntry.type === 'tool') {
        tools.push(nextEntry.tool);
      }
    }
    nodes.push(
      <ToolActivityGroup
        key={`core-tool-${groupKey}`}
        tools={tools}
        defaultOpen={tools.some(shouldExpandToolByDefault)}
        openablePaths={input.openablePaths}
        searchQuery={input.searchQuery}
        onOpenPath={input.onOpenPath}
        renderContent={renderChatContent}
      />
    );
  }
  return nodes;
}

function renderProcessTimeline(input: {
  content: string;
  activityItems: StreamActivityEntry[];
  toolExecutions: ToolExecutionEntry[];
  visibleStages: StageExecutionEntry[];
  autoExpandActiveToolGroup?: boolean;
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
      <Fragment key={`process-text-${nodes.length}-${start}-${end}`}>
        {renderChatContent(slice, input.openablePaths, input.searchQuery, input.onOpenPath)}
      </Fragment>
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
        nodes.push(
          <ToolActivityGroup
            key={`process-tool-${toolActivities.map((item) => item.id).join(':')}`}
            tools={tools}
            defaultOpen={tools.some(shouldExpandToolByDefault)}
            active={activeToolGroup}
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

function normalizeProcessActivities(activityItems: StreamActivityEntry[], contentLength: number): StreamActivityEntry[] {
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

function AgentCoreContextBlock(props: { title: string; content: string; tone?: 'error' }): JSX.Element {
  return (
    <div className={`chat-content-block ${props.tone === 'error' ? 'tool-result error' : 'fallback'}`}>
      <div className="chat-content-block-title">{props.title}</div>
      <div className="chat-content-block-body">{props.content}</div>
    </div>
  );
}

function AgentCoreTodoBlock(props: { items: Extract<AgentCoreMessagePart, { kind: 'todo_update' }>['items'] }): JSX.Element {
  const language = useUiLanguage();
  const labels = {
    pending: localize(language, '待处理', 'Pending'),
    in_progress: localize(language, '进行中', 'In progress'),
    completed: localize(language, '已完成', 'Completed'),
    cancelled: localize(language, '已取消', 'Cancelled')
  };
  return (
    <div className="chat-content-block tool">
      <div className="chat-content-block-title">{localize(language, '任务清单', 'Task List')}</div>
      <div className="chat-content-block-body">
        <div className="chat-rich-list-block">
          {props.items.map((item) => (
            <div key={item.id} className="chat-rich-list-line">
              <span>•</span>
              <div>{labels[item.status]} · {item.title}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PermissionImpactBlock(props: { impact?: AgentPermissionImpact }): JSX.Element | null {
  const language = useUiLanguage();
  const impact = props.impact;
  if (!impact) {
    return null;
  }

  const entries = [
    impact.toolTitle || impact.toolName
      ? localize(language, `工具：${impact.toolTitle || impact.toolName}`, `Tool: ${impact.toolTitle || impact.toolName}`)
      : '',
    impact.paths?.length
      ? localize(language, `路径：${impact.paths.join(' · ')}`, `Paths: ${impact.paths.join(' · ')}`)
      : '',
    impact.commands?.length
      ? localize(language, `命令：${impact.commands.join(' · ')}`, `Commands: ${impact.commands.join(' · ')}`)
      : '',
    impact.mcp?.pluginName || impact.mcp?.pluginId || impact.mcp?.toolName
      ? localize(language, `MCP：${[impact.mcp.pluginName ?? impact.mcp.pluginId, impact.mcp.toolName].filter(Boolean).join(' / ')}`, `MCP: ${[impact.mcp.pluginName ?? impact.mcp.pluginId, impact.mcp.toolName].filter(Boolean).join(' / ')}`)
      : '',
    impact.mcp?.permission || impact.mcp?.risk || impact.mcp?.policySource
      ? localize(language, `MCP 策略：${[impact.mcp.permission, impact.mcp.risk, impact.mcp.policySource].filter(Boolean).join(' / ')}`, `MCP policy: ${[impact.mcp.permission, impact.mcp.risk, impact.mcp.policySource].filter(Boolean).join(' / ')}`)
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
      {entries.map((entry) => <span key={entry}>{entry}</span>)}
      {detailEntries.map((entry) => <span key={`detail:${entry}`}>{entry}</span>)}
    </div>
  );
}

export function getMessagePlainText(message: ChatMessage, includeToolDetails = true): string {
  if (message.role === 'assistant' && message.metadata?.agentCoreParts?.length) {
    const agentCoreText = getAgentCorePartsPlainText(message.metadata.agentCoreParts, includeToolDetails);
    if (agentCoreText.trim() || isPseudoToolTextForDisplay(message.content)) {
      return agentCoreText;
    }
  }

  const blocks = message.contentBlocks;
  if (!blocks?.length) {
    return getRenderableMessageFallbackContent(message);
  }

  const visibleBlocks = message.role === 'assistant' && !includeToolDetails
    ? blocks.filter((block) => block.type === 'text' || block.type === 'fallback')
    : blocks;
  return visibleBlocks.map((block) => getBlockPlainText(block)).filter(Boolean).join('\n\n');
}

function isPseudoToolTextLine(value: string): boolean {
  return PSEUDO_TOOL_TEXT_LINE_PATTERNS.some((pattern) => pattern.test(value));
}

function isPseudoToolTextForDisplay(value: string): boolean {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some((line) => isPseudoToolTextLine(line));
}

function stripPseudoToolTextForDisplay(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n');
  const firstNonEmptyLine = normalized.split('\n').find((line) => line.trim());
  if (firstNonEmptyLine && isPseudoToolTextLine(firstNonEmptyLine)) {
    return '';
  }
  return normalized
    .split('\n')
    .filter((line) => !isPseudoToolTextLine(line))
    .join('\n')
    .trim();
}

function getRenderableMessageFallbackContent(message: ChatMessage): string {
  if (message.role !== 'assistant') {
    return message.content;
  }
  return stripPseudoToolTextForDisplay(message.content);
}

function getAgentCorePartsPlainText(parts: AgentCoreMessagePart[], includeToolDetails: boolean): string {
  return orderAgentCoreParts(parts)
    .map((part) => getAgentCorePartPlainText(part, includeToolDetails))
    .filter(Boolean)
    .join('\n\n');
}

function getAgentCorePartPlainText(part: AgentCoreMessagePart, includeToolDetails: boolean): string {
  if (part.kind === 'assistant_text') {
    return stripPseudoToolTextForDisplay(part.text);
  }
  if (part.kind === 'assistant_thinking') {
    return includeToolDetails ? part.thinking : '';
  }
  if (part.kind === 'tool_call') {
    return includeToolDetails
      ? `${part.name}\n${part.input ? JSON.stringify(part.input, null, 2) : ''}`.trim()
      : '';
  }
  if (part.kind === 'tool_result') {
    return includeToolDetails ? part.content : '';
  }
  if (part.kind === 'tool_error') {
    return includeToolDetails ? part.error : '';
  }
  if (part.kind === 'context_summary') {
    return part.summary;
  }
  if (part.kind === 'todo_update') {
    return part.items.map((item) => `${item.status} · ${item.title}`).join('\n');
  }
  if (part.kind === 'run_error') {
    return part.error;
  }
  if (part.kind === 'system_event') {
    return includeToolDetails || part.metadata?.type === 'skill_activation'
      ? [part.title, part.summary].filter(Boolean).join('\n')
      : '';
  }
  if (part.kind === 'permission_request') {
    return includeToolDetails ? [part.toolName, part.reason].filter(Boolean).join('\n') : '';
  }
  if (part.kind === 'user_input_request') {
    return includeToolDetails ? part.question : '';
  }
  return '';
}

function getBlockPlainText(block: ChatContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'thinking') return '';
  if (block.type === 'tool_use') return `${block.name}\n${block.input ? JSON.stringify(block.input, null, 2) : ''}`.trim();
  if (block.type === 'tool_result') return block.content;
  return block.text;
}

function renderChatMessageBlocks(
  message: ChatMessage,
  openablePaths: string[],
  searchQuery: string,
  onOpenPath: (path: string) => void,
  developerMode: boolean
): JSX.Element {
  if (message.role === 'assistant' && hasRenderableAgentCoreParts(message)) {
    const renderedParts = renderAgentCoreParts({
      parts: message.metadata?.agentCoreParts ?? [],
      developerMode,
      openablePaths,
      searchQuery,
      onOpenPath
    });
    if (renderedParts.length > 0) {
      return <>{renderedParts}</>;
    }
  }

  const blocks = message.contentBlocks;
  if (!blocks?.length) {
    const fallbackContent = getRenderableMessageFallbackContent(message);
    return fallbackContent ? renderChatContent(fallbackContent, openablePaths, searchQuery, onOpenPath) : <></>;
  }

  if (message.role === 'assistant' && hasRenderableProcessTimeline(message)) {
    const processText = message.metadata?.agentProcessText?.trim() ? message.metadata.agentProcessText : message.content;
    const renderedTimeline = renderProcessTimeline({
      content: processText,
      activityItems: message.metadata?.agentProcessActivities ?? [],
      toolExecutions: buildMessageProcessTools(message),
      visibleStages: [],
      openablePaths,
      searchQuery,
      onOpenPath
    });
    if (renderedTimeline.length > 0) {
      return <>{renderedTimeline}</>;
    }
  }

  const displayBlocks = message.role === 'assistant'
    ? blocks.filter((block) => developerMode || block.type !== 'thinking')
    : blocks;
  if (displayBlocks.length === 0) {
    return message.role === 'assistant' ? <></> : renderChatContent(message.content, openablePaths, searchQuery, onOpenPath);
  }

  const renderableEntries = pairHistoricalToolExecutions(displayBlocks);
  const renderedEntries: ReactNode[] = [];

  for (let index = 0; index < renderableEntries.length; index += 1) {
    const entry = renderableEntries[index];

    if (entry.type === 'tool') {
      const tools: ToolExecutionEntry[] = [entry.tool];
      const groupKey = entry.key;
      while (renderableEntries[index + 1]?.type === 'tool') {
        index += 1;
        const nextEntry = renderableEntries[index];
        if (nextEntry.type === 'tool') {
          tools.push(nextEntry.tool);
        }
      }

      renderedEntries.push(
        <ToolActivityGroup
          key={`tool-activity-${groupKey}`}
          tools={tools}
          defaultOpen={tools.some(shouldExpandToolByDefault)}
          openablePaths={openablePaths}
          searchQuery={searchQuery}
          onOpenPath={onOpenPath}
          renderContent={renderChatContent}
        />
      );
      continue;
    }

    renderedEntries.push(
      <ChatContentBlockView
        key={entry.key}
        block={entry.block}
        openablePaths={openablePaths}
        searchQuery={searchQuery}
        onOpenPath={onOpenPath}
        developerMode={developerMode}
      />
    );
  }

  return <>{renderedEntries}</>;
}

function ChatContentBlockView(props: {
  block: ChatContentBlock;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
  developerMode: boolean;
}): JSX.Element | null {
  const language = useUiLanguage();
  const [expandedToolResult, setExpandedToolResult] = useState(false);

  if (props.block.type === 'text') {
    return renderChatContent(props.block.text, props.openablePaths, props.searchQuery, props.onOpenPath);
  }

  if (props.block.type === 'fallback') {
    return (
      <div className="chat-content-block fallback">
        {props.developerMode ? (
          <div className="chat-content-block-title">{localize(language, '本地回退回复', 'Fallback Reply')}</div>
        ) : null}
        <div className="chat-content-block-body">
          {renderChatContent(props.block.text, props.openablePaths, props.searchQuery, props.onOpenPath)}
        </div>
        {props.developerMode && props.block.reason ? <pre className="chat-content-block-error-detail">{props.block.reason}</pre> : null}
      </div>
    );
  }

  if (props.block.type === 'thinking') {
    return null;
  }

  if (props.block.type === 'tool_use' || props.block.type === 'tool_result') {
    const toolResultSummary = props.block.type === 'tool_result'
      ? summarizeToolResultBlockContent(props.block.content)
      : undefined;
    const toolResultContent = props.block.type === 'tool_result'
      ? expandedToolResult || !toolResultSummary?.truncated
        ? props.block.content
        : toolResultSummary.text
      : '';

    return (
      <div className={`chat-content-block ${props.block.type === 'tool_use' ? 'tool' : 'tool-result'} ${props.block.type === 'tool_result' && props.block.isError ? 'error' : ''}`}>
        <div className="chat-content-block-title">
          {props.block.type === 'tool_use'
            ? `${localize(language, '工具调用', 'Tool Call')} · ${props.block.name}`
            : props.block.isError
              ? localize(language, '工具执行失败', 'Tool Failed')
              : localize(language, '工具结果', 'Tool Result')}
        </div>
        <div className="chat-content-block-body">
          {props.block.type === 'tool_use' && props.block.input ? <pre className="chat-tool-json">{JSON.stringify(props.block.input, null, 2)}</pre> : null}
          {props.block.type === 'tool_result' ? (
            <>
              {renderChatContent(toolResultContent, props.openablePaths, props.searchQuery, props.onOpenPath)}
              {toolResultSummary?.truncated ? (
                <button type="button" className="chat-tool-result-expand" onClick={() => setExpandedToolResult((current) => !current)}>
                  {expandedToolResult
                    ? localize(language, '收起完整结果', 'Collapse full result')
                    : localize(language, '显示完整工具结果', 'Show full tool result')}
                </button>
              ) : null}
              <MediaResultGrid media={props.block.media} onOpenPath={props.onOpenPath} onRevealPath={revealLocalFilePath} />
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return <></>;
}

function summarizeToolResultBlockContent(content: string): {
  text: string;
  truncated: boolean;
} {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return {
      text: '',
      truncated: false
    };
  }

  const lines = normalized.split('\n');
  const lineLimited = lines.slice(0, TOOL_RESULT_SUMMARY_LINES).join('\n');
  const text = truncateInlineText(lineLimited, TOOL_RESULT_SUMMARY_CHARS);
  return {
    text,
    truncated: normalized.length > text.length || lines.length > TOOL_RESULT_SUMMARY_LINES
  };
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

function renderChatContent(content: string, openablePaths: string[], searchQuery: string, onOpenPath: (path: string) => void): JSX.Element {
  const openablePathSet = new Set(openablePaths);
  const blocks = parseChatBlocks(content);

  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return <ChatCodeBlock key={`block-${index}`} language={block.language} content={block.content} />;
        }

        if (block.type === 'heading') {
          const sizeClass =
            block.level === 1 ? 'large' : block.level === 2 ? 'medium' : 'small';
          return (
            <div key={`block-${index}`} className={`chat-rich-heading ${sizeClass}`}>
              {renderChatInline(block.text, openablePathSet, searchQuery, onOpenPath)}
            </div>
          );
        }

        if (block.type === 'list') {
          return (
            <div key={`block-${index}`} className="chat-rich-list-block">
              {block.items.map((item, itemIndex) => (
                <div key={`item-${itemIndex}`} className="chat-rich-list-line">
                  <span>•</span>
                  <div>{renderChatInline(item, openablePathSet, searchQuery, onOpenPath)}</div>
                </div>
              ))}
            </div>
          );
        }

        if (block.type === 'quote') {
          return (
            <blockquote key={`block-${index}`} className="chat-rich-quote">
              {renderChatInline(block.text, openablePathSet, searchQuery, onOpenPath)}
            </blockquote>
          );
        }

        if (block.type === 'divider') {
          return <div key={`block-${index}`} className="chat-rich-divider" role="separator" />;
        }

        if (block.type === 'table') {
          return (
            <div key={`block-${index}`} className="chat-rich-table-wrap">
              <table className="chat-rich-table">
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`header-${headerIndex}`}>
                        {renderChatInline(header, openablePathSet, searchQuery, onOpenPath)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`row-${rowIndex}`}>
                      {block.headers.map((_header, cellIndex) => (
                        <td key={`cell-${rowIndex}-${cellIndex}`}>
                          {renderChatInline(row[cellIndex] ?? '', openablePathSet, searchQuery, onOpenPath)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <div key={`block-${index}`} className="chat-rich-text-block">
            <div className="chat-rich-text-line">
              {renderChatInline(block.text, openablePathSet, searchQuery, onOpenPath)}
            </div>
          </div>
        );
      })}
    </>
  );
}

function ChatCodeBlock(props: { language?: string; content: string }): JSX.Element {
  const language = useUiLanguage();
  const [copied, setCopied] = useState(false);
  const codeLanguage = props.language?.trim() || 'code';

  function handleCopy(): void {
    navigator.clipboard.writeText(props.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  }

  return (
    <div className="chat-code-card">
      <div className="chat-code-header">
        <span className="chat-code-language">{codeLanguage}</span>
        <button className="chat-code-copy" type="button" onClick={handleCopy}>
          {copied ? localize(language, '已复制', 'Copied') : localize(language, '复制', 'Copy')}
        </button>
      </div>
      <pre className="chat-code-block">
        <code>{props.content}</code>
      </pre>
    </div>
  );
}

function parseChatBlocks(content: string): ParsedChatBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ParsedChatBlock[] = [];
  const paragraphLines: string[] = [];
  const listItems: string[] = [];
  const quoteLines: string[] = [];
  const codeLines: string[] = [];
  let codeLanguage = '';
  let inCodeBlock = false;

  function flushParagraph(): void {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push({
      type: 'paragraph',
      text: paragraphLines.join(' ').trim()
    });
    paragraphLines.length = 0;
  }

  function flushList(): void {
    if (listItems.length === 0) {
      return;
    }
    blocks.push({
      type: 'list',
      items: [...listItems]
    });
    listItems.length = 0;
  }

  function flushQuote(): void {
    if (quoteLines.length === 0) {
      return;
    }
    blocks.push({
      type: 'quote',
      text: quoteLines.join(' ').trim()
    });
    quoteLines.length = 0;
  }

  function flushCode(): void {
    blocks.push({
      type: 'code',
      language: codeLanguage || undefined,
      content: codeLines.join('\n').trim()
    });
    codeLines.length = 0;
    codeLanguage = '';
  }

  function flushTableRows(rows: string[][]): void {
    if (rows.length < 2 || !isMarkdownTableSeparatorRow(rows[1])) {
      return;
    }
    const width = rows[0].length;
    if (width === 0) {
      return;
    }
    blocks.push({
      type: 'table',
      headers: rows[0],
      rows: rows.slice(2).filter((row) => row.some((cell) => cell.trim())).map((row) => {
        const normalized = row.slice(0, width);
        while (normalized.length < width) {
          normalized.push('');
        }
        return normalized;
      })
    });
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const line = rawLine.trimEnd();

    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      flushQuote();
      if (inCodeBlock) {
        flushCode();
      } else {
        codeLanguage = line.replace(/```/, '').trim();
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const collapsedTable = parseCollapsedMarkdownTableRows(line);
    if (collapsedTable) {
      const prefix = line.slice(0, collapsedTable.startIndex).trim();
      if (prefix) {
        paragraphLines.push(prefix);
      }
      flushParagraph();
      flushList();
      flushQuote();
      flushTableRows(collapsedTable.rows);
      continue;
    }

    const tableRow = parseMarkdownTableRow(line);
    const nextTableRow = lineIndex + 1 < lines.length ? parseMarkdownTableRow(lines[lineIndex + 1].trimEnd()) : null;
    if (tableRow && nextTableRow && isMarkdownTableSeparatorRow(nextTableRow)) {
      const rows = [tableRow, nextTableRow];
      lineIndex += 1;
      while (lineIndex + 1 < lines.length) {
        const row = parseMarkdownTableRow(lines[lineIndex + 1].trimEnd());
        if (!row) {
          break;
        }
        rows.push(row);
        lineIndex += 1;
      }
      flushParagraph();
      flushList();
      flushQuote();
      flushTableRows(rows);
      continue;
    }

    const dividerMatch = line.trim().match(/^([-*_])(?:\s*\1){2,}\s*$/);
    if (dividerMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({ type: 'divider' });
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length as 1 | 2 | 3 | 4,
        text: headingMatch[2].trim()
      });
      continue;
    }

    const standaloneBulletMatch = line.match(/^\s*[•]\s*$/);
    if (standaloneBulletMatch && lineIndex + 1 < lines.length) {
      const nextLine = lines[lineIndex + 1].trim();
      if (nextLine && !isStructuralMarkdownLine(nextLine)) {
        flushParagraph();
        flushQuote();
        listItems.push(nextLine);
        lineIndex += 1;
        continue;
      }
    }

    const listMatch = line.match(/^\s*[-*+•]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      listItems.push(listMatch[1].trim());
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1].trim());
      continue;
    }

    paragraphLines.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushQuote();
  if (inCodeBlock) {
    flushCode();
  }

  return blocks.length > 0 ? blocks : [{ type: 'paragraph', text: content }];
}

function isStructuralMarkdownLine(line: string): boolean {
  return /^(```|#{1,6}\s|[-*_]{3,}\s*$|[-*+•]\s+|>\s?|[|])/.test(line);
}

function parseMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return null;
  }
  const cells = trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparatorRow(row: string[]): boolean {
  return row.length >= 2 && row.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseCollapsedMarkdownTableRows(line: string): { rows: string[][]; startIndex: number } | null {
  if (!/\|\s*:?-{3,}:?\s*\|/.test(line)) {
    return null;
  }
  const startIndex = line.indexOf('|');
  if (startIndex === -1) {
    return null;
  }
  const tableSource = line.slice(startIndex);
  const rows: string[][] = [];
  let current: string[] = [];
  for (const rawCell of tableSource.split('|')) {
    const cell = rawCell.trim();
    if (!cell) {
      if (current.length > 0) {
        rows.push(current);
        current = [];
      }
      continue;
    }
    current.push(cell);
  }
  if (current.length > 0) {
    rows.push(current);
  }
  return rows.length >= 2 && isMarkdownTableSeparatorRow(rows[1]) ? { rows, startIndex } : null;
}
