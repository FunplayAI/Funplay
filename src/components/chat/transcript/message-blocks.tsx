import { useState, type JSX, type ReactNode } from 'react';
import type { ChatContentBlock, ChatMessage } from '../../../../shared/types';
import { localize, useUiLanguage } from '../../../i18n';
import { Button } from '../../ui/index';
import { revealLocalFilePath } from '../inline-renderer';
import { renderChatContent } from './chat-markdown';
import { getRenderableMessageFallbackContent, summarizeToolResultBlockContent } from './message-plain-text';
import {
  hasRenderableAgentCoreParts,
  renderAgentCoreParts,
  hasRenderableProcessTimeline,
  renderProcessTimeline,
  buildMessageProcessTools
} from './message-process';
import {
  type ToolExecutionEntry,
  ToolActivityGroup,
  MediaResultGrid,
  pairHistoricalToolExecutions,
  shouldExpandToolByDefault
} from '../tool-activity';

export function renderChatMessageBlocks(
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
                <Button size="compact" variant="ghost" className="chat-tool-result-expand" onClick={() => setExpandedToolResult((current) => !current)}>
                  {expandedToolResult
                    ? localize(language, '收起完整结果', 'Collapse full result')
                    : localize(language, '显示完整工具结果', 'Show full tool result')}
                </Button>
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
