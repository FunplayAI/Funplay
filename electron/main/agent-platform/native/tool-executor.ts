import type { ToolSet } from 'ai';
import type { AgentToolTransactionSummary } from '../../../../shared/types';
import type { GenericAgentRuntimeParams } from '../types';
import type { WorkspaceToolActionResult } from '../workspace-tools';
import {
  advanceToolExecutorTransaction,
  completeToolExecutorTransaction,
  createToolExecutorTransactionSummary,
  createToolExecutorTransaction,
  normalizeToolExecutorTransactionResult,
  type ToolExecutorToolClass,
  type ToolExecutorTransaction
} from '../tool-executor';

export type NativeWorkspaceToolOutput = {
  ok?: boolean;
  summary?: string;
  isError?: boolean;
  media?: WorkspaceToolActionResult['media'];
  changedFiles?: WorkspaceToolActionResult['changedFiles'];
  command?: WorkspaceToolActionResult['command'];
  terminal?: WorkspaceToolActionResult['terminal'];
  browser?: WorkspaceToolActionResult['browser'];
  edit?: WorkspaceToolActionResult['edit'];
  mcp?: WorkspaceToolActionResult['mcp'];
  artifacts?: WorkspaceToolActionResult['artifacts'];
};

export interface NativeWorkspaceToolTransactionCallbacks {
  emitToolUse?: GenericAgentRuntimeParams['onToolUse'];
  emitToolResult?: GenericAgentRuntimeParams['onToolResult'];
}

export interface NativeWorkspaceToolTransactionHooks {
  onStart?: () => void;
  onResult?: (toolResult: NativeWorkspaceToolOutput, summary: string, transaction: AgentToolTransactionSummary) => void;
  onTransaction?: (transaction: ToolExecutorTransaction) => void;
}

export interface NativeWorkspaceToolTransactionInput {
  tools: ToolSet;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  callbacks?: NativeWorkspaceToolTransactionCallbacks;
  hooks?: NativeWorkspaceToolTransactionHooks;
  precomputedResult?: NativeWorkspaceToolOutput;
}

function inferNativeWorkspaceToolClass(toolName: string): ToolExecutorToolClass {
  if (toolName === 'run_command') {
    return 'command';
  }
  if (toolName.startsWith('terminal_')) {
    return 'terminal';
  }
  if (toolName.startsWith('browser_')) {
    return 'browser';
  }
  if (toolName.includes('mcp') || toolName.startsWith('mcp__')) {
    return 'mcp';
  }
  if (toolName.startsWith('media_') || toolName === 'image_generate' || toolName === 'read_document') {
    return 'media';
  }
  if (toolName.startsWith('funplay_memory_')) {
    return 'memory';
  }
  if (toolName === 'ask_user') {
    return 'user_input';
  }
  if (toolName.includes('subagent')) {
    return 'subagent';
  }
  if (toolName.startsWith('checkpoint_')) {
    return 'checkpoint';
  }
  return 'workspace';
}

export function stringifyNativeToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export async function executeNativeWorkspaceToolSetTool(
  tools: ToolSet,
  toolName: string,
  input: Record<string, unknown>
): Promise<NativeWorkspaceToolOutput> {
  const selectedTool = tools[toolName] as unknown as {
    execute?: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>;
  };
  if (typeof selectedTool?.execute !== 'function') {
    return {
      ok: false,
      isError: true,
      summary: `未知工具：${toolName}`
    };
  }
  const output = await selectedTool.execute(input, {});
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return output as NativeWorkspaceToolOutput;
  }
  return {
    ok: true,
    summary: stringifyNativeToolOutput(output)
  };
}

export function recordNativeWorkspaceToolTransactionResult(input: Omit<NativeWorkspaceToolTransactionInput, 'tools' | 'precomputedResult'> & {
  toolResult: NativeWorkspaceToolOutput;
}): {
  summary: string;
  toolResult: NativeWorkspaceToolOutput;
  transaction: ToolExecutorTransaction;
} {
  let transaction = createToolExecutorTransaction({
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    toolClass: inferNativeWorkspaceToolClass(input.toolName),
    input: input.input
  });
  transaction = advanceToolExecutorTransaction(transaction, {
    phase: 'executing',
    eventType: 'execution_started',
    summary: `Executing ${input.toolName}.`
  });
  input.hooks?.onStart?.();
  input.callbacks?.emitToolUse?.({
    toolUseId: input.toolUseId,
    name: input.toolName,
    input: input.input,
    status: 'running'
  });
  const summary = input.toolResult.summary ?? stringifyNativeToolOutput(input.toolResult);
  transaction = completeToolExecutorTransaction(transaction, normalizeToolExecutorTransactionResult({
    ...input.toolResult,
    content: summary,
    isError: Boolean(input.toolResult.isError)
  }));
  const transactionSummary = createToolExecutorTransactionSummary(transaction);
  input.callbacks?.emitToolResult?.({
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    content: summary,
    isError: Boolean(input.toolResult.isError),
    media: input.toolResult.media,
    changedFiles: input.toolResult.changedFiles,
    command: input.toolResult.command,
    terminal: input.toolResult.terminal,
    browser: input.toolResult.browser,
    edit: input.toolResult.edit,
    mcp: input.toolResult.mcp,
    artifacts: input.toolResult.artifacts,
    transaction: transactionSummary
  });
  input.hooks?.onResult?.(input.toolResult, summary, transactionSummary);
  input.callbacks?.emitToolUse?.({
    toolUseId: input.toolUseId,
    name: input.toolName,
    input: undefined,
    status: input.toolResult.isError ? 'failed' : 'completed'
  });
  input.hooks?.onTransaction?.(transaction);
  return {
    summary,
    toolResult: input.toolResult,
    transaction
  };
}

export async function executeNativeWorkspaceToolTransaction(input: NativeWorkspaceToolTransactionInput): Promise<{
  summary: string;
  toolResult: NativeWorkspaceToolOutput;
  transaction: ToolExecutorTransaction;
}> {
  const toolResult = input.precomputedResult ?? await executeNativeWorkspaceToolSetTool(input.tools, input.toolName, input.input);
  return recordNativeWorkspaceToolTransactionResult({
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    input: input.input,
    callbacks: input.callbacks,
    hooks: input.hooks,
    toolResult
  });
}
