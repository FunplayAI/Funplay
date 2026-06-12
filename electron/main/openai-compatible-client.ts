import type { AiProvider, AiProviderApiMode } from '../../shared/types';
import { resolveOpenAiCompatibleProviderProfile, resolveProviderEffortLevel } from '../../shared/provider-catalog';
import { materializeNativeProvider } from './agent-platform/provider-resolver';
import type {
  OpenAiCompatibleTextResult,
  OpenAiCompatibleToolStepResult,
  GenerateOpenAiCompatibleTextInput,
  GenerateOpenAiCompatibleToolStepInput,
  OpenAiCompatibleRequest,
  OpenAiCompatibleToolStepRequest,
  OpenAiCompatibleProtocolAdapter
} from './openai-compatible-types';
import {
  isRecord,
  truncateText,
  createApiError,
  postAnthropicMessagesStream,
  postChatCompletionsStream,
  postResponsesStream
} from './openai-compatible-transport';
import { AnthropicMessagesAdapter, ChatCompletionsAdapter, ResponsesAdapter } from './openai-compatible-adapters';
import {
  applyOpenAiCompatibleRequestBodyTransforms,
  repairOpenAiCompatibleToolCalls,
  repairTextualOpenAiCompatibleToolCalls
} from './openai-compatible-profile-transforms';

export type {
  OpenAiCompatibleTextResult,
  OpenAiCompatibleToolDefinition,
  OpenAiCompatibleToolCall,
  OpenAiCompatibleToolMessage,
  OpenAiCompatibleToolStepResult
} from './openai-compatible-types';
import { stripOpenAiCompatibleEndpointSuffix } from './provider-base-url';

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizeOpenAiCompatibleBaseUrl(provider: AiProvider): string {
  const baseUrl = stripOpenAiCompatibleEndpointSuffix(trimSlash(provider.baseUrl));
  if (!baseUrl) {
    return baseUrl;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  const marker = `${provider.name} ${parsed.hostname}`.toLowerCase();
  if (
    marker.includes('packy') &&
    parsed.hostname === 'www.packyapi.com' &&
    parsed.pathname.replace(/\/+$/, '') === ''
  ) {
    parsed.pathname = '/v1';
    return trimSlash(parsed.toString());
  }
  return baseUrl;
}

function resolveBaseUrl(provider: AiProvider): string {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(provider);
  if (!baseUrl) {
    throw new Error('OpenAI-compatible base URL is required.');
  }
  return baseUrl;
}

function resolveApiMode(provider: AiProvider): AiProviderApiMode {
  const profile = resolveOpenAiCompatibleProviderProfile(provider);
  if (profile.apiMode === 'responses' && !profile.supportsResponses) {
    throw new Error(
      `Provider ${provider.name} does not support the OpenAI-compatible Responses API. Switch this provider to Chat Completions mode.`
    );
  }
  if (profile.apiMode === 'chat' && !profile.supportsChatCompletions) {
    throw new Error(
      `Provider ${provider.name} does not support OpenAI-compatible Chat Completions mode. Switch this provider to Responses mode.`
    );
  }
  return profile.apiMode;
}

function summarizeContentParts(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((part) => {
    if (!isRecord(part)) {
      return typeof part === 'string' ? truncateText(part, 240) : part;
    }
    return {
      type: typeof part.type === 'string' ? part.type : undefined,
      textPreview: typeof part.text === 'string' ? truncateText(part.text, 240) : undefined,
      contentPreview: typeof part.content === 'string' ? truncateText(part.content, 240) : undefined
    };
  });
}

function summarizeResponseBody(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }

  const output = Array.isArray(body.output)
    ? body.output.map((item) => {
        if (!isRecord(item)) {
          return item;
        }
        return {
          id: typeof item.id === 'string' ? item.id : undefined,
          type: typeof item.type === 'string' ? item.type : undefined,
          role: typeof item.role === 'string' ? item.role : undefined,
          status: typeof item.status === 'string' ? item.status : undefined,
          name: typeof item.name === 'string' ? item.name : undefined,
          textPreview: typeof item.text === 'string' ? truncateText(item.text, 240) : undefined,
          argumentsPreview: typeof item.arguments === 'string' ? truncateText(item.arguments, 240) : undefined,
          content: summarizeContentParts(item.content),
          summary: summarizeContentParts(item.summary)
        };
      })
    : undefined;

  const choices = Array.isArray(body.choices)
    ? body.choices.map((choice) => {
        if (!isRecord(choice)) {
          return choice;
        }
        const message = isRecord(choice.message) ? choice.message : undefined;
        return {
          finishReason: choice.finish_reason,
          textPreview: typeof choice.text === 'string' ? truncateText(choice.text, 240) : undefined,
          messageRole: message?.role,
          messageContentType:
            message?.content == null
              ? String(message?.content)
              : Array.isArray(message?.content)
                ? 'array'
                : typeof message?.content,
          messageContentPreview: typeof message?.content === 'string' ? truncateText(message.content, 240) : undefined,
          reasoningPreview:
            typeof message?.reasoning_content === 'string'
              ? truncateText(message.reasoning_content, 240)
              : typeof message?.reasoningContent === 'string'
                ? truncateText(message.reasoningContent, 240)
                : undefined
        };
      })
    : undefined;

  return {
    id: body.id,
    object: body.object,
    model: body.model,
    status: body.status,
    error: body.error,
    incompleteDetails: body.incomplete_details,
    outputTextLength: typeof body.output_text === 'string' ? body.output_text.length : undefined,
    output,
    choices,
    usage: body.usage,
    instructionsLength: typeof body.instructions === 'string' ? body.instructions.length : undefined,
    instructionsPreview: typeof body.instructions === 'string' ? truncateText(body.instructions, 600) : undefined,
    topLevelKeys: Object.keys(body)
  };
}

function sanitizeResponseBodyForDiagnostics(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }
  return {
    summary: summarizeResponseBody(body),
    raw: {
      ...body,
      instructions: typeof body.instructions === 'string' ? truncateText(body.instructions, 600) : body.instructions
    }
  };
}

function withStreamEnabled(body: unknown): unknown {
  return isRecord(body) ? { ...body, stream: true } : body;
}

function createProtocolAdapter(apiMode: AiProviderApiMode): OpenAiCompatibleProtocolAdapter {
  if (apiMode === 'responses') {
    return new ResponsesAdapter();
  }
  if (apiMode === 'anthropic-messages') {
    return new AnthropicMessagesAdapter();
  }
  return new ChatCompletionsAdapter();
}

function postOpenAiCompatibleStream(input: {
  apiMode: AiProviderApiMode;
  requestUrl: string;
  provider: AiProvider;
  requestBody: unknown;
  abortSignal?: AbortSignal;
  onDelta?: (delta: string, accumulated: string) => void;
  onReasoningDelta?: (delta: string, accumulated: string) => void;
}): Promise<{ text: string; reasoningContent?: string; responseBody: unknown }> {
  if (input.apiMode === 'responses') {
    return postResponsesStream(input.requestUrl, input.provider, input.requestBody, input.abortSignal, input.onDelta);
  }
  if (input.apiMode === 'anthropic-messages') {
    return postAnthropicMessagesStream(
      input.requestUrl,
      input.provider,
      input.requestBody,
      input.abortSignal,
      input.onDelta,
      input.onReasoningDelta
    );
  }
  return postChatCompletionsStream(
    input.requestUrl,
    input.provider,
    input.requestBody,
    input.abortSignal,
    input.onDelta,
    input.onReasoningDelta
  );
}

export async function generateOpenAiCompatibleStreamingToolStep(
  input: GenerateOpenAiCompatibleToolStepInput
): Promise<OpenAiCompatibleToolStepResult> {
  const provider = materializeNativeProvider(input.provider);
  const apiMode = resolveApiMode(provider);
  const adapter = createProtocolAdapter(apiMode);
  const baseUrl = resolveBaseUrl(provider);
  const requestUrl = adapter.getCompletionUrl(baseUrl);
  const request: OpenAiCompatibleToolStepRequest = {
    provider,
    model: provider.model.trim(),
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    maxOutputTokens: input.maxOutputTokens ?? 4096,
    effort: resolveProviderEffortLevel(provider, input.effort)
  };
  const requestBody = withStreamEnabled(
    applyOpenAiCompatibleRequestBodyTransforms(adapter.serializeToolStepRequest(request), request, apiMode)
  );
  const streamResult = await postOpenAiCompatibleStream({
    apiMode,
    requestUrl,
    provider,
    requestBody,
    abortSignal: input.abortSignal,
    onDelta: input.onDelta,
    onReasoningDelta: input.onReasoningDelta
  });
  const parsed = adapter.parseResponse(streamResult.responseBody);
  const toolCalls = adapter.parseToolCalls(streamResult.responseBody);
  repairOpenAiCompatibleToolCalls(toolCalls, input.tools);
  const textualToolRepair =
    toolCalls.length === 0 && parsed.text.includes('[Tool]')
      ? repairTextualOpenAiCompatibleToolCalls(parsed.text, input.tools)
      : undefined;
  const normalizedToolCalls = toolCalls.length > 0 ? toolCalls : (textualToolRepair?.toolCalls ?? []);
  const normalizedText = toolCalls.length > 0 ? parsed.text : (textualToolRepair?.text ?? parsed.text);
  const responseOutputItems =
    apiMode === 'responses' && isRecord(streamResult.responseBody) && Array.isArray(streamResult.responseBody.output)
      ? streamResult.responseBody.output
      : undefined;
  const streamReasoningContent =
    isRecord(streamResult) && typeof streamResult.reasoningContent === 'string'
      ? streamResult.reasoningContent
      : undefined;
  const reasoningContent =
    apiMode === 'chat' ? (parsed.reasoningContent ?? streamReasoningContent) || undefined : parsed.reasoningContent;

  return {
    ...parsed,
    text: normalizedText.trim(),
    reasoningContent,
    toolCalls: normalizedToolCalls,
    toolCallRepair: textualToolRepair?.toolCalls.length
      ? {
          type: 'textual_tool_marker',
          toolNames: textualToolRepair.toolCalls.map((toolCall) => toolCall.name)
        }
      : undefined,
    responseOutputItems,
    requestUrl,
    requestBody,
    responseBody: streamResult.responseBody,
    streamed: true
  };
}

export async function generateOpenAiCompatibleText(
  input: GenerateOpenAiCompatibleTextInput
): Promise<OpenAiCompatibleTextResult> {
  const provider = materializeNativeProvider(input.provider);
  const apiMode = resolveApiMode(provider);
  const adapter = createProtocolAdapter(apiMode);
  const baseUrl = resolveBaseUrl(provider);
  const requestUrl = adapter.getCompletionUrl(baseUrl);
  const request: OpenAiCompatibleRequest = {
    provider,
    model: provider.model.trim(),
    messages: [
      {
        role: 'system',
        content: input.system
      },
      {
        role: 'user',
        content: input.prompt
      }
    ],
    maxOutputTokens: input.maxOutputTokens ?? 2048
  };
  const requestBody = withStreamEnabled(
    applyOpenAiCompatibleRequestBodyTransforms(adapter.serializeRequest(request), request, apiMode)
  );
  const streamResult = await postOpenAiCompatibleStream({
    apiMode,
    requestUrl,
    provider,
    requestBody,
    abortSignal: input.abortSignal,
    onDelta: input.onDelta,
    onReasoningDelta: input.onReasoningDelta
  });
  const parsed = adapter.parseResponse(streamResult.responseBody);

  if (!parsed.text.trim()) {
    throw createApiError('模型返回了空回复。', {
      code: 'MODEL_EMPTY_RESPONSE',
      apiMode,
      requestUrl,
      requestBody,
      responseBody: sanitizeResponseBodyForDiagnostics(streamResult.responseBody)
    });
  }

  return {
    ...parsed,
    text: parsed.text.trim(),
    requestUrl,
    requestBody,
    responseBody: streamResult.responseBody
  };
}
