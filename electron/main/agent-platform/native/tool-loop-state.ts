import type {
  AgentCoreMessagePart,
  AgentCoreStateMachineSnapshot,
  AiProviderApiMode
} from '../../../../shared/types';
import {
  type OpenAiCompatibleToolCall,
  type OpenAiCompatibleToolMessage,
  type OpenAiCompatibleToolStepResult
} from '../../openai-compatible-client';
import type { WorkspaceToolActionResult } from '../workspace-tools';
import type { NativeTodoSnapshot } from './continuation-policy';
import { normalizeModelReplyText } from './text';

export interface NativeToolLoopRunResult {
  assistantMessage: string;
  finishReason?: string;
  stepCount: number;
  toolCalls: string[];
  streamedText?: boolean;
  usage?: unknown;
  coreState?: AgentCoreStateMachineSnapshot;
  agentCoreParts?: AgentCoreMessagePart[];
}

export type NativeToolLoopStatePart =
  | {
      type: 'assistant_text';
      stepIndex: number;
      text: string;
      final: boolean;
    }
  | {
      type: 'tool_use';
      stepIndex: number;
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      stepIndex: number;
      toolUseId: string;
      content: string;
      isError?: boolean;
    }
  | {
      type: 'continuation';
      stepIndex: number;
      reason: 'partial_write' | 'incomplete_todo' | 'edit_recovery';
      text: string;
    };

export interface NativeToolLoopState {
  messages: OpenAiCompatibleToolMessage[];
  parts: NativeToolLoopStatePart[];
  finalText: string;
  stepCount: number;
  finishReason?: string;
  toolCalls: string[];
  streamedText: boolean;
  thinking: string;
  usage?: unknown;
  partialWriteContinuationCount: number;
  editFailureContinuationCount: number;
  incompleteTodoContinuationCount: number;
  latestTodoSnapshot?: NativeTodoSnapshot;
  completedToolResultsByUseId: Map<string, {
    name: string;
    summary: string;
    isError?: boolean;
    failureKind?: string;
    recoveryHint?: string;
    media?: WorkspaceToolActionResult['media'];
    changedFiles?: WorkspaceToolActionResult['changedFiles'];
    command?: WorkspaceToolActionResult['command'];
    terminal?: WorkspaceToolActionResult['terminal'];
    browser?: WorkspaceToolActionResult['browser'];
    edit?: WorkspaceToolActionResult['edit'];
    mcp?: WorkspaceToolActionResult['mcp'];
    artifacts?: WorkspaceToolActionResult['artifacts'];
    searchText?: string;
  }>;
}

export interface NativeOpenAiToolInvocation {
  toolCall: OpenAiCompatibleToolCall;
  toolUseId: string;
  stepIndex: number;
  started: boolean;
  completed: boolean;
}

export function createNativeToolLoopState(messages: OpenAiCompatibleToolMessage[]): NativeToolLoopState {
  return {
    messages,
    parts: [],
    finalText: '',
    stepCount: 0,
    toolCalls: [],
    streamedText: false,
    thinking: '',
    partialWriteContinuationCount: 0,
    editFailureContinuationCount: 0,
    incompleteTodoContinuationCount: 0,
    completedToolResultsByUseId: new Map()
  };
}

export function recordNativeToolLoopAssistantText(
  state: NativeToolLoopState,
  stepIndex: number,
  text: string,
  options: {
    final: boolean;
  }
): string {
  const normalized = normalizeModelReplyText(text);
  if (!normalized.trim()) {
    return '';
  }

  state.parts.push({
    type: 'assistant_text',
    stepIndex,
    text: normalized,
    final: options.final
  });
  if (options.final) {
    state.finalText = normalized;
  }
  return normalized;
}

export function appendNativeToolLoopAssistantToolMessage(
  state: NativeToolLoopState,
  stepResult: OpenAiCompatibleToolStepResult,
  options: {
    apiMode: AiProviderApiMode;
    assistantText: string;
  }
): void {
  if (options.apiMode === 'responses' && stepResult.responseOutputItems?.length) {
    state.messages.push({
      role: 'responses_output',
      items: stepResult.responseOutputItems
    });
    return;
  }

  state.messages.push({
    role: 'assistant',
    content: options.assistantText.trim() || undefined,
    reasoningContent: stepResult.reasoningContent,
    toolCalls: stepResult.toolCalls
  });
}

export function createNativeToolLoopRunResult(
  state: NativeToolLoopState,
  coreState?: AgentCoreStateMachineSnapshot,
  agentCoreParts?: AgentCoreMessagePart[]
): NativeToolLoopRunResult {
  return {
    assistantMessage: normalizeModelReplyText(state.finalText),
    finishReason: state.finishReason,
    stepCount: state.stepCount,
    toolCalls: state.toolCalls,
    streamedText: state.streamedText,
    usage: state.usage,
    coreState,
    agentCoreParts
  };
}
