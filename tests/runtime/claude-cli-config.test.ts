import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProject } from './test-helpers.ts';
import { getActiveProjectSession, replaceProjectSession } from '../../shared/project-sessions.ts';
import { buildGenericWorkspaceContext } from '../../electron/main/agent-platform/context.ts';
import {
  buildClaudeCodeCliEnv,
  buildClaudeCodeSdkEnv,
  classifyClaudeRuntimeError,
  createClaudeCodeCliArgs,
  isClaudeSideRuntimeModel,
  redactClaudeRuntimeErrorDetail,
  resolveClaudeCodeProvider,
  resolveClaudeContextWindowTokens,
  shouldUseClaudeNativeWeb
} from '../../electron/main/agent-platform/claude/runtime.ts';
import { resolveNativeContextWindowTokens } from '../../electron/main/agent-platform/native/context-handoff.ts';
import { classifyNativeRuntimeError, redactNativeRuntimeErrorDetail } from '../../electron/main/agent-platform/native/diagnostics.ts';
import { materializeNativeProvider, resolveProviderForRuntime, toNativeProviderConfig } from '../../electron/main/agent-platform/provider-resolver.ts';

test('Claude Code CLI args resume sessions and only pass Anthropic models', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-args-'));
  try {
    await writeFile(join(projectPath, 'AGENTS.md'), '# Agent Rules\n\nAlways run focused checks.', 'utf8');
    let project = buildProject(projectPath);
    const activeSession = getActiveProjectSession(project);
    project = replaceProjectSession(project, {
      ...activeSession,
      runtimeOverrides: {
        runtimeId: 'claude-code-sdk',
        effort: 'xhigh',
        claudeCodeSessionId: '11111111-1111-4111-8111-111111111111',
        claudeCodeSessionCwd: projectPath
      }
    });
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 `src/App.tsx`');
    const params = {
      project,
      message: '继续修改 src/App.tsx',
      provider: {
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
      },
      plugins: [],
      context,
      permission: {
        mode: 'read-only' as const,
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    };

    const args = createClaudeCodeCliArgs(params, false, {
      resumeSessionId: '11111111-1111-4111-8111-111111111111'
    });
    assert.equal(args.includes('--include-partial-messages'), true);
    assert.equal(args.includes('--resume'), true);
    assert.equal(args[args.indexOf('--resume') + 1], '11111111-1111-4111-8111-111111111111');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6');
    assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Task,Read,Glob,Grep,LS,TodoWrite,AskUserQuestion');
    assert.equal(args.includes('--disallowedTools'), false);
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /never pass pages as an empty string/);
    assert.doesNotMatch(args[args.indexOf('--append-system-prompt') + 1], /built-in WebSearch\/WebFetch/);
    assert.doesNotMatch(args[args.indexOf('--append-system-prompt') + 1], /fallback web research tools/);
    assert.doesNotMatch(args[args.indexOf('--append-system-prompt') + 1], /funplay_web_search/);
    assert.match(args.at(-1) ?? '', /Always run focused checks/);
    assert.doesNotMatch(args.at(-1) ?? '', /Recent conversation turns/);

    const webArgs = createClaudeCodeCliArgs({
      ...params,
      message: '搜索 React 最新文档并总结',
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '搜索 React 最新文档')
    }, false);
    assert.equal(webArgs[webArgs.indexOf('--allowedTools') + 1], 'Task,Read,Glob,Grep,LS,TodoWrite,AskUserQuestion,WebFetch,WebSearch');
    assert.match(webArgs[webArgs.indexOf('--append-system-prompt') + 1], /built-in WebSearch\/WebFetch/);

    const openAiArgs = createClaudeCodeCliArgs({
      ...params,
      provider: {
        ...params.provider,
        id: 'provider_openai',
        name: 'OpenAI Compat',
        protocol: 'openai-compatible',
        baseUrl: 'https://example.com/v1',
        model: 'gpt-test'
      }
    }, false);
    assert.equal(openAiArgs.includes('--model'), false);
    assert.equal(openAiArgs[openAiArgs.indexOf('--allowedTools') + 1], 'Task,Read,Glob,Grep,LS,TodoWrite,AskUserQuestion');
    assert.equal(openAiArgs[openAiArgs.indexOf('--disallowedTools') + 1], 'WebFetch,WebSearch');
    assert.doesNotMatch(openAiArgs[openAiArgs.indexOf('--append-system-prompt') + 1], /funplay_web_search/);

    const anthropicCompatGptArgs = createClaudeCodeCliArgs({
      ...params,
      provider: {
        ...params.provider,
        model: 'gpt-5.4-xhigh'
      }
    }, false);
    assert.equal(isClaudeSideRuntimeModel({ ...params.provider, model: 'gpt-5.4-xhigh' }), false);
    assert.equal(shouldUseClaudeNativeWeb({ ...params.provider, model: 'gpt-5.4-xhigh' }), true);
    assert.equal(anthropicCompatGptArgs.includes('--model'), false);
    assert.equal(anthropicCompatGptArgs[anthropicCompatGptArgs.indexOf('--allowedTools') + 1], 'Task,Read,Glob,Grep,LS,TodoWrite,AskUserQuestion');
    assert.equal(anthropicCompatGptArgs.includes('--disallowedTools'), false);
    assert.doesNotMatch(anthropicCompatGptArgs[anthropicCompatGptArgs.indexOf('--append-system-prompt') + 1], /built-in WebSearch\/WebFetch/);
    assert.doesNotMatch(anthropicCompatGptArgs[anthropicCompatGptArgs.indexOf('--append-system-prompt') + 1], /funplay_web_search/);

    const anthropicMappedGptArgs = createClaudeCodeCliArgs({
      ...params,
      provider: {
        ...params.provider,
        model: 'gpt-5.4-xhigh',
        claudeCodeCompatible: true,
        claudeRoleModels: {
          default: 'gpt-5.4-xhigh',
          haiku: 'gpt-5.4-mini',
          sonnet: 'gpt-5.4-xhigh',
          opus: 'gpt-5.5'
        }
      }
    }, false);
    assert.equal(shouldUseClaudeNativeWeb({ ...params.provider, model: 'gpt-5.4-xhigh', claudeCodeCompatible: true }), true);
    assert.equal(anthropicMappedGptArgs[anthropicMappedGptArgs.indexOf('--model') + 1], 'gpt-5.4-xhigh');
    assert.equal(anthropicMappedGptArgs[anthropicMappedGptArgs.indexOf('--allowedTools') + 1], 'Task,Read,Glob,Grep,LS,TodoWrite,AskUserQuestion');
    assert.equal(anthropicMappedGptArgs.includes('--disallowedTools'), false);
    assert.doesNotMatch(anthropicMappedGptArgs[anthropicMappedGptArgs.indexOf('--append-system-prompt') + 1], /built-in WebSearch\/WebFetch/);
    assert.doesNotMatch(anthropicMappedGptArgs[anthropicMappedGptArgs.indexOf('--append-system-prompt') + 1], /funplay_web_search/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('Claude Code CLI env injects only Anthropic provider credentials', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'old-key',
    ANTHROPIC_BASE_URL: 'https://old.example/v1',
    ANTHROPIC_EXPERIMENTAL_AUTH: 'old-experimental-auth'
  };
  const anthropicEnv = buildClaudeCodeCliEnv({
    id: 'provider_anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'new-key',
    model: 'claude-opus-4-1',
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, baseEnv);

  assert.equal(anthropicEnv.ANTHROPIC_API_KEY, 'new-key');
  assert.equal(anthropicEnv.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(anthropicEnv.ANTHROPIC_EXPERIMENTAL_AUTH, undefined);
  assert.equal(anthropicEnv.ANTHROPIC_MODEL, 'claude-opus-4-1');
  assert.equal(anthropicEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-opus-4-1');
  assert.equal(anthropicEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-opus-4-1');
  assert.equal(anthropicEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-1');
  assert.equal(anthropicEnv.ANTHROPIC_SMALL_FAST_MODEL, 'claude-opus-4-1');
  assert.equal(anthropicEnv.ANTHROPIC_REASONING_MODEL, 'claude-opus-4-1');
  assert.equal(anthropicEnv.PATH, '/usr/bin');

  const openAiEnv = buildClaudeCodeCliEnv({
    id: 'provider_openai',
    name: 'OpenAI Compat',
    protocol: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'openai-key',
    model: 'gpt-test',
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, baseEnv);
  assert.equal(openAiEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(openAiEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(openAiEnv.ANTHROPIC_EXPERIMENTAL_AUTH, undefined);
  assert.equal(openAiEnv.ANTHROPIC_MODEL, undefined);

  const mappedEnv = buildClaudeCodeCliEnv({
    id: 'provider_anthropic_mapped',
    name: 'Mapped Anthropic Compat',
    protocol: 'anthropic',
    baseUrl: 'https://gateway.example/anthropic',
    apiKey: 'mapped-key',
    model: 'gpt-5.4-xhigh',
    claudeCodeCompatible: true,
    claudeRoleModels: {
      default: 'gpt-5.4-xhigh',
      haiku: 'gpt-5.4-mini',
      sonnet: 'gpt-5.4-xhigh',
      opus: 'gpt-5.5',
      small: 'gpt-5.4-mini',
      reasoning: 'gpt-5.4-xhigh'
    },
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, baseEnv);
  assert.equal(mappedEnv.ANTHROPIC_MODEL, 'gpt-5.4-xhigh');
  assert.equal(mappedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-5.4-mini');
  assert.equal(mappedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'gpt-5.4-xhigh');
  assert.equal(mappedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'gpt-5.5');
  assert.equal(mappedEnv.ANTHROPIC_SMALL_FAST_MODEL, 'gpt-5.4-mini');
  assert.equal(mappedEnv.ANTHROPIC_REASONING_MODEL, 'gpt-5.4-xhigh');

  const backfilledEnv = buildClaudeCodeCliEnv({
    id: 'provider_anthropic_backfilled',
    name: 'Backfilled Anthropic Compat',
    protocol: 'anthropic',
    baseUrl: 'https://gateway.example/anthropic',
    apiKey: 'mapped-key',
    model: 'gpt-5.4-xhigh',
    claudeCodeCompatible: true,
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, baseEnv);
  assert.equal(backfilledEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-5.4-xhigh');
  assert.equal(backfilledEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'gpt-5.4-xhigh');
  assert.equal(backfilledEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'gpt-5.4-xhigh');
});

test('Claude Code provider resolver exposes one runtime diagnostic view', () => {
  const anthropicProvider = {
    id: 'provider_anthropic',
    name: 'Anthropic',
    protocol: 'anthropic' as const,
    baseUrl: 'https://api.anthropic.com/',
    apiKey: 'secret',
    model: 'claude-opus-4-7',
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const resolved = resolveClaudeCodeProvider(anthropicProvider);
  assert.equal(resolved.canUseClaudeCode, true);
  assert.equal(resolved.injectAnthropicEnv, true);
  assert.equal(resolved.useShadowHome, true);
  assert.deepEqual(resolved.settingSources, ['user']);
  assert.equal(resolved.baseUrl, 'https://api.anthropic.com');
  assert.equal(resolved.model, 'claude-opus-4-7');
  assert.equal(resolved.diagnostic.hasApiKey, true);
  assert.equal(resolveClaudeContextWindowTokens(anthropicProvider), 1_000_000);

  const openAiResolved = resolveClaudeCodeProvider({
    ...anthropicProvider,
    id: 'provider_openai',
    protocol: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    model: 'gpt-test'
  });
  assert.equal(openAiResolved.canUseClaudeCode, false);
  assert.equal(openAiResolved.injectAnthropicEnv, false);
  assert.deepEqual(openAiResolved.settingSources, ['user']);
});

test('Claude SDK env builder handles auth-token and env-only providers without leaking managed env', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'old-key',
    ANTHROPIC_AUTH_TOKEN: 'old-token',
    AWS_REGION: 'old-region',
    AWS_SECRET_ACCESS_KEY: 'old-secret'
  };
  const tokenEnv = buildClaudeCodeSdkEnv({
    id: 'provider_token',
    name: 'Token Proxy',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://proxy.example/anthropic',
    apiKey: 'new-token',
    model: 'sonnet',
    sdkProxyOnly: true,
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, baseEnv);
  assert.equal(tokenEnv.ANTHROPIC_AUTH_TOKEN, 'new-token');
  assert.equal(tokenEnv.ANTHROPIC_API_KEY, '');
  assert.equal(tokenEnv.ANTHROPIC_BASE_URL, 'https://proxy.example/anthropic');
  assert.equal(tokenEnv.AWS_SECRET_ACCESS_KEY, undefined);

  const bedrockEnv = buildClaudeCodeSdkEnv({
    id: 'provider_bedrock',
    name: 'Bedrock',
    protocol: 'bedrock',
    authStyle: 'env_only',
    baseUrl: '',
    apiKey: '',
    model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    envOverrides: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1'
    },
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, baseEnv);
  assert.equal(bedrockEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(bedrockEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(bedrockEnv.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(bedrockEnv.AWS_REGION, 'us-east-1');
  assert.equal(bedrockEnv.AWS_SECRET_ACCESS_KEY, undefined);
});

test('Native provider config uses upstream model and rejects SDK-only routes', () => {
  const resolved = resolveProviderForRuntime({
    explicitProvider: {
      id: 'provider_native_upstream',
      name: 'Anthropic Alias',
      protocol: 'anthropic',
      authStyle: 'auth_token',
      baseUrl: 'https://proxy.example/anthropic',
      apiKey: 'token',
      model: 'sonnet',
      upstreamModel: 'claude-sonnet-4-20250514',
      headers: {
        'x-provider-routing': 'funplay'
      },
      enabled: true,
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  });
  const nativeConfig = toNativeProviderConfig(resolved);
  assert.equal(nativeConfig.canUseNative, true);
  assert.equal(nativeConfig.authToken, 'token');
  assert.equal(nativeConfig.upstreamModel, 'claude-sonnet-4-20250514');
  assert.equal(nativeConfig.headers['x-provider-routing'], 'funplay');

  const materialized = materializeNativeProvider(resolved.provider!);
  assert.equal(materialized.model, 'claude-sonnet-4-20250514');
  assert.equal(materialized.authStyle, 'auth_token');
  assert.equal(materialized.apiKey, 'token');

  const sdkOnly = toNativeProviderConfig(resolveProviderForRuntime({
    explicitProvider: {
      ...resolved.provider!,
      id: 'provider_sdk_only',
      sdkProxyOnly: true
    }
  }));
  assert.equal(sdkOnly.canUseNative, false);
  assert.match(sdkOnly.nativeUnsupportedReason ?? '', /sdkProxyOnly/);
});

test('Native provider config supports Bedrock and Vertex env-only providers', () => {
  const timestamp = new Date().toISOString();
  const bedrock = toNativeProviderConfig(resolveProviderForRuntime({
    explicitProvider: {
      id: 'provider_bedrock_native',
      name: 'Bedrock Native',
      protocol: 'bedrock',
      authStyle: 'env_only',
      baseUrl: '',
      apiKey: '',
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      envOverrides: {
        AWS_REGION: 'us-east-1'
      },
      enabled: true,
      isDefault: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  }));
  assert.equal(bedrock.canUseNative, true);
  assert.equal(bedrock.hasCredentials, true);
  assert.equal(bedrock.apiKey, undefined);

  const vertex = toNativeProviderConfig(resolveProviderForRuntime({
    explicitProvider: {
      id: 'provider_vertex_native',
      name: 'Vertex Native',
      protocol: 'vertex',
      authStyle: 'env_only',
      baseUrl: '',
      apiKey: '',
      model: 'claude-3-5-sonnet-v2@20241022',
      envOverrides: {
        GOOGLE_VERTEX_PROJECT: 'funplay-test',
        GOOGLE_VERTEX_LOCATION: 'us-central1'
      },
      enabled: true,
      isDefault: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  }));
  assert.equal(vertex.canUseNative, true);
  assert.equal(vertex.hasCredentials, true);
  assert.equal(vertex.apiKey, undefined);
});

test('native context window resolves catalog and Opus 4.7 one million token defaults', () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const activeSession = getActiveProjectSession(project);
  assert.equal(resolveNativeContextWindowTokens({
    id: 'provider_opus',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'key',
    model: 'claude-opus-4-7',
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, activeSession), 1_000_000);
});

test('provider context window override takes precedence for Native and Claude context sizing', () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const activeSession = getActiveProjectSession(project);
  const provider = {
    id: 'provider_context_override',
    name: 'Custom Context Provider',
    protocol: 'openai-compatible' as const,
    baseUrl: 'https://example.test/v1',
    apiKey: 'key',
    model: 'custom-large-context',
    contextWindowTokens: 262_144,
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  assert.equal(resolveNativeContextWindowTokens(provider, activeSession), 262_144);
  assert.equal(resolveClaudeContextWindowTokens(provider), 262_144);
});

test('native runtime diagnostics classify errors and redact secrets', () => {
  const provider = {
    id: 'provider_secret',
    name: 'Secret Provider',
    protocol: 'openai-compatible' as const,
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test-secret-value',
    model: 'model-x',
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const raw = '401 unauthorized api_key=sk-test-secret-value Authorization: Bearer sk-test-secret-value';
  const redacted = redactNativeRuntimeErrorDetail(raw, provider);
  assert.equal(redacted.includes('sk-test-secret-value'), false);
  assert.match(redacted, /api_key=\[redacted\]/);

  const diagnostic = classifyNativeRuntimeError({
    error: new Error(raw),
    provider
  });
  assert.equal(diagnostic.code, 'native_auth_failed');
  assert.equal(diagnostic.detail?.includes('sk-test-secret-value'), false);

  const contextDiagnostic = classifyNativeRuntimeError({
    error: new Error('maximum context length exceeded'),
    provider
  });
  assert.equal(contextDiagnostic.code, 'native_context_too_long');

  const fetchReset = new TypeError('fetch failed') as Error & { cause?: unknown };
  fetchReset.cause = {
    code: 'ECONNRESET',
    message: 'Client network socket disconnected before secure TLS connection was established'
  };
  const networkDiagnostic = classifyNativeRuntimeError({
    error: fetchReset,
    provider
  });
  assert.equal(networkDiagnostic.code, 'native_network_error');
  assert.match(networkDiagnostic.summary, /临时中断/);
});
