import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUnityHealth } from '../../electron/main/unity-bridge.ts';
import { executeAgentToolAction } from '../../electron/main/agent-platform/workspace-tools.ts';
import { openUnityProjectDirectly } from '../../electron/main/unity-install-tasks.ts';
import { readUnityProjectVersion } from '../../electron/main/unity-version.ts';
import {
  callUnityTool,
  completeUnityMcpArgument,
  getUnityPrompt,
  listUnityPrompts,
  listUnityResources,
  listUnityResourceTemplates,
  listUnityTools,
  readUnityResource
} from '../../electron/main/unity-mcp-client.ts';
import { getMcpConnectionSnapshot, postMcpJsonRpcForConfig, reconnectMcpConnection, resetMcpConnection, stopMcpConnection } from '../../electron/main/mcp-connection-manager.ts';
import {
  completeTask,
  createTask,
  bindTaskProjectPath,
  environmentTasks,
  listEnvironmentTasks,
  taskStageUpdate
} from '../../electron/main/environment-task-manager.ts';
import { listEnvironmentTasksForState } from '../../electron/main/environment-service.ts';
import { buildMcpPlugin, buildProject, buildState, buildStdioMcpPlugin, readJsonRequest, sendJsonRpc, startSdkHttpMcpServer, startTestMcpServer } from './test-helpers.ts';

async function startUnityMcpServer(options: { projectPath?: string } = {}): Promise<{
  baseUrl: string;
  origins: Array<string | undefined>;
  methods: string[];
  close: () => Promise<void>;
}> {
  const origins: Array<string | undefined> = [];
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    const method = typeof body.method === 'string' ? body.method : '';
    methods.push(method);
    origins.push(Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin);
    if (method === 'resources/read') {
      sendJsonRpc(response, body.id, {
        contents: [
          {
            uri: 'unity://project/context',
            mimeType: 'text/plain',
            text: [
              'Funplay MCP Project Context',
              '- Project: Test',
              '- Unity: 2022.3.62f2c1',
              `- Project Path: ${options.projectPath ?? '/tmp/funplay-test-project'}`,
              '- Assets Path: Assets'
            ].join('\n')
          }
        ]
      });
      return;
    }
    sendJsonRpc(response, body.id, {
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: 'Funplay MCP Server - Test',
        version: '0.3.0'
      },
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    origins,
    methods,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })
  };
}

test('environment task updates preserve existing fields and terminal completion', () => {
  environmentTasks.clear();
  const task = createTask('create_unity_project', '创建 Unity 项目', '准备中');
  taskStageUpdate(task.id, {
    stage: 'checking',
    status: 'running',
    progress: 12,
    message: '运行中',
    log: 'started'
  });
  taskStageUpdate(task.id, {
    progress: 18,
    log: 'progress only'
  });

  let current = listEnvironmentTasks()[0];
  assert.equal(current.status, 'running');
  assert.equal(current.stage, 'checking');
  assert.equal(current.message, '运行中');
  assert.equal(current.progress, 18);
  assert.deepEqual(current.logs.slice(-2), ['started', 'progress only']);

  completeTask(task.id, 'completed', '完成');
  taskStageUpdate(task.id, {
    stage: 'validating',
    status: 'running',
    progress: 50,
    message: '不应覆盖'
  });
  current = listEnvironmentTasks()[0];
  assert.equal(current.status, 'completed');
  assert.equal(current.stage, 'completed');
  assert.equal(current.message, '完成');
  assert.equal(current.progress, 100);

  const manualTask = createTask('install_unity_hub', '安装 Unity Hub', '准备中');
  completeTask(manualTask.id, 'needs_user', '请手动完成');
  const manual = listEnvironmentTasks().find((item) => item.id === manualTask.id);
  assert.equal(manual?.status, 'needs_user');
  assert.equal(manual?.stage, 'waiting_manual');
});

test('agent engine control tools use generic names and return unsupported for unfinished adapters', async () => {
  const project = {
    ...buildProject('/tmp/funplay-godot-project'),
    engine: {
      platform: 'godot' as const,
      setupMode: 'import' as const,
      projectPath: '/tmp/funplay-godot-project',
      dimension: '2d' as const
    }
  };

  const diagnosis = await executeAgentToolAction(project, {
    type: 'diagnose_engine_status'
  });
  assert.equal(diagnosis.ok, true);
  assert.match(diagnosis.summary, /Godot Adapter/);
  assert.match(diagnosis.summary, /还没有实现|尚未实现/);

  const opened = await executeAgentToolAction(project, {
    type: 'open_engine_project'
  });
  assert.equal(opened.ok, false);
  assert.match(opened.summary, /Godot.*尚未实现/);
});

test('unity project opening requires the exact saved editor version', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-unity-version-'));
  try {
    await mkdir(join(projectPath, 'Assets'));
    await mkdir(join(projectPath, 'ProjectSettings'));
    await writeFile(
      join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 9999.1.2f3\nm_EditorVersionWithRevision: 9999.1.2f3 (deadbeef)\n',
      'utf8'
    );

    assert.equal(readUnityProjectVersion(projectPath)?.version, '9999.1.2f3');
    assert.equal(await openUnityProjectDirectly(projectPath), false);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('unity health probe does not send browser Origin header', async () => {
  const server = await startUnityMcpServer();
  try {
    const result = await checkUnityHealth(server.baseUrl);
    assert.equal(result.status, 'online');
    assert.match(result.message, /Funplay MCP Server - Test/);
    assert.equal(server.origins[0], undefined);
  } finally {
    await server.close();
  }
});

test('unity health probe requires MCP project path match when expected project is provided', async () => {
  const server = await startUnityMcpServer({ projectPath: '/tmp/funplay-current-project' });
  try {
    const matched = await checkUnityHealth(server.baseUrl, { expectedProjectPath: '/tmp/funplay-current-project' });
    assert.equal(matched.status, 'online');
    assert.equal(matched.projectPath, '/tmp/funplay-current-project');

    const mismatched = await checkUnityHealth(server.baseUrl, { expectedProjectPath: '/tmp/funplay-other-project' });
    assert.equal(mismatched.status, 'offline');
    assert.match(mismatched.message, /项目不匹配/);
  } finally {
    await server.close();
  }
});

test('unity health probe caches repeated polling checks', async () => {
  const server = await startUnityMcpServer({ projectPath: '/tmp/funplay-cached-project' });
  try {
    const first = await checkUnityHealth(server.baseUrl, { expectedProjectPath: '/tmp/funplay-cached-project' });
    const second = await checkUnityHealth(server.baseUrl, { expectedProjectPath: '/tmp/funplay-cached-project' });
    assert.equal(first.status, 'online');
    assert.equal(second.status, 'online');
    assert.equal(server.methods.filter((method) => method === 'initialize').length, 1);
    assert.equal(server.methods.filter((method) => method === 'resources/read').length, 1);

    const fresh = await checkUnityHealth(server.baseUrl, {
      expectedProjectPath: '/tmp/funplay-cached-project',
      bypassCache: true
    });
    assert.equal(fresh.status, 'online');
    assert.equal(server.methods.filter((method) => method === 'initialize').length, 1);
    assert.equal(server.methods.filter((method) => method === 'resources/read').length, 2);
  } finally {
    await server.close();
  }
});

test('unity mcp client reuses initialization across repeated resource reads', async () => {
  const server = await startUnityMcpServer();
  try {
    await readUnityResource(server.baseUrl, 'unity://project/context');
    await readUnityResource(server.baseUrl, 'unity://project/context');

    assert.equal(server.methods.filter((method) => method === 'initialize').length, 1);
    assert.equal(server.methods.filter((method) => method === 'notifications/initialized').length, 1);
    assert.equal(server.methods.filter((method) => method === 'resources/read').length, 2);
    const snapshot = getMcpConnectionSnapshot(server.baseUrl);
    assert.equal(snapshot.status, 'online');
    assert.equal(snapshot.initializeCount, 1);
  } finally {
    await server.close();
  }
});

test('mcp connection manager reconnects on demand without losing status visibility', async () => {
  const server = await startUnityMcpServer();
  try {
    await readUnityResource(server.baseUrl, 'unity://project/context');
    assert.equal(server.methods.filter((method) => method === 'initialize').length, 1);

    const reconnected = await reconnectMcpConnection(server.baseUrl);
    assert.equal(reconnected.name, 'Funplay MCP Server - Test');
    assert.equal(server.methods.filter((method) => method === 'initialize').length, 2);
    assert.equal(server.methods.filter((method) => method === 'notifications/initialized').length, 2);

    const snapshot = getMcpConnectionSnapshot(server.baseUrl);
    assert.equal(snapshot.status, 'online');
    assert.equal(snapshot.serverInfo?.name, 'Funplay MCP Server - Test');
    assert.equal(snapshot.initializeCount, 1);
  } finally {
    await server.close();
  }
});

test('unity mcp client exposes prompt, resource template, and completion capabilities', async () => {
  const server = await startTestMcpServer({
    capabilities: {
      prompts: {},
      resources: {},
      completions: {}
    }
  });
  try {
    const prompts = await listUnityPrompts(server.baseUrl);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.name, 'unity.scene_review');
    assert.equal(prompts[0]?.arguments?.[0]?.name, 'scene');

    const prompt = await getUnityPrompt(server.baseUrl, 'unity.scene_review', {
      scene: 'MainScene'
    });
    assert.equal(prompt.description, 'prompt:unity.scene_review');
    assert.equal(prompt.messages[0]?.content.text, 'Review MainScene');

    const templates = await listUnityResourceTemplates(server.baseUrl);
    assert.equal(templates[0]?.uriTemplate, 'unity://asset/{guid}');

    const completion = await completeUnityMcpArgument(server.baseUrl, {
      type: 'ref/prompt',
      name: 'unity.scene_review'
    }, 'scene', 'Ma');
    assert.deepEqual(completion.values, ['MainScene', 'BattleScene']);
    assert.equal(completion.total, 2);
    assert.equal(completion.hasMore, false);
    assert.equal(server.requests.filter((method) => method === 'initialize').length, 1);
    assert.equal(server.requests.filter((method) => method === 'prompts/list').length, 1);
    assert.equal(server.requests.filter((method) => method === 'resources/templates/list').length, 1);
    assert.equal(server.requests.filter((method) => method === 'completion/complete').length, 1);
  } finally {
    await server.close();
  }
});

test('unity mcp optional capability calls fall back when server does not advertise support', async () => {
  const server = await startTestMcpServer();
  try {
    assert.deepEqual(await listUnityPrompts(server.baseUrl), []);
    assert.deepEqual(await listUnityResourceTemplates(server.baseUrl), []);
    assert.deepEqual(await completeUnityMcpArgument(server.baseUrl, {
      type: 'ref/prompt',
      name: 'unity.scene_review'
    }, 'scene', 'Ma'), {
      values: [],
      raw: {}
    });
    assert.equal(server.requests.filter((method) => method === 'initialize').length, 1);
    assert.equal(server.requests.includes('prompts/list'), false);
    assert.equal(server.requests.includes('resources/templates/list'), false);
    assert.equal(server.requests.includes('completion/complete'), false);
  } finally {
    await server.close();
  }
});

test('mcp tool elicitation bridges through host user input and resumes tool result', async () => {
  const server = await startTestMcpServer({
    elicitationOnToolCall: true
  });
  try {
    const project = buildProject('/tmp/funplay-mcp-elicit');
    const plugin = buildMcpPlugin(server.baseUrl);
    const userInputRequests: Array<{ question: string; options: string[] }> = [];
    const result = await executeAgentToolAction(
      project,
      {
        type: 'call_mcp_tool',
        pluginId: plugin.id,
        toolName: 'unity.echo',
        args: {}
      },
      {
        plugins: [plugin],
        requestUserInput: async (request) => {
          userInputRequests.push({
            question: request.question,
            options: request.options?.map((option) => option.id) ?? []
          });
          return {
            answer: '',
            optionId: 'BattleScene'
          };
        }
      }
    );

    assert.equal(result.ok, true);
    assert.match(result.summary, /elicited:BattleScene/);
    assert.equal(userInputRequests[0]?.question, 'Pick a scene');
    assert.deepEqual(userInputRequests[0]?.options, ['MainScene', 'BattleScene']);
    assert.equal(server.requests.includes('client/response'), true);
  } finally {
    await server.close();
  }
});

test('mcp compatibility matrix covers a web search style tool server', async () => {
  const server = await startTestMcpServer({
    capabilities: {
      tools: {},
      resources: {}
    },
    toolsListByCall: [[
      {
        name: 'web.search',
        description: 'Search public web sources',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string'
            },
            limit: {
              type: 'number'
            }
          },
          required: ['query']
        }
      }
    ]]
  });
  const plugin = {
    ...buildMcpPlugin(server.baseUrl),
    id: 'plugin_web_search_mcp',
    name: 'Web Search MCP',
    kind: 'custom' as const
  };
  try {
    const tools = await listUnityTools(plugin);
    assert.equal(tools[0]?.name, 'web.search');
    const schema = tools[0]?.inputSchema as { properties?: Record<string, { type?: string }> } | undefined;
    assert.equal(schema?.properties?.query?.type, 'string');

    const result = await callUnityTool(plugin, 'web.search', {
      query: 'Funplay MCP',
      limit: 3
    });
    assert.equal(result.content[0]?.text, 'tool:web.search');

    const resources = await listUnityResources(plugin);
    assert.equal(resources[0]?.uri, 'unity://project/context');

    const snapshot = getMcpConnectionSnapshot(plugin);
    assert.equal(snapshot.status, 'online');
    assert.equal(snapshot.serverInfo?.name, 'Test MCP');
    assert.equal(server.requests.filter((method) => method === 'tools/list').length, 1);
    assert.equal(server.requests.filter((method) => method === 'tools/call').length, 1);
  } finally {
    resetMcpConnection(plugin);
    await server.close();
  }
});

test('mcp stdio transport initializes once and supports tools and resources', async () => {
  const plugin = buildStdioMcpPlugin();
  try {
    const tools = await listUnityTools(plugin);
    assert.equal(tools[0]?.name, 'stdio.echo');

    const toolResult = await callUnityTool(plugin, 'stdio.echo', {
      value: 'hello'
    });
    assert.equal(toolResult.content[0]?.text, 'stdio:hello');

    const resources = await listUnityResources(plugin);
    assert.equal(resources[0]?.uri, 'stdio://context');

    const resource = await readUnityResource(plugin, 'stdio://context');
    assert.equal(resource.content[0]?.text, 'resource:stdio://context');

    const snapshot = getMcpConnectionSnapshot(plugin);
    assert.equal(snapshot.status, 'online');
    assert.equal(snapshot.serverInfo?.name, 'Stdio Test MCP');
    assert.equal(snapshot.initializeCount, 1);
  } finally {
    resetMcpConnection(plugin);
  }
});

test('mcp stdio lifecycle exposes process state, stderr tail, stop, and restart', async () => {
  const plugin = buildStdioMcpPlugin({ stderrOnStart: 'stdio ready' });
  try {
    await listUnityTools(plugin);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const running = getMcpConnectionSnapshot(plugin);
    assert.equal(running.status, 'online');
    assert.equal(running.processStatus, 'running');
    assert.equal(typeof running.pid, 'number');
    assert.equal(running.stderrTail?.includes('stdio ready'), true);

    const stopped = await stopMcpConnection(plugin);
    assert.equal(stopped.status, 'offline');
    assert.equal(stopped.processStatus, 'stopped');
    assert.equal(stopped.stderrTail?.includes('stdio ready'), true);

    const restarted = await reconnectMcpConnection(plugin);
    assert.equal(restarted.name, 'Stdio Test MCP');
    const afterRestart = getMcpConnectionSnapshot(plugin);
    assert.equal(afterRestart.status, 'online');
    assert.equal(afterRestart.processStatus, 'running');
  } finally {
    resetMcpConnection(plugin);
  }
});

test('mcp stdio crash records exit state and stderr tail', async () => {
  const plugin = buildStdioMcpPlugin({ crashOnToolCall: true });
  try {
    await assert.rejects(
      postMcpJsonRpcForConfig(plugin, 'tools/call', {
        name: 'stdio.echo',
        arguments: { value: 'boom' }
      }),
      /MCP stdio process exited|MCP stdio tools\/call/
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const snapshot = getMcpConnectionSnapshot(plugin);
    assert.equal(snapshot.status, 'offline');
    assert.equal(snapshot.processStatus, 'exited');
    assert.equal(snapshot.exitCode, 42);
    assert.equal(snapshot.stderrTail?.includes('fatal tool crash'), true);
  } finally {
    resetMcpConnection(plugin);
  }
});

test('mcp streamable http transport uses SDK client for tools', async () => {
  const server = await startSdkHttpMcpServer('streamable-http');
  const plugin = {
    ...buildMcpPlugin(server.baseUrl),
    id: 'plugin_streamable_mcp',
    name: 'Streamable MCP',
    transport: 'streamable-http' as const
  };
  try {
    const tools = await listUnityTools(plugin);
    assert.equal(tools[0]?.name, 'remote.echo');

    const result = await callUnityTool(plugin, 'remote.echo', { value: 'hello' });
    assert.equal(result.content[0]?.text, 'streamable-http:hello');

    const snapshot = getMcpConnectionSnapshot(plugin);
    assert.equal(snapshot.status, 'online');
    assert.equal(snapshot.transport, 'streamable-http');
    assert.equal(snapshot.serverInfo?.name, 'Streamable Test MCP');
  } finally {
    resetMcpConnection(plugin);
    await server.close();
  }
});

test('mcp sse transport uses SDK client for tools', async () => {
  const server = await startSdkHttpMcpServer('sse');
  const plugin = {
    ...buildMcpPlugin(server.baseUrl),
    id: 'plugin_sse_mcp',
    name: 'SSE MCP',
    transport: 'sse' as const
  };
  try {
    const tools = await listUnityTools(plugin);
    assert.equal(tools[0]?.name, 'remote.echo');

    const result = await callUnityTool(plugin, 'remote.echo', { value: 'hello' });
    assert.equal(result.content[0]?.text, 'sse:hello');

    const snapshot = getMcpConnectionSnapshot(plugin);
    assert.equal(snapshot.status, 'online');
    assert.equal(snapshot.transport, 'sse');
    assert.equal(snapshot.serverInfo?.name, 'SSE Test MCP');
  } finally {
    resetMcpConnection(plugin);
    await server.close();
  }
});

test('environment task polling reconciles bridge tasks when Unity MCP is online', async () => {
  environmentTasks.clear();
  const server = await startUnityMcpServer({ projectPath: '/tmp/funplay-target-project' });
  try {
    const state = buildState(buildProject());
    state.settings.baseUrl = server.baseUrl;
    const task = createTask('create_unity_project', '创建 Unity 项目', '准备中');
    bindTaskProjectPath(task.id, '/tmp/funplay-target-project');
    taskStageUpdate(task.id, {
      stage: 'validating',
      status: 'running',
      progress: 92,
      message: 'Unity 项目已启动，正在等待 Bridge / MCP 连通…'
    });

    const tasks = await listEnvironmentTasksForState(state);
    const current = tasks.find((item) => item.id === task.id);
    assert.equal(current?.status, 'completed');
    assert.equal(current?.stage, 'completed');
    assert.equal(current?.message, 'Unity 项目已打开，Bridge / MCP 已连通。');
    assert.equal(state.settings.baseUrl, server.baseUrl);
  } finally {
    await server.close();
  }
});

test('environment task polling does not complete a task from another Unity project MCP', async () => {
  environmentTasks.clear();
  const server = await startUnityMcpServer({ projectPath: '/tmp/funplay-other-project' });
  try {
    const state = buildState(buildProject());
    state.settings.baseUrl = server.baseUrl;
    const task = createTask('create_unity_project', '创建 Unity 项目', '准备中');
    bindTaskProjectPath(task.id, '/tmp/funplay-target-project');
    taskStageUpdate(task.id, {
      stage: 'validating',
      status: 'running',
      progress: 92,
      message: 'Unity 项目已启动，正在等待 Bridge / MCP 连通…'
    });

    const tasks = await listEnvironmentTasksForState(state);
    const current = tasks.find((item) => item.id === task.id);
    assert.equal(current?.status, 'running');
    assert.equal(current?.stage, 'validating');
    assert.equal(current?.message, 'Unity 项目已启动，正在等待 Bridge / MCP 连通…');
  } finally {
    await server.close();
  }
});
