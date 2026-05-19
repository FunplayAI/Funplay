import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProject } from './test-helpers.ts';
import { getActiveProjectSession } from '../../shared/project-sessions.ts';
import { buildGenericWorkspaceContext } from '../../electron/main/agent-platform/context.ts';
import { createClaudeCodeSdkOptions, createClaudeSdkPermissionHandler, isClaudeSideRuntimeModel, shouldUseClaudeNativeWeb } from '../../electron/main/agent-platform/claude/runtime.ts';
import { sanitizeClaudeModelOptions } from '../../electron/main/agent-platform/claude/model-options.ts';
import { normalizeAgentLifecycleHookConfig } from '../../electron/main/agent-platform/agent-hooks.ts';

test('Claude model option sanitizer handles Opus 4.7 thinking and context beta', () => {
  const opus = sanitizeClaudeModelOptions({
    model: 'claude-opus-4-7',
    context1m: true,
    effort: 'max',
    thinking: {
      type: 'enabled',
      budgetTokens: 4096
    }
  });
  assert.equal(opus.applyContext1mBeta, false);
  assert.equal(opus.effort, 'max');
  assert.deepEqual(opus.thinking, {
    type: 'adaptive',
    display: 'summarized'
  });

  const sonnet = sanitizeClaudeModelOptions({
    model: 'claude-sonnet-4-20250514',
    context1m: true,
    effort: 'auto',
    thinking: {
      type: 'enabled',
      budgetTokens: 2048
    }
  });
  assert.equal(sonnet.applyContext1mBeta, true);
  assert.equal(sonnet.effort, undefined);
  assert.deepEqual(sonnet.thinking, {
    type: 'enabled',
    budgetTokens: 2048
  });
});

test('Claude Agent SDK options mirror reference runtime boundaries', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-sdk-options-'));
  try {
    await writeFile(
      join(projectPath, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          projectServer: {
            type: 'http',
            url: 'http://127.0.0.1:8765/mcp',
            headers: {
              Authorization: 'Bearer token'
            }
          },
          stdioServer: {
            command: 'node',
            args: ['server.js'],
            env: {
              MCP_ENV: 'test'
            }
          }
        }
      }),
      'utf8'
    );
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/App.tsx');
    const baseProvider = {
      id: 'provider_anthropic',
      name: 'Anthropic',
      protocol: 'anthropic' as const,
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'secret',
      model: 'claude-sonnet-4-6',
      enabled: true,
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const params = {
      project,
      message: '修改 src/App.tsx',
      provider: baseProvider,
      plugins: [
        {
          id: 'unity',
          name: 'Unity MCP',
          kind: 'engine' as const,
          transport: 'http' as const,
          baseUrl: 'http://127.0.0.1:9000/mcp',
          enabled: true,
          isDefault: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      context: {
        ...context,
        sessionMode: 'agent' as const,
        sessionEffort: 'xhigh' as const
      },
      permission: {
        mode: 'read-only' as const,
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      checkpointSnapshotId: 'snapshot_sdk_test'
    };

    const options = createClaudeCodeSdkOptions(params, false, {
      cwd: projectPath,
      abortController: new AbortController(),
      resumeSessionId: '11111111-1111-4111-8111-111111111111'
    });

    assert.equal(options.includePartialMessages, true);
    assert.equal(options.resume, '11111111-1111-4111-8111-111111111111');
    assert.equal(options.model, 'claude-sonnet-4-6');
    assert.equal(options.effort, 'xhigh');
    assert.equal(options.permissionMode, 'dontAsk');
    assert.equal(options.enableFileCheckpointing, true);
    assert.deepEqual(options.settingSources, ['user']);
    assert.equal(isClaudeSideRuntimeModel(baseProvider), true);
    assert.equal(shouldUseClaudeNativeWeb(baseProvider), true);
    assert.equal(options.tools, undefined);
    assert.equal(options.allowedTools?.includes('Read'), true);
    assert.equal(options.allowedTools?.includes('WebSearch'), false);
    assert.equal(options.allowedTools?.includes('mcp__funplay-web__funplay_web_search'), false);
    assert.equal(options.allowedTools?.includes('mcp__funplay-media__funplay_media_attach_file'), false);
    assert.equal(options.allowedTools?.includes('mcp__funplay-image-gen__funplay_image_generate'), false);
    assert.deepEqual(options.disallowedTools, ['WebFetch', 'WebSearch']);
    assert.equal(options.env?.ANTHROPIC_API_KEY, 'secret');
    assert.equal(options.env?.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
    assert.equal(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP, 'funplay/0.1.0');
    assert.equal((options.systemPrompt as { type?: string; preset?: string; append?: string }).preset, 'claude_code');
    assert.match((options.systemPrompt as { append?: string }).append ?? '', /Claude Code runtime inside Funplay/);
    assert.match((options.systemPrompt as { append?: string }).append ?? '', /never pass pages as an empty string/);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? '', /funplay_memory_recent/);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? '', /funplay_notify/);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? '', /funplay_media_attach_file/);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? '', /funplay_image_generate/);
    assert.match((options.systemPrompt as { append?: string }).append ?? '', /AskUserQuestion/);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? '', /funplay_ask_user/);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? '', /built-in WebSearch\/WebFetch/);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? '', /fallback web research tools/);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? '', /bad_response_status_code/);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? '', /funplay_web_search/);
    assert.equal((options.mcpServers?.projectserver as { type?: string; url?: string })?.type, 'http');
    assert.equal((options.mcpServers?.projectserver as { type?: string; url?: string })?.url, 'http://127.0.0.1:8765/mcp');
    assert.equal((options.mcpServers?.stdioserver as { type?: string; command?: string })?.command, 'node');
    assert.equal((options.mcpServers?.['funplay-engine-unity'] as { type?: string; url?: string })?.url, 'http://127.0.0.1:9000/mcp');
    assert.equal(options.mcpServers?.['funplay-web'], undefined);
    assert.equal(options.mcpServers?.['funplay-memory'], undefined);
    assert.equal(options.mcpServers?.['funplay-notify'], undefined);
    assert.equal(options.mcpServers?.['funplay-media'], undefined);
    assert.equal(options.mcpServers?.['funplay-image-gen'], undefined);
    assert.equal(options.mcpServers?.['funplay-user-input'], undefined);

    const writeOptions = createClaudeCodeSdkOptions({
      ...params,
      context: {
        ...params.context,
        sessionMode: 'agent'
      },
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, true, {
      cwd: projectPath,
      abortController: new AbortController()
    });
    assert.equal(writeOptions.permissionMode, 'bypassPermissions');
    assert.equal(writeOptions.allowDangerouslySkipPermissions, true);
    assert.equal(writeOptions.tools, undefined);
    assert.equal(writeOptions.allowedTools?.includes('Bash'), false);
    assert.equal(writeOptions.allowedTools?.includes('Write'), false);
    assert.equal(writeOptions.allowedTools?.includes('mcp__funplay-workspace-write__funplay_workspace_write_file'), true);
    assert.equal(writeOptions.allowedTools?.includes('mcp__funplay-image-gen__funplay_image_generate'), false);
    assert.deepEqual(writeOptions.disallowedTools, ['WebFetch', 'WebSearch']);
    assert.ok(writeOptions.mcpServers?.['funplay-workspace-write']);
    assert.match((writeOptions.systemPrompt as { append?: string }).append ?? '', /Host-Controlled Workspace Writes/);

    const openAiProvider = {
      ...baseProvider,
      id: 'provider_openai',
      name: 'OpenAI Compat',
      protocol: 'openai-compatible' as const,
      baseUrl: 'https://example.com/v1',
      model: 'gpt-test'
    };
    const openAiOptions = createClaudeCodeSdkOptions({
      ...params,
      provider: openAiProvider
    }, false, {
      cwd: projectPath,
      abortController: new AbortController()
    });
    assert.equal(openAiOptions.model, undefined);
    assert.equal(isClaudeSideRuntimeModel(openAiProvider), false);
    assert.deepEqual(openAiOptions.settingSources, ['user']);
    assert.equal(openAiOptions.tools, undefined);
    assert.equal(openAiOptions.allowedTools?.includes('Read'), true);
    assert.equal(openAiOptions.allowedTools?.includes('WebSearch'), false);
    assert.equal(openAiOptions.allowedTools?.includes('mcp__funplay-web__funplay_web_search'), false);
    assert.deepEqual(openAiOptions.disallowedTools, ['WebFetch', 'WebSearch']);
    assert.doesNotMatch((openAiOptions.systemPrompt as { append?: string }).append ?? '', /funplay_web_search/);
    assert.equal(openAiOptions.mcpServers?.['funplay-web'], undefined);

    const webIntentParams = {
      ...params,
      message: '搜索 React 最新 release notes',
      provider: openAiProvider,
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '搜索 React 最新 release notes')
    };
    const openAiWebOptions = createClaudeCodeSdkOptions(webIntentParams, false, {
      cwd: projectPath,
      abortController: new AbortController()
    });
    assert.equal(openAiWebOptions.allowedTools?.includes('WebSearch'), false);
    assert.equal(openAiWebOptions.allowedTools?.includes('mcp__funplay-web__funplay_web_search'), true);
    assert.deepEqual(openAiWebOptions.disallowedTools, ['WebFetch', 'WebSearch']);
    assert.match((openAiWebOptions.systemPrompt as { append?: string }).append ?? '', /funplay_web_search/);
    assert.ok(openAiWebOptions.mcpServers?.['funplay-web']);
    const webMcpServer = openAiWebOptions.mcpServers?.['funplay-web'] as {
      instance?: {
        _registeredTools?: Record<string, {
          inputSchema?: {
            safeParse: (input: unknown) => { success: boolean };
          };
        }>;
      };
    } | undefined;
    const webSearchMcpSchema = webMcpServer?.instance?._registeredTools?.funplay_web_search?.inputSchema;
    assert.equal(webSearchMcpSchema?.safeParse({
      query: 'release notes',
      domains: ['react.dev', 'developer.mozilla.org', 'typescriptlang.org', 'nodejs.org', 'vite.dev', 'electronjs.org']
    }).success, true);
    const mediaOptions = createClaudeCodeSdkOptions({
      ...params,
      message: '预览素材图片并保存附件',
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '预览素材图片')
    }, false, {
      cwd: projectPath,
      abortController: new AbortController()
    });
    assert.equal(mediaOptions.allowedTools?.includes('mcp__funplay-media__funplay_media_attach_file'), true);
    assert.equal(mediaOptions.allowedTools?.includes('mcp__funplay-image-gen__funplay_image_generate'), false);
    const mediaMcpServer = mediaOptions.mcpServers?.['funplay-media'] as {
      instance?: {
        _registeredTools?: Record<string, {
          inputSchema?: {
            safeParse: (input: unknown) => { success: boolean };
          };
        }>;
      };
    } | undefined;
    const mediaAttachSchema = mediaMcpServer?.instance?._registeredTools?.funplay_media_attach_file?.inputSchema;
    assert.equal(mediaAttachSchema?.safeParse({
      file_path: 'Assets/icon.png',
      title: 'Icon'
    }).success, true);

    const imageOptions = createClaudeCodeSdkOptions({
      ...params,
      message: '生成一张透明背景软件图标',
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '生成图标')
    }, false, {
      cwd: projectPath,
      abortController: new AbortController()
    });
    assert.equal(imageOptions.allowedTools?.includes('mcp__funplay-image-gen__funplay_image_generate'), true);
    assert.ok(imageOptions.mcpServers?.['funplay-image-gen']);

    const anthropicCompatGptOptions = createClaudeCodeSdkOptions({
      ...params,
      message: '搜索 React 最新 release notes',
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '搜索 React 最新 release notes'),
      provider: {
        ...baseProvider,
        model: 'gpt-5.4-xhigh'
      }
    }, false, {
      cwd: projectPath,
      abortController: new AbortController()
    });
    assert.equal(isClaudeSideRuntimeModel({ ...baseProvider, model: 'gpt-5.4-xhigh' }), false);
    assert.equal(shouldUseClaudeNativeWeb({ ...baseProvider, model: 'gpt-5.4-xhigh' }), true);
    assert.equal(anthropicCompatGptOptions.model, undefined);
    assert.equal(anthropicCompatGptOptions.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
    assert.equal(anthropicCompatGptOptions.tools, undefined);
    assert.equal(anthropicCompatGptOptions.disallowedTools, undefined);
    assert.match((anthropicCompatGptOptions.systemPrompt as { append?: string }).append ?? '', /built-in WebSearch\/WebFetch/);
    assert.ok(anthropicCompatGptOptions.mcpServers?.['funplay-web']);

    const anthropicMappedGptOptions = createClaudeCodeSdkOptions({
      ...params,
      message: '搜索 React 最新 release notes',
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '搜索 React 最新 release notes'),
      provider: {
        ...baseProvider,
        model: 'gpt-5.4-xhigh',
        claudeCodeCompatible: true,
        claudeRoleModels: {
          default: 'gpt-5.4-xhigh',
          haiku: 'gpt-5.4-mini',
          sonnet: 'gpt-5.4-xhigh',
          opus: 'gpt-5.5'
        }
      }
    }, false, {
      cwd: projectPath,
      abortController: new AbortController()
    });
    assert.equal(shouldUseClaudeNativeWeb({
      ...baseProvider,
      model: 'gpt-5.4-xhigh',
      claudeCodeCompatible: true
    }), true);
    assert.equal(anthropicMappedGptOptions.model, 'gpt-5.4-xhigh');
    assert.equal(anthropicMappedGptOptions.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-5.4-mini');
    assert.equal(anthropicMappedGptOptions.tools, undefined);
    assert.equal(anthropicMappedGptOptions.disallowedTools, undefined);
    assert.match((anthropicMappedGptOptions.systemPrompt as { append?: string }).append ?? '', /built-in WebSearch\/WebFetch/);
    assert.ok(anthropicMappedGptOptions.mcpServers?.['funplay-web']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('Claude Agent SDK permission handler runs PreToolUse hooks before host permission', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-sdk-pretool-hook-'));
  try {
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写 src/App.tsx');
    let permissionRequested = false;
    const emittedHooks: string[] = [];
    const stages: string[] = [];
    const handler = createClaudeSdkPermissionHandler({
      project,
      message: '写 src/App.tsx',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'secret',
        model: 'claude-sonnet-4-6',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      },
      lifecycleHooks: normalizeAgentLifecycleHookConfig({
        rules: [{
          id: 'block_claude_writes',
          event: 'PreToolUse',
          matcher: 'Write',
          action: {
            type: 'block',
            message: 'Claude writes are blocked by project hook.'
          }
        }]
      }),
      requestPermission: async () => {
        permissionRequested = true;
        return 'allow';
      },
      onLifecycleHook: (hook) => emittedHooks.push(`${hook.event}:${hook.status}:${hook.ruleId}`),
      onStage: (stage) => stages.push(`${stage.target}:${stage.status}`)
    });

    const decision = await handler('Write', {
      file_path: 'src/App.tsx',
      content: 'export default function App() { return null; }'
    }, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_write',
      displayName: 'Write file'
    });

    assert.equal(decision.behavior, 'deny');
    assert.match(decision.behavior === 'deny' ? decision.message : '', /Claude writes are blocked/);
    assert.equal(permissionRequested, false);
    assert.deepEqual(emittedHooks, ['PreToolUse:blocked:block_claude_writes']);
    assert.equal(stages.some((stage) => stage.includes('hook:PreToolUse:failed')), true);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('Claude Agent SDK PreToolUse audit hooks do not bypass host permission denial', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-sdk-pretool-audit-'));
  try {
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '运行 npm test');
    let permissionRequested = false;
    const emittedHooks: string[] = [];
    const handler = createClaudeSdkPermissionHandler({
      project,
      message: '运行 npm test',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'secret',
        model: 'claude-sonnet-4-6',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context,
      permission: {
        mode: 'ask',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      lifecycleHooks: normalizeAgentLifecycleHookConfig({
        rules: [{
          id: 'audit_bash',
          event: 'PreToolUse',
          matcher: 'Bash',
          action: {
            type: 'audit',
            message: 'Bash observed before host permission.'
          }
        }]
      }),
      requestPermission: async () => {
        permissionRequested = true;
        return 'deny';
      },
      onLifecycleHook: (hook) => emittedHooks.push(`${hook.event}:${hook.status}:${hook.ruleId}`)
    });

    const decision = await handler('Bash', {
      command: 'npm test'
    }, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_bash',
      displayName: 'Run command'
    });

    assert.equal(decision.behavior, 'deny');
    assert.equal(permissionRequested, true);
    assert.deepEqual(emittedHooks, ['PreToolUse:matched:audit_bash']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
