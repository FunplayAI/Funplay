import type { JSX } from 'react';
import type { ChatMessage } from '../../../../shared/types';
import { renderChatContent } from './chat-markdown';
import { getRenderableMessageFallbackContent } from './message-plain-text';
import {
  hasRenderableAgentCoreParts,
  renderAgentCoreParts,
} from './message-process';

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

  const fallbackContent = getRenderableMessageFallbackContent(message);
  if (!fallbackContent) {
    return <></>;
  }
  const content = renderChatContent(fallbackContent, openablePaths, searchQuery, onOpenPath);
  return message.role === 'assistant' ? <div className="chat-assistant-answer">{content}</div> : content;
}
