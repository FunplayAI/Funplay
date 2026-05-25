import { Fragment, type JSX, type ReactNode } from 'react';
import type { AgentCoreMessagePart, AgentPermissionImpact, ChatMessage } from '../../../../shared/types';
import { localize, useUiLanguage } from '../../../i18n';
import { renderChatContent } from './chat-markdown';
import { buildTranscriptViewItems, type TranscriptViewItem } from './transcript-view-model';
import {
  type ToolExecutionEntry,
  type StageExecutionEntry,
  type StreamActivityEntry,
  ToolActivityGroup,
  StreamActivityTrail,
  StageTimeline,
  buildCompletedMessageProcessTools,
  shouldExpandToolByDefault
} from '../tool-activity';

export function hasStructuredToolBlocks(message: ChatMessage): boolean {
  return Boolean(message.metadata?.agentCoreParts?.some((part) => part.kind === 'tool_call' || part.kind === 'tool_result' || part.kind === 'tool_error'));
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

export function renderAgentCoreParts(input: {
  parts: AgentCoreMessagePart[];
  developerMode: boolean;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): ReactNode[] {
  return buildTranscriptViewItems(input.parts)
    .map((item) => renderTranscriptViewItem(item, input))
    .filter((node): node is ReactNode => Boolean(node));
}

function renderTranscriptViewItem(item: TranscriptViewItem, input: {
  developerMode: boolean;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): ReactNode {
  if (item.kind === 'assistant_text') {
    return (
      <div className="chat-assistant-answer" key={`core-node-${item.id}`}>
        {renderChatContent(item.text, input.openablePaths, input.searchQuery, input.onOpenPath)}
      </div>
    );
  }
  if (item.kind === 'assistant_thinking') {
    return input.developerMode
      ? <Fragment key={`core-node-${item.id}`}><AgentCoreContextBlock title={item.title} content={item.thinking} /></Fragment>
      : null;
  }
  if (item.kind === 'tool_group') {
    return (
      <ToolActivityGroup
        key={`core-tool-${item.id}`}
        tools={item.tools}
        defaultOpen={item.tools.some(shouldExpandToolByDefault)}
        collapseBeforeAssistantText={item.collapseBeforeAssistantText}
        showDiagnosticMeta={input.developerMode}
        openablePaths={input.openablePaths}
        searchQuery={input.searchQuery}
        onOpenPath={input.onOpenPath}
        renderContent={renderChatContent}
      />
    );
  }
  if (item.kind === 'context_summary') {
    return <Fragment key={`core-node-${item.id}`}><AgentCoreContextBlock title="上下文摘要" content={item.summary} /></Fragment>;
  }
  if (item.kind === 'todo_update') {
    return <Fragment key={`core-node-${item.id}`}><AgentCoreTodoBlock items={item.items} /></Fragment>;
  }
  if (item.kind === 'permission_request') {
    return (
      <Fragment key={`core-node-${item.id}`}>
        <AgentCoreContextBlock title="等待权限确认" content={[item.toolName, item.reason].filter(Boolean).join('\n')} tone={item.risk === 'high' ? 'error' : undefined} />
        <PermissionImpactBlock impact={item.impact} />
      </Fragment>
    );
  }
  if (item.kind === 'user_input_request') {
    return <Fragment key={`core-node-${item.id}`}><AgentCoreContextBlock title="等待用户回答" content={item.question} /></Fragment>;
  }
  if (item.kind === 'run_error') {
    return <Fragment key={`core-node-${item.id}`}><AgentCoreContextBlock title="运行错误" content={item.error} tone="error" /></Fragment>;
  }
  if (item.kind === 'system_event' && (input.developerMode || item.status === 'failed' || item.compactSummary)) {
    return <Fragment key={`core-node-${item.id}`}><AgentCoreContextBlock title={item.title} content={item.summary ?? ''} tone={item.status === 'failed' ? 'error' : undefined} /></Fragment>;
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
        {renderChatContent(slice, input.openablePaths, input.searchQuery, input.onOpenPath)}
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

export function PermissionImpactBlock(props: { impact?: AgentPermissionImpact }): JSX.Element | null {
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
