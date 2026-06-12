import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatCompletionsAdapter,
  ResponsesAdapter,
  AnthropicMessagesAdapter
} from '../../electron/main/openai-compatible-adapters.ts';
import { resolveProviderEffortLevel } from '../../shared/provider-catalog.ts';
import { classifyNativeRuntimeError } from '../../electron/main/agent-platform/native/diagnostics.ts';
import { resolveTodoSnapshotFromToolResult } from '../../electron/main/agent-platform/native/continuation-policy.ts';
import type { AiProvider } from '../../shared/types/index.ts';
import type {
  OpenAiCompatibleToolStepRequest,
  OpenAiCompatibleToolMessage
} from '../../electron/main/openai-compatible-types.ts';

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'p1',
    name: 'Test',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    apiKey: 'sk-test',
    authStyle: 'api_key',
    ...overrides
  } as AiProvider;
}

function stepRequest(overrides: Partial<OpenAiCompatibleToolStepRequest> = {}): OpenAiCompatibleToolStepRequest {
  return {
    provider: provider(),
    model: 'test-model',
    system: 'You are a helper.',
    messages: [{ role: 'user', content: 'hi' }] as OpenAiCompatibleToolMessage[],
    tools: [],
    maxOutputTokens: 4096,
    ...overrides
  };
}

test('effort resolution clamps to the model-declared supported levels', () => {
  const gpt = provider({
    model: 'gpt-5.5',
    availableModels: [
      {
        modelId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        capabilities: { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }
      }
    ]
  });
  assert.equal(resolveProviderEffortLevel(gpt, 'high'), 'high');
  // 'max' is above this model's ceiling → clamps down to the highest supported level.
  assert.equal(resolveProviderEffortLevel(gpt, 'max'), 'high');
  // 'auto' and unsupported models map to no knob.
  assert.equal(resolveProviderEffortLevel(gpt, 'auto'), undefined);
  assert.equal(resolveProviderEffortLevel(provider(), 'high'), undefined);
});

test('chat adapter emits reasoning_effort only when an effort level is resolved', () => {
  const adapter = new ChatCompletionsAdapter();
  const withEffort = adapter.serializeToolStepRequest(stepRequest({ effort: 'medium' })) as Record<string, unknown>;
  assert.equal(withEffort.reasoning_effort, 'medium');
  const withoutEffort = adapter.serializeToolStepRequest(stepRequest()) as Record<string, unknown>;
  assert.equal('reasoning_effort' in withoutEffort, false);
});

test('responses adapter nests effort under reasoning', () => {
  const adapter = new ResponsesAdapter();
  const body = adapter.serializeToolStepRequest(stepRequest({ effort: 'high' })) as Record<string, unknown>;
  assert.deepEqual(body.reasoning, { effort: 'high' });
});

test('anthropic-messages adapter maps a tool result to a user tool_result block', () => {
  const adapter = new AnthropicMessagesAdapter();
  const body = adapter.serializeToolStepRequest(
    stepRequest({
      messages: [
        { role: 'user', content: 'run the build' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'run_command', arguments: { command: 'npm run build' } }]
        },
        { role: 'tool', toolCallId: 'call_1', name: 'run_command', content: 'build ok' }
      ] as OpenAiCompatibleToolMessage[]
    })
  ) as {
    messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    max_tokens: number;
    system?: unknown;
  };

  assert.equal(typeof body.max_tokens, 'number');
  const toolUse = body.messages.find((m) => m.role === 'assistant')?.content.find((b) => b.type === 'tool_use');
  assert.equal(toolUse?.name, 'run_command');
  const toolResult = body.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
  assert.equal(toolResult?.tool_use_id, 'call_1');
});

test('anthropic-messages adapter adds cache_control breakpoints only for anthropic-explicit caching', () => {
  const adapter = new AnthropicMessagesAdapter();
  const explicit = provider({
    model: 'qwen-cache',
    availableModels: [
      { modelId: 'qwen-cache', displayName: 'Qwen', capabilities: { cachingShape: 'anthropic-explicit' } }
    ]
  });
  const body = adapter.serializeToolStepRequest(stepRequest({ provider: explicit, model: 'qwen-cache' })) as {
    system?: Array<Record<string, unknown>>;
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  assert.ok(Array.isArray(body.system));
  assert.ok(body.system?.[0]?.cache_control);

  const implicit = adapter.serializeToolStepRequest(stepRequest()) as { system?: unknown };
  assert.equal(typeof implicit.system, 'string');
});

test('diagnostics prefers structured status codes over message regexes', () => {
  const rateLimited = classifyNativeRuntimeError({
    provider: provider(),
    error: Object.assign(new Error('something opaque'), { statusCode: 429 })
  });
  assert.equal(rateLimited.code, 'native_rate_limited');

  const overloaded = classifyNativeRuntimeError({
    provider: provider(),
    error: Object.assign(new Error('opaque'), { cause: { status: 503 } })
  });
  assert.equal(overloaded.code, 'native_overloaded');

  const auth = classifyNativeRuntimeError({
    provider: provider(),
    error: Object.assign(new Error('opaque'), { statusCode: 401 })
  });
  assert.equal(auth.code, 'native_auth_failed');
});

test('todo snapshot resolves only from structured tool input, never from rendered summary', () => {
  const fromInput = resolveTodoSnapshotFromToolResult({
    toolName: 'update_todo_list',
    toolInput: { todos: [{ id: 't1', content: 'do it', status: 'in_progress' }] },
    summary: '- [completed] x: unrelated'
  });
  assert.equal(fromInput?.items[0]?.status, 'in_progress');

  const noInput = resolveTodoSnapshotFromToolResult({
    toolName: 'update_todo_list',
    toolInput: undefined,
    summary: '- [in_progress] t1: do it'
  });
  assert.equal(noInput, undefined);
});
