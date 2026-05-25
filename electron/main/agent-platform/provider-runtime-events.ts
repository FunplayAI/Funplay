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
} from '../../../shared/types';
import type {
  AgentCoreRunEngineSnapshot,
  AgentCoreRuntimeBridgeEvent
} from '../agent-core/index';
import type { GenericAgentRuntimeParams } from './types';

type ProviderRuntimeBoundaryEventType =
  | 'provider_step_started'
  | 'provider_step_streaming'
  | 'provider_step_collected'
  | 'provider_input_ready';

type ProviderRuntimeBoundaryPhase =
  | 'step_started'
  | 'step_streaming'
  | 'step_collected'
  | 'input_ready';

type ProviderStepRecordedCoreEvent = Extract<AgentCoreRuntimeBridgeEvent, { type: 'provider'; phase: 'step_recorded' }>;
type ToolResultRecordedCoreEvent = Extract<AgentCoreRuntimeBridgeEvent, { type: 'tool'; phase: 'result_recorded' }>;

export type ProviderRuntimeEvent =
  | {
      type:
        | 'provider_step_started'
        | 'provider_step_streaming'
        | 'provider_step_collected'
        | 'context_loading_started'
        | 'context_compaction_started'
        | 'tool_execution_started'
        | 'tool_results_recorded'
        | 'provider_input_ready'
        | 'run_completed'
        | 'run_failed'
        | 'run_interrupted';
      reason: string;
    }
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
      title?: string;
      summary?: string;
      activity?: string;
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
    }
  | {
      type: 'provider_step_recorded';
      providerStep: ProviderStepRecordedCoreEvent['providerStep'];
      options?: ProviderStepRecordedCoreEvent['options'];
    }
  | {
      type: 'tool_result_recorded';
      toolResult: ToolResultRecordedCoreEvent['toolResult'];
    };

export interface ProviderRuntimeEventObserver {
  observe: (event: ProviderRuntimeEvent) => unknown;
}

export interface ProviderRuntimeEventAdapterOptions {
  callbacks?: ProviderRuntimeToolEventCallbacks;
  controller?: {
    submitEvent: (event: AgentCoreRuntimeBridgeEvent) => unknown;
  };
  onTextDelta?: (delta: string, accumulated: string) => void;
  onThinkingDelta?: (delta: string, accumulated: string) => void;
  onProviderStepDone?: (event: Extract<ProviderRuntimeEvent, { type: 'provider_step_done' }>) => void;
  mapToolEventsToCore?: boolean;
}

export interface ProviderRuntimeController {
  observe: ProviderRuntimeEventObserver['observe'];
  recordProviderStep: (
    event: Omit<Extract<ProviderRuntimeEvent, { type: 'provider_step_recorded' }>, 'type'>
  ) => AgentCoreRunEngineSnapshot;
  recordToolResult: (
    event: Omit<Extract<ProviderRuntimeEvent, { type: 'tool_result_recorded' }>, 'type'>
  ) => AgentCoreRunEngineSnapshot;
  providerInputReady: (reason: string) => void;
  toolExecutionStarted: (reason: string) => void;
  toolResultsRecorded: (reason: string) => void;
  completeRun: (reason: string) => void;
  failRun: (reason: string) => void;
  interruptRun: (reason: string) => void;
}

export interface ProviderRuntimeToolEventCallbacks {
  emitToolUse?: GenericAgentRuntimeParams['onToolUse'];
  emitToolResult?: GenericAgentRuntimeParams['onToolResult'];
}

export function createProviderRuntimeToolCallbackHandlers(callbacks?: ProviderRuntimeToolEventCallbacks): {
  onToolUse: (event: Extract<ProviderRuntimeEvent, { type: 'tool_use' }>) => void;
  onToolResult: (event: Extract<ProviderRuntimeEvent, { type: 'tool_result' }>) => void;
} {
  return {
    onToolUse: (event) => {
      callbacks?.emitToolUse?.({
        toolUseId: event.toolUseId,
        name: event.toolName,
        title: event.title,
        summary: event.summary,
        activity: event.activity,
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

export function createProviderRuntimeEventObserver(callbacks: {
  onTextDelta?: (delta: string, accumulated: string) => void;
  onThinkingDelta?: (delta: string, accumulated: string) => void;
  onToolUse?: (event: Extract<ProviderRuntimeEvent, { type: 'tool_use' }>) => void;
  onToolResult?: (event: Extract<ProviderRuntimeEvent, { type: 'tool_result' }>) => void;
  onProviderStepDone?: (event: Extract<ProviderRuntimeEvent, { type: 'provider_step_done' }>) => void;
}): ProviderRuntimeEventObserver {
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
        default:
          break;
      }
    }
  };
}

export function providerRuntimeEventToCoreEvent(event: ProviderRuntimeEvent): AgentCoreRuntimeBridgeEvent | undefined {
  switch (event.type) {
    case 'provider_step_started':
    case 'provider_step_streaming':
    case 'provider_step_collected':
    case 'provider_input_ready':
      return {
        type: 'provider',
        phase: providerRuntimeEventToProviderPhase(event.type),
        reason: event.reason
      };
    case 'context_loading_started':
    case 'context_compaction_started':
      return {
        type: 'context',
        phase: event.type === 'context_loading_started' ? 'loading_started' : 'compaction_started',
        reason: event.reason
      };
    case 'tool_execution_started':
    case 'tool_results_recorded':
      return {
        type: 'tool',
        phase: event.type === 'tool_execution_started' ? 'execution_started' : 'results_recorded',
        reason: event.reason
      };
    case 'run_completed':
    case 'run_failed':
    case 'run_interrupted':
      return {
        type: 'terminal',
        status: event.type === 'run_completed' ? 'completed' : event.type === 'run_failed' ? 'failed' : 'interrupted',
        reason: event.reason
      };
    case 'text_delta':
      return {
        type: 'provider',
        phase: 'step_streaming',
        reason: 'Provider 正在流式输出文本。'
      };
    case 'thinking_delta':
      return {
        type: 'provider',
        phase: 'step_streaming',
        reason: 'Provider 正在流式输出推理内容。'
      };
    case 'tool_use':
      return {
        type: 'tool',
        phase: 'execution_started',
        reason: `Provider 请求执行工具 ${event.toolName}。`
      };
    case 'tool_result':
      return {
        type: 'tool',
        phase: 'results_recorded',
        reason: `工具 ${event.toolName ?? event.toolUseId} 返回结果。`
      };
    case 'provider_step_done':
      if (event.toolCallCount > 0) {
        return undefined;
      }
      return {
        type: 'provider',
        phase: 'step_collected',
        reason: `Provider step 完成，finishReason=${event.finishReason ?? 'unknown'}，未返回工具调用。`
      };
    case 'provider_step_recorded':
      return {
        type: 'provider',
        phase: 'step_recorded',
        providerStep: event.providerStep,
        options: event.options
      };
    case 'tool_result_recorded':
      return {
        type: 'tool',
        phase: 'result_recorded',
        toolResult: event.toolResult
      };
  }
}

function providerRuntimeEventToProviderPhase(type: ProviderRuntimeBoundaryEventType): ProviderRuntimeBoundaryPhase {
  switch (type) {
    case 'provider_step_started':
      return 'step_started';
    case 'provider_step_streaming':
      return 'step_streaming';
    case 'provider_step_collected':
      return 'step_collected';
    case 'provider_input_ready':
      return 'input_ready';
  }
  throw new Error(`Unsupported provider runtime boundary event: ${type}`);
}

export function createProviderRuntimeEventAdapter(
  options: ProviderRuntimeEventAdapterOptions
): ProviderRuntimeEventObserver {
  const toolCallbacks = createProviderRuntimeToolCallbackHandlers(options.callbacks);
  const observer = createProviderRuntimeEventObserver({
    onTextDelta: options.onTextDelta,
    onThinkingDelta: options.onThinkingDelta,
    onToolUse: toolCallbacks.onToolUse,
    onToolResult: toolCallbacks.onToolResult,
    onProviderStepDone: options.onProviderStepDone
  });

  return {
    observe: (event) => {
      const coreEvent = providerRuntimeEventToCoreEvent(event);
      const shouldMapCoreEvent =
        event.type !== 'tool_use' && event.type !== 'tool_result'
          ? true
          : options.mapToolEventsToCore !== false;
      let result: unknown;
      if (coreEvent && shouldMapCoreEvent) {
        result = options.controller?.submitEvent(coreEvent);
      }
      observer.observe(event);
      return result;
    }
  };
}

function expectRunEngineSnapshot(result: unknown, eventName: string): AgentCoreRunEngineSnapshot {
  if (!result || typeof result !== 'object' || !('runController' in result)) {
    throw new Error(`Provider runtime event ${eventName} did not return an Agent Core snapshot.`);
  }
  return result as AgentCoreRunEngineSnapshot;
}

export function createProviderRuntimeController(options: {
  submitEvent: (event: AgentCoreRuntimeBridgeEvent) => unknown;
  mapToolEventsToCore?: boolean;
}): ProviderRuntimeController {
  const observer = createProviderRuntimeEventAdapter({
    controller: {
      submitEvent: options.submitEvent
    },
    mapToolEventsToCore: options.mapToolEventsToCore
  });

  return {
    observe: (event) => observer.observe(event),
    recordProviderStep: (event) => expectRunEngineSnapshot(observer.observe({
      type: 'provider_step_recorded',
      ...event
    }), 'provider_step_recorded'),
    recordToolResult: (event) => expectRunEngineSnapshot(observer.observe({
      type: 'tool_result_recorded',
      ...event
    }), 'tool_result_recorded'),
    providerInputReady: (reason) => {
      observer.observe({ type: 'provider_input_ready', reason });
    },
    toolExecutionStarted: (reason) => {
      observer.observe({ type: 'tool_execution_started', reason });
    },
    toolResultsRecorded: (reason) => {
      observer.observe({ type: 'tool_results_recorded', reason });
    },
    completeRun: (reason) => {
      observer.observe({ type: 'run_completed', reason });
    },
    failRun: (reason) => {
      observer.observe({ type: 'run_failed', reason });
    },
    interruptRun: (reason) => {
      observer.observe({ type: 'run_interrupted', reason });
    }
  };
}
