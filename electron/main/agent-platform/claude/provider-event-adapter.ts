import type {
  AgentCoreMessagePart,
  AgentCoreProviderStepResult,
  ChatContentBlock
} from '../../../../shared/types';
import type { AgentCoreRuntimeBridgeEvent } from '../../agent-core/index';
import {
  createProviderRuntimeEventAdapter,
  type ProviderRuntimeEvent
} from '../provider-runtime-events';
import type { createConversationRuntimeOutputCollector } from '../runtime-output';
import type { GenericAgentRuntimeParams } from '../types';
import type { ClaudeContentBlock } from './types';
import { normalizeToolInput } from './stream-events';

type ClaudeRuntimeOutputCollector = ReturnType<typeof createConversationRuntimeOutputCollector>;

interface ClaudeRunControllerSnapshot {
  pendingToolUseIds: string[];
  coreState: {
    state: string;
  };
  parts: AgentCoreMessagePart[];
}

export interface ClaudeProviderEventAdapter {
  emitProviderEvent: (event: ProviderRuntimeEvent) => void;
  emitToolUse: (tool: {
    toolUseId: string;
    name: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }) => void;
  emitToolResult: (result: Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0]) => void;
  emitContextLoading: (reason: string) => void;
  emitProviderInputReady: (reason: string) => void;
  emitContextCompaction: (reason: string) => void;
  emitToolExecutionStarted: (reason: string) => void;
  emitToolResultsRecorded: (reason: string) => void;
  emitProviderStreaming: (reason: string) => void;
  emitRunCompleted: (reason: string) => void;
  emitRunFailed: (reason: string) => void;
  publishFinalAgentCoreParts: () => void;
  buildFinalMetadata: (message?: string, block?: ChatContentBlock) => ReturnType<ClaudeRuntimeOutputCollector['buildMetadata']>;
}

export function createClaudeProviderEventAdapter(input: {
  outputCollector: ClaudeRuntimeOutputCollector;
  submitEvent: (event: AgentCoreRuntimeBridgeEvent) => unknown;
  emitCoreStateStage: (state: 'completed' | 'failed', reason: string) => void;
  getRunControllerSnapshot: () => ClaudeRunControllerSnapshot;
}): ClaudeProviderEventAdapter {
  const providerEventAdapter = createProviderRuntimeEventAdapter({
    callbacks: {
      emitToolUse: input.outputCollector.onToolUse,
      emitToolResult: input.outputCollector.onToolResult
    },
    controller: {
      submitEvent: input.submitEvent
    },
    mapToolEventsToCore: false
  });
  let emittedFinalAgentCoreParts = false;
  const emitProviderEvent = (event: ProviderRuntimeEvent): void => {
    providerEventAdapter.observe(event);
  };
  return {
    emitProviderEvent,
    emitToolUse: (tool) => {
      emitProviderEvent({
        type: 'tool_use',
        toolUseId: tool.toolUseId,
        toolName: tool.name,
        input: tool.input
      });
    },
    emitToolResult: (result) => {
      const snapshot = input.getRunControllerSnapshot();
      if (
        snapshot.pendingToolUseIds.includes(result.toolUseId) ||
        snapshot.coreState.state === 'executing_tools' ||
        snapshot.coreState.state === 'recording_tool_results'
      ) {
        emitProviderEvent({
          type: 'tool_result_recorded',
          toolResult: {
            toolUseId: result.toolUseId,
            toolName: result.toolName,
            content: result.content,
            isError: result.isError,
            changedFiles: result.changedFiles,
            command: result.command,
            terminal: result.terminal,
            browser: result.browser,
            edit: result.edit,
            mcp: result.mcp,
            artifacts: result.artifacts,
            transaction: result.transaction
          }
        });
      }
      emitProviderEvent({
        type: 'tool_result',
        toolUseId: result.toolUseId,
        toolName: result.toolName,
        content: result.content,
        isError: result.isError,
        media: result.media,
        changedFiles: result.changedFiles,
        command: result.command,
        terminal: result.terminal,
        browser: result.browser,
        edit: result.edit,
        mcp: result.mcp,
        artifacts: result.artifacts,
        transaction: result.transaction
      });
    },
    emitContextLoading: (reason) => {
      emitProviderEvent({
        type: 'context_loading_started',
        reason
      });
    },
    emitProviderInputReady: (reason) => {
      emitProviderEvent({
        type: 'provider_input_ready',
        reason
      });
    },
    emitContextCompaction: (reason) => {
      emitProviderEvent({
        type: 'context_compaction_started',
        reason
      });
    },
    emitToolExecutionStarted: (reason) => {
      emitProviderEvent({
        type: 'tool_execution_started',
        reason
      });
    },
    emitToolResultsRecorded: (reason) => {
      emitProviderEvent({
        type: 'tool_results_recorded',
        reason
      });
    },
    emitProviderStreaming: (reason) => {
      emitProviderEvent({
        type: 'provider_step_streaming',
        reason
      });
    },
    emitRunCompleted: (reason) => {
      emitProviderEvent({
        type: 'run_completed',
        reason
      });
      input.emitCoreStateStage('completed', 'Agent Core v2 状态机完成本轮 Claude runtime。');
    },
    emitRunFailed: (reason) => {
      emitProviderEvent({
        type: 'run_failed',
        reason
      });
      input.emitCoreStateStage('failed', reason);
    },
    publishFinalAgentCoreParts: () => {
      if (emittedFinalAgentCoreParts) {
        return;
      }
      const parts = input.getRunControllerSnapshot().parts;
      if (parts.length > 0) {
        input.outputCollector.onAgentCoreParts(parts);
        emittedFinalAgentCoreParts = true;
      }
    },
    buildFinalMetadata: (message, block) => {
      const parts = input.getRunControllerSnapshot().parts;
      if (!emittedFinalAgentCoreParts && parts.length > 0) {
        input.outputCollector.onAgentCoreParts(parts);
        emittedFinalAgentCoreParts = true;
      }
      return input.outputCollector.buildMetadata(message, block);
    }
  };
}

export function createClaudeContentProviderEventObserver(adapter: Pick<
  ClaudeProviderEventAdapter,
  | 'emitProviderEvent'
  | 'emitProviderStreaming'
  | 'emitToolExecutionStarted'
  | 'emitToolResultsRecorded'
>) {
  const recordAssistantContentForRunController = (content?: ClaudeContentBlock[]): void => {
    if (!Array.isArray(content)) {
      return;
    }
    const toolCalls: AgentCoreProviderStepResult['toolCalls'] = [];
    for (const [index, block] of content.entries()) {
      if (block.type !== 'tool_use') {
        continue;
      }
      const input = normalizeToolInput(block.input);
      toolCalls.push({
        toolUseId: block.id ?? `claude_tool_${index}`,
        name: block.name ?? 'claude_tool',
        ...(block.id ? { providerCallId: block.id } : {}),
        ...(input ? { input } : {})
      });
    }
    if (toolCalls.length === 0) {
      return;
    }
    const text = content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n\n')
      .trim();
    const thinking = content
      .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
      .map((block) => block.thinking)
      .join('\n\n')
      .trim();
    adapter.emitProviderEvent({
      type: 'provider_step_recorded',
      providerStep: {
        text: text || undefined,
        thinking: thinking || undefined,
        finishReason: 'tool_calls',
        toolCalls
      }
    });
  };

  return {
    observeAssistantContent(content?: ClaudeContentBlock[]): void {
      if (!Array.isArray(content)) {
        return;
      }
      if (content.some((block) => block.type === 'text' || block.type === 'thinking')) {
        adapter.emitProviderStreaming('Claude runtime 正在流式输出内容。');
      }
      if (content.some((block) => block.type === 'tool_use')) {
        adapter.emitToolExecutionStarted('Claude runtime 请求执行工具。');
      }
      if (content.some((block) => block.type === 'tool_result')) {
        adapter.emitToolResultsRecorded('Claude runtime 返回工具结果。');
      }
      recordAssistantContentForRunController(content);
    },
    observeUserContent(content?: ClaudeContentBlock[] | string): void {
      if (Array.isArray(content) && content.some((block) => block.type === 'tool_result')) {
        adapter.emitToolResultsRecorded('Claude runtime 已收到工具结果回放。');
      }
    }
  };
}
