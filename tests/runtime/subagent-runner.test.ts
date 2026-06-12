import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getActiveProjectSession } from '../../shared/project-sessions.ts';
import type { AiProvider } from '../../shared/types.ts';
import type { GenericAgentRuntimeParams } from '../../electron/main/agent-platform/types.ts';
import { buildGenericWorkspaceContext } from '../../electron/main/agent-platform/context.ts';
import { listNativeWorkspaceToolNames } from '../../electron/main/agent-platform/native/tool-adapter.ts';
import {
  resetSubagentDefinitionCache,
  resolveNativeSubagentToolPoolMode
} from '../../electron/main/agent-platform/native/subagent-definitions.ts';
import {
  readNativeBackgroundSubagentStatus,
  runNativeSubagent
} from '../../electron/main/agent-platform/native/subagent-runner.ts';
import {
  createNativeToolPool,
  drainNativeSubagentCompletionNotices,
  enqueueNativeSubagentCompletionNotice
} from '../../electron/main/agent-platform/native/tool-pool.ts';
import { executeNativeWorkspaceToolSetTool } from '../../electron/main/agent-platform/native/tool-executor.ts';
import { initializeStore, tryUpsertSubagentRun } from '../../electron/main/store.ts';
import { buildProject } from './test-helpers.ts';

function buildSubagentProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'provider_subagent_test',
    name: 'Subagent Test Provider',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    hasStoredApiKey: true,
    model: 'parent-model',
    availableModels: [{ modelId: 'sub-model' }, { modelId: 'def-model' }],
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function buildSubagentRuntimeParams(
  project: ReturnType<typeof buildProject>,
  provider: AiProvider
): GenericAgentRuntimeParams {
  return {
    project,
    message: '测试子任务',
    uiLanguage: 'zh-CN',
    provider,
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '测试子任务'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true
    }
  };
}

function sseTextResponse(content: string): Response {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: 'chat_subagent',
        choices: [{ delta: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      })}`,
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n'),
    {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream'
      }
    }
  );
}

test('worker subagent pools expose write/command tools while investigator stays read-only', async () => {
  const investigatorNames = listNativeWorkspaceToolNames(resolveNativeSubagentToolPoolMode({ mode: 'investigator' }));
  assert.ok(investigatorNames.includes('read_file'));
  assert.ok(investigatorNames.includes('web_search'));
  for (const forbidden of [
    'write_file',
    'edit_file',
    'run_command',
    'terminal_start',
    'ask_user',
    'run_subagent',
    'run_subagents',
    'subagent_start',
    'subagent_status'
  ]) {
    assert.equal(investigatorNames.includes(forbidden), false, `investigator must not expose ${forbidden}`);
  }

  const workerNames = listNativeWorkspaceToolNames(resolveNativeSubagentToolPoolMode({ mode: 'worker' }));
  assert.ok(workerNames.includes('write_file'));
  assert.ok(workerNames.includes('edit_file'));
  assert.ok(workerNames.includes('run_command'));
  for (const forbidden of [
    'checkpoint_rollback',
    'ask_user',
    'run_subagent',
    'run_subagents',
    'subagent_start',
    'subagent_status'
  ]) {
    assert.equal(workerNames.includes(forbidden), false, `worker must not expose ${forbidden}`);
  }

  const restrictedNames = listNativeWorkspaceToolNames(
    resolveNativeSubagentToolPoolMode({
      mode: 'worker',
      definition: {
        name: 'writer',
        tools: ['read', 'write'],
        systemPrompt: '',
        sourcePath: '/tmp/agents/writer.md',
        source: 'claude'
      }
    })
  );
  assert.ok(restrictedNames.includes('write_file'));
  assert.equal(restrictedNames.includes('run_command'), false);
  assert.equal(restrictedNames.includes('web_search'), false);

  // Same flags through the real tool pool used by the runner.
  const project = buildProject();
  const params = buildSubagentRuntimeParams(project, buildSubagentProvider());
  const workerPool = await createNativeToolPool({
    params,
    mode: resolveNativeSubagentToolPoolMode({ mode: 'worker' })
  });
  assert.ok(workerPool.names.includes('write_file'));
  assert.ok(workerPool.names.includes('run_command'));
  assert.equal(workerPool.names.includes('run_subagent'), false);
});

test('explicit subagent model override threads through to the provider step request', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseTextResponse('子任务结论。');
    }) as typeof fetch;

    const project = buildProject();
    const params = buildSubagentRuntimeParams(project, buildSubagentProvider());
    const result = await runNativeSubagent(params, {
      type: 'run_subagent',
      task: '检查 README 内容',
      model: 'sub-model'
    });

    assert.equal(result.ok, true);
    assert.equal(capturedBody.model, 'sub-model');
    assert.match(result.summary, /Model: sub-model/);
    assert.match(result.summary, /子任务结论。/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unknown subagent model falls back to the parent model and notes the fallback in the transcript', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseTextResponse('回退后的结论。');
    }) as typeof fetch;

    const project = buildProject();
    const params = buildSubagentRuntimeParams(project, buildSubagentProvider());
    const result = await runNativeSubagent(params, {
      type: 'run_subagent',
      task: '检查 README 内容',
      model: 'mystery-model'
    });

    assert.equal(result.ok, true);
    assert.equal(capturedBody.model, 'parent-model');
    assert.match(result.summary, /Model: parent-model \(fallback from mystery-model\)/);
    // The fallback note rides inside the subagent prompt so the transcript records it.
    assert.match(JSON.stringify(capturedBody), /回退到父模型/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('subagent definitions thread system prompt addition, model, and worker mode through a run', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-subagent-def-run-'));
  const originalFetch = globalThis.fetch;
  try {
    resetSubagentDefinitionCache();
    const agentsDir = join(projectPath, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'builder.md'),
      [
        '---',
        'name: builder',
        'description: 项目改造工人',
        'tools: [read, write]',
        'model: def-model',
        '---',
        '永远先列出计划，再动手修改。'
      ].join('\n'),
      'utf8'
    );

    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseTextResponse('已完成修改。');
    }) as typeof fetch;

    const project = buildProject(projectPath);
    const params = buildSubagentRuntimeParams(project, buildSubagentProvider());
    const result = await runNativeSubagent(params, {
      type: 'run_subagent',
      task: '更新 README 标题',
      agent: 'builder',
      mode: 'worker'
    });

    assert.equal(result.ok, true);
    assert.equal(capturedBody.model, 'def-model', 'definition model must override the provider step model');
    const serialized = JSON.stringify(capturedBody);
    assert.match(serialized, /子 Agent 定义附加指令/);
    assert.match(serialized, /永远先列出计划，再动手修改。/);
    assert.match(serialized, /Worker Agent/);
    assert.match(result.summary, /Agent: builder/);
    assert.match(result.summary, /Mode: worker/);

    const missing = await runNativeSubagent(params, {
      type: 'run_subagent',
      task: '更新 README 标题',
      agent: 'does-not-exist'
    });
    assert.equal(missing.isError, true);
    assert.match(missing.summary, /未找到子 Agent 定义/);
    assert.match(missing.summary, /builder/);
  } finally {
    globalThis.fetch = originalFetch;
    resetSubagentDefinitionCache();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('subagent_status reads persisted background records through the store', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-subagent-status-store-'));
  try {
    await initializeStore(userDataPath);
    const project = buildProject();
    const params = buildSubagentRuntimeParams(project, buildSubagentProvider());
    const sessionId = params.context.activeSessionId;
    assert.ok(sessionId);

    // Simulates a record written by a previous app process and marked interrupted at startup.
    tryUpsertSubagentRun({
      id: 'subagent_persisted_1',
      parentSessionId: sessionId,
      status: 'interrupted',
      agentName: 'builder',
      prompt: '重启前的后台任务',
      startedAt: '2026-06-11T01:00:00.000Z',
      finishedAt: '2026-06-11T01:01:00.000Z',
      resultSummary: 'Application restarted before the background subagent completed.'
    });
    tryUpsertSubagentRun({
      id: 'subagent_foreign_1',
      parentSessionId: 'session_other_project',
      status: 'completed',
      prompt: '别的项目的任务',
      startedAt: '2026-06-11T01:00:00.000Z',
      finishedAt: '2026-06-11T01:02:00.000Z',
      resultSummary: 'done'
    });

    const byId = await readNativeBackgroundSubagentStatus(params, {
      type: 'subagent_status',
      taskId: 'subagent_persisted_1'
    });
    assert.equal(byId.ok, true);
    assert.match(byId.summary, /subagent_persisted_1/);
    assert.match(byId.summary, /Status: interrupted/);
    assert.match(byId.summary, /interrupted/);
    assert.match(byId.summary, /Agent: builder/);
    assert.match(byId.summary, /重启前的后台任务/);

    const listed = await readNativeBackgroundSubagentStatus(params, {
      type: 'subagent_status'
    });
    assert.equal(listed.ok, true);
    assert.match(listed.summary, /subagent_persisted_1/);
    assert.equal(/subagent_foreign_1/.test(listed.summary), false, 'records from other sessions must stay hidden');

    const foreign = await readNativeBackgroundSubagentStatus(params, {
      type: 'subagent_status',
      taskId: 'subagent_foreign_1'
    });
    assert.equal(foreign.isError, true, 'records outside this project sessions are not visible by id');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('background completion notices append to the next parent-loop tool result and drain once', async () => {
  const project = buildProject();
  const params = buildSubagentRuntimeParams(project, buildSubagentProvider());
  const todoInput = {
    todos: [{ content: '继续主任务', status: 'pending' }]
  };

  // A pool without subagent delegates (i.e. a subagent's own pool) must not steal notices.
  enqueueNativeSubagentCompletionNotice({
    projectId: project.id,
    sessionId: params.context.activeSessionId,
    notice: '后台子任务已完成：taskId=subagent_notice_test。'
  });
  const subagentPool = await createNativeToolPool({
    params,
    mode: resolveNativeSubagentToolPoolMode({ mode: 'investigator' })
  });
  const subagentOutput = await executeNativeWorkspaceToolSetTool(subagentPool.toolSet, 'update_todo_list', todoInput);
  assert.equal(/Background subagent update/.test(subagentOutput.summary ?? ''), false);

  // The parent pool (wired with subagent delegates) delivers and drains the notice.
  const parentPool = await createNativeToolPool({
    params,
    mode: {
      includeWriteTools: false,
      includeMcpToolCalls: false,
      includeCommandTools: false
    },
    delegates: {
      startSubagent: async () => ({ ok: true, summary: 'stub' })
    }
  });
  const firstOutput = await executeNativeWorkspaceToolSetTool(parentPool.toolSet, 'update_todo_list', todoInput);
  assert.match(firstOutput.summary ?? '', /\[Background subagent update\]/);
  assert.match(firstOutput.summary ?? '', /subagent_notice_test/);

  const secondOutput = await executeNativeWorkspaceToolSetTool(parentPool.toolSet, 'update_todo_list', todoInput);
  assert.equal(/Background subagent update/.test(secondOutput.summary ?? ''), false, 'notices must drain exactly once');
  assert.deepEqual(drainNativeSubagentCompletionNotices(project.id, params.context.activeSessionId), []);
});
