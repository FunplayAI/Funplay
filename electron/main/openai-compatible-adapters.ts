import type {
  OpenAiCompatibleProtocolAdapter,
  OpenAiCompatibleRequest,
  OpenAiCompatibleToolStepRequest,
  OpenAiCompatibleParsedResponse,
  OpenAiCompatibleToolCall
} from './openai-compatible-types';
import {
  ANTHROPIC_EFFORT_THINKING_BUDGET_TOKENS,
  resolveOpenAiCompatibleChatTokenParameter,
  resolveOpenAiCompatibleProviderProfile,
  resolveProviderModelMetadata,
  type ResolvedProviderEffortLevel
} from '../../shared/provider-catalog';
import {
  isRecord,
  extractReasoningFromAnthropicMessageBody,
  extractReasoningFromChatChoices,
  extractTextFromAnthropicMessageBody,
  extractTextFromChatChoices,
  extractTextFromResponsesBody,
  normalizeAnthropicMessagesUsage
} from './openai-compatible-transport';
import {
  getOpenAiCompatibleAssistantReasoningFields,
  normalizeOpenAiCompatibleToolParameters,
  parseToolCallArguments
} from './openai-compatible-profile-transforms';

function parseToolArguments(value: unknown): {
  arguments: Record<string, unknown>;
  rawArguments?: string;
  argumentsParseError?: string;
} {
  if (isRecord(value)) {
    return {
      arguments: value
    };
  }
  if (typeof value !== 'string') {
    return {
      arguments: {}
    };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      arguments: {},
      rawArguments: value
    };
  }
  const parsed = parseToolCallArguments(trimmed);
  if (parsed) {
    return {
      arguments: parsed,
      rawArguments: value
    };
  }
  return {
    arguments: {},
    rawArguments: value,
    argumentsParseError: 'Tool arguments are not valid JSON.'
  };
}

function stringifyToolArguments(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function serializeChatToolDefinition(
  toolDefinition: OpenAiCompatibleToolStepRequest['tools'][number],
  request: OpenAiCompatibleToolStepRequest
): Record<string, unknown> {
  const parameters = normalizeOpenAiCompatibleToolParameters(toolDefinition.parameters, {
    provider: request.provider,
    model: request.model,
    apiMode: 'chat'
  });
  return {
    type: 'function',
    function: {
      name: toolDefinition.name,
      description: toolDefinition.description,
      ...(parameters ? { parameters } : {})
    }
  };
}

function serializeResponsesToolDefinition(
  toolDefinition: OpenAiCompatibleToolStepRequest['tools'][number],
  request: OpenAiCompatibleToolStepRequest
): Record<string, unknown> {
  const parameters = normalizeOpenAiCompatibleToolParameters(toolDefinition.parameters, {
    provider: request.provider,
    model: request.model,
    apiMode: 'responses'
  });
  return {
    type: 'function',
    name: toolDefinition.name,
    description: toolDefinition.description,
    ...(parameters ? { parameters } : {})
  };
}

function getFirstChoice(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) {
    return undefined;
  }
  return body.choices[0];
}

function parseCreatedAt(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return new Date(value * 1000).toISOString();
  }
  return undefined;
}

function inferResponsesFinishReason(body: Record<string, unknown>, text: string): string | undefined {
  if (!Array.isArray(body.output)) {
    return undefined;
  }
  if (body.output.some((item) => isRecord(item) && item.type === 'function_call')) {
    return 'tool_calls';
  }
  return text.trim() ? 'stop' : undefined;
}

function makeParsedResponse(text: string, body: unknown): OpenAiCompatibleParsedResponse {
  const record = isRecord(body) ? body : {};
  const firstChoice = getFirstChoice(body);
  const reasoningContent = extractReasoningFromChatChoices(body);
  const finishReason =
    typeof record.finish_reason === 'string'
      ? record.finish_reason
      : typeof record.status === 'string'
        ? record.status
        : typeof firstChoice?.finish_reason === 'string'
          ? firstChoice.finish_reason
          : inferResponsesFinishReason(record, text);
  return {
    text,
    reasoningContent: reasoningContent || undefined,
    finishReason,
    rawFinishReason: typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : undefined,
    usage: record.usage,
    responseId: typeof record.id === 'string' ? record.id : undefined,
    responseModelId: typeof record.model === 'string' ? record.model : undefined,
    responseTimestamp: parseCreatedAt(record.created_at ?? record.created),
    responseBody: body
  };
}

function getChatTokenParameter(request: OpenAiCompatibleRequest | OpenAiCompatibleToolStepRequest): 'max_tokens' | 'max_completion_tokens' {
  return resolveOpenAiCompatibleChatTokenParameter({
    name: request.provider.name,
    protocol: request.provider.protocol,
    baseUrl: request.provider.baseUrl,
    apiMode: request.provider.apiMode,
    model: request.model
  });
}

function shouldSendAutoToolChoice(request: OpenAiCompatibleToolStepRequest): boolean {
  const profile = resolveOpenAiCompatibleProviderProfile({
    name: request.provider.name,
    protocol: request.provider.protocol,
    baseUrl: request.provider.baseUrl,
    apiMode: request.provider.apiMode
  });
  return request.tools.length > 0 && !profile.omitToolChoice && profile.toolChoiceModes.includes('auto');
}

function serializeResponsesTextMessage(role: 'user' | 'assistant', content: string): Record<string, unknown> {
  return {
    type: 'message',
    role,
    content: [
      {
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: content
      }
    ]
  };
}

// OpenAI-style reasoning knobs only define low/medium/high on the wire; xhigh/max clamp to high.
function toOpenAiReasoningEffort(level: ResolvedProviderEffortLevel): 'low' | 'medium' | 'high' {
  return level === 'low' || level === 'medium' ? level : 'high';
}

export class ChatCompletionsAdapter implements OpenAiCompatibleProtocolAdapter {
  readonly apiMode = 'chat' as const;

  getCompletionUrl(baseUrl: string): string {
    return `${baseUrl}/chat/completions`;
  }

  serializeRequest(request: OpenAiCompatibleRequest): unknown {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages
    };
    body[getChatTokenParameter(request)] = request.maxOutputTokens;
    return body;
  }

  serializeToolStepRequest(request: OpenAiCompatibleToolStepRequest): unknown {
    const messages = [
      {
        role: 'system',
        content: request.system
      },
      ...request.messages.map((message) => {
        if (message.role === 'responses_output') {
          return {
            role: 'assistant',
            content: ''
          };
        }
        if (message.role === 'tool') {
          return {
            role: 'tool',
            tool_call_id: message.toolCallId,
            ...(message.name ? { name: message.name } : {}),
            content: message.content
          };
        }
        if (message.role === 'assistant') {
          return {
            role: 'assistant',
            content: message.content ?? null,
            ...getOpenAiCompatibleAssistantReasoningFields(message.reasoningContent, request),
            ...(message.toolCalls?.length
              ? {
                  tool_calls: message.toolCalls.map((toolCall) => ({
                    id: toolCall.id,
                    type: 'function',
                    function: {
                      name: toolCall.name,
                      arguments: stringifyToolArguments(toolCall.arguments)
                    }
                  }))
                }
              : {})
          };
        }
        return {
          role: 'user',
          content: message.images?.length
            ? [
                { type: 'text', text: message.content },
                ...message.images.map((image) => ({
                  type: 'image_url',
                  image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` }
                }))
              ]
            : message.content
        };
      })
    ];
    const body: Record<string, unknown> = {
      model: request.model,
      messages
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((toolDefinition) => serializeChatToolDefinition(toolDefinition, request));
    }
    if (shouldSendAutoToolChoice(request)) {
      body.tool_choice = 'auto';
    }
    if (request.effort) {
      body.reasoning_effort = toOpenAiReasoningEffort(request.effort);
    }
    body[getChatTokenParameter(request)] = request.maxOutputTokens;
    return body;
  }

  parseResponse(body: unknown): OpenAiCompatibleParsedResponse {
    return makeParsedResponse(extractTextFromChatChoices(body), body);
  }

  parseToolCalls(body: unknown): OpenAiCompatibleToolCall[] {
    const firstChoice = getFirstChoice(body);
    const message = isRecord(firstChoice?.message) ? firstChoice.message : undefined;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const parsedToolCalls = toolCalls
      .map((toolCall, index) => {
        if (!isRecord(toolCall)) {
          return undefined;
        }
        const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
        const name = typeof fn?.name === 'string' ? fn.name : '';
        if (!name) {
          return undefined;
        }
        const parsedArguments = parseToolArguments(fn?.arguments);
        return {
          id: typeof toolCall.id === 'string' ? toolCall.id : `call_${index}`,
          name,
          ...parsedArguments
        };
      })
      .filter((toolCall): toolCall is OpenAiCompatibleToolCall => Boolean(toolCall));

    if (parsedToolCalls.length > 0) {
      return parsedToolCalls;
    }

    const functionCall = isRecord(message?.function_call) ? message.function_call : undefined;
    const functionName = typeof functionCall?.name === 'string' ? functionCall.name : '';
    if (!functionName) {
      return [];
    }
    return [
      {
        id: 'function_call',
        name: functionName,
        ...parseToolArguments(functionCall?.arguments)
      }
    ];
  }
}

export class ResponsesAdapter implements OpenAiCompatibleProtocolAdapter {
  readonly apiMode = 'responses' as const;

  getCompletionUrl(baseUrl: string): string {
    return `${baseUrl}/responses`;
  }

  serializeRequest(request: OpenAiCompatibleRequest): unknown {
    const instructions = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join('\n\n');
    const input = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => serializeResponsesTextMessage('user', message.content));

    return {
      model: request.model,
      max_output_tokens: request.maxOutputTokens,
      store: false,
      ...(instructions ? { instructions } : {}),
      input
    };
  }

  serializeToolStepRequest(request: OpenAiCompatibleToolStepRequest): unknown {
    const input = request.messages.flatMap((message): unknown[] => {
      if (message.role === 'responses_output') {
        return message.items;
      }
      if (message.role === 'tool') {
        return [
          {
            type: 'function_call_output',
            call_id: message.toolCallId,
            output: message.content
          }
        ];
      }
      if (message.role === 'assistant') {
        const items: unknown[] = [];
        if (message.content?.trim()) {
          items.push(serializeResponsesTextMessage('assistant', message.content));
        }
        for (const toolCall of message.toolCalls ?? []) {
          items.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: stringifyToolArguments(toolCall.arguments)
          });
        }
        return items;
      }
      return [
        message.images?.length
          ? {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: message.content },
                ...message.images.map((image) => ({
                  type: 'input_image',
                  image_url: `data:${image.mimeType};base64,${image.dataBase64}`
                }))
              ]
            }
          : serializeResponsesTextMessage('user', message.content)
      ];
    });

    return {
      model: request.model,
      max_output_tokens: request.maxOutputTokens,
      store: false,
      parallel_tool_calls: false,
      instructions: request.system,
      input,
      ...(request.tools.length > 0
        ? { tools: request.tools.map((toolDefinition) => serializeResponsesToolDefinition(toolDefinition, request)) }
        : {}),
      ...(shouldSendAutoToolChoice(request) ? { tool_choice: 'auto' } : {}),
      ...(request.effort ? { reasoning: { effort: toOpenAiReasoningEffort(request.effort) } } : {})
    };
  }

  parseResponse(body: unknown): OpenAiCompatibleParsedResponse {
    return makeParsedResponse(extractTextFromResponsesBody(body), body);
  }

  parseToolCalls(body: unknown): OpenAiCompatibleToolCall[] {
    if (!isRecord(body) || !Array.isArray(body.output)) {
      return [];
    }

    return body.output
      .map((item, index) => {
        if (!isRecord(item) || item.type !== 'function_call') {
          return undefined;
        }
        const name = typeof item.name === 'string' ? item.name : '';
        if (!name) {
          return undefined;
        }
        const parsedArguments = parseToolArguments(item.arguments);
        return {
          id:
            typeof item.call_id === 'string'
              ? item.call_id
              : typeof item.id === 'string'
                ? item.id
                : `call_${index}`,
          name,
          ...parsedArguments
        };
      })
      .filter((toolCall): toolCall is OpenAiCompatibleToolCall => Boolean(toolCall));
  }
}

type AnthropicMessageBlock = Record<string, unknown>;

interface AnthropicMessageTurn {
  role: 'user' | 'assistant';
  content: AnthropicMessageBlock[];
}

const ANTHROPIC_MIN_MESSAGES_THINKING_BUDGET_TOKENS = 1024;
const ANTHROPIC_EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' as const };

// The Messages API requires strictly alternating user/assistant turns, so consecutive
// same-role messages (e.g. several tool results) fold into one turn's content blocks.
function pushAnthropicMessageBlocks(
  turns: AnthropicMessageTurn[],
  role: AnthropicMessageTurn['role'],
  blocks: AnthropicMessageBlock[]
): void {
  if (blocks.length === 0) {
    return;
  }
  const last = turns[turns.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
    return;
  }
  turns.push({
    role,
    content: blocks
  });
}

function mapAnthropicStopReasonToFinishReason(stopReason: string | undefined, text: string): string | undefined {
  if (stopReason === 'tool_use') {
    return 'tool_calls';
  }
  if (stopReason === 'max_tokens') {
    return 'length';
  }
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
    return 'stop';
  }
  if (stopReason) {
    return stopReason;
  }
  return text.trim() ? 'stop' : undefined;
}

export class AnthropicMessagesAdapter implements OpenAiCompatibleProtocolAdapter {
  readonly apiMode = 'anthropic-messages' as const;

  getCompletionUrl(baseUrl: string): string {
    // Anthropic-compatible endpoints sit at <root>/v1/messages; tolerate base URLs
    // that already end in /v1 (the common OpenAI-compatible configuration style).
    return baseUrl.endsWith('/v1') ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
  }

  serializeRequest(request: OpenAiCompatibleRequest): unknown {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join('\n\n');
    const turns: AnthropicMessageTurn[] = [];
    for (const message of request.messages) {
      if (message.role === 'system' || !message.content.trim()) {
        continue;
      }
      pushAnthropicMessageBlocks(turns, 'user', [{ type: 'text', text: message.content }]);
    }

    return {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      ...(system ? { system } : {}),
      messages: turns
    };
  }

  serializeToolStepRequest(request: OpenAiCompatibleToolStepRequest): unknown {
    const capabilities = resolveProviderModelMetadata(request.provider)?.capabilities;
    const useExplicitCacheBreakpoints = capabilities?.cachingShape === 'anthropic-explicit';
    const preserveReasoning = capabilities?.preserveReasoning === true;

    const turns: AnthropicMessageTurn[] = [];
    for (const message of request.messages) {
      if (message.role === 'responses_output') {
        continue;
      }
      if (message.role === 'tool') {
        pushAnthropicMessageBlocks(turns, 'user', [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: [{ type: 'text', text: message.content }]
          }
        ]);
        continue;
      }
      if (message.role === 'assistant') {
        const blocks: AnthropicMessageBlock[] = [];
        if (preserveReasoning && message.reasoningContent?.trim()) {
          // MiniMax-style interleaved thinking round-trip: prior-turn reasoning is
          // re-sent as a thinking block ahead of the visible assistant content.
          blocks.push({
            type: 'thinking',
            thinking: message.reasoningContent,
            signature: ''
          });
        }
        if (message.content?.trim()) {
          blocks.push({ type: 'text', text: message.content });
        }
        for (const toolCall of message.toolCalls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.arguments
          });
        }
        pushAnthropicMessageBlocks(turns, 'assistant', blocks);
        continue;
      }
      pushAnthropicMessageBlocks(turns, 'user', [
        { type: 'text', text: message.content },
        ...(message.images ?? []).map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mimeType, data: image.dataBase64 }
        }))
      ]);
    }

    if (useExplicitCacheBreakpoints && turns.length > 0) {
      // One breakpoint on the last block of the last message: everything before it
      // (system + tools + history) becomes the reusable cached prefix.
      const lastTurn = turns[turns.length - 1];
      const lastBlock = lastTurn.content[lastTurn.content.length - 1];
      lastTurn.content[lastTurn.content.length - 1] = {
        ...lastBlock,
        cache_control: ANTHROPIC_EPHEMERAL_CACHE_CONTROL
      };
    }

    const system = request.system.trim()
      ? useExplicitCacheBreakpoints
        ? [
            {
              type: 'text',
              text: request.system,
              cache_control: ANTHROPIC_EPHEMERAL_CACHE_CONTROL
            }
          ]
        : request.system
      : undefined;

    const thinkingBudgetTokens = request.effort
      ? Math.min(
          ANTHROPIC_EFFORT_THINKING_BUDGET_TOKENS[request.effort],
          request.maxOutputTokens - ANTHROPIC_MIN_MESSAGES_THINKING_BUDGET_TOKENS
        )
      : 0;

    return {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      ...(system ? { system } : {}),
      messages: turns,
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((toolDefinition) => ({
              name: toolDefinition.name,
              description: toolDefinition.description,
              input_schema:
                normalizeOpenAiCompatibleToolParameters(toolDefinition.parameters, {
                  provider: request.provider,
                  model: request.model,
                  apiMode: 'anthropic-messages'
                }) ?? { type: 'object', properties: {} }
            }))
          }
        : {}),
      ...(shouldSendAutoToolChoice(request) ? { tool_choice: { type: 'auto' } } : {}),
      ...(thinkingBudgetTokens >= ANTHROPIC_MIN_MESSAGES_THINKING_BUDGET_TOKENS
        ? { thinking: { type: 'enabled', budget_tokens: thinkingBudgetTokens } }
        : {})
    };
  }

  parseResponse(body: unknown): OpenAiCompatibleParsedResponse {
    const record = isRecord(body) ? body : {};
    const text = extractTextFromAnthropicMessageBody(body);
    const reasoningContent = extractReasoningFromAnthropicMessageBody(body);
    const stopReason = typeof record.stop_reason === 'string' ? record.stop_reason : undefined;
    return {
      text,
      reasoningContent: reasoningContent || undefined,
      finishReason: mapAnthropicStopReasonToFinishReason(stopReason, text),
      rawFinishReason: stopReason,
      usage: normalizeAnthropicMessagesUsage(record.usage),
      responseId: typeof record.id === 'string' ? record.id : undefined,
      responseModelId: typeof record.model === 'string' ? record.model : undefined,
      responseTimestamp: undefined,
      responseBody: body
    };
  }

  parseToolCalls(body: unknown): OpenAiCompatibleToolCall[] {
    if (!isRecord(body) || !Array.isArray(body.content)) {
      return [];
    }
    return body.content
      .map((block, index) => {
        if (!isRecord(block) || block.type !== 'tool_use') {
          return undefined;
        }
        const name = typeof block.name === 'string' ? block.name : '';
        if (!name) {
          return undefined;
        }
        return {
          id: typeof block.id === 'string' ? block.id : `toolu_${index}`,
          name,
          ...parseToolArguments(block.input)
        };
      })
      .filter((toolCall): toolCall is OpenAiCompatibleToolCall => Boolean(toolCall));
  }
}
