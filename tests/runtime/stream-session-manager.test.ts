import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  applyPromptStreamEventToManager,
  clearStreamSessions,
  getStreamSessionForSession,
  listStreamSessions,
  seedStreamSession,
  subscribeStreamSessions,
  type StreamSessionLabels,
  type StreamSessionState
} from '../../src/lib/stream-session-manager.ts';
import { restoreMissingRuntimeStreams } from '../../src/hooks/agent-runtime-stream-restore.ts';
import type { AgentRuntimeStatus } from '../../shared/types.ts';

const labels: StreamSessionLabels = {
  streaming: 'streaming',
  reasoning: 'reasoning',
  toolRunning: (name) => `tool:${name}`,
  toolCompleted: 'tool completed',
  toolFailed: 'tool failed',
  waitingPermission: 'waiting permission',
  waitingUserInput: 'waiting user input',
  permissionAllowed: 'permission allowed',
  permissionAllowedSession: 'permission allowed session',
  permissionDenied: 'permission denied',
  userInputSubmitted: 'user input submitted',
  completed: 'completed'
};

function stream(input: {
  streamId: string;
  projectId: string;
  sessionId: string;
  startedAt: string;
  phase?: StreamSessionState['phase'];
}): StreamSessionState {
  return {
    streamId: input.streamId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    prompt: `prompt ${input.streamId}`,
    content: '',
    thinkingContent: '',
    toolUses: [],
    toolResults: [],
    phase: input.phase ?? 'starting',
    activityItems: [],
    statusMessage: 'starting',
    startedAt: input.startedAt,
    kind: 'conversation'
  };
}

test('stream manager tracks parallel sessions within and across projects', () => {
  clearStreamSessions();

  seedStreamSession(
    stream({
      streamId: 'stream_project_a_session_1',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );
  seedStreamSession(
    stream({
      streamId: 'stream_project_a_session_2',
      projectId: 'project_a',
      sessionId: 'session_2',
      startedAt: '2026-04-22T08:01:00.000Z'
    })
  );
  seedStreamSession(
    stream({
      streamId: 'stream_project_b_session_1',
      projectId: 'project_b',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:02:00.000Z'
    })
  );

  assert.deepEqual(
    listStreamSessions().map((item) => item.streamId),
    ['stream_project_b_session_1', 'stream_project_a_session_2', 'stream_project_a_session_1']
  );
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.streamId, 'stream_project_a_session_1');
  assert.equal(getStreamSessionForSession('project_b', 'session_1')?.streamId, 'stream_project_b_session_1');

  applyPromptStreamEventToManager(
    {
      type: 'permission_request',
      streamId: 'stream_project_a_session_2',
      projectId: 'project_a',
      sessionId: 'session_2',
      requestId: 'perm_session_2',
      title: 'Write file',
      detail: 'Needs session scoped write permission.',
      risk: 'medium',
      impact: {
        toolName: 'write_file',
        toolTitle: 'Write File',
        paths: ['src/app.ts'],
        checkpointPolicy: 'before_write'
      },
      startedAt: '2026-04-22T08:01:00.000Z'
    },
    labels
  );

  assert.equal(getStreamSessionForSession('project_a', 'session_2')?.pendingPermission?.requestId, 'perm_session_2');
  assert.deepEqual(getStreamSessionForSession('project_a', 'session_2')?.pendingPermission?.impact?.paths, [
    'src/app.ts'
  ]);
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.pendingPermission, undefined);
  assert.equal(getStreamSessionForSession('project_b', 'session_1')?.pendingPermission, undefined);
});

test('stream manager tracks pending user input per active stream', () => {
  clearStreamSessions();

  seedStreamSession(
    stream({
      streamId: 'stream_user_input',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  applyPromptStreamEventToManager(
    {
      type: 'user_input_request',
      streamId: 'stream_user_input',
      projectId: 'project_a',
      sessionId: 'session_1',
      requestId: 'input_1',
      title: 'Choose target',
      question: 'Which screen should be updated?',
      options: [
        { id: 'home', label: 'Home' },
        { id: 'settings', label: 'Settings' }
      ],
      multiSelect: true,
      allowFreeText: false,
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );

  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.pendingUserInput?.requestId, 'input_1');
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.pendingUserInput?.multiSelect, true);
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.statusMessage, 'waiting user input');

  applyPromptStreamEventToManager(
    {
      type: 'user_input_resolved',
      streamId: 'stream_user_input',
      projectId: 'project_a',
      sessionId: 'session_1',
      requestId: 'input_1',
      response: {
        answer: 'Home, Settings',
        optionId: 'home',
        optionIds: ['home', 'settings']
      },
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );

  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.pendingUserInput, undefined);
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.statusMessage, 'user input submitted');
});

test('stream manager restores running streams from runtime status after renderer reload', async () => {
  clearStreamSessions();
  const status: AgentRuntimeStatus = {
    id: 'run_1',
    kind: 'conversation',
    projectId: 'project_a',
    sessionId: 'session_1',
    streamId: 'stream_restored',
    startedAt: '2026-04-22T08:00:00.000Z',
    updatedAt: '2026-04-22T08:00:03.000Z',
    status: 'running',
    statusMessage: 'Still running',
    canResume: false,
    inputPreview: 'build the scene',
    events: [
      {
        id: 'evt_text',
        type: 'text_delta',
        createdAt: '2026-04-22T08:00:01.000Z',
        status: 'running',
        streamDelta: {
          contentPreview: 'Working...',
          contentLength: 10
        }
      },
      {
        id: 'evt_tool',
        type: 'tool_use',
        createdAt: '2026-04-22T08:00:02.000Z',
        status: 'running',
        toolUse: {
          toolUseId: 'tool_1',
          name: 'read_file',
          title: 'Read file',
          input: { path: 'src/App.tsx' },
          status: 'running'
        }
      },
      {
        id: 'evt_permission',
        type: 'permission_request',
        createdAt: '2026-04-22T08:00:03.000Z',
        status: 'running',
        permissionRequest: {
          requestId: 'perm_1',
          title: 'Allow edit?',
          detail: 'edit src/App.tsx',
          risk: 'medium',
          toolName: 'edit_file'
        }
      }
    ]
  };

  restoreMissingRuntimeStreams([status]);
  const restored = getStreamSessionForSession('project_a', 'session_1');
  assert.equal(restored?.streamId, 'stream_restored');
  assert.equal(restored?.prompt, 'build the scene');
  assert.equal(restored?.statusMessage, 'Still running');
  assert.equal(restored?.pendingPermission?.requestId, 'perm_1');
  assert.ok(restored?.agentCoreParts?.some((part) => part.kind === 'tool_call' && part.title === 'Read file'));

  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_restored',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: 'done',
      content: 'Working...done',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.content, 'W');
  await delay(260);
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.content, 'Working...done');
});

test('stream manager accepts authoritative Agent Core parts from the main runtime ledger', () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_agent_core_parts',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_agent_core_parts',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: '我先读取文件。',
      content: '我先读取文件。',
      startedAt: '2026-04-22T08:00:01.000Z'
    },
    labels
  );
  const liveParts = getStreamSessionForSession('project_a', 'session_1')?.agentCoreParts ?? [];
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.agentCorePartsAuthoritative, undefined);
  assert.deepEqual(
    liveParts.map((part) => part.kind),
    ['assistant_text']
  );
  assert.equal(liveParts[0]?.kind === 'assistant_text' ? liveParts[0].text : '', '我');
  applyPromptStreamEventToManager(
    {
      type: 'tool_use',
      streamId: 'stream_agent_core_parts',
      projectId: 'project_a',
      sessionId: 'session_1',
      toolUseId: 'tool_read',
      name: 'read_file',
      input: {
        path: 'README.md'
      },
      status: 'running',
      startedAt: '2026-04-22T08:00:02.000Z'
    },
    labels
  );
  const flushedLiveParts = getStreamSessionForSession('project_a', 'session_1')?.agentCoreParts ?? [];
  assert.equal(flushedLiveParts[0]?.kind === 'assistant_text' ? flushedLiveParts[0].text : '', '我先读取文件。');
  applyPromptStreamEventToManager(
    {
      type: 'tool_result',
      streamId: 'stream_agent_core_parts',
      projectId: 'project_a',
      sessionId: 'session_1',
      toolUseId: 'tool_read',
      content: 'README content',
      startedAt: '2026-04-22T08:00:03.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'agent_core_parts',
      streamId: 'stream_agent_core_parts',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:04.000Z',
      parts: [
        {
          id: 'ledger_text',
          kind: 'assistant_text',
          sequence: 0,
          createdAt: '2026-04-22T08:00:01.000Z',
          text: '我先读取文件。'
        },
        {
          id: 'ledger_tool_call',
          kind: 'tool_call',
          sequence: 1,
          createdAt: '2026-04-22T08:00:02.000Z',
          toolUseId: 'tool_read',
          name: 'read_file',
          input: {
            path: 'README.md'
          },
          status: 'completed'
        },
        {
          id: 'ledger_tool_result',
          kind: 'tool_result',
          sequence: 2,
          createdAt: '2026-04-22T08:00:03.000Z',
          toolUseId: 'tool_read',
          content: 'README content'
        }
      ]
    },
    labels
  );

  const parts = getStreamSessionForSession('project_a', 'session_1')?.agentCoreParts ?? [];
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.agentCorePartsAuthoritative, true);
  assert.deepEqual(
    parts.map((part) => part.kind),
    ['assistant_text', 'tool_call', 'tool_result']
  );
  assert.equal(parts[0]?.kind === 'assistant_text' ? parts[0].text : '', '我先读取文件。');
  assert.equal(parts[1]?.kind === 'tool_call' ? parts[1].name : '', 'read_file');
  assert.equal(parts[2]?.kind === 'tool_result' ? parts[2].content : '', 'README content');
});

test('stream manager places live tool steps before text generated after the tool', async () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_tool_before_text',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  applyPromptStreamEventToManager(
    {
      type: 'tool_use',
      streamId: 'stream_tool_before_text',
      projectId: 'project_a',
      sessionId: 'session_1',
      toolUseId: 'tool_search',
      name: 'web_search',
      input: {
        query: 'AI news'
      },
      status: 'running',
      startedAt: '2026-04-22T08:00:01.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'tool_result',
      streamId: 'stream_tool_before_text',
      projectId: 'project_a',
      sessionId: 'session_1',
      toolUseId: 'tool_search',
      content: 'Search results',
      startedAt: '2026-04-22T08:00:02.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_tool_before_text',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: '以下是整理后的正文。',
      content: '以下是整理后的正文。',
      startedAt: '2026-04-22T08:00:03.000Z'
    },
    labels
  );

  await delay(180);
  const parts = getStreamSessionForSession('project_a', 'session_1')?.agentCoreParts ?? [];
  assert.deepEqual(
    parts.map((part) => part.kind),
    ['tool_call', 'tool_result', 'assistant_text']
  );
  assert.equal(parts[0]?.kind === 'tool_call' ? parts[0].name : '', 'web_search');
  assert.equal(parts[2]?.kind === 'assistant_text' ? parts[2].text : '', '以下是整理后的正文。');
});

test('stream manager removes completed, cancelled, and error streams after they are consumed', () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_completed',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );
  seedStreamSession(
    stream({
      streamId: 'stream_cancelled',
      projectId: 'project_a',
      sessionId: 'session_2',
      startedAt: '2026-04-22T08:01:00.000Z'
    })
  );

  applyPromptStreamEventToManager(
    {
      type: 'completed',
      streamId: 'stream_completed',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'cancelled',
      streamId: 'stream_cancelled',
      projectId: 'project_a',
      sessionId: 'session_2',
      startedAt: '2026-04-22T08:01:00.000Z'
    },
    labels
  );

  assert.equal(getStreamSessionForSession('project_a', 'session_1'), null);
  assert.equal(getStreamSessionForSession('project_a', 'session_2'), null);
});

test('stream manager keeps runtime status events out of transcript content', () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_runtime_events',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  applyPromptStreamEventToManager(
    {
      type: 'context_compressed',
      streamId: 'stream_runtime_events',
      projectId: 'project_a',
      sessionId: 'session_1',
      message: '上下文已压缩。',
      boundaryOrdinal: 12,
      coveredMessageCount: 13,
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.statusMessage, '上下文已压缩。');
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.content, '');

  applyPromptStreamEventToManager(
    {
      type: 'tool_timeout',
      streamId: 'stream_runtime_events',
      projectId: 'project_a',
      sessionId: 'session_1',
      toolName: 'Read',
      elapsedSeconds: 300,
      message: '工具执行超时。',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.statusMessage, '工具执行超时。');
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.content, '');
});

test('stream manager records usage totals without transcript content', () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_usage_events',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  applyPromptStreamEventToManager(
    {
      type: 'usage',
      streamId: 'stream_usage_events',
      projectId: 'project_a',
      sessionId: 'session_1',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
        totalTokens: 37,
        recordedAt: '2026-04-22T08:00:01.000Z',
        provider: 'openai',
        model: 'gpt-test'
      },
      totals: {
        turns: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
        totalTokens: 37
      },
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );

  const current = getStreamSessionForSession('project_a', 'session_1');
  assert.equal(current?.content, '');
  assert.equal(current?.lastUsage?.model, 'gpt-test');
  assert.deepEqual(current?.usageTotals, {
    turns: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    totalTokens: 37
  });
});

test('stream manager records inline activity at streaming text boundaries', () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_inline_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_inline_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: '我先看一下项目结构。\n\n',
      content: '我先看一下项目结构。\n\n',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'tool_use',
      streamId: 'stream_inline_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      toolUseId: 'tool_read_1',
      name: 'read_file',
      input: { path: 'package.json' },
      status: 'running',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'tool_result',
      streamId: 'stream_inline_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      toolUseId: 'tool_read_1',
      content: 'package metadata',
      transaction: {
        id: 'tool_txn:tool_read_1',
        toolUseId: 'tool_read_1',
        toolName: 'read_file',
        toolClass: 'workspace',
        phase: 'completed',
        status: 'completed',
        eventCount: 3,
        startedAt: '2026-04-22T08:00:00.000Z',
        updatedAt: '2026-04-22T08:00:01.000Z'
      },
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_inline_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: '已经确认入口文件。\n\n',
      content: '我先看一下项目结构。\n\n已经确认入口文件。\n\n',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'context_compressed',
      streamId: 'stream_inline_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      message: '上下文已自动压缩。',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );

  const current = getStreamSessionForSession('project_a', 'session_1');
  assert.equal(current?.activityItems.length, 2);
  assert.equal(current?.activityItems[0]?.type, 'tool');
  assert.equal(current?.activityItems[0]?.status, 'completed');
  assert.deepEqual(current?.activityItems[0]?.toolUseIds, ['tool_read_1']);
  assert.equal(current?.toolResults[0]?.transaction?.toolName, 'read_file');
  assert.equal(current?.toolResults[0]?.transaction?.status, 'completed');
  assert.equal(current?.activityItems[0]?.offset, '我先看一下项目结构。\n\n'.length);
  assert.equal(current?.activityItems[1]?.type, 'context');
  assert.equal(current?.activityItems[1]?.offset, '我先看一下项目结构。\n\n已经确认入口文件。\n\n'.length);
});

test('stream manager records command lifecycle hook stages as inline activity', () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_hook_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_hook_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: '我先完成实现。',
      content: '我先完成实现。',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'stage',
      streamId: 'stream_hook_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      stageId: 'stage:lifecycle_hook:Stop:build_check:hook_1',
      title: '生命周期 Hook',
      target: 'hook:Stop',
      status: 'running',
      input: {
        actionType: 'command',
        status: 'requires_permission'
      },
      summary: 'Hook command requires host permission before execution: npm run build',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  applyPromptStreamEventToManager(
    {
      type: 'stage',
      streamId: 'stream_hook_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      stageId: 'stage:lifecycle_hook:Stop:build_check:hook_1',
      title: '生命周期 Hook',
      target: 'hook:Stop',
      status: 'completed',
      input: {
        actionType: 'command',
        status: 'command_completed'
      },
      summary: 'npm run build completed.',
      transaction: {
        id: 'tool_txn:hook_1',
        toolUseId: 'hook_1',
        toolName: 'run_command',
        toolClass: 'command',
        phase: 'completed',
        status: 'completed',
        eventCount: 5,
        startedAt: '2026-04-22T08:00:00.000Z',
        updatedAt: '2026-04-22T08:00:01.000Z',
        permission: {
          policy: 'ask',
          risk: 'high',
          decision: 'allow',
          requestId: 'perm_hook_1'
        },
        checkpoint: {
          policy: 'external_best_effort',
          status: 'pending'
        }
      },
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );

  const current = getStreamSessionForSession('project_a', 'session_1');
  assert.equal(current?.activityItems.length, 1);
  assert.equal(current?.activityItems[0]?.type, 'stage');
  assert.equal(current?.activityItems[0]?.status, 'completed');
  assert.equal(current?.activityItems[0]?.stageId, 'stage:lifecycle_hook:Stop:build_check:hook_1');
  assert.equal(current?.activityItems[0]?.offset, '我先完成实现。'.length);
  assert.match(current?.activityItems[0]?.summary ?? '', /npm run build completed/);
  assert.equal(current?.stages[0]?.transaction?.toolName, 'run_command');
  assert.equal(current?.activityItems[0]?.transaction?.status, 'completed');
});

test('stream manager keeps separate tool activities at the same text boundary', () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_parallel_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_parallel_activity',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: '我会同时读取两个文件。\n\n',
      content: '我会同时读取两个文件。\n\n',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );

  for (const toolUseId of ['tool_read_a', 'tool_read_b']) {
    applyPromptStreamEventToManager(
      {
        type: 'tool_use',
        streamId: 'stream_parallel_activity',
        projectId: 'project_a',
        sessionId: 'session_1',
        toolUseId,
        name: 'read_file',
        input: { path: `${toolUseId}.txt` },
        status: 'running',
        startedAt: '2026-04-22T08:00:00.000Z'
      },
      labels
    );
    applyPromptStreamEventToManager(
      {
        type: 'tool_result',
        streamId: 'stream_parallel_activity',
        projectId: 'project_a',
        sessionId: 'session_1',
        toolUseId,
        content: `${toolUseId} content`,
        startedAt: '2026-04-22T08:00:00.000Z'
      },
      labels
    );
  }

  const current = getStreamSessionForSession('project_a', 'session_1');
  assert.equal(current?.activityItems.length, 2);
  assert.deepEqual(
    current?.activityItems.map((activity) => activity.toolUseIds),
    [['tool_read_a'], ['tool_read_b']]
  );
  assert.deepEqual(
    current?.activityItems.map((activity) => activity.status),
    ['completed', 'completed']
  );
  assert.deepEqual(
    current?.activityItems.map((activity) => activity.offset),
    ['我会同时读取两个文件。\n\n'.length, '我会同时读取两个文件。\n\n'.length]
  );
});

test('stream manager smooths large text deltas and clears the draft on completion', async () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_smooth_delta',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  const targetContent = [
    '第一段内容需要稳定地显示，避免一次性跳出很长一段。',
    'Second paragraph should also appear progressively instead of in one large UI chunk.',
    '第三段继续补充更多文字，确保 smoothing timer 有足够内容推进。'
  ].join('\n\n');

  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_smooth_delta',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: targetContent,
      content: targetContent,
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );

  const immediateContent = getStreamSessionForSession('project_a', 'session_1')?.content ?? '';
  assert.ok(immediateContent.length > 0);
  assert.ok(immediateContent.length < targetContent.length);

  await delay(70);
  const progressedContent = getStreamSessionForSession('project_a', 'session_1')?.content ?? '';
  assert.ok(progressedContent.length > immediateContent.length);
  assert.ok(progressedContent.length <= targetContent.length);

  applyPromptStreamEventToManager(
    {
      type: 'completed',
      streamId: 'stream_smooth_delta',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );

  assert.equal(getStreamSessionForSession('project_a', 'session_1'), null);
  clearStreamSessions();
});

test('stream manager coalesces rapid text deltas behind a smoothing frame', async () => {
  clearStreamSessions();
  seedStreamSession(
    stream({
      streamId: 'stream_coalesced_delta',
      projectId: 'project_a',
      sessionId: 'session_1',
      startedAt: '2026-04-22T08:00:00.000Z'
    })
  );

  let changeCount = 0;
  const unsubscribe = subscribeStreamSessions(() => {
    changeCount += 1;
  });
  const firstTarget = '第一段需要平滑显示，'.repeat(12);
  const secondTarget = `${firstTarget}${'第二段也应进入同一个平滑帧，'.repeat(8)}`;

  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_coalesced_delta',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: firstTarget,
      content: firstTarget,
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );
  const afterFirst = getStreamSessionForSession('project_a', 'session_1')?.content ?? '';
  const changesAfterFirst = changeCount;

  applyPromptStreamEventToManager(
    {
      type: 'delta',
      streamId: 'stream_coalesced_delta',
      projectId: 'project_a',
      sessionId: 'session_1',
      delta: secondTarget.slice(firstTarget.length),
      content: secondTarget,
      startedAt: '2026-04-22T08:00:00.000Z'
    },
    labels
  );

  assert.equal(changeCount, changesAfterFirst);
  assert.equal(getStreamSessionForSession('project_a', 'session_1')?.content, afterFirst);

  await delay(25);
  assert.ok((getStreamSessionForSession('project_a', 'session_1')?.content.length ?? 0) > afterFirst.length);

  unsubscribe();
  clearStreamSessions();
});
