import type { AgentToolTransactionSummary } from '../../../../shared/types';
import { makeId } from '../../../../shared/utils';
import { normalizeToolInput } from './tool-loop-message-adapter';
import type { normalizeToolOutputForStream } from './tool-loop-output';

type NativeAiSdkStreamToolOutput = ReturnType<typeof normalizeToolOutputForStream>;

export interface NativeAiSdkTrackedToolCall {
  rawToolCallId: string;
  toolUseId: string;
  toolName: string;
  input?: Record<string, unknown>;
}

export interface NativeAiSdkTrackedToolResult {
  rawToolCallId: string;
  toolUseId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  content: string;
  isError?: boolean;
  failureKind?: string;
  recoveryHint?: string;
  changedFiles?: NativeAiSdkStreamToolOutput['changedFiles'];
  command?: NativeAiSdkStreamToolOutput['command'];
  terminal?: NativeAiSdkStreamToolOutput['terminal'];
  browser?: NativeAiSdkStreamToolOutput['browser'];
  edit?: NativeAiSdkStreamToolOutput['edit'];
  mcp?: NativeAiSdkStreamToolOutput['mcp'];
  artifacts?: NativeAiSdkStreamToolOutput['artifacts'];
  transaction?: AgentToolTransactionSummary;
}

export class NativeAiSdkStepState {
  private readonly toolCallIds = new Map<string, string>();
  private readonly toolCallInputs = new Map<
    string,
    {
      toolName: string;
      input?: Record<string, unknown>;
    }
  >();
  private readonly completedToolCallIds = new Set<string>();
  private readonly stepToolCallInputs = new Map<string, NativeAiSdkTrackedToolCall>();
  private readonly stepToolResults = new Map<string, Omit<NativeAiSdkTrackedToolResult, 'rawToolCallId'>>();
  private stepText = '';
  private stepThinking = '';

  get hasToolCalls(): boolean {
    return this.toolCallIds.size > 0;
  }

  beginStep(): void {
    this.toolCallIds.clear();
    this.toolCallInputs.clear();
    this.completedToolCallIds.clear();
    this.stepToolCallInputs.clear();
    this.stepToolResults.clear();
    this.stepText = '';
    this.stepThinking = '';
  }

  recordTextDelta(delta: string): string {
    this.stepText += delta;
    return this.stepText;
  }

  recordThinkingDelta(delta: string): string {
    this.stepThinking += delta;
    return this.stepThinking;
  }

  getStepText(): string {
    return this.stepText;
  }

  getStepThinking(): string {
    return this.stepThinking;
  }

  recordToolCall(input: { toolCallId: string; toolName: string; rawInput: unknown }): NativeAiSdkTrackedToolCall {
    const rawToolCallId = input.toolCallId || makeId('tool_call');
    const toolUseId = input.toolCallId || makeId('tool');
    const normalizedInput = normalizeToolInput(input.rawInput);
    const tracked = {
      rawToolCallId,
      toolUseId,
      toolName: input.toolName,
      input: normalizedInput
    };
    this.toolCallIds.set(rawToolCallId, toolUseId);
    this.toolCallInputs.set(rawToolCallId, {
      toolName: input.toolName,
      input: normalizedInput
    });
    this.stepToolCallInputs.set(rawToolCallId, tracked);
    return tracked;
  }

  recordToolResult(input: {
    toolCallId: string;
    toolName: string;
    output: NativeAiSdkStreamToolOutput;
  }): NativeAiSdkTrackedToolResult {
    const rawToolCallId = input.toolCallId || makeId('tool_call');
    const toolUseId = this.toolCallIds.get(rawToolCallId) ?? input.toolCallId ?? makeId('tool');
    const toolCallInput = this.toolCallInputs.get(rawToolCallId);
    const toolName = toolCallInput?.toolName ?? input.toolName;
    this.completedToolCallIds.add(rawToolCallId);
    const tracked = {
      rawToolCallId,
      toolUseId,
      toolName,
      toolInput: toolCallInput?.input,
      content: input.output.summary,
      isError: Boolean(input.output.isError),
      failureKind: input.output.edit?.failureKind,
      recoveryHint: input.output.edit?.recoveryHint,
      changedFiles: input.output.changedFiles,
      command: input.output.command,
      terminal: input.output.terminal,
      browser: input.output.browser,
      edit: input.output.edit,
      mcp: input.output.mcp,
      artifacts: input.output.artifacts
    };
    this.stepToolResults.set(rawToolCallId, {
      toolUseId,
      toolName,
      toolInput: toolCallInput?.input,
      content: tracked.content,
      isError: tracked.isError,
      failureKind: tracked.failureKind,
      recoveryHint: tracked.recoveryHint,
      changedFiles: tracked.changedFiles,
      command: tracked.command,
      terminal: tracked.terminal,
      browser: tracked.browser,
      edit: tracked.edit,
      mcp: tracked.mcp,
      artifacts: tracked.artifacts
    });
    return tracked;
  }

  recordToolResultTransaction(input: { toolCallId: string; transaction: AgentToolTransactionSummary }): void {
    const rawToolCallId = input.toolCallId || makeId('tool_call');
    const current = this.stepToolResults.get(rawToolCallId);
    if (!current) {
      return;
    }
    this.stepToolResults.set(rawToolCallId, {
      ...current,
      transaction: input.transaction
    });
  }

  buildProviderToolCalls(): Array<{
    toolCallId: string;
    toolName: string;
    input?: Record<string, unknown>;
  }> {
    return [...this.stepToolCallInputs.values()].map((toolCall) => ({
      toolCallId: toolCall.toolUseId,
      toolName: toolCall.toolName,
      input: toolCall.input
    }));
  }

  buildCurrentToolCalls(): Array<{
    toolCallId: string;
    toolName: string;
    input?: Record<string, unknown>;
  }> {
    return [...this.toolCallInputs.entries()].map(([toolCallId, toolCall]) => ({
      toolCallId,
      toolName: toolCall.toolName,
      input: toolCall.input
    }));
  }

  drainStepToolResults(): Array<{
    toolUseId: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    content: string;
    isError?: boolean;
    failureKind?: string;
    recoveryHint?: string;
    changedFiles?: NativeAiSdkStreamToolOutput['changedFiles'];
    command?: NativeAiSdkStreamToolOutput['command'];
    terminal?: NativeAiSdkStreamToolOutput['terminal'];
    browser?: NativeAiSdkStreamToolOutput['browser'];
    edit?: NativeAiSdkStreamToolOutput['edit'];
    mcp?: NativeAiSdkStreamToolOutput['mcp'];
    artifacts?: NativeAiSdkStreamToolOutput['artifacts'];
    transaction?: AgentToolTransactionSummary;
  }> {
    return [...this.stepToolResults.values()];
  }

  collectInterruptedToolResults(content: string): Array<{
    toolUseId: string;
    toolName?: string;
    content: string;
    isError: true;
  }> {
    const interrupted: Array<{
      toolUseId: string;
      toolName?: string;
      content: string;
      isError: true;
    }> = [];
    for (const [rawToolCallId, toolUseId] of this.toolCallIds) {
      if (this.completedToolCallIds.has(rawToolCallId)) {
        continue;
      }
      interrupted.push({
        toolUseId,
        toolName: this.toolCallInputs.get(rawToolCallId)?.toolName,
        content,
        isError: true
      });
    }
    return interrupted;
  }
}
