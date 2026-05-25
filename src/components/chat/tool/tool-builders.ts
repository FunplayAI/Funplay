import type {
  AgentCoreMessagePart,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTransactionSummary,
  ChatContentBlock,
  ChatMediaBlock
} from '../../../../shared/types';
import { buildToolExecutionsFromAgentCoreParts } from '../transcript/transcript-view-model';
import type { RenderableChatEntry, ToolExecutionEntry } from './tool-types';

export function buildCompletedMessageProcessTools(message: {
  metadata?: {
    agentCoreParts?: AgentCoreMessagePart[];
  };
  agentCoreParts?: AgentCoreMessagePart[];
}): ToolExecutionEntry[] {
  const agentCoreParts = message.agentCoreParts ?? message.metadata?.agentCoreParts;
  if (agentCoreParts?.length) {
    return buildToolExecutionsFromAgentCoreParts(agentCoreParts);
  }

  return [];
}

export function buildToolsFromContentBlocks(blocks: ChatContentBlock[] | undefined): ToolExecutionEntry[] {
  if (!blocks?.length) {
    return [];
  }

  return pairHistoricalToolExecutions(blocks)
    .filter((entry): entry is Extract<RenderableChatEntry, { type: 'tool' }> => entry.type === 'tool')
    .map((entry) => entry.tool);
}

export function pairStreamingToolExecutions(
  toolUses: Array<{
    toolUseId: string;
    name: string;
    title?: string;
    summary?: string;
    activity?: string;
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
      title: tool.title,
      summary: tool.summary,
      activity: tool.activity,
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
          title: block.title,
          summary: block.summary,
          activity: block.activity,
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
