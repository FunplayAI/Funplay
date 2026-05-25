import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentCoreMessagePart } from '../../shared/types.ts';
import {
  agentCorePartsToAiSdkModelMessages,
  agentCorePartsToOpenAiCompatibleMessages,
  buildAgentCoreReplaySnapshot
} from '../../electron/main/agent-core/index.ts';

function partBase(sequence: number): Pick<AgentCoreMessagePart, 'id' | 'createdAt' | 'sequence'> {
  return {
    id: `part_${sequence}`,
    createdAt: `2026-05-15T00:00:0${sequence}.000Z`,
    sequence
  };
}

test('Agent Core replay builds OpenAI-compatible assistant tool messages', () => {
  const parts: AgentCoreMessagePart[] = [
    {
      ...partBase(1),
      kind: 'assistant_thinking',
      thinking: 'inspect first'
    },
    {
      ...partBase(2),
      kind: 'assistant_text',
      text: '我先读文件。'
    },
    {
      ...partBase(3),
      kind: 'tool_call',
      toolUseId: 'tool_1',
      providerCallId: 'call_1',
      name: 'read_file',
      input: {
        path: 'package.json'
      },
      status: 'completed'
    },
    {
      ...partBase(4),
      kind: 'tool_result',
      toolUseId: 'call_1',
      toolName: 'read_file',
      content: '{"name":"funplay"}'
    },
    {
      ...partBase(5),
      kind: 'assistant_text',
      text: '读取完成。'
    }
  ];

  const messages = agentCorePartsToOpenAiCompatibleMessages(parts);
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.role, 'assistant');
  if (messages[0]?.role !== 'assistant') {
    throw new Error('Expected assistant message.');
  }
  assert.equal(messages[0].content, '我先读文件。');
  assert.equal(messages[0].reasoningContent, 'inspect first');
  assert.deepEqual(messages[0].toolCalls, [
    {
      id: 'call_1',
      name: 'read_file',
      arguments: {
        path: 'package.json'
      }
    }
  ]);
  assert.deepEqual(messages[1], {
    role: 'tool',
    toolCallId: 'call_1',
    name: 'read_file',
    content: '{"name":"funplay"}'
  });
  assert.deepEqual(messages[2], {
    role: 'assistant',
    content: '读取完成。',
    reasoningContent: undefined,
    toolCalls: undefined
  });
});

test('Agent Core replay builds AI SDK model messages with tool errors and context', () => {
  const parts: AgentCoreMessagePart[] = [
    {
      ...partBase(2),
      kind: 'tool_error',
      toolUseId: 'tool_bad',
      toolName: 'edit_file',
      error: 'oldText not found',
      failureKind: 'precheck_failed'
    },
    {
      ...partBase(1),
      kind: 'tool_call',
      toolUseId: 'tool_bad',
      name: 'edit_file',
      input: {
        path: 'src/index.ts'
      },
      status: 'failed'
    },
    {
      ...partBase(3),
      kind: 'context_summary',
      summary: 'Earlier work was compacted.'
    }
  ];

  const messages = agentCorePartsToAiSdkModelMessages(parts);
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.role, 'assistant');
  if (messages[0]?.role !== 'assistant' || !Array.isArray(messages[0].content)) {
    throw new Error('Expected assistant parts.');
  }
  assert.equal(messages[0].content[0]?.type, 'tool-call');
  assert.equal(messages[1]?.role, 'tool');
  if (messages[1]?.role !== 'tool') {
    throw new Error('Expected tool message.');
  }
  assert.equal(messages[1].content[0]?.type, 'tool-result');
  assert.match(JSON.stringify(messages[1]), /oldText not found/);
  assert.deepEqual(messages[2], {
    role: 'user',
    content: 'Context summary:\nEarlier work was compacted.'
  });
});

test('Agent Core replay snapshot resumes from the last completed tool boundary', () => {
  const parts: AgentCoreMessagePart[] = [
    {
      ...partBase(1),
      kind: 'assistant_text',
      text: '先读文件。'
    },
    {
      ...partBase(2),
      kind: 'tool_call',
      toolUseId: 'tool_done',
      name: 'read_file',
      input: {
        path: 'README.md'
      },
      status: 'completed'
    },
    {
      ...partBase(3),
      kind: 'tool_result',
      toolUseId: 'tool_done',
      toolName: 'read_file',
      content: 'README content'
    },
    {
      ...partBase(4),
      kind: 'tool_call',
      toolUseId: 'tool_pending',
      name: 'write_file',
      input: {
        path: 'index.html'
      },
      status: 'pending'
    }
  ];

  const snapshot = buildAgentCoreReplaySnapshot(parts);

  assert.equal(snapshot.cursor.strategy, 'resume_after_last_completed_tool');
  assert.equal(snapshot.cursor.toolUseId, 'tool_done');
  assert.deepEqual(snapshot.completedToolUseIds, ['tool_done']);
  assert.deepEqual(snapshot.pendingToolUseIds, ['tool_pending']);
  assert.equal(snapshot.stableParts.some((part) => part.kind === 'tool_call' && part.toolUseId === 'tool_pending'), false);
  assert.match(JSON.stringify(snapshot.openAiCompatibleMessages), /README content/);
  assert.equal(JSON.stringify(snapshot.openAiCompatibleMessages).includes('tool_pending'), false);
});

test('Agent Core replay formats structured context summaries without breaking tool pairing', () => {
  const parts: AgentCoreMessagePart[] = [
    {
      ...partBase(1),
      kind: 'context_summary',
      summary: 'Earlier work compressed.',
      structured: {
        goal: 'Build a stable agent loop',
        completedWork: ['Tool replay is stable'],
        unfinishedWork: ['UI replay parity'],
        changedFiles: ['electron/main/agent-core/replay.ts'],
        decisions: ['Use host-owned permission checks'],
        constraints: ['No pseudo tool text'],
        failedTools: ['edit_file missing_match'],
        nextStep: 'Continue from replay cursor'
      }
    },
    {
      ...partBase(2),
      kind: 'tool_call',
      toolUseId: 'tool_after_summary',
      name: 'read_file',
      input: {
        path: 'README.md'
      },
      status: 'completed'
    },
    {
      ...partBase(3),
      kind: 'tool_result',
      toolUseId: 'tool_after_summary',
      toolName: 'read_file',
      content: 'README content'
    }
  ];

  const messages = agentCorePartsToOpenAiCompatibleMessages(parts);

  assert.equal(messages[0]?.role, 'user');
  assert.match(messages[0]?.role === 'user' ? messages[0].content : '', /Goal: Build a stable agent loop/);
  assert.match(messages[0]?.role === 'user' ? messages[0].content : '', /Next step: Continue from replay cursor/);
  assert.equal(messages[1]?.role, 'assistant');
  assert.equal(messages[2]?.role, 'tool');
});
