import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { type AppState, type ChatMessage } from '../../shared/types.ts';
import { ensureProjectSessions, getActiveProjectSession, replaceProjectSession } from '../../shared/project-sessions.ts';
import { buildGenericWorkspaceContext } from '../../electron/main/agent-platform/context.ts';
import {
  applyClaudeAssistantEvent,
  applyClaudeStreamEvent,
  applyClaudeUserEvent,
  buildClaudeContextSummaryForSession,
  buildClaudeContextSummaryForSessionWithProvider,
  classifyClaudeRuntimeError,
  collectClaudeCodeExecutableCandidates,
  createClaudeRuntimeState,
  filterClaudeMessagesAfterSummaryBoundary,
  normalizeClaudeHistoryMessageContent,
  redactClaudeRuntimeErrorDetail,
  resetClaudeContextCompressionState,
  resolveClaudeMcpProfile
} from '../../electron/main/agent-platform/claude/runtime.ts';
import {
  createClaudeStreamCollector,
  resolveClaudeCollectorFinalText
} from '../../electron/main/agent-platform/claude/stream-collector.ts';
import {
  exportRuntimeDiagnostics,
  repairRuntimeDoctor,
  runRuntimeDoctor
} from '../../electron/main/runtime-doctor-service.ts';
import { buildProject, buildState } from './test-helpers.ts';

test('Claude runtime error classifier returns actionable diagnostic codes', () => {
  const provider = {
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

  assert.equal(classifyClaudeRuntimeError({ error: new Error('spawn claude ENOENT'), provider }).code, 'claude_cli_missing');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('401 unauthorized invalid API key'), provider }).code, 'claude_auth_failed');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('model not found: claude-missing'), provider }).code, 'claude_model_invalid');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('fetch failed ENOTFOUND api.example.test'), provider }).code, 'claude_base_url_invalid');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('unsupported feature: context1m'), provider }).code, 'claude_unsupported_feature');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('ANTHROPIC_AUTH_TOKEN from ~/.claude/settings.json overrode provider'), provider }).code, 'claude_provider_env_polluted');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('no conversation found for resume session'), provider }).code, 'claude_stale_session');
  assert.equal(classifyClaudeRuntimeError({ finalEvent: { type: 'result', is_error: true, result: 'prompt too long for maximum context' }, provider }).code, 'claude_context_too_long');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('ToolTimeout after 600 seconds'), provider }).code, 'claude_tool_timeout');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('write_permission_denied'), provider }).code, 'claude_permission_rejected');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('429 rate_limit_error: too many requests'), provider }).code, 'claude_rate_limited');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('Git Bash required: cannot find bash.exe'), provider }).code, 'claude_git_bash_missing');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('unknown option --unsupported-sdk-flag'), provider }).code, 'claude_cli_version_unsupported');
  assert.equal(classifyClaudeRuntimeError({ error: new Error('x-api-key cannot be used with bearer authorization'), provider }).code, 'claude_auth_style_mismatch');
});

test('Claude runtime diagnostics redact provider secrets', () => {
  const provider = {
    id: 'provider_anthropic',
    name: 'Anthropic',
    protocol: 'anthropic' as const,
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-secret-value',
    model: 'claude-sonnet-4-6',
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const redacted = redactClaudeRuntimeErrorDetail(
    'Authorization: Bearer abc123xyz\nx-api-key: sk-ant-secret-value\nANTHROPIC_API_KEY=sk-ant-secret-value',
    provider
  );
  assert.doesNotMatch(redacted, /sk-ant-secret-value|abc123xyz/);
  assert.match(redacted, /\[redacted\]/);
});

test('runtime doctor reports resolver/env probes, repairs state, and exports redacted diagnostics', async () => {
  let project = buildProject('/tmp/funplay-doctor-current');
  const activeSession = getActiveProjectSession(project);
  project = replaceProjectSession(project, {
    ...activeSession,
    runtimeOverrides: {
      runtimeId: 'claude-code-sdk',
      claudeCodeSessionId: 'stale-session',
      claudeCodeSessionCwd: '/tmp/funplay-doctor-old'
    }
  });
  const state = buildState(project) as AppState;
  state.providers.push({
    id: 'provider_anthropic_doctor',
    name: 'Anthropic Doctor',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-doctor-secret',
    hasStoredApiKey: true,
    model: 'claude-opus-4-7',
    enabled: true,
    isDefault: false,
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const doctor = await runRuntimeDoctor(state, {
    providerId: 'provider_anthropic_doctor',
    projectId: project.id
  });
  assert.equal(doctor.providerId, 'provider_anthropic_doctor');
  assert.ok(doctor.probes.some((probe) => probe.id === 'sdk-env'));
  assert.ok(doctor.probes.some((probe) => probe.id === 'auth'));
  assert.ok(doctor.probes.some((probe) => probe.id === 'network'));
  assert.ok(doctor.probes.some((probe) => probe.id === 'context-session'));
  assert.ok(doctor.probes.some((probe) => probe.findings.some((finding) => finding.code === 'auth_secret_ready')));
  assert.ok(doctor.repairs.some((repair) => repair.id === 'clear-stale-claude-session'));

  const repair = repairRuntimeDoctor(state, {
    actionId: 'clear-stale-claude-session',
    projectId: project.id
  });
  assert.equal(repair.stateChanged, true);
  const repairedSession = getActiveProjectSession(ensureProjectSessions(state.projects[0]));
  assert.equal(repairedSession.runtimeOverrides?.claudeCodeSessionId, undefined);

  repairRuntimeDoctor(state, {
    actionId: 'switch-auth-style-auth-token',
    providerId: 'provider_anthropic_doctor'
  });
  assert.equal(state.providers.find((provider) => provider.id === 'provider_anthropic_doctor')?.authStyle, 'auth_token');

  const exported = await exportRuntimeDiagnostics(state, {
    providerId: 'provider_anthropic_doctor',
    projectId: project.id
  });
  assert.doesNotMatch(exported, /sk-ant-doctor-secret/);
  assert.match(exported, /provider_anthropic_doctor/);
});

test('Claude CLI executable candidates prioritize explicit env path and keep fallback', () => {
  const candidates = collectClaudeCodeExecutableCandidates({
    PATH: '',
    HOME: tmpdir(),
    FUNPLAY_CLAUDE_CODE_CLI_PATH: '/tmp/funplay-missing-claude'
  });

  assert.equal(candidates[0]?.source, 'env');
  assert.equal(candidates[0]?.path, '/tmp/funplay-missing-claude');
  assert.ok(candidates.some((candidate) => candidate.source === 'fallback' && candidate.path === 'claude'));
});

test('Claude Code stream parser handles user tool_result events', () => {
  const state = createClaudeRuntimeState();
  const toolUses: Array<{
    toolUseId: string;
    name: string;
    status?: string;
    input?: Record<string, unknown>;
  }> = [];
  const toolResults: Array<{
    toolUseId: string;
    content: string;
    isError?: boolean;
  }> = [];

  applyClaudeAssistantEvent(
    {
      type: 'assistant',
      uuid: 'assistant_event_1',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_read_1',
            name: 'Read',
            input: {
              file_path: 'src/App.tsx'
            }
          }
        ]
      }
    },
    state,
    {
      onToolUse: (tool) => toolUses.push(tool)
    }
  );

  applyClaudeStreamEvent(
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: {
          text: 'file '
        }
      }
    },
    state,
    {
      onTextDelta: () => {}
    }
  );

  applyClaudeAssistantEvent(
    {
      type: 'assistant',
      uuid: 'assistant_event_2',
      message: {
        content: [
          {
            type: 'text',
            text: 'file contents'
          }
        ]
      }
    },
    state,
    {}
  );

  applyClaudeUserEvent(
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read_1',
            content: [
              {
                type: 'text',
                text: 'file contents'
              }
            ]
          }
        ]
      }
    },
    state,
    {
      onToolUse: (tool) => toolUses.push(tool),
      onToolResult: (result) => toolResults.push(result)
    }
  );

  applyClaudeUserEvent(
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read_1',
            content: 'duplicate'
          }
        ]
      }
    },
    state,
    {
      onToolUse: (tool) => toolUses.push(tool),
      onToolResult: (result) => toolResults.push(result)
    }
  );

  assert.equal(toolUses[0]?.status, 'running');
  assert.equal(toolUses[0]?.name, 'Read');
  assert.equal(toolUses[1]?.status, 'completed');
  assert.equal(toolUses[1]?.name, 'Read');
  assert.equal(state.text, 'file contents');
  assert.deepEqual(toolResults, [
    {
      toolUseId: 'toolu_read_1',
      content: 'file contents',
      isError: undefined
    }
  ]);
});

test('Claude Code stream parser replaces corrected final assistant text instead of duplicating it', () => {
  const state = createClaudeRuntimeState();
  const streamedText = [
    '可以，我先按 **北京出发、天津、情侣出行、轻松不赶路** 给你出一个可直接执行的版本。',
    '',
    '# 天津 3天2晚情侣详细计划',
    '',
    '## 二、预算预估（两人）',
    '- 高铁往返：**400–700 元**',
    '- 酒店两晚：**800–180 元**',
    '- 吃饭饮品：**600–120 元**',
    '',
    '**合计：约 200–4250 元 / 两人**'
  ].join('\n');
  const correctedText = streamedText
    .replace('800–180 元', '800–1800 元')
    .replace('600–120 元', '600–1200 元')
    .replace('200–4250 元', '2000–4250 元');

  applyClaudeStreamEvent(
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: {
          text: streamedText
        }
      }
    },
    state,
    {
      onTextDelta: () => {}
    }
  );

  applyClaudeAssistantEvent(
    {
      type: 'assistant',
      uuid: 'assistant_final_corrected',
      message: {
        content: [
          {
            type: 'text',
            text: correctedText
          }
        ]
      }
    },
    state,
    {}
  );

  assert.equal(state.text, correctedText);
  assert.equal(state.text.match(/天津 3天2晚情侣详细计划/g)?.length, 1);
  assert.equal(state.text.includes(`${streamedText}${correctedText}`), false);
});

test('Claude context summary prefers provider summarizer and records coverage', async () => {
  const project = buildProject();
  const activeSession = getActiveProjectSession(project);
  const timestamp = new Date().toISOString();
  const chat: ChatMessage[] = Array.from({ length: 18 }, (_, index) => ({
    id: `summary_chat_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index % 2 === 0
      ? `summary user request ${index}`
      : `summary assistant response ${index}`,
    createdAt: timestamp
  }));

  const providerResult = await buildClaudeContextSummaryForSessionWithProvider({
    ...activeSession,
    runtimeOverrides: {
      claudeCodeSessionId: 'provider-session'
    },
    chat
  }, {
    providerSummary: async (prompt) => {
      assert.match(prompt, /summary user request 0/);
      return 'provider compressed summary';
    }
  });
  assert.equal(providerResult.summary, 'provider compressed summary');
  assert.equal(providerResult.coverage?.strategy, 'provider');
  assert.equal(providerResult.coverage?.sourceRuntimeSessionId, 'provider-session');
  assert.equal(providerResult.coverage?.messageCount, 6);

  const fallbackResult = await buildClaudeContextSummaryForSessionWithProvider({
    ...activeSession,
    chat
  }, {
    providerSummary: async () => {
      throw new Error('provider unavailable');
    }
  });
  assert.match(fallbackResult.summary ?? '', /summary user request 0/);
  assert.equal(fallbackResult.coverage?.strategy, 'extractive');
});

test('Claude context summary stops calling failing provider compressor after circuit breaker', async () => {
  const project = buildProject();
  const activeSession = getActiveProjectSession(project);
  const timestamp = new Date().toISOString();
  const chat: ChatMessage[] = Array.from({ length: 18 }, (_, index) => ({
    id: `compress_breaker_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `breaker message ${index}`,
    createdAt: timestamp,
    ordinal: index
  }));
  const session = {
    ...activeSession,
    chat
  };

  resetClaudeContextCompressionState(session.id);
  let calls = 0;
  for (let index = 0; index < 4; index += 1) {
    const result = await buildClaudeContextSummaryForSessionWithProvider(session, {
      providerSummary: async () => {
        calls += 1;
        throw new Error('provider compressor down');
      }
    });
    assert.match(result.summary ?? '', /breaker message 0/);
    assert.equal(result.coverage?.strategy, 'extractive');
  }
  assert.equal(calls, 3);
  resetClaudeContextCompressionState(session.id);
});

test('Claude context boundary filters already summarized messages by ordinal', async () => {
  const project = buildProject();
  const activeSession = getActiveProjectSession(project);
  const timestamp = new Date().toISOString();
  const chat: ChatMessage[] = Array.from({ length: 24 }, (_, index) => ({
    id: `boundary_chat_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `boundary message ${index}`,
    createdAt: timestamp,
    ordinal: index,
    storageRowId: 100 + index
  }));
  const session = {
    ...activeSession,
    runtimeOverrides: {
      claudeContextSummary: 'previous summary',
      claudeContextSummaryTurnCount: 3,
      claudeContextSummaryCoverage: {
        version: 2,
        strategy: 'extractive' as const,
        fromMessageId: 'boundary_chat_0',
        toMessageId: 'boundary_chat_5',
        boundaryRowId: 105,
        boundaryOrdinal: 5,
        coveredMessageCount: 6,
        messageCount: 6,
        turnCount: 3,
        generatedAt: timestamp
      }
    },
    chat
  };

  const uncovered = filterClaudeMessagesAfterSummaryBoundary(session);
  assert.equal(uncovered[0]?.id, 'boundary_chat_6');
  assert.equal(uncovered.some((message) => message.id === 'boundary_chat_0'), false);

  const summary = buildClaudeContextSummaryForSession(session);
  assert.match(summary ?? '', /previous summary/);
  assert.match(summary ?? '', /boundary message 6/);
  assert.doesNotMatch(summary ?? '', /boundary message 0/);

  const result = await buildClaudeContextSummaryForSessionWithProvider(session, {
    providerSummary: async (prompt) => {
      assert.match(prompt, /boundary message 6/);
      assert.doesNotMatch(prompt, /boundary message 0/);
      return 'provider boundary summary';
    }
  });
  assert.equal(result.coverage?.boundaryRowId, 111);
  assert.equal(result.coverage?.boundaryOrdinal, 11);
  assert.equal(result.coverage?.coveredMessageCount, 12);
  assert.deepEqual(result.coverage?.summaryInputMessageIds, [
    'boundary_chat_6',
    'boundary_chat_7',
    'boundary_chat_8',
    'boundary_chat_9',
    'boundary_chat_10',
    'boundary_chat_11'
  ]);
});

test('Claude history normalizer preserves prior tools as metadata markers', () => {
  const content = normalizeClaudeHistoryMessageContent({
    id: 'tool_history',
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    ordinal: 1,
    contentBlocks: [
      {
        type: 'thinking',
        thinking: 'I should inspect the project.'
      },
      {
        type: 'tool_use',
        toolUseId: 'toolu_read',
        name: 'Read',
        input: {
          file_path: 'src/App.tsx'
        }
      },
      {
        type: 'tool_result',
        toolUseId: 'toolu_read',
        content: 'const App = () => null;'
      }
    ]
  });

  assert.match(content, /<prior-reasoning>/);
  assert.match(content, /<prior-tool-call id="toolu_read" name="Read">/);
  assert.match(content, /<prior-tool-result tool_use_id="toolu_read"/);
  assert.doesNotMatch(content, /\(used Read:/);
});

test('Claude MCP profile injects built-ins only for matching intent', () => {
  const project = buildProject();
  const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/App.tsx');
  const baseParams = {
    project,
    message: '修改 src/App.tsx',
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

  const codeProfile = resolveClaudeMcpProfile(baseParams, { allowWriteTools: false });
  assert.equal(codeProfile.includeWeb, false);
  assert.equal(codeProfile.includeMedia, false);
  assert.equal(codeProfile.includeWorkspaceWrite, false);
  assert.equal(codeProfile.builtinAllowedTools.includes('mcp__funplay-web__funplay_web_search'), false);

  const webProfile = resolveClaudeMcpProfile({
    ...baseParams,
    message: '搜索 React 最新文档',
    context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '搜索 React 最新文档')
  }, { allowWriteTools: false });
  assert.equal(webProfile.includeWeb, true);
  assert.equal(webProfile.builtinAllowedTools.includes('mcp__funplay-web__funplay_web_search'), true);
  assert.equal(webProfile.builtinAllowedTools.includes('mcp__funplay-media__funplay_media_attach_file'), false);

  const mediaProfile = resolveClaudeMcpProfile({
    ...baseParams,
    message: '预览素材图片附件',
    context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '预览素材图片附件')
  }, { allowWriteTools: false });
  assert.equal(mediaProfile.includeMedia, true);
  assert.equal(mediaProfile.includeImageGeneration, false);
  assert.equal(mediaProfile.builtinAllowedTools.includes('mcp__funplay-media__funplay_media_attach_file'), true);

  const writeProfile = resolveClaudeMcpProfile({
    ...baseParams,
    permission: {
      mode: 'full-access' as const,
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }, {
    allowWriteTools: true,
    supportsHostControlledWrites: true
  });
  assert.equal(writeProfile.writeMode, 'host-controlled');
  assert.equal(writeProfile.includeWorkspaceWrite, true);
  assert.equal(writeProfile.builtinAllowedTools.includes('mcp__funplay-workspace-write__funplay_workspace_patch_file'), true);
});

test('Claude stream collector records text and tool results exactly once', () => {
  const textDeltas: string[] = [];
  const toolResults: string[] = [];
  const toolStatuses: string[] = [];
  const collector = createClaudeStreamCollector({
    onTextDelta: (delta) => textDeltas.push(delta),
    onToolUse: (tool) => toolStatuses.push(`${tool.name}:${tool.status ?? 'unknown'}`),
    onToolResult: (result) => toolResults.push(result.content),
    normalizeToolInput: (input) => typeof input === 'string' ? { raw: input } : input,
    extractToolResult: (block) => ({
      content: typeof block.content === 'string' ? block.content : 'ok'
    })
  });

  collector.applyStreamEvent({
    event: {
      type: 'content_block_delta',
      delta: {
        text: 'hello '
      }
    }
  });
  collector.applyAssistantEvent({
    uuid: 'assistant_1',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: {
            file_path: 'src/App.tsx'
          }
        },
        {
          type: 'text',
          text: 'hello world'
        }
      ]
    }
  });
  collector.applyAssistantEvent({
    uuid: 'assistant_1',
    message: {
      content: [
        {
          type: 'text',
          text: 'duplicate'
        }
      ]
    }
  });
  collector.applyUserEvent({
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'read result'
        },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'duplicate result'
        }
      ]
    }
  });
  collector.applyResultEvent({
    result: 'hello world',
    session_id: 'collector-session',
    is_error: false
  });

  assert.equal(collector.state.text, 'hello world');
  assert.equal(textDeltas.join(''), 'hello world');
  assert.deepEqual(toolResults, ['read result']);
  assert.deepEqual(toolStatuses, ['Read:running', 'Read:completed']);
  assert.equal(collector.state.resultSessionId, 'collector-session');
  assert.equal(resolveClaudeCollectorFinalText(collector.state), 'hello world');
});

test('Claude stream collector uses the SDK result as the canonical final reply', () => {
  const textDeltas: string[] = [];
  const collector = createClaudeStreamCollector({
    onTextDelta: (_delta, accumulated) => textDeltas.push(accumulated)
  });

  collector.applyStreamEvent({
    event: {
      type: 'content_block_delta',
      delta: {
        text: '我先快速查看当前目录结构。\n\n'
      }
    }
  });
  collector.applyStreamEvent({
    event: {
      type: 'content_block_delta',
      delta: {
        text: '已拿到顶层结构。\n\n'
      }
    }
  });
  collector.applyAssistantEvent({
    uuid: 'assistant_final_preview',
    message: {
      content: [
        {
          type: 'text',
          text: '帮你整理了一下当前项目文件结构：\n\n```text\nCode Plan/\n├── index.html\n└── main.js\n```'
        }
      ]
    }
  });
  collector.applyResultEvent({
    result: '我帮你整理了一下当前项目文件结构：\n\n```text\nCode Plan/\n├── index.html\n└── main.js\n```',
    session_id: 'collector-session',
    is_error: false
  });

  assert.ok(textDeltas.length > 0);
  assert.match(collector.state.text, /我先快速查看/);
  assert.match(collector.state.text, /帮你整理了一下当前项目文件结构/);
  assert.equal(
    resolveClaudeCollectorFinalText(collector.state),
    '我帮你整理了一下当前项目文件结构：\n\n```text\nCode Plan/\n├── index.html\n└── main.js\n```'
  );
});

test('Claude stream collector replaces revised trailing assistant text instead of appending it', () => {
  const accumulatedTexts: string[] = [];
  const collector = createClaudeStreamCollector({
    onTextDelta: (_delta, accumulated) => accumulatedTexts.push(accumulated)
  });

  collector.applyStreamEvent({
    event: {
      type: 'content_block_delta',
      delta: {
        text: '我先看现有斗地主页面结构，再做一轮只改界面的视觉优化。\n\n'
      }
    }
  });
  collector.applyStreamEvent({
    event: {
      type: 'content_block_delta',
      delta: {
        text: '会保留现有结构，主要强化牌桌质感、按钮分层和玩家面板视觉。'
      }
    }
  });
  collector.applyAssistantEvent({
    uuid: 'assistant_revised_tail',
    message: {
      content: [
        {
          type: 'text',
          text: '我会保留现有结构，主要强化牌桌质感、按钮分层和玩家面板视觉。'
        }
      ]
    }
  });

  assert.equal(
    collector.state.text,
    '我先看现有斗地主页面结构，再做一轮只改界面的视觉优化。\n\n我会保留现有结构，主要强化牌桌质感、按钮分层和玩家面板视觉。'
  );
  assert.doesNotMatch(collector.state.text, /会保留现有结构.*我会保留现有结构/s);
  assert.equal(accumulatedTexts.at(-1), collector.state.text);
});

test('Claude stream collector falls back to the last assistant text when no result text is available', () => {
  const collector = createClaudeStreamCollector({});

  collector.applyStreamEvent({
    event: {
      type: 'content_block_delta',
      delta: {
        text: '我先快速查看当前目录结构。\n\n'
      }
    }
  });
  collector.applyAssistantEvent({
    uuid: 'assistant_final_without_result',
    message: {
      content: [
        {
          type: 'text',
          text: '最终整理：\n\n- index.html\n- main.js'
        }
      ]
    }
  });

  assert.equal(resolveClaudeCollectorFinalText(collector.state), '最终整理：\n\n- index.html\n- main.js');
});
