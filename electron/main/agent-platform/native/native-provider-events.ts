import type {
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolCommandResult,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTerminalResult,
  AgentToolTransactionSummary,
  ChatMediaBlock
} from '../../../../shared/types';
import type { GenericAgentRuntimeParams } from '../types';

export type NativeProviderStepEvent =
  | {
      type: 'text_delta';
      delta: string;
      accumulated: string;
    }
  | {
      type: 'thinking_delta';
      delta: string;
      accumulated: string;
    }
  | {
      type: 'tool_use';
      toolUseId: string;
      toolName: string;
      input?: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      toolUseId: string;
      toolName?: string;
      content: string;
      isError?: boolean;
      media?: ChatMediaBlock[];
      changedFiles?: AgentToolChangedFile[];
      command?: AgentToolCommandResult;
      terminal?: AgentToolTerminalResult;
      browser?: AgentToolBrowserResult;
      edit?: AgentToolEditMetrics;
      mcp?: AgentToolMcpResult;
      artifacts?: AgentToolArtifact[];
      transaction?: AgentToolTransactionSummary;
    }
  | {
      type: 'provider_step_done';
      finishReason?: string;
      toolCallCount: number;
      text?: string;
    };

export interface NativeProviderStepEventObserver {
  observe: (event: NativeProviderStepEvent) => void;
}

export interface NativeProviderToolEventCallbacks {
  emitToolUse?: GenericAgentRuntimeParams['onToolUse'];
  emitToolResult?: GenericAgentRuntimeParams['onToolResult'];
}

export function createNativeProviderToolCallbackHandlers(callbacks?: NativeProviderToolEventCallbacks): {
  onToolUse: (event: Extract<NativeProviderStepEvent, { type: 'tool_use' }>) => void;
  onToolResult: (event: Extract<NativeProviderStepEvent, { type: 'tool_result' }>) => void;
} {
  return {
    onToolUse: (event) => {
      callbacks?.emitToolUse?.({
        toolUseId: event.toolUseId,
        name: event.toolName,
        input: event.input,
        status: 'running'
      });
    },
    onToolResult: (event) => {
      callbacks?.emitToolResult?.({
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        content: event.content,
        isError: Boolean(event.isError),
        media: event.media,
        changedFiles: event.changedFiles,
        command: event.command,
        terminal: event.terminal,
        browser: event.browser,
        edit: event.edit,
        mcp: event.mcp,
        artifacts: event.artifacts,
        transaction: event.transaction
      });
      callbacks?.emitToolUse?.({
        toolUseId: event.toolUseId,
        name: event.toolName ?? 'tool',
        input: undefined,
        status: event.isError ? 'failed' : 'completed'
      });
    }
  };
}

export function createNativeProviderStepEventObserver(callbacks: {
  onTextDelta?: (delta: string, accumulated: string) => void;
  onThinkingDelta?: (delta: string, accumulated: string) => void;
  onToolUse?: (event: Extract<NativeProviderStepEvent, { type: 'tool_use' }>) => void;
  onToolResult?: (event: Extract<NativeProviderStepEvent, { type: 'tool_result' }>) => void;
  onProviderStepDone?: (event: Extract<NativeProviderStepEvent, { type: 'provider_step_done' }>) => void;
}): NativeProviderStepEventObserver {
  return {
    observe: (event) => {
      switch (event.type) {
        case 'text_delta':
          callbacks.onTextDelta?.(event.delta, event.accumulated);
          break;
        case 'thinking_delta':
          callbacks.onThinkingDelta?.(event.delta, event.accumulated);
          break;
        case 'tool_use':
          callbacks.onToolUse?.(event);
          break;
        case 'tool_result':
          callbacks.onToolResult?.(event);
          break;
        case 'provider_step_done':
          callbacks.onProviderStepDone?.(event);
          break;
      }
    }
  };
}
