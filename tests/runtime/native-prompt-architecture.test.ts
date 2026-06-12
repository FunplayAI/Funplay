import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { getActiveProjectSession, replaceProjectSession } from '../../shared/project-sessions.ts';
import type { AiProvider, ChatMessage } from '../../shared/types.ts';
import type { GenericAgentRuntimeParams } from '../../electron/main/agent-platform/types.ts';
import type { NativeRuntimeToolDefinition } from '../../electron/main/agent-platform/native/tool-adapter.ts';
import {
  createNativeToolLoopPrompt,
  createNativeToolLoopSystemPrompt
} from '../../electron/main/agent-platform/native/tool-loop-prompt.ts';
import { buildNativeToolLoopMessages } from '../../electron/main/agent-platform/model-message-builder.ts';
import {
  applyNativeContextPatchToProject,
  buildNativeContextSummaryForSession,
  buildNativeStructuredTurnHistory,
  clearNativeSessionTokenBaseline,
  computeNativeSessionTranscriptChars,
  filterNativeMessagesAfterSummaryBoundary,
  prepareNativeContextHandoffWithModelSummary,
  recordNativeSessionTokenBaseline,
  resolveModelContextWindow,
  shouldPrepareNativeContextHandoff,
  shouldUseNativeProviderContextSummary
} from '../../electron/main/agent-platform/native/context-handoff.ts';
import {
  computeNativeWorkspaceObservationSignature,
  recordNativeWorkspaceObservation,
  resetNativeWorkspaceObservationGate,
  shouldRunNativeWorkspaceObservation
} from '../../electron/main/agent-platform/native/loop.ts';
import { applyNativeAnthropicTailCacheBreakpoint } from '../../electron/main/agent-platform/native/ai-sdk-provider-step.ts';
import { buildProject } from './test-helpers.ts';

function buildRuntimeParams(
  overrides: {
    message?: string;
    plugins?: GenericAgentRuntimeParams['context']['toolContext']['plugins'];
  } = {}
): GenericAgentRuntimeParams {
  const project = buildProject();
  return {
    project,
    message: overrides.message ?? '请帮我检查项目入口',
    uiLanguage: 'zh-CN',
    plugins: [],
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: false
    },
    context: {
      projectId: 'project_arch_test',
      projectName: 'Arch Test',
      projectPath: '/tmp/funplay-arch-test',
      platform: 'web',
      runtimeEnvironment: {
        workingDirectory: '/tmp/funplay-arch-test',
        platform: 'linux',
        shell: 'zsh',
        currentDate: '2026-06-01',
        timezone: 'Asia/Shanghai',
        isGitRepository: true,
        git: {
          root: '/tmp/funplay-arch-test',
          branch: 'main',
          status: 'M src/index.ts',
          recentCommits: 'abc1234 feat: initial commit'
        }
      },
      projectContextIndex: {
        generatedAt: '2026-06-01T00:00:00.000Z',
        manifests: [{ path: 'package.json', kind: 'node', name: 'arch-test' }],
        scripts: [{ name: 'test', command: 'node --test', source: 'package.json' }],
        testCommands: [{ name: 'test', command: 'node --test', source: 'package.json' }],
        dependencies: [],
        entrypoints: [{ path: 'src/index.ts', reason: 'package.json main' }],
        configFiles: ['tsconfig.json'],
        recentFiles: [{ path: 'src/index.ts', status: 'M' }]
      },
      activeSessionId: getActiveProjectSession(project).id,
      archivedTurnCount: 0,
      recentTurns: [],
      recentMessages: [],
      crossSessionSummaries: [],
      relatedSessionEvidence: [],
      projectInstructions: [],
      toolContext: {
        plugins: overrides.plugins ?? [],
        skills: [],
        skillIndex: [],
        activeSkills: []
      }
    }
  };
}

function buildToolDefinition(
  name: string,
  options: {
    canonicalName?: string;
    usageHint?: string;
  } = {}
): NativeRuntimeToolDefinition {
  return {
    name,
    title: `${name} tool`,
    description: `${name} description`,
    inputSchema: z.object({}),
    risk: 'low',
    permissionPolicy: 'always',
    checkpointPolicy: 'none',
    readOnly: true,
    toolLanguage: options.canonicalName
      ? {
          canonicalName: options.canonicalName,
          usageHint: options.usageHint
        }
      : undefined
  } as NativeRuntimeToolDefinition;
}

function buildChatMessage(input: {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ordinal: number;
  metadata?: ChatMessage['metadata'];
}): ChatMessage {
  return {
    id: input.id,
    role: input.role,
    content: input.content,
    createdAt: '2026-06-01T00:00:00.000Z',
    ordinal: input.ordinal,
    storageRowId: input.ordinal,
    metadata: input.metadata
  };
}

function buildProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  const timestamp = '2026-06-01T00:00:00.000Z';
  return {
    id: 'provider_arch_test',
    name: 'Arch Provider',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    enabled: true,
    isDefault: true,
    notes: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

test('native tool-loop system prompt carries the environment block and is byte-identical across steps', () => {
  const params = buildRuntimeParams();
  const toolDefinitions = [
    buildToolDefinition('read_file', { canonicalName: 'Read', usageHint: '读取文件内容' }),
    buildToolDefinition('edit_file', { canonicalName: 'Edit' }),
    buildToolDefinition('write_file'),
    buildToolDefinition('run_command', { canonicalName: 'Bash' }),
    buildToolDefinition('update_todo_list', { canonicalName: 'TodoWrite' })
  ];

  const stepOne = createNativeToolLoopSystemPrompt(params, { toolDefinitions });
  const stepTwo = createNativeToolLoopSystemPrompt(params, { toolDefinitions });
  assert.equal(stepOne, stepTwo);

  // Environment block: data captured once at run start, no per-step git refresh.
  assert.match(stepOne, /环境信息（运行开始时由 host 采集一次，本轮内不会重新执行 git）/);
  assert.match(stepOne, /操作系统平台：linux/);
  assert.match(stepOne, /今日日期：2026-06-01/);
  assert.match(stepOne, /工作目录：\/tmp\/funplay-arch-test/);
  assert.match(stepOne, /Git 分支：main/);
  assert.match(stepOne, /M src\/index\.ts/);

  // Frontier doctrine blocks live in the system prompt.
  assert.match(stepOne, /工具调用准则/);
  assert.match(stepOne, /并行发起多个工具调用/);
  assert.match(stepOne, /编辑协议/);
  assert.match(stepOne, /oldText 必须逐字来自最近一次 read_file 输出/);
  assert.match(stepOne, /验证要求/);
  assert.match(stepOne, /任务清单纪律/);
  assert.match(stepOne, /update_todo_list/);
  assert.match(stepOne, /回复风格/);
  assert.match(stepOne, /Native 工具语言/);
  assert.match(stepOne, /- Read → read_file/);

  // Write tools were materialized, so the write-enabled rule text is selected.
  assert.match(stepOne, /项目写入工具出现在工具列表中/);
});

test('native tool-loop per-turn prompt is a compact dynamic block without static rule text', () => {
  const params = buildRuntimeParams({ message: '继续上次的修改' });
  const dynamicPrompt = createNativeToolLoopPrompt(params, ['read_file'], {
    includeWriteTools: true,
    includeMcpToolCalls: false,
    includeCommandTools: true
  });

  assert.match(dynamicPrompt, /本回合动态上下文/);
  assert.match(dynamicPrompt, /用户消息：继续上次的修改/);
  assert.match(dynamicPrompt, /"projectId":"project_arch_test"/);
  // Static rules and environment moved to the system prompt; the dynamic block
  // must not rebuild them per turn.
  assert.doesNotMatch(dynamicPrompt, /编辑协议/);
  assert.doesNotMatch(dynamicPrompt, /工具调用准则/);
  assert.doesNotMatch(dynamicPrompt, /环境信息/);
  assert.doesNotMatch(dynamicPrompt, /"runtimeEnvironment"/);
  // Compact JSON: no pretty-printed two-space indentation lines.
  assert.doesNotMatch(dynamicPrompt, /\n {2}"projectId"/);
});

test('native tool-loop messages are append-only across turns modulo the dynamic tail', () => {
  const project = buildProject();
  const activeSession = getActiveProjectSession(project);
  const turnOneChat: ChatMessage[] = [
    buildChatMessage({ id: 'msg_1', role: 'user', content: '第一轮问题', ordinal: 1 }),
    buildChatMessage({ id: 'msg_2', role: 'assistant', content: '第一轮回答', ordinal: 2 })
  ];
  const turnOneProject = replaceProjectSession(project, { ...activeSession, chat: turnOneChat }, activeSession.id);
  const turnOneMessages = buildNativeToolLoopMessages({
    project: turnOneProject,
    sessionId: activeSession.id,
    currentPrompt: '动态上下文 turn-1'
  });

  const turnTwoProject = replaceProjectSession(
    project,
    {
      ...activeSession,
      chat: [
        ...turnOneChat,
        buildChatMessage({ id: 'msg_3', role: 'user', content: '第二轮问题', ordinal: 3 }),
        buildChatMessage({ id: 'msg_4', role: 'assistant', content: '第二轮回答', ordinal: 4 })
      ]
    },
    activeSession.id
  );
  const turnTwoMessages = buildNativeToolLoopMessages({
    project: turnTwoProject,
    sessionId: activeSession.id,
    currentPrompt: '动态上下文 turn-2'
  });

  // Turn N transcript (everything except the dynamic tail) must be reused
  // verbatim as a prefix of turn N+1 — that is the prompt-cache acceptance bar.
  const turnOneTranscript = turnOneMessages.slice(0, -1);
  assert.deepEqual(turnTwoMessages.slice(0, turnOneTranscript.length), turnOneTranscript);
  assert.equal(turnTwoMessages[turnTwoMessages.length - 1]?.content, '动态上下文 turn-2');
  assert.equal(turnOneMessages[turnOneMessages.length - 1]?.content, '动态上下文 turn-1');
  // The dynamic tail is its own message, never merged into transcript history.
  assert.equal(turnTwoMessages.length, turnOneTranscript.length + 3);
});

test('budget-driven retention keeps verbatim history under budget and compacts once over budget', () => {
  const project = buildProject();
  const activeSession = getActiveProjectSession(project);
  const longText = 'tool-output-'.repeat(400);
  const chat: ChatMessage[] = Array.from({ length: 12 }, (_, index) =>
    buildChatMessage({
      id: `budget_msg_${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index + 1} ${longText}`,
      ordinal: index + 1
    })
  );
  const session = { ...activeSession, chat };

  // Under budget (huge window): no handoff, transcript replayed verbatim.
  const bigWindowProvider = buildProvider({ contextWindowTokens: 1_000_000 });
  assert.equal(
    shouldPrepareNativeContextHandoff({ session, provider: bigWindowProvider, currentPrompt: '继续' }),
    false
  );
  const verbatimProject = replaceProjectSession(project, session, activeSession.id);
  const verbatimMessages = buildNativeToolLoopMessages({
    project: verbatimProject,
    sessionId: activeSession.id,
    currentPrompt: '动态上下文'
  });
  assert.equal(verbatimMessages.length, chat.length + 1);
  assert.equal(JSON.stringify(verbatimMessages).includes(longText), true);

  // Over budget (tiny window): the 0.68 ratio triggers exactly one compaction
  // with a recorded coverage boundary.
  const smallWindowProvider = buildProvider({ contextWindowTokens: 2_000 });
  assert.equal(
    shouldPrepareNativeContextHandoff({ session, provider: smallWindowProvider, currentPrompt: '继续' }),
    true
  );
  const handoff = buildNativeContextSummaryForSession({
    session,
    provider: smallWindowProvider,
    currentPrompt: '继续',
    recentMessageCount: 4
  });
  assert.ok(handoff);
  assert.equal(handoff.coverage.boundaryRowId, 8);
  const remaining = filterNativeMessagesAfterSummaryBoundary(chat, handoff.coverage);
  assert.deepEqual(
    remaining.map((message) => message.id),
    ['budget_msg_9', 'budget_msg_10', 'budget_msg_11', 'budget_msg_12']
  );

  // Compaction happens once: re-running over the already-covered region is a no-op.
  const compactedSession = {
    ...session,
    runtimeOverrides: {
      ...session.runtimeOverrides,
      ...handoff.patch
    }
  };
  const secondPass = buildNativeContextSummaryForSession({
    session: compactedSession,
    provider: smallWindowProvider,
    currentPrompt: '继续',
    recentMessageCount: 4
  });
  assert.equal(secondPass, undefined);
});

test('resolveModelContextWindow prefers the provider model catalog over the marker table', () => {
  const provider = buildProvider({
    model: 'gpt-5-custom',
    availableModels: [
      {
        modelId: 'gpt-5-custom',
        capabilities: { toolUse: true, contextWindow: 333_000 }
      }
    ]
  });
  // Marker table would say 400k for a gpt-5 model; the catalog entry wins.
  assert.equal(resolveModelContextWindow(provider, 'gpt-5-custom'), 333_000);
  // Marker table fallback when the catalog has no entry for the model.
  assert.equal(resolveModelContextWindow(buildProvider({ model: 'gpt-5-mega' })), 400_000);
  // Final fallback when neither catalog nor marker table matches.
  assert.equal(resolveModelContextWindow(buildProvider({ model: 'mystery-model' })), 128_000);
});

test('native context compaction defaults to the model summary with extractive fallback', async () => {
  const originalFlag = process.env.FUNPLAY_NATIVE_CONTEXT_SUMMARY_PROVIDER;
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.FUNPLAY_NATIVE_CONTEXT_SUMMARY_PROVIDER;
    const provider = buildProvider();
    // Default ON without any env flag; '0' is the explicit opt-out.
    assert.equal(shouldUseNativeProviderContextSummary(provider), true);
    assert.equal(shouldUseNativeProviderContextSummary(undefined), false);
    process.env.FUNPLAY_NATIVE_CONTEXT_SUMMARY_PROVIDER = '0';
    assert.equal(shouldUseNativeProviderContextSummary(provider), false);
    delete process.env.FUNPLAY_NATIVE_CONTEXT_SUMMARY_PROVIDER;

    // Provider summary failure falls back to the extractive strategy.
    const project = buildProject();
    const activeSession = getActiveProjectSession(project);
    const chat: ChatMessage[] = Array.from({ length: 12 }, (_, index) =>
      buildChatMessage({
        id: `fallback_msg_${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `fallback message ${index + 1} ${'x'.repeat(60)}`,
        ordinal: index + 1
      })
    );
    const projectWithChat = replaceProjectSession(project, { ...activeSession, chat }, activeSession.id);
    globalThis.fetch = (async () => {
      throw new Error('summary provider unavailable');
    }) as typeof fetch;
    const result = await prepareNativeContextHandoffWithModelSummary({
      project: projectWithChat,
      sessionId: activeSession.id,
      provider,
      currentPrompt: '继续工作',
      force: true
    });
    assert.ok(result);
    assert.equal(result.coverage.strategy, 'extractive');
    assert.match(result.summary, /fallback message 1/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) {
      delete process.env.FUNPLAY_NATIVE_CONTEXT_SUMMARY_PROVIDER;
    } else {
      process.env.FUNPLAY_NATIVE_CONTEXT_SUMMARY_PROVIDER = originalFlag;
    }
  }
});

test('structured turn history captures files touched, commands run, todos, and the last error', () => {
  const createdAt = '2026-06-01T00:00:00.000Z';
  const messages: ChatMessage[] = [
    buildChatMessage({ id: 'sh_user', role: 'user', content: '把入口改成 TypeScript', ordinal: 1 }),
    buildChatMessage({
      id: 'sh_assistant',
      role: 'assistant',
      content: '',
      ordinal: 2,
      metadata: {
        agentCoreParts: [
          {
            id: 'sh_text',
            kind: 'assistant_text',
            sequence: 0,
            createdAt,
            text: '决定使用 esbuild 打包入口。'
          },
          {
            id: 'sh_write',
            kind: 'tool_call',
            sequence: 1,
            createdAt,
            toolUseId: 'tool_sh_write',
            name: 'write_file',
            input: { path: 'src/main.ts', content: 'console.log(1);' },
            status: 'completed'
          },
          {
            id: 'sh_cmd',
            kind: 'tool_call',
            sequence: 2,
            createdAt,
            toolUseId: 'tool_sh_cmd',
            name: 'run_command',
            input: { command: 'npm run build' },
            status: 'completed'
          },
          {
            id: 'sh_todo',
            kind: 'tool_call',
            sequence: 3,
            createdAt,
            toolUseId: 'tool_sh_todo',
            name: 'update_todo_list',
            input: {
              todos: [
                { title: '迁移入口文件', status: 'completed' },
                { title: '更新构建脚本', status: 'in_progress' }
              ]
            },
            status: 'completed'
          },
          {
            id: 'sh_error',
            kind: 'tool_error',
            sequence: 4,
            createdAt,
            toolUseId: 'tool_sh_cmd',
            error: 'build failed: missing tsconfig'
          }
        ]
      }
    })
  ];

  const structured = buildNativeStructuredTurnHistory(messages);
  assert.match(structured, /User requests:/);
  assert.match(structured, /把入口改成 TypeScript/);
  assert.match(structured, /Files touched:/);
  assert.match(structured, /write_file: src\/main\.ts/);
  assert.match(structured, /Commands run:/);
  assert.match(structured, /npm run build/);
  assert.match(structured, /Open todos:/);
  assert.match(structured, /\[in_progress\] 更新构建脚本/);
  assert.doesNotMatch(structured, /\[completed\] 迁移入口文件/);
  assert.match(structured, /Last error: build failed: missing tsconfig/);
});

test('provider-reported token baseline drives the context estimate until compaction clears it', () => {
  const project = buildProject();
  const activeSession = getActiveProjectSession(project);
  const chat: ChatMessage[] = [
    buildChatMessage({ id: 'baseline_user', role: 'user', content: '短消息', ordinal: 1 }),
    buildChatMessage({ id: 'baseline_assistant', role: 'assistant', content: '短回答', ordinal: 2 })
  ];
  const session = { ...activeSession, chat };
  const provider = buildProvider({ contextWindowTokens: 64_000 });
  try {
    // Cold start: chars/4 estimate of a tiny transcript stays far below budget.
    assert.equal(shouldPrepareNativeContextHandoff({ session, provider, currentPrompt: '继续' }), false);

    // A provider usage report becomes the primary estimator: 50k prompt tokens
    // exceed 0.68 * 64k even though the visible transcript is tiny.
    recordNativeSessionTokenBaseline(
      session.id,
      { inputTokens: 49_000, cacheReadTokens: 1_000 },
      computeNativeSessionTranscriptChars(session, '继续')
    );
    assert.equal(shouldPrepareNativeContextHandoff({ session, provider, currentPrompt: '继续' }), true);

    // Applying a compaction patch moves the boundary and clears the stale baseline.
    applyNativeContextPatchToProject(project, session.id, {
      nativeContextSummary: 'summary',
      nativeContextSummaryCoverage: {
        version: 1,
        strategy: 'extractive',
        boundaryRowId: 1,
        boundaryOrdinal: 1,
        messageCount: 1,
        turnCount: 1,
        generatedAt: '2026-06-01T00:00:00.000Z'
      }
    });
    assert.equal(shouldPrepareNativeContextHandoff({ session, provider, currentPrompt: '继续' }), false);
  } finally {
    clearNativeSessionTokenBaseline(session.id);
  }
});

test('workspace observation pre-stages are gated by a change-detection signature', () => {
  const sessionId = `session_obs_${Date.now()}`;
  try {
    const params = buildRuntimeParams();
    const signature = computeNativeWorkspaceObservationSignature(params);

    // generatedAt churn alone must not invalidate the snapshot.
    const regenerated = buildRuntimeParams();
    regenerated.context.projectContextIndex = {
      ...regenerated.context.projectContextIndex!,
      generatedAt: '2026-06-02T12:34:56.000Z'
    };
    assert.equal(computeNativeWorkspaceObservationSignature(regenerated), signature);

    // First run executes, repeat run with an unchanged signature is skipped.
    assert.equal(shouldRunNativeWorkspaceObservation(sessionId, signature), true);
    recordNativeWorkspaceObservation(sessionId, signature);
    assert.equal(shouldRunNativeWorkspaceObservation(sessionId, signature), false);

    // File-tree drift (recentFiles), plugin set changes, and compaction all
    // produce a different signature and re-enable the stages.
    const fileDrift = buildRuntimeParams();
    fileDrift.context.projectContextIndex = {
      ...fileDrift.context.projectContextIndex!,
      recentFiles: [{ path: 'src/new-file.ts', status: 'A' }]
    };
    const fileDriftSignature = computeNativeWorkspaceObservationSignature(fileDrift);
    assert.notEqual(fileDriftSignature, signature);
    assert.equal(shouldRunNativeWorkspaceObservation(sessionId, fileDriftSignature), true);

    const withPlugin = buildRuntimeParams({
      plugins: [{ id: 'plugin_a', name: 'Plugin A', kind: 'engine', enabled: true, hasEndpoint: true }]
    });
    assert.notEqual(computeNativeWorkspaceObservationSignature(withPlugin), signature);

    const afterCompaction = computeNativeWorkspaceObservationSignature(params, {
      boundaryRowId: 12,
      boundaryOrdinal: 12
    });
    assert.notEqual(afterCompaction, signature);
    assert.equal(shouldRunNativeWorkspaceObservation(sessionId, afterCompaction), true);

    // No session id → always observe (nothing to cache against).
    assert.equal(shouldRunNativeWorkspaceObservation(undefined, signature), true);
  } finally {
    resetNativeWorkspaceObservationGate(sessionId);
  }
});

test('anthropic cache breakpoint marks only the tail message without mutating the transcript', () => {
  const messages = [
    { role: 'user' as const, content: '历史消息' },
    { role: 'assistant' as const, content: '历史回答' },
    { role: 'user' as const, content: '本回合动态上下文' }
  ];
  const marked = applyNativeAnthropicTailCacheBreakpoint(messages);

  assert.equal(marked.length, 3);
  assert.equal(marked[0], messages[0]);
  assert.equal(marked[1], messages[1]);
  assert.deepEqual(marked[2]?.providerOptions, {
    anthropic: {
      cacheControl: {
        type: 'ephemeral'
      }
    }
  });
  // Source array untouched: the stored transcript stays clean so the next step
  // re-marks only its own tail (exactly one history breakpoint per request).
  assert.equal(messages[2].providerOptions, undefined);
  assert.deepEqual(applyNativeAnthropicTailCacheBreakpoint([]), []);
});
