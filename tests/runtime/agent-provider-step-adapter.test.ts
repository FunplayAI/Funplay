import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiSdkStepToAgentCoreProviderStepResult,
  normalizeAgentCoreProviderFinishReason,
  openAiCompatibleStepToAgentCoreProviderStepResult
} from '../../electron/main/agent-platform/provider-step-adapter.ts';

test('provider step adapter normalizes finish reasons', () => {
  assert.equal(normalizeAgentCoreProviderFinishReason('stop'), 'stop');
  assert.equal(normalizeAgentCoreProviderFinishReason('max_tokens'), 'length');
  assert.equal(normalizeAgentCoreProviderFinishReason('content_filter'), 'content_filter');
  assert.equal(normalizeAgentCoreProviderFinishReason('stop', { hasToolCalls: true }), 'tool_calls');
  assert.equal(normalizeAgentCoreProviderFinishReason('ignored', { isError: true }), 'error');
  assert.equal(normalizeAgentCoreProviderFinishReason(undefined), 'unknown');
});

test('OpenAI-compatible provider step maps to Agent Core provider step result', () => {
  const step = openAiCompatibleStepToAgentCoreProviderStepResult(
    {
      text: '需要读文件',
      reasoningContent: 'think',
      finishReason: 'stop',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: {
          cached_tokens: 3
        }
      },
      requestUrl: 'https://example.test/v1/chat/completions',
      requestBody: {},
      responseBody: {},
      toolCalls: [
        {
          id: 'call_1',
          name: 'read_file',
          arguments: {
            path: 'README.md'
          }
        }
      ],
      streamed: true,
      responseId: 'resp_1',
      responseModelId: 'model_1'
    },
    {
      providerId: 'provider_1',
      model: 'model_1'
    }
  );

  assert.equal(step.finishReason, 'tool_calls');
  assert.equal(step.text, '需要读文件');
  assert.equal(step.thinking, 'think');
  assert.deepEqual(step.toolCalls, [
    {
      toolUseId: 'call_1',
      providerCallId: 'call_1',
      name: 'read_file',
      input: {
        path: 'README.md'
      }
    }
  ]);
  assert.equal(step.usage?.totalTokens, 15);
  assert.equal(step.usage?.cacheReadTokens, 3);
  assert.equal(step.rawMetadata?.responseId, 'resp_1');
});

test('AI SDK provider step maps tool calls and usage', () => {
  const step = aiSdkStepToAgentCoreProviderStepResult(
    {
      text: 'done',
      finishReason: 'stop',
      usage: {
        inputTokens: 7,
        outputTokens: 4,
        totalTokens: 11
      },
      toolCalls: [
        {
          toolCallId: 'tool_1',
          toolName: 'find_files',
          input: {
            query: '*.ts'
          }
        }
      ]
    },
    {
      providerId: 'provider_ai_sdk',
      model: 'claude-test'
    }
  );

  assert.equal(step.finishReason, 'tool_calls');
  assert.equal(step.toolCalls[0]?.name, 'find_files');
  assert.equal(step.toolCalls[0]?.providerCallId, 'tool_1');
  assert.equal(step.usage?.inputTokens, 7);
  assert.equal(step.usage?.outputTokens, 4);
});
