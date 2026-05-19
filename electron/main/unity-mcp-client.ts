import type {
  UnityMcpCallResult,
  UnityMcpCompletionResult,
  UnityMcpContentPart,
  UnityMcpPrompt,
  UnityMcpPromptArgument,
  UnityMcpPromptMessage,
  UnityMcpPromptResult,
  UnityMcpResource,
  UnityMcpResourceTemplate,
  UnityMcpServerInfo,
  UnityMcpTool,
  McpPlugin
} from '../../shared/types';
import {
  initializeMcpConnection,
  type McpConnectionConfig,
  type McpClientRequestHandler,
  McpJsonRpcError,
  postMcpJsonRpcForConfig,
  resetMcpConnection,
  runMcpInitializedOperation
} from './mcp-connection-manager';

type McpCapabilityName = 'tools' | 'resources' | 'prompts' | 'completions';
export type UnityMcpEndpoint = string | Pick<McpPlugin, 'id' | 'name' | 'transport' | 'baseUrl' | 'command' | 'args' | 'cwd' | 'env'>;

function toMcpConnectionConfig(endpoint: UnityMcpEndpoint): McpConnectionConfig {
  if (typeof endpoint === 'string') {
    return {
      transport: 'http',
      baseUrl: endpoint
    };
  }
  return {
    id: endpoint.id,
    name: endpoint.name,
    transport: endpoint.transport,
    baseUrl: endpoint.baseUrl,
    command: endpoint.command,
    args: endpoint.args,
    cwd: endpoint.cwd,
    env: endpoint.env
  };
}

function normalizeContentPart(part: Record<string, unknown>): UnityMcpContentPart {
  if (part.type === 'image') {
    return {
      type: 'image',
      data: typeof part.data === 'string' ? part.data : '',
      mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'image/png'
    };
  }

  return {
    type: 'text',
    text: typeof part.text === 'string' ? part.text : JSON.stringify(part)
  };
}

function hasServerCapability(serverInfo: UnityMcpServerInfo, capability: McpCapabilityName): boolean {
  return typeof serverInfo.capabilities[capability] === 'object' && serverInfo.capabilities[capability] !== null;
}

function isUnsupportedMcpCapability(error: unknown): boolean {
  if (error instanceof McpJsonRpcError && error.code === -32601) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported method|method not found|not implemented|unknown method/i.test(message);
}

async function listPaginatedMcpEntries(
  endpoint: UnityMcpEndpoint,
  method: string,
  resultKey: string,
  abortSignal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  const config = toMcpConnectionConfig(endpoint);
  do {
    const result = await postMcpJsonRpcForConfig<Record<string, unknown>>(config, method, cursor ? { cursor } : {}, false, abortSignal);
    const rawEntries = Array.isArray(result[resultKey]) ? result[resultKey] : [];
    for (const entry of rawEntries) {
      if (entry && typeof entry === 'object') {
        entries.push(entry as Record<string, unknown>);
      }
    }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor.trim().length > 0 ? result.nextCursor : undefined;
  } while (cursor);
  return entries;
}

async function listOptionalMcpEntries(
  endpoint: UnityMcpEndpoint,
  method: string,
  resultKey: string,
  capability: McpCapabilityName,
  abortSignal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  const serverInfo = await initializeUnityMcp(endpoint, abortSignal);
  if (!hasServerCapability(serverInfo, capability)) {
    return [];
  }
  try {
    return await listPaginatedMcpEntries(endpoint, method, resultKey, abortSignal);
  } catch (error) {
    if (isUnsupportedMcpCapability(error)) {
      return [];
    }
    throw error;
  }
}

function normalizeCallResult(result: unknown): UnityMcpCallResult {
  const dictionary = (result ?? {}) as Record<string, unknown>;
  const rawContent = Array.isArray(dictionary.content)
    ? dictionary.content
    : Array.isArray(dictionary.contents)
      ? dictionary.contents
      : [];
  const content = rawContent.map((part) => {
    const entry = (part ?? {}) as Record<string, unknown>;
    if (typeof entry.text === 'string' && !entry.type) {
      return {
        type: 'text' as const,
        text: entry.text
      };
    }
    return normalizeContentPart(entry);
  });

  return {
    content,
    raw: result
  };
}

export async function initializeUnityMcp(endpoint: UnityMcpEndpoint, abortSignal?: AbortSignal): Promise<UnityMcpServerInfo> {
  return initializeMcpConnection(toMcpConnectionConfig(endpoint), { abortSignal });
}

export async function listUnityTools(endpoint: UnityMcpEndpoint, abortSignal?: AbortSignal): Promise<UnityMcpTool[]> {
  const config = toMcpConnectionConfig(endpoint);
  const tools = await runMcpInitializedOperation(config, abortSignal, () =>
    listPaginatedMcpEntries(endpoint, 'tools/list', 'tools', abortSignal)
  );
  return tools.map((tool) => {
    const entry = tool;
    return {
      name: typeof entry.name === 'string' ? entry.name : 'unknown_tool',
      description: typeof entry.description === 'string' ? entry.description : '',
      inputSchema: (entry.inputSchema ?? entry.input_schema ?? {}) as Record<string, unknown>
    };
  });
}

export async function callUnityTool(
  endpoint: UnityMcpEndpoint,
  toolName: string,
  args: Record<string, unknown> = {},
  abortSignal?: AbortSignal,
  clientRequestHandler?: McpClientRequestHandler
): Promise<UnityMcpCallResult> {
  const config = toMcpConnectionConfig(endpoint);
  await initializeUnityMcp(endpoint, abortSignal);
  try {
    const result = await postMcpJsonRpcForConfig<Record<string, unknown>>(config, 'tools/call', {
      name: toolName,
      arguments: args
    }, false, abortSignal, undefined, clientRequestHandler);
    return normalizeCallResult(result);
  } catch (error) {
    resetMcpConnection(config);
    throw error;
  }
}

export async function listUnityResources(endpoint: UnityMcpEndpoint, abortSignal?: AbortSignal): Promise<UnityMcpResource[]> {
  const config = toMcpConnectionConfig(endpoint);
  const resources = await runMcpInitializedOperation(config, abortSignal, () =>
    listPaginatedMcpEntries(endpoint, 'resources/list', 'resources', abortSignal)
  );
  return resources.map((resource) => {
    const entry = resource;
    return {
      uri: typeof entry.uri === 'string' ? entry.uri : '',
      name: typeof entry.name === 'string' ? entry.name : undefined,
      title: typeof entry.title === 'string' ? entry.title : undefined,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : undefined
    };
  });
}

export async function readUnityResource(endpoint: UnityMcpEndpoint, uri: string, abortSignal?: AbortSignal): Promise<UnityMcpCallResult> {
  const config = toMcpConnectionConfig(endpoint);
  const result = await runMcpInitializedOperation(config, abortSignal, () =>
    postMcpJsonRpcForConfig<Record<string, unknown>>(config, 'resources/read', {
      uri
    }, false, abortSignal)
  );
  return normalizeCallResult(result);
}

function normalizePromptArgument(argument: Record<string, unknown>): UnityMcpPromptArgument {
  return {
    name: typeof argument.name === 'string' ? argument.name : 'argument',
    title: typeof argument.title === 'string' ? argument.title : undefined,
    description: typeof argument.description === 'string' ? argument.description : undefined,
    required: typeof argument.required === 'boolean' ? argument.required : undefined
  };
}

export async function listUnityPrompts(endpoint: UnityMcpEndpoint, abortSignal?: AbortSignal): Promise<UnityMcpPrompt[]> {
  const config = toMcpConnectionConfig(endpoint);
  const prompts = await runMcpInitializedOperation(config, abortSignal, () =>
    listOptionalMcpEntries(endpoint, 'prompts/list', 'prompts', 'prompts', abortSignal)
  );
  return prompts.map((prompt) => {
    const rawArguments = Array.isArray(prompt.arguments) ? prompt.arguments : [];
    return {
      name: typeof prompt.name === 'string' ? prompt.name : 'unknown_prompt',
      title: typeof prompt.title === 'string' ? prompt.title : undefined,
      description: typeof prompt.description === 'string' ? prompt.description : undefined,
      arguments: rawArguments
        .filter((argument): argument is Record<string, unknown> => Boolean(argument && typeof argument === 'object'))
        .map(normalizePromptArgument)
    };
  });
}

export async function getUnityPrompt(
  endpoint: UnityMcpEndpoint,
  name: string,
  args: Record<string, unknown> = {},
  abortSignal?: AbortSignal
): Promise<UnityMcpPromptResult> {
  const config = toMcpConnectionConfig(endpoint);
  const result = await runMcpInitializedOperation(config, abortSignal, () =>
    postMcpJsonRpcForConfig<Record<string, unknown>>(config, 'prompts/get', {
      name,
      arguments: args
    }, false, abortSignal)
  );
  const rawMessages = Array.isArray(result.messages) ? result.messages : [];
  const messages: UnityMcpPromptMessage[] = rawMessages
    .filter((message): message is Record<string, unknown> => Boolean(message && typeof message === 'object'))
    .map((message) => ({
      role: typeof message.role === 'string' ? message.role : 'user',
      content: normalizeContentPart((message.content ?? {}) as Record<string, unknown>)
    }));
  return {
    description: typeof result.description === 'string' ? result.description : undefined,
    messages,
    raw: result
  };
}

export async function listUnityResourceTemplates(endpoint: UnityMcpEndpoint, abortSignal?: AbortSignal): Promise<UnityMcpResourceTemplate[]> {
  const config = toMcpConnectionConfig(endpoint);
  const templates = await runMcpInitializedOperation(config, abortSignal, () =>
    listOptionalMcpEntries(endpoint, 'resources/templates/list', 'resourceTemplates', 'resources', abortSignal)
  );
  return templates.map((template) => ({
    uriTemplate: typeof template.uriTemplate === 'string' ? template.uriTemplate : '',
    name: typeof template.name === 'string' ? template.name : undefined,
    title: typeof template.title === 'string' ? template.title : undefined,
    description: typeof template.description === 'string' ? template.description : undefined,
    mimeType: typeof template.mimeType === 'string' ? template.mimeType : undefined,
    annotations: template.annotations && typeof template.annotations === 'object'
      ? template.annotations as Record<string, unknown>
      : undefined
  }));
}

export async function completeUnityMcpArgument(
  endpoint: UnityMcpEndpoint,
  ref: Record<string, unknown>,
  argumentName: string,
  value: string,
  context: Record<string, unknown> = {},
  abortSignal?: AbortSignal
): Promise<UnityMcpCompletionResult> {
  const config = toMcpConnectionConfig(endpoint);
  const serverInfo = await initializeUnityMcp(endpoint, abortSignal);
  if (!hasServerCapability(serverInfo, 'completions')) {
    return {
      values: [],
      raw: {}
    };
  }
  const result = await runMcpInitializedOperation(config, abortSignal, () =>
    postMcpJsonRpcForConfig<Record<string, unknown>>(config, 'completion/complete', {
      ref,
      argument: {
        name: argumentName,
        value
      },
      ...(Object.keys(context).length > 0 ? { context } : {})
    }, false, abortSignal)
  );
  const completion = (result.completion ?? {}) as Record<string, unknown>;
  return {
    values: Array.isArray(completion.values) ? completion.values.filter((item): item is string => typeof item === 'string') : [],
    total: typeof completion.total === 'number' ? completion.total : undefined,
    hasMore: typeof completion.hasMore === 'boolean' ? completion.hasMore : undefined,
    raw: result
  };
}
