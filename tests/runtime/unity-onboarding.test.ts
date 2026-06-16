import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUnityHealth } from '../../electron/main/unity-bridge.ts';
import { executeAgentToolAction } from '../../electron/main/agent-platform/workspace-tools.ts';
import { getAgentToolDefinition } from '../../electron/main/agent-platform/tool-registry.ts';
import { assembleGameTools } from '../../electron/main/game-tool-layer.ts';
import { openUnityProjectDirectly } from '../../electron/main/unity-install-tasks.ts';
import { readUnityProjectVersion } from '../../electron/main/unity-version.ts';
import {
  createCocosProjectFromTemplate,
  installCocosBridge,
  isCocosProjectCurrentlyOpen,
  openCocosDashboard,
  openCocosProject
} from '../../electron/main/agent-platform/cocos-adapter.ts';
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
import {
  getMcpConnectionSnapshot,
  postMcpJsonRpcForConfig,
  reconnectMcpConnection,
  resetMcpConnection,
  stopMcpConnection
} from '../../electron/main/mcp-connection-manager.ts';
import {
  completeTask,
  createTask,
  bindTaskProjectPath,
  environmentTasks,
  listEnvironmentTasks,
  taskStageUpdate
} from '../../electron/main/environment-task-manager.ts';
import {
  diagnoseEnvironment,
  getProjectRuntimeState,
  isLikelyUnityHubPath,
  listEnvironmentTasksForState,
  resolveUnityHubBinaryPath,
  runEnvironmentAction
} from '../../electron/main/environment-service.ts';
import {
  buildMcpPlugin,
  buildProject,
  buildState,
  buildStdioMcpPlugin,
  readJsonRequest,
  sendJsonRpc,
  startSdkHttpMcpServer,
  startTestMcpServer
} from './test-helpers.ts';

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
    close: () =>
      new Promise<void>((resolve, reject) => {
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

async function startCocosMcpProjectServer(projectPath: string): Promise<{
  baseUrl: string;
  methods: string[];
  close: () => Promise<void>;
}> {
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    const method = typeof body.method === 'string' ? body.method : '';
    methods.push(method);
    if (method === 'notifications/initialized') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === 'initialize') {
      sendJsonRpc(response, body.id, {
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'Funplay Cocos MCP - Test',
          version: '0.3.3'
        },
        capabilities: {
          tools: {},
          resources: {}
        }
      });
      return;
    }
    if (method === 'tools/call') {
      const params = body.params && typeof body.params === 'object' ? (body.params as Record<string, unknown>) : {};
      if (params.name === 'get_project_info') {
        sendJsonRpc(response, body.id, {
          structuredContent: {
            ok: true,
            data: {
              projectPath
            }
          },
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                projectPath
              })
            }
          ]
        });
        return;
      }
    }
    if (method === 'resources/list') {
      sendJsonRpc(response, body.id, {
        resources: [
          { uri: 'cocos://project/context', name: 'Project Context' },
          { uri: 'cocos://scene/active', name: 'Active Scene' },
          { uri: 'cocos://selection/current', name: 'Current Selection' },
          { uri: 'cocos://errors/scripts', name: 'Script Diagnostics' }
        ]
      });
      return;
    }
    if (method === 'tools/list') {
      sendJsonRpc(response, body.id, {
        tools: [
          { name: 'get_scene_info', inputSchema: { type: 'object', properties: {} } },
          { name: 'execute_javascript', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
          { name: 'capture_game_screenshot', inputSchema: { type: 'object', properties: {} } }
        ]
      });
      return;
    }
    if (method === 'resources/read') {
      sendJsonRpc(response, body.id, {
        contents: [
          {
            uri: 'cocos://project/context',
            mimeType: 'text/plain',
            text: ['Funplay Cocos MCP Project Context', `- Project Path: ${projectPath}`].join('\n')
          }
        ]
      });
      return;
    }
    sendJsonRpc(response, body.id, {});
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    methods,
    close: () =>
      new Promise<void>((resolve, reject) => {
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

async function writeCocosProjectFixture(projectPath: string): Promise<void> {
  const bridgePath = join(projectPath, 'extensions', 'funplay-cocos-mcp');
  await mkdir(join(projectPath, 'assets'), { recursive: true });
  await mkdir(bridgePath, { recursive: true });
  await writeFile(join(projectPath, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');
  await writeFile(join(bridgePath, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
  await writeFile(join(bridgePath, 'browser.js'), '', 'utf8');
  await writeFile(join(bridgePath, 'server.json'), '{}', 'utf8');
}

async function writeFakeCocosCreator(
  executablePath: string,
  script = '#!/bin/sh\nwhile true; do sleep 1; done\n'
): Promise<void> {
  await mkdir(join(executablePath, '..'), { recursive: true });
  await writeFile(executablePath, script, 'utf8');
  await chmod(executablePath, 0o755);
}

async function stopChildProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 300))
  ]);
  if (child.exitCode === null && !child.killed) {
    child.kill('SIGKILL');
  }
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

test('unity hub detection accepts a custom app path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-unity-hub-'));
  const hubPath = join(root, 'Unity Hub.app');
  const binaryPath = join(hubPath, 'Contents', 'MacOS', 'Unity Hub');
  try {
    await mkdir(join(hubPath, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(binaryPath, '', 'utf8');

    assert.equal(isLikelyUnityHubPath(hubPath), true);
    assert.equal(resolveUnityHubBinaryPath(hubPath), binaryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

    const completion = await completeUnityMcpArgument(
      server.baseUrl,
      {
        type: 'ref/prompt',
        name: 'unity.scene_review'
      },
      'scene',
      'Ma'
    );
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
    assert.deepEqual(
      await completeUnityMcpArgument(
        server.baseUrl,
        {
          type: 'ref/prompt',
          name: 'unity.scene_review'
        },
        'scene',
        'Ma'
      ),
      {
        values: [],
        raw: {}
      }
    );
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
    toolsListByCall: [
      [
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
      ]
    ]
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

test('environment task polling does not complete a Unity task that has no bound project path', async () => {
  environmentTasks.clear();
  const server = await startUnityMcpServer({ projectPath: '/tmp/funplay-some-project' });
  try {
    const state = buildState(buildProject());
    state.settings.baseUrl = server.baseUrl;
    const task = createTask('open_unity_project', '打开 Unity 项目', '准备中');
    // Intentionally NO bindTaskProjectPath — an online bridge can't be attributed
    // to this task's project, so it must not be force-completed (#7).
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
  } finally {
    await server.close();
  }
});

test('cocos diagnose resolves the engine variant (defaults to creator3, honors cocos4)', async () => {
  const state = buildState(buildProject());
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-variant-'));
  try {
    const defaulted = await diagnoseEnvironment(state, {
      platform: 'cocos',
      mode: 'create',
      dimension: '3d',
      projectName: 'Arrow',
      projectPath: root
    });
    assert.equal(defaulted.cocosVariant, 'creator3');

    const explicit = await diagnoseEnvironment(state, {
      platform: 'cocos',
      mode: 'create',
      dimension: '3d',
      cocosVariant: 'cocos4',
      projectName: 'Arrow',
      projectPath: root
    });
    assert.equal(explicit.cocosVariant, 'cocos4');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos onboarding diagnostics mirror Unity-style staged setup and preserve 3D mode', async () => {
  const state = buildState(buildProject());
  const timestamp = new Date().toISOString();
  state.mcpPlugins = [
    {
      id: 'mcp_stale_unity',
      name: 'Unity MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: 'http://127.0.0.1:9000/',
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Unity MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: 'mcp_cocos',
      name: 'Funplay Cocos MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: 'http://127.0.0.1:8765/',
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Cocos Creator MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-onboarding-'));
  const fakeCreator = join(root, 'CocosCreator.app', 'Contents', 'MacOS', 'CocosCreator');
  const fakeDashboard = join(root, 'CocosDashboard.app', 'Contents', 'MacOS', 'CocosDashboard');
  const previousCreator = process.env.COCOS_CREATOR_EXECUTABLE;
  const previousDashboard = process.env.COCOS_DASHBOARD_EXECUTABLE;
  try {
    await mkdir(join(fakeCreator, '..'), { recursive: true });
    await mkdir(join(fakeDashboard, '..'), { recursive: true });
    await writeFile(fakeCreator, '', 'utf8');
    await writeFile(fakeDashboard, '', 'utf8');
    process.env.COCOS_CREATOR_EXECUTABLE = fakeCreator;
    process.env.COCOS_DASHBOARD_EXECUTABLE = fakeDashboard;

    const diagnostics = await diagnoseEnvironment(state, {
      platform: 'cocos',
      mode: 'create',
      dimension: '3d',
      projectName: 'Arrow',
      projectPath: root,
      enginePluginId: 'mcp_stale_unity'
    });
    const ids = diagnostics.checks.map((check) => check.id);
    const projectCheck = diagnostics.checks.find((check) => check.id === 'engine-project');

    assert.deepEqual(ids, [
      'cocos-dashboard',
      'engine-project',
      'engine-opened',
      'bridge-installed',
      'bridge-connected'
    ]);
    assert.equal(diagnostics.dimension, '3d');
    assert.equal(diagnostics.enginePluginId, 'mcp_cocos');
    assert.equal(diagnostics.ready, false);
    assert.equal(diagnostics.checks[0]?.status, 'passed');
    assert.equal(projectCheck?.status, 'warning');
    assert.match(projectCheck?.detail ?? '', /Cocos Creator 内置 3D 空模板/);
    assert.equal(projectCheck?.actions[0]?.id, 'create_cocos_project');
    assert.doesNotMatch(JSON.stringify(diagnostics), /仅开放 2D|2D 项目模式/);
  } finally {
    if (typeof previousCreator === 'undefined') {
      delete process.env.COCOS_CREATOR_EXECUTABLE;
    } else {
      process.env.COCOS_CREATOR_EXECUTABLE = previousCreator;
    }
    if (typeof previousDashboard === 'undefined') {
      delete process.env.COCOS_DASHBOARD_EXECUTABLE;
    } else {
      process.env.COCOS_DASHBOARD_EXECUTABLE = previousDashboard;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos template creator can generate a local 3D project without Dashboard interaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-template-'));
  const fakeCreator = join(root, 'CocosCreator.app', 'Contents', 'MacOS', 'CocosCreator');
  const templatePath = join(root, 'CocosCreator.app', 'Contents', 'Resources', 'templates', 'empty');
  const targetProjectPath = join(root, 'Arrow');
  try {
    await mkdir(templatePath, { recursive: true });
    await mkdir(join(fakeCreator, '..'), { recursive: true });
    await writeFile(fakeCreator, '', 'utf8');
    await writeFile(join(root, 'CocosCreator.app', 'Contents', 'Resources', 'templates', 'list.json'), '[]', 'utf8');
    await writeFile(join(templatePath, 'package.json'), JSON.stringify({ name: 'empty' }), 'utf8');
    await writeFile(join(templatePath, 'tsconfig.json'), '{}', 'utf8');

    const result = createCocosProjectFromTemplate({
      targetProjectPath,
      projectName: 'Arrow',
      dimension: '3d',
      env: {
        ...process.env,
        COCOS_CREATOR_EXECUTABLE: fakeCreator
      }
    });

    assert.equal(result.ok, true);
    assert.match(result.summary, /Template: empty/);
    assert.equal(JSON.parse(await readFile(join(targetProjectPath, 'package.json'), 'utf8')).name, 'Arrow');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos project runtime state reports online Cocos MCP when the bridge server responds', async () => {
  const state = buildState(buildProject());
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-runtime-'));
  const server = await startCocosMcpProjectServer(root);
  const timestamp = new Date().toISOString();
  state.mcpPlugins = [
    {
      id: 'mcp_cocos',
      name: 'Funplay Cocos MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: server.baseUrl,
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Cocos Creator MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
  try {
    const bridgePath = join(root, 'extensions', 'funplay-cocos-mcp');
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(bridgePath, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');
    await writeFile(join(bridgePath, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
    await writeFile(join(bridgePath, 'browser.js'), '', 'utf8');
    await writeFile(join(bridgePath, 'server.json'), '{}', 'utf8');

    const runtimeState = await getProjectRuntimeState(state, {
      platform: 'cocos',
      projectPath: root
    });

    assert.equal(runtimeState.projectExists, true);
    assert.equal(runtimeState.unityProjectValid, true);
    assert.equal(runtimeState.bridgeInstalled, true);
    assert.equal(runtimeState.bridgeHealth?.status, 'online');
    assert.equal(runtimeState.projectOpen, true);
    assert.equal(runtimeState.mcpSettings?.url.replace(/\/$/, ''), server.baseUrl.replace(/\/$/, ''));
    assert.equal(runtimeState.bridgeHealth?.projectPath, root);
    assert.match(runtimeState.bridgeHealth?.message ?? '', /Cocos MCP 已连通/);
    assert.equal(server.methods.includes('tools/call'), true);
    // P7b: the online cocos runtime snapshot reads the cocos:// resource layer.
    assert.ok((runtimeState.availableResourceUris ?? []).includes('cocos://scene/active'));
    assert.match(runtimeState.activeSceneSummary ?? '', /Project Context/);
  } finally {
    resetMcpConnection(server.baseUrl);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos refresh_engine_runtime_state agent tool returns live runtime state, not the static diagnose blob', async () => {
  const state = buildState(buildProject());
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-refresh-'));
  const server = await startCocosMcpProjectServer(root);
  const timestamp = new Date().toISOString();
  state.mcpPlugins = [
    {
      id: 'mcp_cocos',
      name: 'Funplay Cocos MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: server.baseUrl,
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Cocos Creator MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
  try {
    const bridgePath = join(root, 'extensions', 'funplay-cocos-mcp');
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(bridgePath, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');
    await writeFile(join(bridgePath, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
    await writeFile(join(bridgePath, 'browser.js'), '', 'utf8');
    await writeFile(join(bridgePath, 'server.json'), '{}', 'utf8');

    const result = await executeAgentToolAction(
      buildProject(),
      { type: 'refresh_engine_runtime_state', platform: 'cocos', projectPath: root },
      { appState: state }
    );

    // Live runtime-state markers (formatRuntimeState), proving refresh is no
    // longer aliased to the static diagnoseCocosEnvironment text blob.
    assert.equal(result.ok, true);
    assert.match(result.summary, /Engine platform: cocos/);
    assert.match(result.summary, /Project open: yes/);
    assert.match(result.summary, /MCP health: online - .*Cocos MCP 已连通/);
    // The old aliased diagnose output emitted this static endpoint line; refresh must not.
    assert.doesNotMatch(result.summary, /Default MCP endpoint:/);
  } finally {
    resetMcpConnection(server.baseUrl);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos diagnose_engine_status agent tool reports live MCP connectivity (online)', async () => {
  const state = buildState(buildProject());
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-diag-online-'));
  const server = await startCocosMcpProjectServer(root);
  const timestamp = new Date().toISOString();
  state.mcpPlugins = [
    {
      id: 'mcp_cocos',
      name: 'Funplay Cocos MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: server.baseUrl,
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Cocos Creator MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
  try {
    const bridgePath = join(root, 'extensions', 'funplay-cocos-mcp');
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(bridgePath, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');
    await writeFile(join(bridgePath, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
    await writeFile(join(bridgePath, 'browser.js'), '', 'utf8');
    await writeFile(join(bridgePath, 'server.json'), '{}', 'utf8');

    const result = await executeAgentToolAction(
      buildProject(),
      { type: 'diagnose_engine_status', platform: 'cocos', projectPath: root },
      { appState: state }
    );

    // Keeps the static install/structure diagnosis...
    assert.equal(result.ok, true);
    assert.match(result.summary, /Cocos project valid: yes/);
    assert.match(result.summary, /Funplay Cocos MCP installed: yes/);
    // ...and now also reports LIVE bridge connectivity, not just on-disk install.
    assert.match(result.summary, /MCP health: online - .*Cocos MCP 已连通/);
  } finally {
    resetMcpConnection(server.baseUrl);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos diagnose_engine_status reports offline (not a hard failure) when no bridge server answers', async () => {
  const state = buildState(buildProject());
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-diag-offline-'));
  const timestamp = new Date().toISOString();
  // Point at a dead localhost port; no server is listening.
  const deadUrl = 'http://127.0.0.1:59231/';
  state.mcpPlugins = [
    {
      id: 'mcp_cocos',
      name: 'Funplay Cocos MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: deadUrl,
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Cocos Creator MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
  try {
    const bridgePath = join(root, 'extensions', 'funplay-cocos-mcp');
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(bridgePath, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');
    await writeFile(join(bridgePath, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
    await writeFile(join(bridgePath, 'browser.js'), '', 'utf8');
    await writeFile(join(bridgePath, 'server.json'), '{}', 'utf8');

    const result = await executeAgentToolAction(
      buildProject(),
      { type: 'diagnose_engine_status', platform: 'cocos', projectPath: root },
      { appState: state }
    );

    // Offline is reported as diagnostic info, not an error — diagnose stays ok.
    assert.equal(result.ok, true);
    assert.notEqual(result.isError, true);
    assert.match(result.summary, /MCP health: offline/);
  } finally {
    resetMcpConnection(deadUrl);
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos runtime-state probe caches within its TTL (repeated polls hit the network once)', async () => {
  const state = buildState(buildProject());
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-cache-'));
  const server = await startCocosMcpProjectServer(root);
  const timestamp = new Date().toISOString();
  state.mcpPlugins = [
    {
      id: 'mcp_cocos',
      name: 'Funplay Cocos MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: server.baseUrl,
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Cocos Creator MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
  try {
    const bridgePath = join(root, 'extensions', 'funplay-cocos-mcp');
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(bridgePath, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');
    await writeFile(join(bridgePath, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
    await writeFile(join(bridgePath, 'browser.js'), '', 'utf8');
    await writeFile(join(bridgePath, 'server.json'), '{}', 'utf8');

    const first = await getProjectRuntimeState(state, { platform: 'cocos', projectPath: root });
    assert.equal(first.bridgeHealth?.status, 'online');
    const initCount = server.methods.filter((method) => method === 'initialize').length;

    // A second poll within the TTL must be served from cache — no new probe.
    const second = await getProjectRuntimeState(state, { platform: 'cocos', projectPath: root });
    assert.equal(second.bridgeHealth?.status, 'online');
    assert.equal(server.methods.filter((method) => method === 'initialize').length, initCount);
  } finally {
    resetMcpConnection(server.baseUrl);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos onboarding task reconciliation completes without poking the project (no get_project_info modal)', async () => {
  environmentTasks.clear();
  const state = buildState(buildProject());
  // mkdtemp lives under the macOS /tmp -> /private/tmp symlink, so inspectCocosProject's
  // resolved path diverges from the bound path — the exact === mismatch (#6).
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-task-'));
  const server = await startCocosMcpProjectServer(root);
  const timestamp = new Date().toISOString();
  state.mcpPlugins = [
    {
      id: 'mcp_cocos',
      name: 'Funplay Cocos MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: server.baseUrl,
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Cocos Creator MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
  try {
    const bridgePath = join(root, 'extensions', 'funplay-cocos-mcp');
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(bridgePath, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');
    await writeFile(join(bridgePath, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
    await writeFile(join(bridgePath, 'browser.js'), '', 'utf8');
    await writeFile(join(bridgePath, 'server.json'), '{}', 'utf8');

    const task = createTask('open_cocos_project', '打开 Cocos 项目', '准备中');
    bindTaskProjectPath(task.id, root);
    taskStageUpdate(task.id, {
      stage: 'validating',
      status: 'running',
      progress: 90,
      message: '正在等待 Cocos MCP 连通…'
    });

    const tasks = await listEnvironmentTasksForState(state);
    const current = tasks.find((item) => item.id === task.id);
    // #6: task auto-completes despite the resolved/bound path divergence.
    assert.equal(current?.status, 'completed');
    // #5: routine reconciliation never calls a tool — so the external Cocos
    // extension's get_project_info (and its blocking modal) is never triggered.
    assert.equal(server.methods.includes('tools/call'), false);
  } finally {
    resetMcpConnection(server.baseUrl);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos onboarding keeps MCP connectivity pending when the online server belongs to another project', async () => {
  const state = buildState(buildProject());
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-mismatch-'));
  const otherRoot = await mkdtemp(join(tmpdir(), 'funplay-cocos-other-'));
  const server = await startCocosMcpProjectServer(otherRoot);
  const timestamp = new Date().toISOString();
  state.mcpPlugins = [
    {
      id: 'mcp_cocos',
      name: 'Funplay Cocos MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: server.baseUrl,
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Cocos Creator MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
  try {
    const bridgePath = join(root, 'extensions', 'funplay-cocos-mcp');
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(bridgePath, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');
    await writeFile(join(bridgePath, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
    await writeFile(join(bridgePath, 'browser.js'), '', 'utf8');
    await writeFile(join(bridgePath, 'server.json'), '{}', 'utf8');

    const diagnostics = await diagnoseEnvironment(state, {
      platform: 'cocos',
      mode: 'import',
      dimension: '2d',
      projectPath: root,
      enginePluginId: 'mcp_cocos'
    });
    const connectionCheck = diagnostics.checks.find((check) => check.id === 'bridge-connected');

    assert.equal(connectionCheck?.status, 'warning');
    assert.match(connectionCheck?.detail ?? '', /不是目标项目/);
    assert.equal(diagnostics.ready, false);
  } finally {
    resetMcpConnection(server.baseUrl);
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
});

test('cocos onboarding hides open-project action when the project is already open', async () => {
  const state = buildState(buildProject());
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-already-open-'));
  const projectPath = join(root, 'Arrow');
  const fakeCreator = join(root, 'CocosCreator');
  const previousCreator = process.env.COCOS_CREATOR_EXECUTABLE;
  let child: ChildProcess | undefined;
  const timestamp = new Date().toISOString();
  state.mcpPlugins = [
    {
      id: 'mcp_cocos_offline',
      name: 'Funplay Cocos MCP',
      kind: 'engine',
      transport: 'http',
      baseUrl: 'http://127.0.0.1:1/',
      enabled: true,
      isDefault: false,
      notes: 'Funplay built-in Cocos Creator MCP bridge.',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
  try {
    await writeCocosProjectFixture(projectPath);
    await writeFakeCocosCreator(fakeCreator);
    process.env.COCOS_CREATOR_EXECUTABLE = fakeCreator;
    child = spawn(fakeCreator, ['--project', projectPath], {
      stdio: 'ignore'
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const diagnostics = await diagnoseEnvironment(state, {
      platform: 'cocos',
      mode: 'import',
      dimension: '2d',
      projectPath,
      enginePluginId: 'mcp_cocos_offline'
    });
    const openedCheck = diagnostics.checks.find((check) => check.id === 'engine-opened');
    const connectionCheck = diagnostics.checks.find((check) => check.id === 'bridge-connected');

    assert.equal(openedCheck?.status, 'passed');
    assert.equal(openedCheck?.actions.length, 0);
    assert.equal(connectionCheck?.status, 'warning');
    assert.equal(
      connectionCheck?.actions.some((action) => action.id === 'open_cocos_project'),
      false
    );
    assert.equal(JSON.stringify(diagnostics).includes('open_cocos_project'), false);
  } finally {
    await stopChildProcess(child);
    resetMcpConnection('http://127.0.0.1:1/');
    if (typeof previousCreator === 'undefined') {
      delete process.env.COCOS_CREATOR_EXECUTABLE;
    } else {
      process.env.COCOS_CREATOR_EXECUTABLE = previousCreator;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos open-project action does not relaunch an already open project', async () => {
  environmentTasks.clear();
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-open-guard-'));
  const projectPath = join(root, 'Arrow');
  const fakeCreator = join(root, 'CocosCreator');
  const launchLog = join(root, 'cocos-launches.log');
  const project = {
    ...buildProject(projectPath),
    engine: {
      platform: 'cocos' as const,
      setupMode: 'import' as const,
      projectPath,
      dimension: '2d' as const
    }
  };
  const state = buildState(project);
  const previousCreator = process.env.COCOS_CREATOR_EXECUTABLE;
  const previousLaunchLog = process.env.FUNPLAY_FAKE_CREATOR_LOG;
  let child: ChildProcess | undefined;
  try {
    await writeCocosProjectFixture(projectPath);
    await writeFakeCocosCreator(
      fakeCreator,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "if (process.env.FUNPLAY_FAKE_CREATOR_LOG) fs.appendFileSync(process.env.FUNPLAY_FAKE_CREATOR_LOG, process.argv.slice(2).join(' ') + '\\n');",
        "if (process.env.FUNPLAY_FAKE_CREATOR_HOLD === '1') setInterval(() => undefined, 1000);",
        'else process.exit(0);',
        ''
      ].join('\n')
    );
    process.env.COCOS_CREATOR_EXECUTABLE = fakeCreator;
    process.env.FUNPLAY_FAKE_CREATOR_LOG = launchLog;
    child = spawn(fakeCreator, ['--project', projectPath], {
      stdio: 'ignore',
      env: {
        ...process.env,
        FUNPLAY_FAKE_CREATOR_HOLD: '1'
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(isCocosProjectCurrentlyOpen(projectPath), true);
    const result = await runEnvironmentAction(state, {
      actionId: 'open_cocos_project',
      platform: 'cocos',
      mode: 'import',
      dimension: '2d',
      projectPath
    });
    const task = result.taskId ? environmentTasks.get(result.taskId) : undefined;

    assert.equal(result.status, 'opened');
    assert.match(result.message, /已经打开/);
    assert.equal(task?.status, 'needs_user');
    assert.equal(task?.stage, 'waiting_manual');
    assert.equal(task?.progress, 72);
    assert.match(task?.message ?? '', /不会重复打开同一个项目/);

    const directOpen = await openCocosProject({ projectPath });
    assert.equal(directOpen.ok, true);
    assert.match(directOpen.summary, /Project already open: yes/);
    assert.match(directOpen.summary, /Skipped launch/);

    const agentOpen = await executeAgentToolAction(
      project,
      {
        type: 'open_engine_project',
        platform: 'cocos',
        projectPath
      },
      {
        appState: state
      }
    );
    assert.equal(agentOpen.ok, true);
    assert.match(agentOpen.summary, /Project open: yes/);
    assert.match(agentOpen.summary, /skipped launching another Cocos Creator instance/i);

    const launches = (await readFile(launchLog, 'utf8')).trim().split('\n');
    assert.equal(launches.length, 1);
  } finally {
    await stopChildProcess(child);
    if (typeof previousCreator === 'undefined') {
      delete process.env.COCOS_CREATOR_EXECUTABLE;
    } else {
      process.env.COCOS_CREATOR_EXECUTABLE = previousCreator;
    }
    if (typeof previousLaunchLog === 'undefined') {
      delete process.env.FUNPLAY_FAKE_CREATOR_LOG;
    } else {
      process.env.FUNPLAY_FAKE_CREATOR_LOG = previousLaunchLog;
    }
    environmentTasks.clear();
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos openProject reports launch failure when Cocos Creator crashes on launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-crash-'));
  const projectPath = join(root, 'Arrow');
  const fakeCreator = join(root, 'CocosCreator');
  const previousCreator = process.env.COCOS_CREATOR_EXECUTABLE;
  try {
    await writeCocosProjectFixture(projectPath);
    // Editor that dies immediately with a non-zero exit code.
    await writeFakeCocosCreator(fakeCreator, '#!/bin/sh\nexit 7\n');
    process.env.COCOS_CREATOR_EXECUTABLE = fakeCreator;

    const result = await openCocosProject({ projectPath, observeMs: 1500 });
    assert.equal(result.ok, false);
    assert.equal(result.isError, true);
    assert.match(result.summary, /Launch failed: .*code 7/);
  } finally {
    if (typeof previousCreator === 'undefined') {
      delete process.env.COCOS_CREATOR_EXECUTABLE;
    } else {
      process.env.COCOS_CREATOR_EXECUTABLE = previousCreator;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos openProject reports started + the manual MCP-server step when the editor launches cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-launch-'));
  const projectPath = join(root, 'Arrow');
  const fakeCreator = join(root, 'CocosCreator');
  const previousCreator = process.env.COCOS_CREATOR_EXECUTABLE;
  try {
    await writeCocosProjectFixture(projectPath);
    // Editor that hands off cleanly (exit 0) — counts as a successful launch.
    await writeFakeCocosCreator(fakeCreator, '#!/bin/sh\nexit 0\n');
    process.env.COCOS_CREATOR_EXECUTABLE = fakeCreator;

    const result = await openCocosProject({ projectPath, observeMs: 1500 });
    assert.equal(result.ok, true);
    assert.match(result.summary, /Project launch: started/);
    assert.match(result.summary, /Funplay > MCP Server/);
  } finally {
    if (typeof previousCreator === 'undefined') {
      delete process.env.COCOS_CREATOR_EXECUTABLE;
    } else {
      process.env.COCOS_CREATOR_EXECUTABLE = previousCreator;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos installBridge verifies the bridge files landed and rejects an incomplete source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-install-'));
  const projectPath = join(root, 'Arrow');
  const completeSource = join(root, 'complete-source');
  const incompleteSource = join(root, 'incomplete-source');
  const previousLocalSource = process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE;
  try {
    // A valid cocos project WITHOUT the bridge yet (so install proceeds to copy).
    await mkdir(join(projectPath, 'assets'), { recursive: true });
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');
    // Complete bridge source (all three required files).
    await mkdir(completeSource, { recursive: true });
    await writeFile(join(completeSource, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
    await writeFile(join(completeSource, 'browser.js'), '', 'utf8');
    await writeFile(join(completeSource, 'server.json'), '{}', 'utf8');
    // Incomplete source: missing browser.js and server.json.
    await mkdir(incompleteSource, { recursive: true });
    await writeFile(join(incompleteSource, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');

    // An incomplete copy is rejected by the post-install verification, not reported as success.
    process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE = incompleteSource;
    const rejected = installCocosBridge({ projectPath });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.isError, true);
    assert.match(rejected.summary, /Install incomplete/);

    // Clear the partial copy, then a complete source installs cleanly.
    await rm(join(projectPath, 'extensions', 'funplay-cocos-mcp'), { recursive: true, force: true });
    process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE = completeSource;
    const installed = installCocosBridge({ projectPath });
    assert.equal(installed.ok, true);
    assert.match(installed.summary, /installed from local source/);
  } finally {
    if (typeof previousLocalSource === 'undefined') {
      delete process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE;
    } else {
      process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE = previousLocalSource;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos openHub reports not-found when no Cocos Dashboard is discovered', () => {
  const result = openCocosDashboard({ resolveDashboard: () => undefined });
  assert.equal(result.ok, false);
  assert.equal(result.isError, true);
  assert.match(result.summary, /Cocos Dashboard executable: not found/);
});

test('cocos openHub launches the Dashboard via the .app bundle (open -a) on macOS', { skip: process.platform !== 'darwin' }, () => {
  const launched: { command: string; args: string[] } = { command: '', args: [] };
  const result = openCocosDashboard({
    resolveDashboard: () => '/Applications/CocosDashboard.app/Contents/MacOS/CocosDashboard',
    isRunning: () => false,
    launch: (command, args) => {
      launched.command = command;
      launched.args = args;
      return { ok: true, summary: `Started ${command} ${args.join(' ')}` };
    }
  });
  assert.equal(result.ok, true);
  // LaunchServices bundle launch, not a direct Mach-O exec.
  assert.equal(launched.command, 'open');
  assert.deepEqual(launched.args, ['-a', '/Applications/CocosDashboard.app']);
});

test('cocos openHub skips launch when a Dashboard is already running', () => {
  let launchCalled = false;
  const result = openCocosDashboard({
    resolveDashboard: () => '/Applications/CocosDashboard.app/Contents/MacOS/CocosDashboard',
    isRunning: () => true,
    launch: () => {
      launchCalled = true;
      return { ok: true, summary: 'started' };
    }
  });
  assert.equal(result.ok, true);
  assert.match(result.summary, /already running: skipped/i);
  assert.equal(launchCalled, false);
});

test('assembleGameTools warm-starts a cocos engine plugin from cocos:// resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-gametools-'));
  const server = await startCocosMcpProjectServer(root);
  try {
    const assembly = await assembleGameTools(server.baseUrl);
    assert.equal(assembly.available, true);
    // Project context is read from cocos://project/context (engine-agnostic suffix
    // match), proving the seeding no longer hardcodes unity:// and a Cocos agent
    // doesn't start cold.
    assert.match(assembly.projectContext ?? '', /Cocos MCP Project Context/);
    // Cocos bridge tools are recognized as preferred (shared + cocos-specific names).
    assert.ok(assembly.preferredTools.some((tool) => tool.name === 'execute_javascript'));
    assert.ok(assembly.preferredTools.some((tool) => tool.name === 'get_scene_info'));
  } finally {
    resetMcpConnection(server.baseUrl);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('run_engine_environment_action is a registered agent tool that excludes heavy software installers', () => {
  const definition = getAgentToolDefinition('run_engine_environment_action');
  assert.ok(definition);
  assert.equal(definition?.readOnly, false);
  // Project-level staged actions are accepted...
  assert.equal(definition?.inputSchema.safeParse({ actionId: 'create_cocos_project', platform: 'cocos' }).success, true);
  assert.equal(definition?.inputSchema.safeParse({ actionId: 'open_cocos_project' }).success, true);
  assert.equal(definition?.inputSchema.safeParse({ actionId: 'create_unity_project' }).success, true);
  // ...but the heavy OS-level software installers are NOT exposed to the agent.
  assert.equal(definition?.inputSchema.safeParse({ actionId: 'install_unity_editor' }).success, false);
  assert.equal(definition?.inputSchema.safeParse({ actionId: 'install_unity_hub' }).success, false);
  assert.equal(definition?.inputSchema.safeParse({ actionId: 'install_cocos_dashboard' }).success, false);
});

test('run_engine_environment_action for cocos reaches the staged runEnvironmentAction, not diagnose', async () => {
  environmentTasks.clear();
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-runaction-'));
  const projectPath = join(root, 'Arrow');
  const state = buildState(buildProject());
  try {
    await mkdir(join(projectPath, 'assets'), { recursive: true });
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({ name: 'Arrow' }), 'utf8');

    // verify_project_path is spawn-free (just inspects the project) — proves the
    // routing reaches runEnvironmentAction without launching a real editor.
    const result = await executeAgentToolAction(
      buildProject(),
      { type: 'run_engine_environment_action', actionId: 'verify_project_path', platform: 'cocos', projectPath },
      { appState: state }
    );

    // runEnvironmentAction's summarizeEnvironmentAction format, NOT the cocos
    // diagnose capability blob it was previously mis-routed into.
    assert.match(result.summary, /Action: verify_project_path/);
    assert.doesNotMatch(result.summary, /Capability: diagnose/);
    assert.match(result.summary, /项目路径校验通过/);
  } finally {
    environmentTasks.clear();
    await rm(root, { recursive: true, force: true });
  }
});

test('cocos create project task waits for real MCP connectivity before completing', async () => {
  environmentTasks.clear();
  const state = buildState(buildProject());
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-create-wait-'));
  const fakeCreator = join(root, 'CocosCreator.app', 'Contents', 'MacOS', 'CocosCreator');
  const templatePath = join(root, 'CocosCreator.app', 'Contents', 'Resources', 'templates', 'empty');
  const targetProjectPath = join(root, 'Arrow');
  const previousCreator = process.env.COCOS_CREATOR_EXECUTABLE;
  const previousLocalSource = process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE;
  try {
    await mkdir(join(fakeCreator, '..'), { recursive: true });
    await mkdir(templatePath, { recursive: true });
    await writeFile(fakeCreator, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(fakeCreator, 0o755);
    await writeFile(join(root, 'CocosCreator.app', 'Contents', 'Resources', 'templates', 'list.json'), '[]', 'utf8');
    await writeFile(join(templatePath, 'package.json'), JSON.stringify({ name: 'empty' }), 'utf8');
    await writeFile(join(templatePath, 'tsconfig.json'), '{}', 'utf8');
    const templateBridgePath = join(templatePath, 'extensions', 'funplay-cocos-mcp');
    await mkdir(templateBridgePath, { recursive: true });
    await writeFile(join(templateBridgePath, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp' }), 'utf8');
    await writeFile(join(templateBridgePath, 'browser.js'), '', 'utf8');
    await writeFile(join(templateBridgePath, 'server.json'), '{}', 'utf8');
    process.env.COCOS_CREATOR_EXECUTABLE = fakeCreator;
    // Belt-and-suspenders: if the bridge install is ever reached, copy it locally
    // instead of doing a real git clone — keeps the test fully offline/deterministic.
    process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE = templateBridgePath;

    const result = await runEnvironmentAction(state, {
      actionId: 'create_cocos_project',
      platform: 'cocos',
      mode: 'create',
      dimension: '3d',
      projectName: 'Arrow',
      projectPath: root
    });
    const task = result.taskId ? environmentTasks.get(result.taskId) : undefined;

    assert.equal(result.status, 'opened');
    assert.equal(task?.status, 'needs_user');
    assert.equal(task?.stage, 'waiting_manual');
    assert.equal(task?.progress, 92);
    assert.match(task?.message ?? '', /Funplay > MCP Server|启动 Funplay MCP Server/);

    const server = await startCocosMcpProjectServer(targetProjectPath);
    const timestamp = new Date().toISOString();
    state.mcpPlugins = [
      {
        id: 'mcp_cocos',
        name: 'Funplay Cocos MCP',
        kind: 'engine',
        transport: 'http',
        baseUrl: server.baseUrl,
        enabled: true,
        isDefault: false,
        notes: 'Funplay built-in Cocos Creator MCP bridge.',
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ];
    try {
      const tasks = await listEnvironmentTasksForState(state);
      const reconciledTask = tasks.find((item) => item.id === result.taskId);

      assert.equal(reconciledTask?.status, 'completed');
      assert.equal(reconciledTask?.stage, 'completed');
      assert.match(reconciledTask?.message ?? '', /Cocos MCP 已连通/);
    } finally {
      resetMcpConnection(server.baseUrl);
      await server.close();
    }
  } finally {
    if (typeof previousCreator === 'undefined') {
      delete process.env.COCOS_CREATOR_EXECUTABLE;
    } else {
      process.env.COCOS_CREATOR_EXECUTABLE = previousCreator;
    }
    if (typeof previousLocalSource === 'undefined') {
      delete process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE;
    } else {
      process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE = previousLocalSource;
    }
    environmentTasks.clear();
    await rm(root, { recursive: true, force: true });
  }
});
