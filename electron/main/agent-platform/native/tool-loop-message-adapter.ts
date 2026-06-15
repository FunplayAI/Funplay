import type { ModelMessage } from 'ai';
import { makeId } from '../../../../shared/utils';
import {
  type OpenAiCompatibleToolCall,
  type OpenAiCompatibleToolMessage
} from '../../openai-compatible-client';
import type { OpenAiCompatibleImagePart } from '../../openai-compatible-types';
import { DYNAMIC_PROJECT_INSTRUCTIONS_MARKER } from '../project-instruction-tracker';

export function normalizeToolInput(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function isDynamicInstructionMessage(message: ModelMessage): boolean {
  return message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(DYNAMIC_PROJECT_INSTRUCTIONS_MARKER);
}

export function withDynamicInstructionMessage(messages: ModelMessage[], content: string): ModelMessage[] {
  return [
    ...messages.filter((message) => !isDynamicInstructionMessage(message)),
    {
      role: 'user',
      content
    }
  ];
}

function collectTextFromModelContent(content: ModelMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function collectImagePartsFromModelContent(content: ModelMessage['content']): OpenAiCompatibleImagePart[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: OpenAiCompatibleImagePart[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || !('type' in part) || part.type !== 'image') {
      continue;
    }
    const image = (part as { image?: unknown }).image;
    const mediaType = (part as { mediaType?: unknown }).mediaType;
    // The native builder inlines image attachments as base64 strings + mediaType.
    if (typeof image === 'string' && typeof mediaType === 'string') {
      parts.push({ mimeType: mediaType, dataBase64: image });
    }
  }
  return parts;
}

function safeStringifyOpenAiCompatibleValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectHistoricToolResultText(content: ModelMessage['content']): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object' || !('type' in part) || part.type !== 'tool-result') {
        return '';
      }
      const output =
        'output' in part && part.output && typeof part.output === 'object' && 'value' in part.output && typeof part.output.value === 'string'
          ? part.output.value
          : 'output' in part
            ? safeStringifyOpenAiCompatibleValue(part.output)
            : '';
      return output.trim();
    })
    .filter(Boolean)
    .join('\n');
}

export function convertModelMessagesToOpenAiCompatible(messages: ModelMessage[], options: {
  preserveToolMessages?: boolean;
} = {}): OpenAiCompatibleToolMessage[] {
  const preserveToolMessages = options.preserveToolMessages ?? true;
  const converted: OpenAiCompatibleToolMessage[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      const content = collectTextFromModelContent(message.content);
      const images = collectImagePartsFromModelContent(message.content);
      if (content.trim() || images.length > 0) {
        converted.push({
          role: 'user',
          content,
          ...(images.length > 0 ? { images } : {})
        });
      }
      continue;
    }

    if (message.role === 'assistant') {
      if (!preserveToolMessages) {
        const content = collectTextFromModelContent(message.content);
        if (content.trim()) {
          converted.push({
            role: 'assistant',
            content
          });
        }
        continue;
      }

      const toolCalls: OpenAiCompatibleToolCall[] = [];
      let text = '';
      let reasoningContent = '';
      if (typeof message.content === 'string') {
        text = message.content;
      } else if (Array.isArray(message.content)) {
        text = message.content
          .map((part) => {
            if (!part || typeof part !== 'object') {
              return '';
            }
            if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') {
              return part.text;
            }
            if ('type' in part && part.type === 'reasoning' && 'text' in part && typeof part.text === 'string') {
              reasoningContent = [reasoningContent, part.text].filter(Boolean).join('\n\n');
              return '';
            }
            if ('type' in part && part.type === 'tool-call') {
              const input = 'input' in part && normalizeToolInput(part.input) ? normalizeToolInput(part.input) : {};
              toolCalls.push({
                id: typeof part.toolCallId === 'string' ? part.toolCallId : makeId('tool'),
                name: typeof part.toolName === 'string' ? part.toolName : 'unknown_tool',
                arguments: input ?? {}
              });
            }
            return '';
          })
          .filter(Boolean)
          .join('\n\n');
      }
      if (text.trim() || reasoningContent.trim() || toolCalls.length > 0) {
        converted.push({
          role: 'assistant',
          content: text.trim() || undefined,
          reasoningContent: reasoningContent.trim() || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        });
      }
      continue;
    }

    if (message.role === 'tool' && !preserveToolMessages) {
      const content = collectHistoricToolResultText(message.content);
      if (content.trim()) {
        converted.push({
          role: 'user',
          content: `历史工具结果上下文，仅用于继续任务，不要逐字复述：\n${content}`
        });
      }
      continue;
    }

    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        const toolCallId = 'toolCallId' in part && typeof part.toolCallId === 'string' ? part.toolCallId : '';
        if (!toolCallId) {
          continue;
        }
        const output = 'output' in part && part.output && typeof part.output === 'object' ? part.output : undefined;
        const content =
          output && 'value' in output && typeof output.value === 'string'
            ? output.value
            : 'output' in part && typeof part.output === 'string'
              ? part.output
              : '';
        converted.push({
          role: 'tool',
          toolCallId,
          name: 'toolName' in part && typeof part.toolName === 'string' ? part.toolName : undefined,
          content
        });
      }
    }
  }

  return converted;
}
