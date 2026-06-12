import type { AiProvider, AiProviderApiMode, ProjectSessionEffort } from '../../shared/types';
import type { ResolvedProviderEffortLevel } from '../../shared/provider-catalog';

export interface OpenAiCompatibleTextResult {
  text: string;
  finishReason?: string;
  rawFinishReason?: string;
  usage?: unknown;
  responseId?: string;
  responseModelId?: string;
  responseTimestamp?: string;
  requestUrl: string;
  requestBody: unknown;
  responseBody: unknown;
}

export interface OpenAiCompatibleToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAiCompatibleToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
  argumentsParseError?: string;
}

export interface OpenAiCompatibleImagePart {
  mimeType: string;
  dataBase64: string;
}

export type OpenAiCompatibleToolMessage =
  | {
      role: 'user';
      content: string;
      /** Optional image parts; only serialized when the resolved model has vision capability. */
      images?: OpenAiCompatibleImagePart[];
    }
  | {
      role: 'assistant';
      content?: string;
      reasoningContent?: string;
      toolCalls?: OpenAiCompatibleToolCall[];
    }
  | {
      role: 'tool';
      toolCallId: string;
      name?: string;
      content: string;
    }
  | {
      role: 'responses_output';
      items: unknown[];
    };

export interface OpenAiCompatibleToolStepResult extends OpenAiCompatibleTextResult {
  toolCalls: OpenAiCompatibleToolCall[];
  responseOutputItems?: unknown[];
  reasoningContent?: string;
  streamed?: boolean;
  toolCallRepair?: {
    type: 'textual_tool_marker';
    toolNames: string[];
  };
}

export interface GenerateOpenAiCompatibleTextInput {
  provider: AiProvider;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  onDelta?: (delta: string, accumulated: string) => void;
  onReasoningDelta?: (delta: string, accumulated: string) => void;
}

export interface GenerateOpenAiCompatibleToolStepInput {
  provider: AiProvider;
  system: string;
  messages: OpenAiCompatibleToolMessage[];
  tools: OpenAiCompatibleToolDefinition[];
  maxOutputTokens?: number;
  /** Session effort request; mapped to a provider reasoning knob only when the catalog declares supportsEffort. */
  effort?: ProjectSessionEffort;
  abortSignal?: AbortSignal;
  onDelta?: (delta: string, accumulated: string) => void;
  onReasoningDelta?: (delta: string, accumulated: string) => void;
}

export interface OpenAiCompatibleMessage {
  role: 'system' | 'user';
  content: string;
}

export interface OpenAiCompatibleRequest {
  provider: AiProvider;
  model: string;
  messages: OpenAiCompatibleMessage[];
  maxOutputTokens: number;
}

export interface OpenAiCompatibleToolStepRequest {
  provider: AiProvider;
  model: string;
  system: string;
  messages: OpenAiCompatibleToolMessage[];
  tools: OpenAiCompatibleToolDefinition[];
  maxOutputTokens: number;
  /** Capability-clamped effort level (never 'auto'); adapters map it onto their wire format. */
  effort?: ResolvedProviderEffortLevel;
}

export interface OpenAiCompatibleParsedResponse {
  text: string;
  reasoningContent?: string;
  finishReason?: string;
  rawFinishReason?: string;
  usage?: unknown;
  responseId?: string;
  responseModelId?: string;
  responseTimestamp?: string;
  responseBody: unknown;
}

export interface OpenAiCompatibleProtocolAdapter {
  readonly apiMode: AiProviderApiMode;
  getCompletionUrl(baseUrl: string): string;
  serializeRequest(request: OpenAiCompatibleRequest): unknown;
  serializeToolStepRequest(request: OpenAiCompatibleToolStepRequest): unknown;
  parseResponse(body: unknown): OpenAiCompatibleParsedResponse;
  parseToolCalls(body: unknown): OpenAiCompatibleToolCall[];
}

export interface OpenAiCompatibleError extends Error {
  cause?: unknown;
  statusCode?: number;
  code?: string;
  apiMode?: AiProviderApiMode;
  requestUrl?: string;
  requestBody?: string;
  responseBody?: string;
}
