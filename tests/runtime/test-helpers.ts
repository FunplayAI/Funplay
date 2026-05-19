import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createProjectFromInput } from '../../shared/planner.ts';
import { ensureProjectSessions } from '../../shared/project-sessions.ts';
import { createNativeWorkspaceTools } from '../../electron/main/agent-platform/native/tool-adapter.ts';
import type { McpPlugin, Project, PromptStreamEvent } from '../../shared/types.ts';

export function buildProject(projectPath?: string): Project {
  return ensureProjectSessions(
    createProjectFromInput({
      name: 'Runtime Test',
      templateId: 'generic-workspace',
      artStyle: 'test',
      pitch: 'runtime test',
      engine: {
        platform: 'web',
        setupMode: 'import',
        projectPath,
        dimension: 'unknown'
      }
    })
  );
}

export function tryRunGit(args: string[], cwd: string): boolean {
  try {
    execFileSync('git', args, {
      cwd,
      stdio: 'ignore',
      timeout: 3000
    });
    return true;
  } catch {
    return false;
  }
}

export function buildState(project: Project) {
  return {
    settings: {
      baseUrl: 'http://127.0.0.1:8765/',
      profile: 'core' as const,
      lastStatus: 'idle' as const,
      lastCreatedProjectDirectory: '~/Downloads',
      lastAssignedMcpPort: 8765
    },
    aiSettings: {
      defaultProviderId: 'provider_default',
      fallbackToLocalPlanner: true
    },
    agentSettings: {
      permissionMode: 'full-access' as const,
      runtimeStrategy: 'native' as const
    },
    providers: [
      {
        id: 'provider_default',
        name: 'Default',
        protocol: 'openai-compatible' as const,
        baseUrl: 'https://example.com',
        apiKey: 'key',
        hasStoredApiKey: true,
        model: 'gpt-default',
        enabled: true,
        isDefault: true,
        notes: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'provider_alt',
        name: 'Alt',
        protocol: 'openai-compatible' as const,
        baseUrl: 'https://example.com',
        apiKey: 'key',
        hasStoredApiKey: true,
        model: 'gpt-alt',
        enabled: true,
        isDefault: false,
        notes: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    mcpSettings: {},
    mcpPlugins: [],
    projects: [project]
  };
}

export function buildMcpPlugin(baseUrl: string): McpPlugin {
  const timestamp = new Date().toISOString();
  return {
    id: 'plugin_test_mcp',
    name: 'Test MCP',
    kind: 'engine',
    transport: 'http',
    baseUrl,
    enabled: true,
    isDefault: true,
    notes: '',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function buildStdioMcpPlugin(options: {
  stderrOnStart?: string;
  crashOnToolCall?: boolean;
} = {}): McpPlugin {
  const timestamp = new Date().toISOString();
  const script = `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    const stderrOnStart = ${JSON.stringify(options.stderrOnStart ?? '')};
    const crashOnToolCall = ${JSON.stringify(options.crashOnToolCall ?? false)};
    if (stderrOnStart) process.stderr.write(stderrOnStart + '\\n');
    function send(id, result) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
    }
    rl.on('line', (line) => {
      const message = JSON.parse(line);
      if (!message.id && message.method === 'notifications/initialized') return;
      if (message.method === 'initialize') {
        send(message.id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'Stdio Test MCP', version: '0.0.1' },
          capabilities: { tools: {}, resources: {} }
        });
        return;
      }
      if (message.method === 'tools/list') {
        send(message.id, {
          tools: [{
            name: 'stdio.echo',
            description: 'Echo through stdio',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } }
            }
          }]
        });
        return;
      }
      if (message.method === 'tools/call') {
        if (crashOnToolCall) {
          process.stderr.write('fatal tool crash\\n');
          process.exit(42);
        }
        send(message.id, {
          content: [{
            type: 'text',
            text: 'stdio:' + String(message.params?.arguments?.value ?? message.params?.name ?? '')
          }]
        });
        return;
      }
      if (message.method === 'resources/list') {
        send(message.id, {
          resources: [{ uri: 'stdio://context', name: 'Stdio Context' }]
        });
        return;
      }
      if (message.method === 'resources/read') {
        send(message.id, {
          content: [{ type: 'text', text: 'resource:' + String(message.params?.uri ?? '') }]
        });
        return;
      }
      send(message.id, {});
    });
  `;
  return {
    id: 'plugin_stdio_mcp',
    name: 'Stdio Test MCP',
    kind: 'custom',
    transport: 'stdio',
    baseUrl: '',
    command: process.execPath,
    args: ['--input-type=module', '-e', script],
    enabled: true,
    isDefault: false,
    notes: '',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export async function startSdkHttpMcpServer(transportType: 'streamable-http' | 'sse'): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const servers = new Set<McpServer>();
  const createMcp = (): McpServer => {
    const mcp = new McpServer({
      name: transportType === 'sse' ? 'SSE Test MCP' : 'Streamable Test MCP',
      version: '0.0.1'
    });
    mcp.registerTool('remote.echo', {
      description: 'Echo through SDK HTTP transport',
      inputSchema: {
        value: z.string().optional()
      }
    }, async ({ value }) => ({
      content: [{
        type: 'text',
        text: `${transportType}:${String(value ?? '')}`
      }]
    }));
    servers.add(mcp);
    return mcp;
  };

  let sseTransport: SSEServerTransport | undefined;
  let sseServer: McpServer | undefined;
  const server = createServer(async (request, response) => {
    try {
      const pathname = request.url?.split('?')[0] ?? '/';
      if (transportType === 'streamable-http') {
        if (pathname !== '/mcp' && pathname !== '/mcp/') {
          response.writeHead(404);
          response.end();
          return;
        }
        const mcp = createMcp();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
        response.on('close', () => {
          void transport.close();
          void mcp.close();
          servers.delete(mcp);
        });
        return;
      }
      if (request.method === 'GET' && (pathname === '/sse' || pathname === '/sse/')) {
        sseServer = createMcp();
        sseTransport = new SSEServerTransport('/messages', response);
        response.on('close', () => {
          if (sseServer) {
            void sseServer.close();
            servers.delete(sseServer);
            sseServer = undefined;
          }
        });
        await sseServer.connect(sseTransport);
        return;
      }
      if (request.method === 'POST' && pathname === '/messages' && sseTransport) {
        await sseTransport.handlePostMessage(request, response);
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/${transportType === 'sse' ? 'sse' : 'mcp'}`,
    close: async () => {
      await Promise.all([...servers].map((item) => item.close().catch(() => undefined)));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

export async function readJsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export function sendJsonRpc(response: ServerResponse, id: unknown, result: Record<string, unknown>): void {
  response.writeHead(200, {
    'Content-Type': 'application/json'
  });
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    id,
    result
  }));
}

export async function startTestMcpServer(options: {
  toolCallDelayMs?: number;
  elicitationOnToolCall?: boolean;
  capabilities?: Record<string, unknown>;
  toolsListByCall?: Array<Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>>;
  promptsListByCall?: Array<Array<{
    name: string;
    title?: string;
    description?: string;
    arguments?: Array<{
      name: string;
      title?: string;
      description?: string;
      required?: boolean;
    }>;
  }>>;
  resourceTemplatesListByCall?: Array<Array<{
    uriTemplate: string;
    name?: string;
    title?: string;
    description?: string;
    mimeType?: string;
  }>>;
} = {}): Promise<{
  baseUrl: string;
  requests: string[];
  getMaxActiveToolCalls: () => number;
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  let activeToolCalls = 0;
  let maxActiveToolCalls = 0;
  let toolsListCount = 0;
  let promptsListCount = 0;
  let resourceTemplatesListCount = 0;
  const server = createServer(async (request, response) => {
    try {
      const body = await readJsonRequest(request);
      const method = typeof body.method === 'string'
        ? body.method
        : typeof body.result !== 'undefined'
          ? 'client/response'
          : '';
      const id = body.id;
      const params = typeof body.params === 'object' && body.params !== null
        ? body.params as Record<string, unknown>
        : {};
      requests.push(method);

      if (method === 'notifications/initialized') {
        response.writeHead(204);
        response.end();
        return;
      }

      if (method === 'client/response') {
        const result = (body.result ?? {}) as Record<string, unknown>;
        const content = (result.content ?? {}) as Record<string, unknown>;
        sendJsonRpc(response, body.id, {
          content: [
            {
              type: 'text',
              text: `elicited:${String(content.scene ?? result.action ?? '')}`
            }
          ]
        });
        return;
      }

      if (method === 'initialize') {
        sendJsonRpc(response, id, {
          protocolVersion: '2024-11-05',
          serverInfo: {
            name: 'Test MCP',
            version: '0.0.1'
          },
          capabilities: options.capabilities ?? {}
        });
        return;
      }

      if (method === 'resources/read') {
        sendJsonRpc(response, id, {
          content: [
            {
              type: 'text',
              text: `resource:${String(params.uri ?? '')}`
            }
          ]
        });
        return;
      }

      if (method === 'resources/list') {
        sendJsonRpc(response, id, {
          resources: [
            {
              uri: 'unity://project/context',
              name: 'Project Context',
              description: 'Current Unity project context'
            }
          ]
        });
        return;
      }

      if (method === 'tools/list') {
        const defaultTools = [
          {
            name: 'unity.echo',
            description: 'Echo a value',
            inputSchema: {
              type: 'object',
              properties: {
                value: {
                  type: 'string'
                }
              }
            }
          }
        ];
        const configuredTools =
          options.toolsListByCall?.[Math.min(toolsListCount, options.toolsListByCall.length - 1)] ?? defaultTools;
        toolsListCount += 1;
        sendJsonRpc(response, id, {
          tools: configuredTools
        });
        return;
      }

      if (method === 'prompts/list') {
        const defaultPrompts = [
          {
            name: 'unity.scene_review',
            title: 'Scene Review',
            description: 'Review the active scene',
            arguments: [
              {
                name: 'scene',
                description: 'Scene name',
                required: true
              }
            ]
          }
        ];
        const configuredPrompts =
          options.promptsListByCall?.[Math.min(promptsListCount, options.promptsListByCall.length - 1)] ?? defaultPrompts;
        promptsListCount += 1;
        sendJsonRpc(response, id, {
          prompts: configuredPrompts
        });
        return;
      }

      if (method === 'prompts/get') {
        sendJsonRpc(response, id, {
          description: `prompt:${String(params.name ?? '')}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Review ${String((params.arguments as Record<string, unknown> | undefined)?.scene ?? 'scene')}`
              }
            }
          ]
        });
        return;
      }

      if (method === 'resources/templates/list') {
        const defaultTemplates = [
          {
            uriTemplate: 'unity://asset/{guid}',
            name: 'Unity Asset',
            description: 'Unity asset by GUID',
            mimeType: 'text/plain'
          }
        ];
        const configuredTemplates =
          options.resourceTemplatesListByCall?.[Math.min(resourceTemplatesListCount, options.resourceTemplatesListByCall.length - 1)] ?? defaultTemplates;
        resourceTemplatesListCount += 1;
        sendJsonRpc(response, id, {
          resourceTemplates: configuredTemplates
        });
        return;
      }

      if (method === 'completion/complete') {
        sendJsonRpc(response, id, {
          completion: {
            values: ['MainScene', 'BattleScene'],
            total: 2,
            hasMore: false
          }
        });
        return;
      }

      if (method === 'tools/call') {
        activeToolCalls += 1;
        maxActiveToolCalls = Math.max(maxActiveToolCalls, activeToolCalls);
        try {
          if (options.toolCallDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, options.toolCallDelayMs));
          }
          if (options.elicitationOnToolCall) {
            response.writeHead(200, {
              'Content-Type': 'application/json'
            });
            response.end(JSON.stringify({
              jsonrpc: '2.0',
              id: 'elicitation_request_1',
              method: 'elicitation/create',
              params: {
                message: 'Pick a scene',
                requestedSchema: {
                  type: 'object',
                  properties: {
                    scene: {
                      type: 'string',
                      enum: ['MainScene', 'BattleScene'],
                      description: 'Scene to inspect'
                    }
                  },
                  required: ['scene']
                }
              }
            }));
            return;
          }
          sendJsonRpc(response, id, {
            content: [
              {
                type: 'text',
                text: `tool:${String(params.name ?? '')}`
              }
            ]
          });
        } finally {
          activeToolCalls -= 1;
        }
        return;
      }

      response.writeHead(500, {
        'Content-Type': 'application/json'
      });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Unsupported method ${method}`
        }
      }));
    } catch (error) {
      response.writeHead(500, {
        'Content-Type': 'application/json'
      });
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : 'request failed'
      }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    getMaxActiveToolCalls: () => maxActiveToolCalls,
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

export async function executeNativeWorkspaceTool(
  tools: ReturnType<typeof createNativeWorkspaceTools>,
  toolName: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const selectedTool = tools[toolName] as unknown as {
    execute?: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>;
  };
  assert.equal(typeof selectedTool.execute, 'function');
  return await selectedTool.execute(input, {}) as Record<string, unknown>;
}

export function buildExecutionPlanProject(): Project {
  const project = buildProject();
  return {
    ...project,
    currentExecutionPlan: {
      summary: 'Run test execution plan',
      rationale: 'Ensure execute-plan stream works.',
      actions: [
        {
          id: 'action_test_plan',
          pluginKind: 'engine',
          title: 'Run test action',
          objective: 'Exercise the execute-plan path.',
          suggestedTools: [],
          inputs: [],
          operations: [],
          successCriteria: [],
          status: 'planned'
        }
      ]
    }
  };
}

export async function waitForFinalStreamEvent(executor: (dispatchEvent: (event: PromptStreamEvent) => void) => Promise<void> | void): Promise<PromptStreamEvent> {
  return new Promise<PromptStreamEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for stream completion.'));
    }, 10_000);

    void executor((event) => {
      if (event.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(event.error));
        return;
      }

      if (event.type === 'completed' || event.type === 'cancelled') {
        clearTimeout(timeout);
        resolve(event);
      }
    });
  });
}
