import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AppState, PromptStreamEvent } from '../../shared/types.ts';
import { appendProjectConversationTurn, getActiveProjectSession, replaceProjectSession } from '../../shared/project-sessions.ts';
import { getRuntimeRun, initializeStore, listRuntimeRuns, setState, getState, upsertRuntimeRun } from '../../electron/main/store.ts';
import { cancelAgentExecutionPlanStream, respondToAgentPermissionRequest, respondToAgentUserInputRequest, resumeAgentRun, startAgentExecutionPlanStream, startAgentPromptStream } from '../../electron/main/agent-platform/stream-manager.ts';
import { registerActiveStream } from '../../electron/main/agent-platform/stream-lifecycle.ts';
import { registerPendingPermission } from '../../electron/main/agent-platform/permission-registry.ts';
import { buildResumeContextForRun } from '../../electron/main/agent-platform/stream-resume.ts';
import { recordActiveRunAgentCoreState, recordActiveRunSkillActivation, recordActiveRunStreamDelta, recordActiveRunTimelineEntry, recordActiveRunToolResult, recordActiveRunToolUse, recordActiveRunUsage, registerActiveRun, unregisterActiveRun, updateActiveRunStatus, updateActiveRunToolBoundary } from '../../electron/main/agent-platform/run-registry.ts';
import { makeStageHandler, makeToolUseHandler } from '../../electron/main/agent-platform/stream-event-dispatcher.ts';
import { makePermissionHandlers, makeUserInputHandlers } from '../../electron/main/agent-platform/stream-interactions.ts';
import { executeAgentToolAction } from '../../electron/main/agent-platform/workspace-tools.ts';
import { buildExecutionPlanProject, buildMcpPlugin, buildProject, buildState, startTestMcpServer, waitForFinalStreamEvent } from './test-helpers.ts';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(label)), timeoutMs).unref?.();
    })
  ]);
}

test('execute-plan stream starts and completes under stream-manager ownership', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-execute-stream-'));
  try {
    await initializeStore(userDataPath);
    const project = buildExecutionPlanProject();
    await setState({
      ...getState(),
      projects: [project]
    });

    let handleStreamId = '';
    const finalEvent = await waitForFinalStreamEvent(async (dispatchEvent) => {
      const handle = startAgentExecutionPlanStream({
        getState,
        persistState: setState,
        projectId: project.id,
        dispatchEvent
      });
      handleStreamId = handle.streamId;
    });

    assert.equal(handleStreamId.length > 0, true);
    assert.equal(finalEvent.type, 'completed');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('execute-plan stream projects tool work into Agent Core state and ordered parts', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-execute-core-'));
  const server = await startTestMcpServer();
  try {
    await initializeStore(userDataPath);
    const plugin = buildMcpPlugin(server.baseUrl);
    const project = {
      ...buildExecutionPlanProject(),
      mcpBindings: {
        engine: plugin.id
      },
      currentExecutionPlan: {
        summary: 'Run test execution plan',
        rationale: 'Ensure execute-plan stream works.',
        actions: [
          {
            id: 'action_test_plan',
            pluginKind: 'engine' as const,
            title: 'Read Unity context',
            objective: 'Exercise the execute-plan Agent Core projection.',
            suggestedTools: [],
            inputs: [],
            operations: [
              {
                type: 'resource_read' as const,
                target: 'unity://project/context'
              }
            ],
            successCriteria: [],
            status: 'planned' as const
          }
        ]
      }
    };
    await setState({
      ...getState(),
      ...(buildState(project) as AppState),
      mcpPlugins: [plugin]
    });

    const events: PromptStreamEvent[] = [];
    let handleStreamId = '';
    const finalEvent = await waitForFinalStreamEvent(async (dispatchEvent) => {
      const handle = startAgentExecutionPlanStream({
        getState,
        persistState: setState,
        projectId: project.id,
        dispatchEvent: (event) => {
          events.push(event);
          dispatchEvent(event);
        }
      });
      handleStreamId = handle.streamId;
    });

    assert.equal(finalEvent.type, 'completed');
    const coreStage = events.find((event) => event.type === 'stage' && event.stageId === 'stage:execute_plan_agent_core_v2');
    assert.equal(coreStage?.type, 'stage');
    assert.equal((coreStage?.input?.coreState as { state?: string } | undefined)?.state, 'building_model_input');
    const persistedRun = listRuntimeRuns(project.id).find((run) => run.streamId === handleStreamId);
    assert.equal(persistedRun?.events?.some((event) => event.type === 'agent_core_state'), true);

    const updatedProject = getState().projects.find((item) => item.id === project.id);
    const assistantMessage = updatedProject ? getActiveProjectSession(updatedProject).chat.at(-1) : undefined;
    const parts = assistantMessage?.metadata?.agentCoreParts ?? [];
    const toolCallIndex = parts.findIndex((part) => part.kind === 'tool_call' && part.name === 'read_resource');
    const toolResultIndex = parts.findIndex((part) => part.kind === 'tool_result' && part.toolUseId === (parts[toolCallIndex]?.kind === 'tool_call' ? parts[toolCallIndex].toolUseId : undefined));
    const finalTextIndex = parts.findIndex((part) => part.kind === 'assistant_text' && Boolean(part.final));

    assert.ok(toolCallIndex >= 0);
    assert.ok(toolResultIndex > toolCallIndex);
    assert.ok(finalTextIndex > toolResultIndex);
    assert.equal(parts[toolCallIndex]?.kind === 'tool_call' ? parts[toolCallIndex].status : undefined, 'completed');
    assert.match(parts[toolResultIndex]?.kind === 'tool_result' ? parts[toolResultIndex].content : '', /resource:unity:\/\/project\/context/);
    assert.equal(parts[toolResultIndex]?.kind === 'tool_result' ? parts[toolResultIndex].mcp?.operation : undefined, 'read_resource');
    assert.equal(parts[toolResultIndex]?.kind === 'tool_result' ? parts[toolResultIndex].mcp?.target : undefined, 'unity://project/context');
    assert.equal(parts[toolResultIndex]?.kind === 'tool_result' ? parts[toolResultIndex].mcp?.pluginId : undefined, plugin.id);
    assert.equal(parts[toolResultIndex]?.kind === 'tool_result' ? parts[toolResultIndex].transaction?.toolClass : undefined, 'mcp');
    assert.equal(parts[toolResultIndex]?.kind === 'tool_result' ? parts[toolResultIndex].transaction?.status : undefined, 'completed');
    assert.equal(parts[toolResultIndex]?.kind === 'tool_result' ? parts[toolResultIndex].transaction?.eventCount : undefined, 3);
    const toolResultEvent = events.find((event) => event.type === 'tool_result' && event.toolUseId === (parts[toolCallIndex]?.kind === 'tool_call' ? parts[toolCallIndex].toolUseId : undefined));
    assert.equal(toolResultEvent?.type, 'tool_result');
    assert.equal(toolResultEvent?.type === 'tool_result' ? toolResultEvent.mcp?.target : undefined, 'unity://project/context');
    assert.equal(toolResultEvent?.type === 'tool_result' ? toolResultEvent.transaction?.toolClass : undefined, 'mcp');
    const persistedToolResultEvent = persistedRun?.events?.find((event) => event.type === 'tool_result' && event.toolResult?.toolUseId === (parts[toolCallIndex]?.kind === 'tool_call' ? parts[toolCallIndex].toolUseId : undefined));
    assert.equal(persistedToolResultEvent?.type === 'tool_result' ? persistedToolResultEvent.toolResult?.transaction?.toolClass : undefined, 'mcp');
  } finally {
    await server.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('execute-plan stream projects denied write permission into Agent Core parts', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-execute-permission-core-'));
  const server = await startTestMcpServer();
  try {
    await initializeStore(userDataPath);
    const plugin = buildMcpPlugin(server.baseUrl);
    const baseProject = buildExecutionPlanProject();
    const activeSession = getActiveProjectSession(baseProject);
    const projectWithReadOnlyPermission = replaceProjectSession(
      baseProject,
      {
        ...activeSession,
        runtimeOverrides: {
          ...activeSession.runtimeOverrides,
          permissionMode: 'read-only'
        }
      },
      activeSession.id
    );
    const project = {
      ...projectWithReadOnlyPermission,
      mcpBindings: {
        engine: plugin.id
      },
      currentExecutionPlan: {
        summary: 'Run write execution plan',
        rationale: 'Ensure execute-plan permission projection works.',
        actions: [
          {
            id: 'action_write_plan',
            pluginKind: 'engine' as const,
            title: 'Modify Unity scene',
            objective: 'Exercise denied write permission projection.',
            suggestedTools: [],
            inputs: [],
            operations: [
              {
                type: 'tool_call' as const,
                target: 'execute_code',
                arguments: {
                  code: 'UnityEditor.EditorSceneManager.MarkSceneDirty(UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene());'
                }
              }
            ],
            successCriteria: [],
            status: 'planned' as const
          }
        ]
      }
    };
    await setState({
      ...getState(),
      ...(buildState(project) as AppState),
      mcpPlugins: [plugin]
    });

    const events: PromptStreamEvent[] = [];
    const finalEvent = await waitForFinalStreamEvent(async (dispatchEvent) => {
      startAgentExecutionPlanStream({
        getState,
        persistState: setState,
        projectId: project.id,
        dispatchEvent: (event) => {
          events.push(event);
          dispatchEvent(event);
        }
      });
    });

    assert.equal(finalEvent.type, 'completed');
    const updatedProject = getState().projects.find((item) => item.id === project.id);
    const assistantMessage = updatedProject ? getActiveProjectSession(updatedProject).chat.at(-1) : undefined;
    const parts = assistantMessage?.metadata?.agentCoreParts ?? [];
    const permissionIndex = parts.findIndex((part) => part.kind === 'permission_request' && part.toolName === 'execute_plan_unity_write');
    const errorIndex = parts.findIndex((part) => part.kind === 'tool_error' && part.toolName === 'execute_plan_unity_write');
    const finalTextIndex = parts.findIndex((part) => part.kind === 'assistant_text' && Boolean(part.final));

    assert.ok(permissionIndex >= 0);
    assert.ok(errorIndex > permissionIndex);
    assert.ok(finalTextIndex > errorIndex);
    assert.match(parts[errorIndex]?.kind === 'tool_error' ? parts[errorIndex].error : '', /read-only 模式下阻止写操作|写入权限未获批准/);
    assert.equal(parts[errorIndex]?.kind === 'tool_error' ? parts[errorIndex].transaction?.toolName : undefined, 'execute_plan_unity_write');
    assert.equal(parts[errorIndex]?.kind === 'tool_error' ? parts[errorIndex].transaction?.permission?.decision : undefined, 'deny');
    assert.equal(parts[errorIndex]?.kind === 'tool_error' ? parts[errorIndex].transaction?.checkpoint?.policy : undefined, 'external_best_effort');
    assert.equal(events.some((event) => event.type === 'stage' && event.stageId === 'stage:execute_plan_agent_core_v2'), true);
  } finally {
    await server.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('execute-plan cancellation clears pending permission requests for the stream', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-execute-cancel-permission-'));
  try {
    await initializeStore(userDataPath);
    const streamId = `planstream_cancel_permission_${Date.now()}`;
    const controller = new AbortController();
    registerActiveStream({
      kind: 'execute-plan',
      streamId,
      projectId: 'project_cancel_permission',
      sessionId: 'session_cancel_permission',
      startedAt: new Date(0).toISOString(),
      controller
    });
    const permission = registerPendingPermission({
      requestId: 'perm_cancel_permission',
      streamId,
      projectId: 'project_cancel_permission',
      sessionId: 'session_cancel_permission',
      title: 'Allow test permission?',
      detail: 'Pending permission used to verify execute-plan cancellation cleanup.',
      risk: 'high',
      toolName: 'execute_plan_unity_write',
      createdAt: new Date(0).toISOString()
    });

    cancelAgentExecutionPlanStream(streamId);

    assert.equal(controller.signal.aborted, true);
    assert.equal(await withTimeout(permission, 250, 'permission cancellation timed out'), 'deny');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('user input requests and resolutions persist in runtime event logs', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-user-input-events-'));
  let activeRunId = '';
  try {
    await initializeStore(userDataPath);
    const controller = new AbortController();
    const streamId = `stream_user_input_${Date.now()}`;
    const activeRun = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_user_input',
      sessionId: 'session_user_input',
      streamId,
      request: {
        kind: 'conversation',
        projectId: 'project_user_input',
        sessionId: 'session_user_input',
        runtimeId: 'native',
        permissionMode: 'full-access',
        message: 'Ask the user.',
        inputPreview: 'Ask the user.'
      },
      controller
    });
    activeRunId = activeRun.id;
    const events: PromptStreamEvent[] = [];
    const handlers = makeUserInputHandlers({
      streamId,
      projectId: 'project_user_input',
      sessionId: 'session_user_input',
      startedAt: new Date(0).toISOString(),
      controller,
      activeRunId: activeRun.id,
      toolNamesByUseId: new Map(),
      dispatchEvent: (event) => events.push(event)
    });
    const pending = handlers.requestUserInput({
      title: 'Agent 需要你的输入',
      question: 'Pick a marker',
      options: [
        {
          id: 'blue',
          label: 'Blue'
        }
      ],
      allowFreeText: false,
      toolName: 'ask_user'
    });
    const requestEvent = events.find((event): event is Extract<PromptStreamEvent, { type: 'user_input_request' }> => event.type === 'user_input_request');
    const requestId = requestEvent?.requestId;
    assert.ok(requestId);
    await respondToAgentUserInputRequest(requestId, {
      answer: 'Blue',
      optionId: 'blue'
    }, (event) => events.push(event));
    const response = await withTimeout(pending, 250, 'user input response timed out');
    const persisted = getRuntimeRun(activeRun.id);

    assert.equal(response.optionId, 'blue');
    assert.equal(persisted?.events?.some((event) => event.type === 'user_input_request' && event.userInputRequest?.requestId === requestId), true);
    assert.equal(persisted?.events?.some((event) => event.type === 'user_input_resolved' && event.userInputResponse?.optionId === 'blue'), true);
    assert.equal(events.some((event) => event.type === 'user_input_resolved'), true);
  } finally {
    if (activeRunId) {
      unregisterActiveRun(activeRunId);
    }
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('permission requests and resolutions persist in runtime event logs', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-permission-events-'));
  let activeRunId = '';
  try {
    await initializeStore(userDataPath);
    const controller = new AbortController();
    const streamId = `stream_permission_${Date.now()}`;
    const activeRun = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_permission',
      sessionId: 'session_permission',
      streamId,
      request: {
        kind: 'conversation',
        projectId: 'project_permission',
        sessionId: 'session_permission',
        runtimeId: 'native',
        permissionMode: 'ask',
        message: 'Write a file.',
        inputPreview: 'Write a file.'
      },
      controller
    });
    activeRunId = activeRun.id;
    const events: PromptStreamEvent[] = [];
    const handlers = makePermissionHandlers({
      streamId,
      projectId: 'project_permission',
      sessionId: 'session_permission',
      startedAt: new Date(0).toISOString(),
      controller,
      activeRunId: activeRun.id,
      toolNamesByUseId: new Map(),
      dispatchEvent: (event) => events.push(event)
    }, {
      getRuntimeId: () => 'native',
      getCwd: () => '/tmp/funplay-project'
    });
    const pending = handlers.requestPermission({
      title: 'Approve write_file',
      detail: 'write index.html',
      risk: 'high',
      toolName: 'write_file',
      impact: {
        toolName: 'write_file',
        paths: ['index.html']
      }
    });
    const requestEvent = events.find((event): event is Extract<PromptStreamEvent, { type: 'permission_request' }> => event.type === 'permission_request');
    const requestId = requestEvent?.requestId;
    assert.ok(requestId);
    await respondToAgentPermissionRequest(requestId, 'allow', (event) => events.push(event));
    const decision = await withTimeout(pending, 250, 'permission response timed out');
    const persisted = getRuntimeRun(activeRun.id);

    assert.equal(decision, 'allow');
    assert.equal(persisted?.events?.some((event) => event.type === 'permission_request' && event.permissionRequest?.requestId === requestId && event.permissionRequest.impact?.paths instanceof Array), true);
    assert.equal(persisted?.events?.some((event) => event.type === 'permission_resolved' && event.permissionResponse?.decision === 'allow'), true);
    assert.equal(events.some((event) => event.type === 'permission_resolved'), true);
  } finally {
    if (activeRunId) {
      unregisterActiveRun(activeRunId);
    }
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('conversation stream dispatches usage events and persists run totals', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-usage-stream-'));
  const originalFetch = globalThis.fetch;
  try {
    await initializeStore(userDataPath);
    let project = buildProject();
    const activeSession = getActiveProjectSession(project);
    project = replaceProjectSession(
      project,
      {
        ...activeSession,
        runtimeOverrides: {
          ...activeSession.runtimeOverrides,
          mode: 'ask'
        }
      },
      activeSession.id
    );
    await setState({
      ...getState(),
      ...(buildState(project) as AppState)
    });

    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chat_usage_stream',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '带 usage 的回复。'
          }
        }
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        prompt_tokens_details: {
          cached_tokens: 3
        }
      }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    })) as typeof fetch;

    const events: PromptStreamEvent[] = [];
    let handleStreamId = '';
    const finalEvent = await waitForFinalStreamEvent(async (dispatchEvent) => {
      const handle = startAgentPromptStream({
        getState,
        persistState: setState,
        projectId: project.id,
        message: '请直接回答',
        dispatchEvent: (event) => {
          events.push(event);
          dispatchEvent(event);
        }
      });
      handleStreamId = handle.streamId;
    });

    const usageEvent = events.find((event): event is Extract<PromptStreamEvent, { type: 'usage' }> => event.type === 'usage');
    assert.equal(finalEvent.type, 'completed');
    assert.equal(usageEvent?.type, 'usage');
    assert.equal(usageEvent?.usage.inputTokens, 12);
    assert.equal(usageEvent?.usage.outputTokens, 4);
    assert.equal(usageEvent?.usage.cacheReadTokens, 3);
    assert.equal(usageEvent?.totals.totalTokens, 16);
    const persistedRun = listRuntimeRuns(project.id).find((run) => run.streamId === handleStreamId);
    assert.equal(persistedRun?.usage?.turns, 1);
    assert.equal(persistedRun?.usage?.totalTokens, 16);
    const reloadedProject = getState().projects.find((item) => item.id === project.id);
    const assistantMessage = reloadedProject ? getActiveProjectSession(reloadedProject).chat.at(-1) : undefined;
    assert.equal(assistantMessage?.metadata?.tokenUsage?.turns, 1);
    assert.equal(assistantMessage?.metadata?.tokenUsage?.inputTokens, 12);
    assert.equal(assistantMessage?.metadata?.tokenUsage?.outputTokens, 4);
    assert.equal(assistantMessage?.metadata?.tokenUsage?.cacheReadTokens, 3);
    assert.equal(assistantMessage?.metadata?.tokenUsage?.totalTokens, 16);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('chat content blocks and operation log persist through SQLite reload', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-chat-blocks-'));
  try {
    await initializeStore(userDataPath);
    const updatedAt = new Date().toISOString();
    let project = buildProject();
    project = appendProjectConversationTurn(project, {
      userMessage: '请读取文件并总结',
      assistantMessage: '我已经总结完成。',
      assistantContentBlocks: [
        {
          type: 'tool_use',
          toolUseId: 'tool_readme',
          name: 'read_file',
          input: {
            path: 'README.md'
          },
          status: 'completed'
        },
        {
          type: 'tool_result',
          toolUseId: 'tool_readme',
          content: 'README 内容摘要',
          isError: false
        },
        {
          type: 'text',
          text: '我已经总结完成。'
        }
      ],
      assistantMetadata: {
        agentStartedAt: updatedAt,
        agentFinishedAt: updatedAt,
        operationLog: [
          {
            id: 'tool_readme',
            scope: 'conversation',
            title: 'read_file',
            target: 'README.md',
            type: 'tool_call',
            input: {
              path: 'README.md'
            },
            status: 'completed',
            summary: 'README 内容摘要',
            startedAt: updatedAt,
            finishedAt: updatedAt
          }
        ]
      },
      updatedAt
    });
    project.lastAgentRun = {
      id: 'run_chat_blocks',
      mode: 'update',
      input: '请读取文件并总结',
      status: 'completed',
      startedAt: updatedAt,
      finishedAt: updatedAt,
      steps: [],
      pluginReports: [],
      operationLog: [
        {
          id: 'tool_readme',
          scope: 'conversation',
          title: 'read_file',
          target: 'README.md',
          type: 'tool_call',
          input: {
            path: 'README.md'
          },
          status: 'completed',
          summary: 'README 内容摘要',
          startedAt: updatedAt,
          finishedAt: updatedAt
        }
      ]
    };

    await setState({
      ...getState(),
      projects: [project]
    });
    await initializeStore(userDataPath);

    const reloadedProject = getState().projects[0];
    const reloadedAssistant = getActiveProjectSession(reloadedProject).chat.at(-1);
    assert.ok(reloadedAssistant?.contentBlocks);
    assert.deepEqual(
      reloadedAssistant?.contentBlocks?.map((block) => block.type),
      ['tool_use', 'tool_result', 'text']
    );
    assert.equal(reloadedAssistant?.metadata?.agentProcessText, undefined);
    assert.equal(reloadedAssistant?.metadata?.agentProcessActivities, undefined);
    assert.equal(reloadedAssistant?.metadata?.operationLog?.[0]?.summary, 'README 内容摘要');
    assert.equal(reloadedProject.lastAgentRun?.operationLog?.[0]?.id, 'tool_readme');
    assert.equal(reloadedProject.lastAgentRun?.operationLog?.[0]?.summary, 'README 内容摘要');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('execute-plan resume restarts persisted interrupted run and clears it on completion', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-execute-resume-'));
  try {
    await initializeStore(userDataPath);
    const project = buildExecutionPlanProject();
    await setState({
      ...getState(),
      projects: [project]
    });

    const sessionId = getActiveProjectSession(project).id;
    const runId = `resume_run_${Date.now()}`;
    const timestamp = new Date().toISOString();
    upsertRuntimeRun({
      id: runId,
      kind: 'execute-plan',
      projectId: project.id,
      sessionId,
      status: 'interrupted',
      startedAt: timestamp,
      updatedAt: timestamp,
      inputPreview: 'Run current plan',
      request: {
        kind: 'execute-plan',
        projectId: project.id,
        sessionId,
        inputPreview: 'Run current plan'
      }
    });

    let resumedHandleRunId = '';
    const finalEvent = await waitForFinalStreamEvent(async (dispatchEvent) => {
      const handle = await resumeAgentRun({
        getState,
        persistState: setState,
        runId,
        dispatchEvent
      });
      resumedHandleRunId = handle.resumedFromRunId ?? '';
    });

    assert.equal(resumedHandleRunId, runId);
    assert.equal(finalEvent.type, 'completed');
    assert.equal(getRuntimeRun(runId), undefined);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('conversation resume restores checkpoint and injects last tool boundary through stream manager', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-conversation-resume-'));
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-project-conversation-resume-'));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(projectPath, 'notes.md'), 'resume stream fixture', 'utf8');
    await initializeStore(userDataPath);
    const project = buildProject(projectPath);
    await setState({
      ...getState(),
      ...(buildState(project) as AppState)
    });

    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'chat_resume_stream_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '恢复后的回答。'
            }
          }
        ]
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }) as typeof fetch;

    const sessionId = getActiveProjectSession(project).id;
    const runId = `conversation_resume_${Date.now()}`;
    const timestamp = new Date().toISOString();
    upsertRuntimeRun({
      id: runId,
      kind: 'conversation',
      projectId: project.id,
      sessionId,
      status: 'interrupted',
      startedAt: timestamp,
      updatedAt: timestamp,
      checkpointSnapshotId: 'snapshot_resume_stream',
      inputPreview: '读取 notes.md 后继续总结',
      request: {
        kind: 'conversation',
        projectId: project.id,
        sessionId,
        runtimeId: 'native',
        providerId: 'provider_default',
        model: 'gpt-default',
        permissionMode: 'ask',
        message: '读取 notes.md 后继续总结',
        checkpointSnapshotId: 'snapshot_resume_stream',
        inputPreview: '读取 notes.md 后继续总结'
      },
      timeline: [
        {
          id: 'stage:tool_loop',
          title: '执行 Agent 工具循环',
          target: 'stage:tool_loop',
          status: 'running',
          summary: 'interrupted during stream'
        }
      ],
      lastToolBoundary: {
        toolUseId: 'tool_resume_stream_read',
        toolName: 'read_file',
        phase: 'tool_result',
        status: 'completed',
        checkpointSnapshotId: 'snapshot_resume_stream',
        completedAt: timestamp,
        summary: 'read notes.md'
      },
      resumeStrategy: 'resume_after_last_completed_tool'
    });

    const finalEvent = await waitForFinalStreamEvent(async (dispatchEvent) => {
      await resumeAgentRun({
        getState,
        persistState: setState,
        runId,
        dispatchEvent
      });
    });

    assert.equal(finalEvent.type, 'completed');
    assert.equal(requests.length, 1);
    const serializedMessages = JSON.stringify(requests[0].messages);
    assert.match(serializedMessages, /恢复运行上下文/);
    assert.match(serializedMessages, /tool_resume_stream_read/);
    assert.match(serializedMessages, /resume_after_last_completed_tool/);
    const updatedProject = getState().projects.find((item) => item.id === project.id);
    const activeSession = updatedProject ? getActiveProjectSession(updatedProject) : undefined;
    assert.equal(activeSession?.chat.at(-2)?.role, 'user');
    assert.equal(activeSession?.chat.at(-2)?.content, '读取 notes.md 后继续总结');
    assert.equal(activeSession?.chat.at(-1)?.content, '恢复后的回答。');
    assert.equal(getRuntimeRun(runId), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(userDataPath, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('runtime run persistence stores timeline and resume strategy metadata', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-runtime-run-'));
  try {
    await initializeStore(userDataPath);
    const timestamp = new Date().toISOString();
    const runId = `timeline_run_${Date.now()}`;
    upsertRuntimeRun({
      id: runId,
      kind: 'conversation',
      projectId: 'project_timeline',
      sessionId: 'session_timeline',
      status: 'interrupted',
      startedAt: timestamp,
      updatedAt: timestamp,
      inputPreview: 'timeline test',
      request: {
        kind: 'conversation',
        projectId: 'project_timeline',
        sessionId: 'session_timeline',
        runtimeId: 'native',
        providerId: 'provider_default',
        model: 'gpt-default',
        permissionMode: 'ask',
        message: 'timeline test'
      },
      timeline: [
        {
          id: 'stage:tool_loop',
          phase: 'execute',
          title: '执行 Agent 工具循环',
          target: 'stage:tool_loop',
          status: 'running',
          startedAt: timestamp,
          summary: 'running'
        }
      ],
      lastToolBoundary: {
        toolUseId: 'tool_1',
        toolName: 'read_file',
        status: 'completed',
        completedAt: timestamp,
        summary: 'read file completed'
      },
      resumeStrategy: 'resume_after_last_completed_tool'
    });

    const restored = getRuntimeRun(runId);
    assert.equal(restored?.resumeStrategy, 'resume_after_last_completed_tool');
    assert.equal(restored?.runtimeId, 'native');
    assert.equal(restored?.providerId, 'provider_default');
    assert.equal(restored?.model, 'gpt-default');
    assert.equal(restored?.permissionMode, 'ask');
    assert.equal(restored?.timeline?.[0]?.id, 'stage:tool_loop');
    assert.equal(restored?.lastToolBoundary?.toolName, 'read_file');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('active runtime runs persist last completed tool boundary on interruption', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-tool-boundary-'));
  try {
    await initializeStore(userDataPath);
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_boundary',
      sessionId: 'session_boundary',
      checkpointSnapshotId: 'snapshot_boundary',
      inputPreview: 'boundary test',
      request: {
        kind: 'conversation',
        projectId: 'project_boundary',
        sessionId: 'session_boundary',
        runtimeId: 'native',
        permissionMode: 'full-access',
        message: 'boundary test',
        checkpointSnapshotId: 'snapshot_boundary'
      }
    });

    recordActiveRunTimelineEntry(run.id, {
      id: 'stage:tool_loop',
      phase: 'execute',
      title: '执行 Agent 工具循环',
      target: 'stage:tool_loop',
      status: 'running',
      summary: 'running tool loop'
    });
    recordActiveRunTimelineEntry(run.id, {
      id: 'stage:tool_loop',
      phase: 'execute',
      title: '执行 Agent 工具循环',
      target: 'stage:tool_loop',
      status: 'completed',
      summary: 'tool loop completed'
    });

    updateActiveRunToolBoundary(run.id, {
      toolUseId: 'tool_boundary',
      toolName: 'read_file',
      phase: 'tool_result',
      status: 'completed',
      checkpointSnapshotId: 'snapshot_boundary',
      completedAt: new Date().toISOString(),
      summary: 'read README',
      transaction: {
        id: 'tool_txn:tool_boundary',
        toolUseId: 'tool_boundary',
        toolName: 'read_file',
        toolClass: 'workspace',
        phase: 'completed',
        status: 'completed',
        eventCount: 3,
        startedAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:01.000Z',
        checkpoint: {
          policy: 'optional',
          snapshotId: 'snapshot_boundary',
          status: 'completed'
        }
      }
    });

    const running = getRuntimeRun(run.id);
    assert.equal(running?.runtimeId, 'native');
    assert.equal(running?.permissionMode, 'full-access');
    assert.equal(running?.resumeStrategy, 'resume_after_last_completed_tool');
    assert.equal(running?.lastToolBoundary?.toolName, 'read_file');
    assert.equal(running?.timeline?.length, 1);
    assert.equal(running?.timeline?.[0]?.status, 'completed');
    assert.equal(running?.timeline?.[0]?.summary, 'tool loop completed');

    unregisterActiveRun(run.id, {
      finalStatus: 'interrupted',
      error: 'interrupted for test'
    });

    const interrupted = getRuntimeRun(run.id);
    assert.equal(interrupted?.canResume, true);
    assert.equal(interrupted?.resumeStrategy, 'resume_after_last_completed_tool');
    assert.equal(interrupted?.lastToolBoundary?.toolUseId, 'tool_boundary');
    assert.equal(interrupted?.lastToolBoundary?.transaction?.eventCount, 3);
    assert.equal(interrupted?.resumeCursor?.transaction?.checkpoint?.snapshotId, 'snapshot_boundary');
    assert.equal(interrupted?.timeline?.[0]?.id, 'stage:tool_loop');
    assert.equal(interrupted?.lastError, 'interrupted for test');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('active runtime runs persist a structured event log', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-run-events-'));
  try {
    await initializeStore(userDataPath);
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_events',
      sessionId: 'session_events',
      checkpointSnapshotId: 'snapshot_events',
      inputPreview: 'event log test',
      request: {
        kind: 'conversation',
        projectId: 'project_events',
        sessionId: 'session_events',
        runtimeId: 'native',
        permissionMode: 'full-access',
        message: 'event log test',
        checkpointSnapshotId: 'snapshot_events'
      }
    });

    updateActiveRunStatus(run.id, '正在思考中...');
    recordActiveRunToolUse(run.id, {
      toolUseId: 'tool_event_read',
      name: 'read_file',
      input: {
        path: 'README.md'
      },
      status: 'running'
    });
    recordActiveRunToolResult(run.id, {
      toolUseId: 'tool_event_read',
      toolName: 'read_file',
      content: 'README event fixture',
      isError: false,
      transaction: {
        id: 'tool_txn:tool_event_read',
        toolUseId: 'tool_event_read',
        toolName: 'read_file',
        toolClass: 'workspace',
        phase: 'completed',
        status: 'completed',
        eventCount: 3,
        startedAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:01.000Z'
      }
    });
    recordActiveRunTimelineEntry(run.id, {
      id: 'stage:event_tool_loop',
      phase: 'tool_loop',
      title: '执行工具循环',
      target: 'native',
      status: 'completed',
      summary: 'tool loop completed'
    });
    recordActiveRunUsage(run.id, {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      recordedAt: new Date().toISOString()
    });
    updateActiveRunToolBoundary(run.id, {
      toolUseId: 'tool_event_read',
      toolName: 'read_file',
      phase: 'tool_result',
      status: 'completed',
      checkpointSnapshotId: 'snapshot_events',
      completedAt: new Date().toISOString(),
      summary: 'read README',
      transaction: {
        id: 'tool_txn:tool_event_read',
        toolUseId: 'tool_event_read',
        toolName: 'read_file',
        toolClass: 'workspace',
        phase: 'completed',
        status: 'completed',
        eventCount: 3,
        startedAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:01.000Z',
        checkpoint: {
          policy: 'optional',
          snapshotId: 'snapshot_events',
          status: 'completed'
        }
      }
    });
    unregisterActiveRun(run.id, {
      finalStatus: 'interrupted',
      error: 'event log interruption'
    });

    const restored = getRuntimeRun(run.id);
    assert.deepEqual(
      restored?.events?.map((event) => event.type),
      [
        'run_registered',
        'status',
        'tool_use',
        'tool_result',
        'timeline',
        'usage',
        'tool_boundary',
        'run_interrupted'
      ]
    );
    assert.equal(restored?.events?.[1]?.statusMessage, '正在思考中...');
    assert.equal(restored?.events?.find((event) => event.type === 'tool_use')?.toolUse?.name, 'read_file');
    assert.equal(restored?.events?.find((event) => event.type === 'tool_result')?.toolResult?.contentPreview, 'README event fixture');
    assert.equal(restored?.events?.find((event) => event.type === 'usage')?.usageTotals?.totalTokens, 15);
    assert.equal(restored?.events?.at(-1)?.error, 'event log interruption');
    const boundaryEvent = restored?.events?.find((event) => event.type === 'tool_boundary');
    assert.equal(restored?.resumeCursor?.eventId, boundaryEvent?.id);
    assert.equal(restored?.resumeCursor?.strategy, 'resume_after_last_completed_tool');
    assert.equal(restored?.resumeCursor?.toolUseId, 'tool_event_read');
    assert.equal(restored?.resumeCursor?.transaction?.eventCount, 3);
    assert.equal(boundaryEvent?.toolBoundary?.transaction?.checkpoint?.snapshotId, 'snapshot_events');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('active runtime runs persist Agent Core state for resumable interruptions', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-run-core-state-'));
  try {
    await initializeStore(userDataPath);
    const timestamp = new Date().toISOString();
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_core_state',
      sessionId: 'session_core_state',
      checkpointSnapshotId: 'snapshot_core_state',
      inputPreview: 'core state resume test',
      request: {
        kind: 'conversation',
        projectId: 'project_core_state',
        sessionId: 'session_core_state',
        runtimeId: 'native',
        permissionMode: 'full-access',
        message: 'core state resume test',
        checkpointSnapshotId: 'snapshot_core_state'
      }
    });

    updateActiveRunToolBoundary(run.id, {
      toolUseId: 'tool_core_boundary',
      toolName: 'write_file',
      phase: 'tool_result',
      status: 'completed',
      checkpointSnapshotId: 'snapshot_core_state',
      completedAt: timestamp,
      summary: 'write file completed'
    });
    recordActiveRunAgentCoreState(run.id, {
      coreState: {
        state: 'interrupted_resumable',
        history: [
          {
            from: 'executing_tools',
            to: 'interrupted_resumable',
            reason: '工具执行被中断，已把未完成工具记录为结构化错误结果。',
            createdAt: timestamp
          }
        ]
      },
      providerStep: {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            toolUseId: 'tool_core_boundary',
            name: 'write_file',
            input: {
              path: 'index.html'
            }
          }
        ]
      }
    });
    unregisterActiveRun(run.id, {
      finalStatus: 'interrupted',
      error: 'interrupted for core state test'
    });

    const restored = getRuntimeRun(run.id);
    assert.equal(restored?.coreState?.state, 'interrupted_resumable');
    assert.equal(restored?.events?.find((event) => event.type === 'agent_core_state')?.providerStep?.finishReason, 'tool_calls');
    assert.equal(restored?.resumeCursor?.toolUseId, 'tool_core_boundary');
    assert.equal(restored?.resumeCursor?.strategy, 'resume_after_last_completed_tool');
    assert.ok(restored);
    const resumeContext = buildResumeContextForRun(restored);
    assert.equal(resumeContext.coreState?.state, 'interrupted_resumable');
    assert.equal(resumeContext.resumeCursor?.toolUseId, 'tool_core_boundary');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('context compression stages persist auditable context summaries', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-context-summary-event-'));
  try {
    await initializeStore(userDataPath);
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_context_summary',
      sessionId: 'session_context_summary',
      inputPreview: 'context summary test',
      request: {
        kind: 'conversation',
        projectId: 'project_context_summary',
        sessionId: 'session_context_summary',
        runtimeId: 'native',
        message: 'context summary test'
      }
    });
    const dispatched: PromptStreamEvent[] = [];
    const handler = makeStageHandler({
      streamId: 'stream_context_summary',
      projectId: 'project_context_summary',
      sessionId: 'session_context_summary',
      startedAt: new Date().toISOString(),
      controller: new AbortController(),
      activeRunId: run.id,
      toolNamesByUseId: new Map(),
      dispatchEvent: (event) => dispatched.push(event)
    });

    handler({
      stageId: 'stage:native_context_handoff',
      phase: 'context_compressed',
      title: '压缩 Native runtime 上下文',
      target: 'stage:native_context_handoff',
      status: 'completed',
      summary: '已生成上下文摘要。',
      runtimeId: 'native',
      input: {
        contextSummary: 'Earlier turns summarized with goals, constraints, decisions, and open tasks.',
        contextSummaryCoverage: {
          version: 1,
          strategy: 'extractive',
          fromMessageId: 'msg_1',
          toMessageId: 'msg_8',
          messageCount: 8,
          turnCount: 4,
          generatedAt: '2026-05-15T00:00:00.000Z',
          audit: {
            generatedAt: '2026-05-15T00:00:00.000Z',
            sourceMessageIds: ['msg_1', 'msg_8'],
            decisions: ['Use Native runtime'],
            constraints: ['Do not repeat completed tools'],
            openTasks: ['Continue implementation']
          }
        }
      }
    });

    const restored = getRuntimeRun(run.id);
    const contextEvent = restored?.events?.find((event) => event.type === 'context_summary');
    assert.equal(contextEvent?.contextSummary?.summary, 'Earlier turns summarized with goals, constraints, decisions, and open tasks.');
    assert.equal(contextEvent?.contextSummary?.runtimeId, 'native');
    assert.equal(contextEvent?.contextSummary?.sourceStageId, 'stage:native_context_handoff');
    assert.equal((contextEvent?.contextSummary?.coverage as { turnCount?: number } | undefined)?.turnCount, 4);
    assert.equal(dispatched[0]?.type, 'stage');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('skill activations persist as first-class runtime events', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-skill-activation-event-'));
  try {
    await initializeStore(userDataPath);
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_skill_activation',
      sessionId: 'session_skill_activation',
      inputPreview: 'skill activation test',
      request: {
        kind: 'conversation',
        projectId: 'project_skill_activation',
        sessionId: 'session_skill_activation',
        runtimeId: 'native',
        message: 'skill activation test'
      }
    });

    recordActiveRunSkillActivation(run.id, {
      id: 'project:/repo:backend-plan',
      name: 'backend-plan',
      description: 'Plan backend changes.',
      source: 'project',
      sourceId: '/repo',
      sourcePath: '.claude/skills/backend-plan/SKILL.md',
      activationReason: 'automatic_metadata_match',
      instruction: 'Plan carefully.',
      trustLevel: 'workspace',
      verificationStatus: 'local_source',
      contentSha256: 'c'.repeat(64),
      permissionPolicy: 'workspace_policy',
      scriptPolicy: 'none'
    });

    const restored = getRuntimeRun(run.id);
    const skillEvent = restored?.events?.find((event) => event.type === 'skill_activation');
    assert.equal(skillEvent?.skillActivation?.name, 'backend-plan');
    assert.equal(skillEvent?.skillActivation?.activationReason, 'automatic_metadata_match');
    assert.equal(skillEvent?.skillActivation?.trustLevel, 'workspace');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('todo-list tool updates persist as first-class runtime events', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-todo-event-'));
  try {
    await initializeStore(userDataPath);
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_todo_event',
      sessionId: 'session_todo_event',
      inputPreview: 'todo event test',
      request: {
        kind: 'conversation',
        projectId: 'project_todo_event',
        sessionId: 'session_todo_event',
        runtimeId: 'native',
        message: 'todo event test'
      }
    });
    const dispatched: PromptStreamEvent[] = [];
    const handler = makeToolUseHandler({
      streamId: 'stream_todo_event',
      projectId: 'project_todo_event',
      sessionId: 'session_todo_event',
      startedAt: new Date().toISOString(),
      controller: new AbortController(),
      activeRunId: run.id,
      toolNamesByUseId: new Map(),
      dispatchEvent: (event) => dispatched.push(event)
    });

    handler({
      toolUseId: 'tool_todo_1',
      name: 'update_todo_list',
      status: 'running',
      input: {
        todos: [
          {
            id: 'inspect',
            content: 'Inspect runtime state',
            status: 'completed'
          },
          {
            content: 'Persist todo update',
            status: 'in_progress'
          }
        ]
      }
    });

    const restored = getRuntimeRun(run.id);
    const todoEvent = restored?.events?.find((event) => event.type === 'todo_update');
    assert.equal(todoEvent?.todoUpdate?.toolUseId, 'tool_todo_1');
    assert.deepEqual(todoEvent?.todoUpdate?.items.map((item) => item.status), ['completed', 'in_progress']);
    assert.equal(todoEvent?.todoUpdate?.items[1]?.id, 'todo_2');
    assert.equal(dispatched[0]?.type, 'tool_use');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('active runtime runs coalesce bounded text and thinking delta events', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-run-delta-events-'));
  try {
    await initializeStore(userDataPath);
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_delta_events',
      sessionId: 'session_delta_events',
      inputPreview: 'delta event test',
      request: {
        kind: 'conversation',
        projectId: 'project_delta_events',
        sessionId: 'session_delta_events',
        runtimeId: 'native',
        message: 'delta event test'
      }
    });

    recordActiveRunStreamDelta(run.id, {
      kind: 'text',
      delta: 'Hello ',
      content: 'Hello '
    });
    recordActiveRunStreamDelta(run.id, {
      kind: 'text',
      delta: 'world',
      content: 'Hello world'
    });
    recordActiveRunStreamDelta(run.id, {
      kind: 'thinking',
      delta: 'plan',
      content: 'plan'
    });
    recordActiveRunStreamDelta(run.id, {
      kind: 'thinking',
      delta: ' more',
      content: 'plan more'
    });
    recordActiveRunStreamDelta(run.id, {
      kind: 'text',
      delta: '!',
      content: `${'x'.repeat(1800)}!`
    });

    const restored = getRuntimeRun(run.id);
    assert.deepEqual(
      restored?.events?.map((event) => event.type),
      ['run_registered', 'text_delta', 'thinking_delta', 'text_delta']
    );
    const firstText = restored?.events?.[1];
    const thinking = restored?.events?.[2];
    const finalText = restored?.events?.[3];
    assert.equal(firstText?.streamDelta?.contentPreview, 'Hello world');
    assert.equal(firstText?.streamDelta?.eventCount, 2);
    assert.equal(thinking?.streamDelta?.contentPreview, 'plan more');
    assert.equal(thinking?.streamDelta?.eventCount, 2);
    assert.equal(finalText?.streamDelta?.contentLength, 1801);
    assert.equal(finalText?.streamDelta?.truncated, true);
    assert.match(finalText?.streamDelta?.contentPreview ?? '', /^\[truncated \d+ chars\]/);
    assert.match(finalText?.streamDelta?.contentPreview ?? '', /!$/);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('active runtime runs persist accumulated usage totals', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-run-usage-'));
  try {
    await initializeStore(userDataPath);
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_usage',
      sessionId: 'session_usage',
      inputPreview: 'usage test',
      request: {
        kind: 'conversation',
        projectId: 'project_usage',
        sessionId: 'session_usage',
        runtimeId: 'native',
        message: 'usage test'
      }
    });

    recordActiveRunUsage(run.id, {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      totalTokens: 18,
      recordedAt: new Date().toISOString()
    });
    recordActiveRunUsage(run.id, {
      inputTokens: 7,
      outputTokens: 2,
      cacheCreationTokens: 4,
      totalTokens: 13,
      recordedAt: new Date().toISOString()
    });

    const running = getRuntimeRun(run.id);
    assert.equal(running?.usage?.turns, 2);
    assert.equal(running?.usage?.inputTokens, 17);
    assert.equal(running?.usage?.outputTokens, 7);
    assert.equal(running?.usage?.cacheCreationTokens, 4);
    assert.equal(running?.usage?.cacheReadTokens, 3);
    assert.equal(running?.usage?.totalTokens, 31);

    unregisterActiveRun(run.id, {
      finalStatus: 'completed'
    });

    const completed = getRuntimeRun(run.id);
    assert.equal(completed?.usage?.turns, 2);
    assert.equal(completed?.usage?.totalTokens, 31);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('interrupted write runs keep checkpoint rollback available', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-interrupted-write-'));
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-project-interrupted-write-'));
  try {
    await initializeStore(userDataPath);
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'notes.md'), 'before', 'utf8');
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: project.id,
      sessionId: getActiveProjectSession(project).id,
      checkpointSnapshotId: 'snapshot_interrupted_write',
      inputPreview: 'write then interrupt',
      request: {
        kind: 'conversation',
        projectId: project.id,
        sessionId: getActiveProjectSession(project).id,
        runtimeId: 'native',
        permissionMode: 'full-access',
        message: 'write then interrupt',
        checkpointSnapshotId: 'snapshot_interrupted_write'
      }
    });

    const writeResult = await executeAgentToolAction(
      project,
      {
        type: 'write_file',
        path: 'notes.md',
        content: 'after'
      },
      {
        checkpointSnapshotId: 'snapshot_interrupted_write'
      }
    );
    assert.equal(writeResult.ok, true);
    assert.equal(await readFile(join(projectPath, 'notes.md'), 'utf8'), 'after');

    updateActiveRunToolBoundary(run.id, {
      toolUseId: 'tool_interrupted_write',
      toolName: 'write_file',
      phase: 'tool_result',
      status: 'completed',
      checkpointSnapshotId: 'snapshot_interrupted_write',
      completedAt: new Date().toISOString(),
      summary: 'write notes.md'
    });
    unregisterActiveRun(run.id, {
      finalStatus: 'interrupted',
      error: 'interrupted after write'
    });

    const interrupted = getRuntimeRun(run.id);
    assert.equal(interrupted?.canResume, true);
    assert.equal(interrupted?.checkpointSnapshotId, 'snapshot_interrupted_write');
    const rollback = await executeAgentToolAction(
      project,
      {
        type: 'checkpoint_rollback',
        reason: 'test interrupted write rollback'
      },
      {
        checkpointSnapshotId: 'snapshot_interrupted_write'
      }
    );
    assert.equal(rollback.ok, true);
    assert.equal(await readFile(join(projectPath, 'notes.md'), 'utf8'), 'before');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('completed runtime runs stay visible but are not resumable', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-store-completed-run-'));
  try {
    await initializeStore(userDataPath);
    const run = registerActiveRun({
      kind: 'conversation',
      projectId: 'project_completed',
      sessionId: 'session_completed',
      inputPreview: 'completed test',
      request: {
        kind: 'conversation',
        projectId: 'project_completed',
        sessionId: 'session_completed',
        runtimeId: 'native',
        message: 'completed test'
      }
    });

    unregisterActiveRun(run.id, {
      finalStatus: 'completed'
    });

    const completed = getRuntimeRun(run.id);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.canResume, false);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});
