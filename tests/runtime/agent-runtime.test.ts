import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectFromInput, createSnapshot } from '../../shared/planner.ts';
import { createLanguageModel } from '../../electron/main/ai-provider.ts';
import {
  appendProjectConversationTurn,
  buildSessionConversationTurns,
  createProjectSessionRecord,
  ensureProjectSessions,
  getActiveProjectSession,
  getChatMessageContextText,
  getChatMessageVisibleAssistantText,
  replaceProjectSession,
  summarizeArchivedConversationTurns
} from '../../shared/project-sessions.ts';
import { DEFAULT_AI_SETTINGS, type AgentRuntimeResumeContext, type AiProvider, type AppState, type ChatMessage, type McpPlugin, type Project, type PromptStreamEvent } from '../../shared/types.ts';
import {
  grantSessionWritePermission,
  hasSessionMcpToolPermission,
  hasSessionWritePermission,
  listSessionMcpToolPermissionKeys,
  makeSessionMcpToolPermissionKey,
  restoreSessionWritePermissionGrant,
  revokeSessionWritePermission
} from '../../electron/main/agent-platform/permission-session-store.ts';
import { nativeRuntime } from '../../electron/main/agent-platform/native/runtime.ts';
import {
  applyClaudeAssistantEvent,
  applyClaudeStreamEvent,
  applyClaudeUserEvent,
  buildClaudeCodeCliEnv,
  buildClaudeCodeSdkEnv,
  buildClaudeContextSummaryForSession,
  buildClaudeContextSummaryForSessionWithProvider,
  classifyClaudeRuntimeError,
  claudeCodeSdkRuntime,
  collectClaudeCodeExecutableCandidates,
  createClaudeSdkPrompt,
  createClaudeRuntimeState,
  createClaudeCodeCliArgs,
  createClaudeCodeSdkOptions,
  createClaudeSdkPermissionHandler,
  filterClaudeMessagesAfterSummaryBoundary,
  isClaudeSideRuntimeModel,
  normalizeClaudeHistoryMessageContent,
  prepareClaudeCodeSdkSubprocessEnv,
  redactClaudeRuntimeErrorDetail,
  resetClaudeContextCompressionState,
  resolveClaudeCodeProvider,
  resolveClaudeContextWindowTokens,
  resolveClaudeMcpProfile,
  sanitizeClaudeToolInput,
  shouldUseClaudeNativeWeb
} from '../../electron/main/agent-platform/claude/runtime.ts';
import {
  createClaudeStreamCollector,
  resolveClaudeCollectorFinalText
} from '../../electron/main/agent-platform/claude/stream-collector.ts';
import { createConversationOperationLogCollector, createConversationProcessTranscriptCollector } from '../../electron/main/agent-platform/operation-log.ts';
import { listAgentRuntimeCapabilities } from '../../electron/main/agent-runtime-capability-service.ts';
import { getAgentToolDefinition, listAgentToolDefinitions, listReadOnlyWorkspaceToolDefinitions } from '../../electron/main/agent-platform/tool-registry.ts';
import { resolveNativeToolPermission } from '../../electron/main/agent-platform/native/tool-permission.ts';
import { resolveAgentToolPermission } from '../../electron/main/agent-platform/permission-broker.ts';
import { normalizeAgentLifecycleHookConfig } from '../../electron/main/agent-platform/agent-hooks.ts';
import { resolveNativeToolLoopStrategy } from '../../electron/main/agent-platform/native/loop.ts';
import { normalizeModelReplyText } from '../../electron/main/agent-platform/native/text.ts';
import {
  createNativeToolLoopPermissionInstructions,
  NATIVE_MAIN_PROVIDER_STEP_TIMEOUT_MS,
  NATIVE_SUBAGENT_PROVIDER_STEP_TIMEOUT_MS,
  runNativeReadOnlyToolLoop,
  runOpenAiCompatibleNativeToolLoop
} from '../../electron/main/agent-platform/native/tool-loop.ts';
import { materializeNativeMcpTools } from '../../electron/main/agent-platform/native/mcp-tool-materializer.ts';
import { assertRawMcpMethodAllowed, sendRawMcpControlRequest } from '../../electron/main/mcp-raw-control.ts';
import { buildModelMessagesFromChat, buildNativeToolLoopMessages } from '../../electron/main/agent-platform/model-message-builder.ts';
import {
  buildNativeContextSummaryForSession,
  filterNativeMessagesAfterSummaryBoundary,
  resetNativeContextCompressionState,
  resolveNativeContextWindowTokens
} from '../../electron/main/agent-platform/native/context-handoff.ts';
import {
  classifyNativeRuntimeError,
  redactNativeRuntimeErrorDetail
} from '../../electron/main/agent-platform/native/diagnostics.ts';
import { createNativeWorkspaceTools, listNativeWorkspaceToolNames, NATIVE_TOOL_OUTPUT_MAX_CHARS } from '../../electron/main/agent-platform/native/tool-adapter.ts';
import { createNativeToolPool } from '../../electron/main/agent-platform/native/tool-pool.ts';
import { executeAgentToolAction, executeWorkspaceToolAction } from '../../electron/main/agent-platform/workspace-tools.ts';
import { disposePersistentTerminals } from '../../electron/main/agent-platform/persistent-terminal-store.ts';
import { buildGenericWorkspaceContext } from '../../electron/main/agent-platform/context.ts';
import { resolveGenericAgentRuntime } from '../../electron/main/agent-platform/runtime-registry.ts';
import type { GenericAgentRuntime, GenericAgentRuntimeParams, GenericAgentRuntimeResult } from '../../electron/main/agent-platform/types.ts';
import { ProjectInstructionTracker, extractNativeToolInputInstructionQuery } from '../../electron/main/agent-platform/project-instruction-tracker.ts';
import { createNativeRuntimeSystemPrompt } from '../../electron/main/agent-platform/native/prompt.ts';
import { createSystemPrompt as createClaudeSystemPrompt } from '../../electron/main/agent-platform/claude/prompt-builder.ts';
import { resolveAgentProvider } from '../../electron/main/agent-platform/provider-resolver.ts';
import { createMcpPlugin, resolveProjectPluginByKind, setActiveMcpPlugin } from '../../electron/main/mcp-plugin-service.ts';
import {
  getRuntimeRun,
  initializeStore,
  setState,
  getState,
  upsertRuntimeRun
} from '../../electron/main/store.ts';
import {
  resumeAgentRun
} from '../../electron/main/agent-platform/stream-manager.ts';
import {
  recordActiveRunTimelineEntry,
  registerActiveRun,
  unregisterActiveRun,
  updateActiveRunToolBoundary
} from '../../electron/main/agent-platform/run-registry.ts';
import { executeGenericConversation } from '../../electron/main/agent-platform/task-executor.ts';
import { restoreFileCheckpoint } from '../../electron/main/agent-platform/file-checkpoint-store.ts';
import { createProjectSession, previewSessionCheckpoint, updateProjectAgentPolicy } from '../../electron/main/project-service.ts';
import { parseFunplaySkillCatalogFromDirectory } from '../../electron/main/skill-catalog-service.ts';
import { buildAgentSkillRegistry } from '../../electron/main/agent-platform/skill-registry.ts';
import {
  clearProjectMemory,
  listProjectMemoryFiles,
  readProjectMemoryFile,
  saveProjectMemoryFile
} from '../../electron/main/memory-service.ts';
import {
  clearWebResearchCache,
  getWebResearchMetrics,
  resetWebResearchMetrics,
  runWebSearchQualityEval
} from '../../electron/main/agent-platform/web-research-service.ts';
import { materializeNativeProvider, resolveProviderForRuntime, toNativeProviderConfig } from '../../electron/main/agent-platform/provider-resolver.ts';
import { sanitizeClaudeModelOptions } from '../../electron/main/agent-platform/claude/model-options.ts';
import {
  exportRuntimeDiagnostics,
  repairRuntimeDoctor,
  runRuntimeDoctor
} from '../../electron/main/runtime-doctor-service.ts';
import { refreshProjectContext } from '../../electron/main/game-context-manager.ts';

import { buildMcpPlugin, buildProject, buildState, executeNativeWorkspaceTool, readJsonRequest, sendJsonRpc, startTestMcpServer, tryRunGit, waitForFinalStreamEvent } from './test-helpers.ts';

async function runRuntimeForTest(
  runtime: GenericAgentRuntime,
  params: GenericAgentRuntimeParams
): Promise<GenericAgentRuntimeResult> {
  for await (const event of runtime.executeEventStream(params)) {
    if (event.type === 'status') {
      params.onStatus?.(event.phase, event.message);
    } else if (event.type === 'text_delta') {
      params.onTextDelta?.(event.delta, event.accumulated);
    } else if (event.type === 'thinking_delta') {
      params.onThinkingDelta?.(event.delta, event.accumulated);
    } else if (event.type === 'tool_use') {
      params.onToolUse?.(event.tool);
    } else if (event.type === 'tool_result') {
      params.onToolResult?.(event.result);
    } else if (event.type === 'stage') {
      params.onStage?.(event.stage);
    } else if (event.type === 'permission_request') {
      params.onPermissionRequest?.(event.request);
    } else if (event.type === 'user_input_request') {
      params.onUserInputRequest?.(event.request);
    } else if (event.type === 'usage') {
      params.onUsage?.(event.usage);
    } else if (event.type === 'lifecycle_hook') {
      params.onLifecycleHook?.(event.hook);
    } else if (event.type === 'agent_core_parts') {
      params.onAgentCoreParts?.(event.parts);
    }
    if (event.type === 'result') {
      return event.result;
    }
  }
  throw new Error(`Runtime ${runtime.id} completed without a result event.`);
}

function resultStreamForTest(result: GenericAgentRuntimeResult): GenericAgentRuntime['executeEventStream'] {
  return async function* () {
    yield {
      type: 'result',
      result
    };
  };
}

test('Claude Agent SDK options pass model options from session runtime overrides', () => {
  let project = buildProject('/tmp/funplay-sdk-model-options');
  const activeSession = getActiveProjectSession(project);
  project = replaceProjectSession(project, {
    ...activeSession,
    runtimeOverrides: {
      runtimeId: 'claude-code-sdk',
      effort: 'max',
      context1m: true,
      thinking: { type: 'adaptive' },
      outputFormat: { type: 'json' },
      agents: {
        reviewer: {
          description: 'Reviews code',
          prompt: 'Review changes.'
        }
      },
      agent: 'reviewer'
    }
  });
  const options = createClaudeCodeSdkOptions({
    project,
    message: 'review',
    provider: {
      id: 'provider_anthropic',
      name: 'Anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'secret',
      model: 'claude-opus-4-7',
      enabled: true,
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, 'review'),
    permission: {
      mode: 'read-only',
      allowWriteTools: false,
      allowSessionWriteTools: false
    }
  }, false, {
    cwd: '/tmp/funplay-sdk-model-options',
    abortController: new AbortController()
  });
  assert.equal(options.effort, 'max');
  assert.deepEqual(options.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(options.outputFormat, { type: 'json' });
  assert.equal(options.agent, 'reviewer');
  assert.ok(options.agents?.reviewer);
  assert.equal(options.betas?.includes('context-1m-2025-08-07') ?? false, false);
});

test('Claude Agent SDK options preload only active filesystem skills and disable skill shell execution', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-sdk-skills-'));
  try {
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'backend-plan'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'unused-skill'), { recursive: true });
    await writeFile(join(projectPath, '.claude', 'skills', 'backend-plan', 'SKILL.md'), [
      '---',
      'name: backend-plan',
      'description: Plan backend changes.',
      '---',
      '',
      'Plan backend changes.'
    ].join('\n'), 'utf8');
    await writeFile(join(projectPath, '.claude', 'skills', 'unused-skill', 'SKILL.md'), [
      '---',
      'name: unused-skill',
      'description: Do not preload.',
      '---',
      '',
      'Unused.'
    ].join('\n'), 'utf8');
    let project = buildProject(projectPath);
    const activeSession = getActiveProjectSession(project);
    project = replaceProjectSession(project, {
      ...activeSession,
      runtimeOverrides: {
        runtimeId: 'claude-code-sdk',
        agent: 'reviewer',
        agents: {
          reviewer: {
            description: 'Reviews plans.',
            prompt: 'Review plans.'
          }
        }
      }
    });
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, 'Please plan backend changes.');
    const options = createClaudeCodeSdkOptions({
      project,
      message: 'Please plan backend changes.',
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
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    }, false, {
      cwd: projectPath,
      abortController: new AbortController()
    });

    assert.equal(options.settings && typeof options.settings !== 'string' ? options.settings.disableSkillShellExecution : undefined, true);
    assert.equal(options.settings && typeof options.settings !== 'string' ? options.settings.skillOverrides?.['backend-plan'] : undefined, 'on');
    assert.equal(options.settings && typeof options.settings !== 'string' ? options.settings.skillOverrides?.['unused-skill'] : undefined, 'user-invocable-only');
    assert.deepEqual(options.agents?.reviewer.skills, ['backend-plan']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('Claude Agent SDK subprocess env shadows user Claude auth while preserving project entries', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'funplay-shadow-home-'));
  try {
    const claudeDir = join(homePath, '.claude');
    await mkdir(join(claudeDir, 'projects'), { recursive: true });
    await writeFile(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: 'old-settings-key',
          ANTHROPIC_BASE_URL: 'https://old.example/v1',
          KEEP_ME: 'yes'
        },
        preferredNotifChannel: 'terminal'
      }),
      'utf8'
    );
    await writeFile(join(claudeDir, 'projects', 'project.json'), '{"mcpServers":{}}', 'utf8');
    await writeFile(join(claudeDir, 'credentials.json'), '{"token":"secret"}', 'utf8');
    await writeFile(join(homePath, '.claude.json'), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'root-token',
        ROOT_KEEP: 'yes'
      }
    }), 'utf8');

    const prepared = prepareClaudeCodeSdkSubprocessEnv({
      id: 'provider_anthropic',
      name: 'Anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'new-key',
      model: 'claude-sonnet-4-6',
      enabled: true,
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, {
      HOME: homePath,
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'old-process-key',
      ANTHROPIC_AUTH_TOKEN: 'old-process-token'
    });

    try {
      const shadowHome = String(prepared.env.HOME);
      assert.notEqual(shadowHome, homePath);
      assert.equal(prepared.shadow.isShadow, true);
      assert.equal(prepared.env.ANTHROPIC_API_KEY, 'new-key');
      assert.equal(prepared.env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(prepared.env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
      assert.equal(prepared.env.USERPROFILE, shadowHome);
      assert.equal(existsSync(join(shadowHome, '.claude', 'projects', 'project.json')), true);
      assert.equal(existsSync(join(shadowHome, '.claude', 'credentials.json')), false);

      const settings = JSON.parse(await readFile(join(shadowHome, '.claude', 'settings.json'), 'utf8')) as {
        env?: Record<string, string>;
        preferredNotifChannel?: string;
      };
      assert.deepEqual(settings.env, {
        KEEP_ME: 'yes'
      });
      assert.equal(settings.preferredNotifChannel, 'terminal');

      const rootConfig = JSON.parse(await readFile(join(shadowHome, '.claude.json'), 'utf8')) as {
        env?: Record<string, string>;
      };
      assert.deepEqual(rootConfig.env, {
        ROOT_KEEP: 'yes'
      });
    } finally {
      prepared.shadow.cleanup();
    }
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});

test('Claude Agent SDK env-only providers keep the real Claude home for OAuth/env flows', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'funplay-real-home-'));
  try {
    const prepared = prepareClaudeCodeSdkSubprocessEnv({
      id: 'provider_env_only',
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
    }, {
      HOME: homePath,
      PATH: '/usr/bin'
    });
    try {
      assert.equal(prepared.shadow.isShadow, false);
      assert.equal(prepared.env.HOME, homePath);
      assert.equal(prepared.env.USERPROFILE, homePath);
      assert.equal(prepared.env.CLAUDE_CODE_USE_BEDROCK, '1');
      assert.equal(prepared.env.AWS_REGION, 'us-east-1');
    } finally {
      prepared.shadow.cleanup();
    }
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});

test('Claude Agent SDK prompt converts small image attachments into vision blocks', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-vision-'));
  try {
    const imagePath = join(projectPath, 'tiny.png');
    const largeImagePath = join(projectPath, 'large.png');
    const notesPath = join(projectPath, 'notes.txt');
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    await writeFile(largeImagePath, 'small fixture', 'utf8');
    await writeFile(notesPath, 'file attachment fixture', 'utf8');

    const project = buildProject(projectPath);
    const prompt = createClaudeSdkPrompt({
      project,
      message: '请分析附件。',
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
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '请分析附件。'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      attachments: [
        {
          id: 'attachment_image',
          name: 'tiny.png',
          path: imagePath,
          relativePath: 'attachments/tiny.png',
          mimeType: 'image/png',
          kind: 'image',
          size: 4
        },
        {
          id: 'attachment_large',
          name: 'large.png',
          path: largeImagePath,
          relativePath: 'attachments/large.png',
          mimeType: 'image/png',
          kind: 'image',
          size: 6 * 1024 * 1024
        },
        {
          id: 'attachment_file',
          name: 'notes.txt',
          path: notesPath,
          relativePath: 'attachments/notes.txt',
          mimeType: 'text/plain',
          kind: 'file',
          size: 23
        }
      ]
    });

    assert.equal(prompt.imageCount, 1);
    assert.equal(prompt.degradedCount, 1);
    assert.notEqual(typeof prompt.prompt, 'string');
    if (typeof prompt.prompt === 'string') {
      assert.fail('image attachments should use SDK user message content blocks.');
    }
    const first = await prompt.prompt[Symbol.asyncIterator]().next();
    const content = (first.value as {
      message?: {
        content?: Array<Record<string, unknown>>;
      };
    }).message?.content ?? [];
    assert.equal(content.filter((block) => block.type === 'image').length, 1);
    const imageBlock = content.find((block) => block.type === 'image') as {
      source?: {
        media_type?: string;
        data?: string;
      };
    } | undefined;
    assert.equal(imageBlock?.source?.media_type, 'image/png');
    assert.equal(imageBlock?.source?.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
    const textBlock = content.find((block) => block.type === 'text') as { text?: string } | undefined;
    assert.match(textBlock?.text ?? '', /Attachment vision routing/);
    assert.match(textBlock?.text ?? '', /attachments\/tiny\.png/);
    assert.match(textBlock?.text ?? '', /larger than/);
    assert.match(textBlock?.text ?? '', /attachments\/notes\.txt/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('Claude Agent SDK prompt applies image count budget and preview data URL fallback', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-vision-budget-'));
  try {
    const imagePath = join(projectPath, 'tiny.png');
    await writeFile(imagePath, Buffer.from([1, 2, 3, 4]), 'binary');
    const project = buildProject(projectPath);
    const attachments = Array.from({ length: 101 }, (_, index) => ({
      id: `image_${index}`,
      name: `image-${index}.png`,
      path: index === 100 ? join(projectPath, 'missing-preview.png') : imagePath,
      relativePath: `attachments/image-${index}.png`,
      mimeType: 'image/png',
      kind: 'image' as const,
      size: 4,
      previewDataUrl: index === 100 ? `data:image/png;base64,${Buffer.from([5, 6, 7, 8]).toString('base64')}` : undefined
    }));
    const prompt = createClaudeSdkPrompt({
      project,
      message: '请分析附件。',
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
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '请分析附件。'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      attachments
    });

    assert.equal(prompt.imageCount, 100);
    assert.equal(prompt.droppedImageCount, 1);
    assert.equal(prompt.totalMediaBytes, 400);
    assert.notEqual(typeof prompt.prompt, 'string');
    if (typeof prompt.prompt === 'string') {
      assert.fail('budgeted image attachments should use SDK user message content blocks.');
    }
    const first = await prompt.prompt[Symbol.asyncIterator]().next();
    const content = (first.value as {
      message?: {
        content?: Array<Record<string, unknown>>;
      };
    }).message?.content ?? [];
    assert.equal(content.filter((block) => block.type === 'image').length, 100);
    const lastImageBlock = content.filter((block) => block.type === 'image').at(-1) as {
      source?: { data?: string };
    } | undefined;
    assert.equal(lastImageBlock?.source?.data, Buffer.from([5, 6, 7, 8]).toString('base64'));
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('Claude Agent SDK prompt includes resume transaction summary', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-resume-transaction-'));
  try {
    const project = buildProject(projectPath);
    const prompt = createClaudeSdkPrompt({
      project,
      message: 'Continue after the interrupted write.',
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
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, 'Continue after the interrupted write.'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      },
      resumeContext: {
        resumedFromRunId: 'run_claude_resume_transaction',
        strategy: 'resume_after_last_completed_tool',
        previousStatus: 'interrupted',
        checkpointSnapshotId: 'snapshot_claude_resume',
        filesRestoredToCheckpoint: true,
        lastToolBoundary: {
          toolUseId: 'tool_write_resume',
          toolName: 'write_file',
          phase: 'tool_result',
          status: 'completed',
          checkpointSnapshotId: 'snapshot_claude_resume',
          completedAt: '2026-05-15T00:00:02.000Z',
          summary: 'write index.html',
          transaction: {
            id: 'tool_txn:tool_write_resume',
            toolUseId: 'tool_write_resume',
            toolName: 'write_file',
            toolClass: 'workspace',
            phase: 'completed',
            status: 'completed',
            eventCount: 4,
            startedAt: '2026-05-15T00:00:00.000Z',
            updatedAt: '2026-05-15T00:00:02.000Z',
            checkpoint: {
              policy: 'optional',
              snapshotId: 'snapshot_claude_resume',
              status: 'completed'
            }
          }
        }
      }
    });

    assert.equal(typeof prompt.prompt, 'string');
    assert.match(prompt.prompt as string, /Resume tool transaction summary/);
    assert.match(prompt.prompt as string, /tool_txn:tool_write_resume/);
    assert.match(prompt.prompt as string, /eventCount: 4/);
    assert.match(prompt.prompt as string, /do not rerun the same tool/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});


test('conversation process transcript persists ordered tool boundaries without pseudo text', () => {
  const collector = createConversationProcessTranscriptCollector();
  const transaction = {
    id: 'tool_txn:tool_read_types',
    toolUseId: 'tool_read_types',
    toolName: 'read_file',
    toolClass: 'workspace' as const,
    phase: 'completed' as const,
    status: 'completed' as const,
    eventCount: 3,
    startedAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:01.000Z'
  };
  collector.onTextDelta('我先查看项目结构。', '我先查看项目结构。');
  collector.onToolUse({
    toolUseId: 'tool_read_types',
    name: 'Read',
    input: {
      file: 'types.ts'
    },
    status: 'running'
  });
  collector.onToolResult({
    toolUseId: 'tool_read_types',
    content: '读取完成',
    transaction
  });
  collector.onTextDelta('\n\n最终回复', '我先查看项目结构。\n\n最终回复');

  const metadata = collector.build('最终回复');
  assert.equal(metadata.agentProcessText, '我先查看项目结构。\n\n最终回复');
  assert.equal(metadata.agentProcessActivities?.length, 1);
  assert.equal(metadata.agentProcessActivities?.[0]?.type, 'tool');
  assert.equal(metadata.agentProcessActivities?.[0]?.status, 'completed');
  assert.deepEqual(metadata.agentProcessActivities?.[0]?.toolUseIds, ['tool_read_types']);
  assert.equal(metadata.agentProcessActivities?.[0]?.offset, '我先查看项目结构。'.length);
  assert.equal(metadata.agentProcessActivities?.[0]?.transaction?.eventCount, 3);
});

test('conversation operation log preserves tool transaction summaries', () => {
  const collector = createConversationOperationLogCollector();
  const transaction = {
    id: 'tool_txn:tool_write',
    toolUseId: 'tool_write',
    toolName: 'write_file',
    toolClass: 'workspace' as const,
    phase: 'completed' as const,
    status: 'completed' as const,
    eventCount: 4,
    startedAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:02.000Z',
    checkpoint: {
      policy: 'required' as const,
      snapshotId: 'snapshot_1',
      status: 'completed' as const
    }
  };
  collector.onToolUse({
    toolUseId: 'tool_write',
    name: 'write_file',
    input: {
      path: 'index.html'
    },
    status: 'running'
  });
  collector.onToolResult({
    toolUseId: 'tool_write',
    content: '写入完成',
    transaction
  });

  const operation = collector.build()[0];
  assert.equal(operation?.transaction?.checkpoint?.snapshotId, 'snapshot_1');
  assert.equal((operation?.input?.transaction as typeof transaction | undefined)?.eventCount, 4);
});

test('conversation process transcript keeps command lifecycle hook stages visible', () => {
  const collector = createConversationProcessTranscriptCollector();
  collector.onTextDelta('我先完成实现。', '我先完成实现。');
  collector.onStage({
    stageId: 'stage:lifecycle_hook:Stop:build_check:hook_1',
    title: '生命周期 Hook',
    target: 'hook:Stop',
    status: 'running',
    summary: 'Hook command requires host permission before execution: npm run build',
    input: {
      actionType: 'command',
      status: 'requires_permission'
    }
  });
  collector.onStage({
    stageId: 'stage:lifecycle_hook:Stop:build_check:hook_1',
    title: '生命周期 Hook',
    target: 'hook:Stop',
    status: 'completed',
    summary: 'npm run build completed.',
    input: {
      actionType: 'command',
      status: 'command_completed'
    },
    transaction: {
      id: 'tool_txn:hook_1',
      toolUseId: 'hook_1',
      toolName: 'run_command',
      toolClass: 'command',
      phase: 'completed',
      status: 'completed',
      eventCount: 5,
      startedAt: '2026-05-16T00:00:00.000Z',
      updatedAt: '2026-05-16T00:00:01.000Z',
      permission: {
        policy: 'ask',
        risk: 'high',
        decision: 'allow',
        requestId: 'perm_hook_1'
      },
      checkpoint: {
        policy: 'external_best_effort',
        status: 'pending'
      }
    }
  });
  collector.onTextDelta('\n\n完成。', '我先完成实现。\n\n完成。');

  const metadata = collector.build('完成。');
  assert.equal(metadata.agentProcessActivities?.length, 1);
  assert.equal(metadata.agentProcessActivities?.[0]?.type, 'stage');
  assert.equal(metadata.agentProcessActivities?.[0]?.status, 'completed');
  assert.equal(metadata.agentProcessActivities?.[0]?.stageId, 'stage:lifecycle_hook:Stop:build_check:hook_1');
  assert.equal(metadata.agentProcessActivities?.[0]?.offset, '我先完成实现。'.length);
  assert.match(metadata.agentProcessActivities?.[0]?.summary ?? '', /npm run build completed/);
  assert.equal(metadata.agentProcessActivities?.[0]?.transaction?.toolName, 'run_command');
  assert.equal(metadata.agentProcessActivities?.[0]?.transaction?.permission?.decision, 'allow');
});

test('generic conversation does not synthesize Agent Core parts from runtime plain text', async () => {
  const project = buildProject();
  const originalExecuteEventStream = nativeRuntime.executeEventStream;
  nativeRuntime.executeEventStream = resultStreamForTest({
    assistantMessage: '我先读取文件。\n\n已经完成。',
    assistantIntent: 'chat',
    status: 'completed',
    steps: []
  });

  try {
    const result = await executeGenericConversation({
      kind: 'conversation',
      project,
      userMessageId: 'user_message_agent_core_default',
      message: '检查 package.json'
    });
    const activeSession = getActiveProjectSession(result.project);
    const assistantMessage = activeSession.chat.findLast((message) => message.role === 'assistant');
    const parts = assistantMessage?.metadata?.agentCoreParts ?? [];

    assert.deepEqual(parts, []);
    assert.equal(assistantMessage?.content, '我先读取文件。\n\n已经完成。');
    assert.equal(Object.prototype.hasOwnProperty.call(assistantMessage ?? {}, 'contentBlocks'), false);
  } finally {
    nativeRuntime.executeEventStream = originalExecuteEventStream;
  }
});

test('generic conversation does not synthesize Agent Core parts from runtime event stream projections', async () => {
  const project = buildProject();
  const originalExecuteEventStream = nativeRuntime.executeEventStream;
  nativeRuntime.executeEventStream = async function* () {
    yield {
      type: 'text_delta',
      delta: '我先读取文件。',
      accumulated: '我先读取文件。'
    };
    yield {
      type: 'tool_use',
      tool: {
        toolUseId: 'tool_stream_read',
        name: 'read_file',
        input: { path: 'package.json' },
        status: 'running'
      }
    };
    yield {
      type: 'tool_result',
      result: {
        toolUseId: 'tool_stream_read',
        toolName: 'read_file',
        content: '读取完成'
      }
    };
    yield {
      type: 'result',
      result: {
        assistantMessage: 'runner fallback text',
        assistantIntent: 'chat',
        status: 'completed',
        steps: []
      }
    };
  };

  try {
    const result = await executeGenericConversation({
      kind: 'conversation',
      project,
      userMessageId: 'user_message_agent_core_stream',
      message: '检查 package.json'
    });
    const activeSession = getActiveProjectSession(result.project);
    const assistantMessage = activeSession.chat.findLast((message) => message.role === 'assistant');
    const parts = assistantMessage?.metadata?.agentCoreParts ?? [];

    assert.deepEqual(parts, []);
    assert.equal(assistantMessage?.content, 'runner fallback text');
    assert.deepEqual(result.run.operationLog, []);
  } finally {
    nativeRuntime.executeEventStream = originalExecuteEventStream;
  }
});

test('conversation append keeps plain text separate from Agent Core parts', () => {
  const project = buildProject();
  const nextProject = appendProjectConversationTurn(project, {
    userMessageId: 'user_message_persistence_core',
    userMessage: '读取文件',
    assistantMessage: '我先读取文件。\n\n已经完成。',
    updatedAt: '2026-05-16T00:00:00.000Z'
  });
  const assistantMessage = getActiveProjectSession(nextProject).chat.findLast((message) => message.role === 'assistant');
  assert.equal(assistantMessage?.metadata?.agentCoreParts, undefined);
  assert.equal(assistantMessage?.content, '我先读取文件。\n\n已经完成。');
  assert.equal(Object.prototype.hasOwnProperty.call(assistantMessage ?? {}, 'contentBlocks'), false);
});

test('conversation append persists canonical Agent Core parts as the only structured ledger', () => {
  const project = buildProject();
  const nextProject = appendProjectConversationTurn(project, {
    userMessageId: 'user_message_projection_core',
    userMessage: '读取文件',
    assistantMessage: '已经完成。',
    assistantMetadata: {
      agentCoreParts: [
        {
          id: 'part_projection_text',
          kind: 'assistant_text',
          sequence: 0,
          createdAt: '2026-05-16T00:00:00.000Z',
          text: '我先读取文件。'
        },
        {
          id: 'part_projection_tool',
          kind: 'tool_call',
          sequence: 1,
          createdAt: '2026-05-16T00:00:01.000Z',
          toolUseId: 'tool_projection_read',
          name: 'read_file',
          input: { path: 'README.md' },
          status: 'completed'
        },
        {
          id: 'part_projection_result',
          kind: 'tool_result',
          sequence: 2,
          createdAt: '2026-05-16T00:00:02.000Z',
          toolUseId: 'tool_projection_read',
          content: '读取完成'
        }
      ]
    },
    updatedAt: '2026-05-16T00:00:03.000Z'
  });
  const assistantMessage = getActiveProjectSession(nextProject).chat.findLast((message) => message.role === 'assistant');

  assert.equal(Object.prototype.hasOwnProperty.call(assistantMessage ?? {}, 'contentBlocks'), false);
  assert.equal(assistantMessage?.metadata?.agentCoreParts?.[1]?.kind, 'tool_call');
});

test('generic conversation surfaces active filesystem skill as an Agent Core part', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-skill-core-part-'));
  const originalExecuteEventStream = nativeRuntime.executeEventStream;
  try {
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'backend-plan'), { recursive: true });
    await writeFile(join(projectPath, '.claude', 'skills', 'backend-plan', 'SKILL.md'), [
      '---',
      'name: backend-plan',
      'description: Plan backend changes.',
      '---',
      '',
      'Use backend planning steps.'
    ].join('\n'), 'utf8');
    nativeRuntime.executeEventStream = resultStreamForTest({
      assistantMessage: '已经完成。',
      assistantIntent: 'chat',
      status: 'completed',
      steps: []
    });

    const result = await executeGenericConversation({
      kind: 'conversation',
      project: buildProject(projectPath),
      userMessageId: 'user_message_skill_core_part',
      message: 'Please plan backend changes.'
    });
    const activeSession = getActiveProjectSession(result.project);
    const assistantMessage = activeSession.chat.findLast((message) => message.role === 'assistant');
    const parts = assistantMessage?.metadata?.agentCoreParts ?? [];

    assert.equal(parts[0]?.kind, 'system_event');
    assert.equal(parts[0]?.kind === 'system_event' ? parts[0].metadata?.type : undefined, 'skill_activation');
    assert.equal(parts[0]?.kind === 'system_event' ? parts[0].metadata?.skillName : undefined, 'backend-plan');
    assert.equal(parts.length, 1);
  } finally {
    nativeRuntime.executeEventStream = originalExecuteEventStream;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('generic conversation enforces a session-level run lock', async () => {
  const project = buildProject();
  const originalExecuteEventStream = nativeRuntime.executeEventStream;
  let releaseFirstRun!: () => void;
  let callCount = 0;
  const firstRunReady = new Promise<void>((resolve) => {
    nativeRuntime.executeEventStream = async function* () {
      callCount += 1;
      if (callCount > 1) {
        yield {
          type: 'result',
          result: {
          assistantMessage: 'later done',
          assistantIntent: 'chat',
          status: 'completed',
          steps: []
          }
        };
        return;
      }
      resolve();
      await new Promise<void>((release) => {
        releaseFirstRun = release;
      });
      yield {
        type: 'result',
        result: {
          assistantMessage: 'first done',
          assistantIntent: 'chat',
          status: 'completed',
          steps: []
        }
      };
    };
  });

  try {
    const first = executeGenericConversation({
      kind: 'conversation',
      project,
      message: 'first'
    });
    await firstRunReady;

    const busyStages: string[] = [];
    await assert.rejects(
      () => executeGenericConversation({
        kind: 'conversation',
        project,
        message: 'second',
        onStage: (stage) => busyStages.push(stage.phase ?? stage.stageId)
      }),
      /SESSION_BUSY/
    );
    assert.equal(busyStages.includes('session_busy'), true);

    releaseFirstRun();
    const firstResult = await first;
    assert.equal(firstResult.run.status, 'completed');

    const secondAfterRelease = await executeGenericConversation({
      kind: 'conversation',
      project,
      message: 'third'
    });
    assert.equal(secondAfterRelease.run.status, 'completed');
  } finally {
    nativeRuntime.executeEventStream = originalExecuteEventStream;
  }
});

test('/compact updates Claude summary without appending chat messages', async () => {
  const timestamp = new Date().toISOString();
  let project = buildProject();
  const activeSession = getActiveProjectSession(project);
  const chat: ChatMessage[] = Array.from({ length: 22 }, (_, index) => ({
    id: `compact_chat_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `compact message ${index}`,
    createdAt: timestamp,
    ordinal: index
  }));
  project = replaceProjectSession(project, {
    ...activeSession,
    runtimeOverrides: {
      runtimeId: 'claude-code-sdk',
      claudeCodeSessionId: 'compact-session',
      claudeCodeSessionCwd: '/tmp/funplay-compact'
    },
    chat
  });

  const stages: string[] = [];
  const result = await executeGenericConversation({
    kind: 'conversation',
    project,
    message: '/compact',
    onStage: (stage) => stages.push(stage.phase ?? stage.stageId)
  });
  const compactedSession = getActiveProjectSession(result.project);

  assert.equal(result.run.status, 'completed');
  assert.equal(compactedSession.chat.length, chat.length);
  assert.equal(compactedSession.runtimeOverrides?.claudeCodeSessionId, '');
  assert.match(compactedSession.runtimeOverrides?.claudeContextSummary ?? '', /compact message 0/);
  assert.equal(compactedSession.runtimeOverrides?.claudeContextSummaryCoverage?.boundaryOrdinal, 9);
  assert.equal(stages.includes('context_compressed'), true);
});

test('/compact updates native summary without appending chat messages', async () => {
  const timestamp = new Date().toISOString();
  let project = buildProject();
  const activeSession = getActiveProjectSession(project);
  const chat: ChatMessage[] = Array.from({ length: 18 }, (_, index) => ({
    id: `native_compact_chat_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `native compact message ${index}`,
    createdAt: timestamp,
    ordinal: index,
    storageRowId: index + 1
  }));
  project = replaceProjectSession(project, {
    ...activeSession,
    runtimeOverrides: {
      runtimeId: 'native'
    },
    chat
  });

  const stages: string[] = [];
  const result = await executeGenericConversation({
    kind: 'conversation',
    project,
    message: '/compact',
    onStage: (stage) => stages.push(stage.phase ?? stage.stageId)
  });
  const compactedSession = getActiveProjectSession(result.project);

  assert.equal(result.run.status, 'completed');
  assert.equal(compactedSession.chat.length, chat.length);
  assert.match(compactedSession.runtimeOverrides?.nativeContextSummary ?? '', /native compact message 0/);
  assert.equal(compactedSession.runtimeOverrides?.nativeContextSummaryCoverage?.boundaryRowId, 10);
  assert.equal(compactedSession.runtimeOverrides?.nativeContextSummaryCoverage?.boundaryOrdinal, 9);
  assert.equal(stages.includes('context_compressed'), true);
});

test('Claude Code runtime compacts long resume context into a persistent handoff summary', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-handoff-project-'));
  const fakeCliDir = await mkdtemp(join(tmpdir(), 'funplay-claude-handoff-cli-'));
  const previousCliPath = process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
  const previousForceCli = process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
  const previousLogPath = process.env.FAKE_CLAUDE_LOG;
  const previousProviderSummary = process.env.FUNPLAY_CLAUDE_CONTEXT_SUMMARY_PROVIDER;
  try {
    const fakeCliPath = join(fakeCliDir, 'fake-claude.js');
    const logPath = join(fakeCliDir, 'fake-claude.log');
    await writeFile(
      fakeCliPath,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const logPath = process.env.FAKE_CLAUDE_LOG;",
        "const argv = process.argv.slice(2);",
        "if (logPath) fs.appendFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');",
        "if (argv.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }",
        "if (argv.includes('--resume')) { console.error('unexpected resume'); process.exit(2); }",
        "const events = [",
        "  { type: 'system', subtype: 'init', session_id: 'fresh-handoff', model: 'claude-sonnet-4-6', tools: ['Read'] },",
        "  { type: 'assistant', uuid: 'text-event', message: { content: [{ type: 'text', text: 'handoff ok' }] } },",
        "  { type: 'result', subtype: 'success', result: 'handoff ok', is_error: false, session_id: 'fresh-handoff' }",
        "];",
        "for (const event of events) console.log(JSON.stringify(event));"
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeCliPath, 0o755);
    process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = fakeCliPath;
    process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = '1';
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FUNPLAY_CLAUDE_CONTEXT_SUMMARY_PROVIDER = '0';

    let project = buildProject(projectPath);
    const activeSession = getActiveProjectSession(project);
    const timestamp = new Date().toISOString();
    const chat: ChatMessage[] = Array.from({ length: 22 }, (_, index) => ({
      id: `chat_${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index % 2 === 0
        ? `old user request ${index}: implement feature ${index}${index === 0 ? '. Decision: use SQLite for persistence. Must keep provider keys out of logs.' : ''}`
        : `old assistant response ${index}: completed step ${index}${index === 1 ? '. TODO: verify the browser workflow next.' : ''}`,
      createdAt: timestamp
    }));
    const directSummary = buildClaudeContextSummaryForSession({ ...activeSession, chat });
    assert.match(directSummary ?? '', /Summarized 10 earlier chat messages/);
    assert.match(directSummary ?? '', /old user request 0/);
    assert.match(directSummary ?? '', /Context summary audit/);
    assert.match(directSummary ?? '', /use SQLite/);
    const continuedSummary = buildClaudeContextSummaryForSession({
      ...activeSession,
      runtimeOverrides: {
        claudeContextSummary: 'prior compact summary',
        claudeContextSummaryTurnCount: 5
      },
      chat: [
        ...chat,
        {
          id: 'chat_22',
          role: 'user',
          content: 'new user request 22: continue implementation',
          createdAt: timestamp
        },
        {
          id: 'chat_23',
          role: 'assistant',
          content: 'new assistant response 23: continued implementation',
          createdAt: timestamp
        },
        {
          id: 'chat_24',
          role: 'user',
          content: 'new user request 24: verify changes',
          createdAt: timestamp
        },
        {
          id: 'chat_25',
          role: 'assistant',
          content: 'new assistant response 25: verified changes',
          createdAt: timestamp
        }
      ]
    });
    assert.match(continuedSummary ?? '', /prior compact summary/);
    assert.doesNotMatch(continuedSummary ?? '', /old user request 0/);
    assert.match(continuedSummary ?? '', /old user request 10/);
    project = replaceProjectSession(project, {
      ...activeSession,
      runtimeOverrides: {
        runtimeId: 'claude-code-sdk',
        claudeCodeSessionId: 'old-claude-session',
        claudeCodeSessionCwd: projectPath
      },
      chat
    });
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);
    const stages: Array<{ stageId?: string; status?: string; input?: unknown }> = [];
    const hookEvents: string[] = [];

    const result = await runRuntimeForTest(claudeCodeSdkRuntime, {
      project,
      message: '继续执行当前任务',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-6',
        enabled: true,
        isDefault: true,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      plugins: [],
      context,
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      lifecycleHooks: normalizeAgentLifecycleHookConfig({
        rules: [{
          id: 'precompact_context',
          event: 'PreCompact',
          action: {
            type: 'append_context',
            context: 'PreCompact hook context: verify summary before restarting Claude session.'
          }
        }]
      }),
      onLifecycleHook: (hook) => hookEvents.push(`${hook.event}:${hook.status}:${hook.ruleId}:${hook.trigger.status}`),
      onStage: (stage) => stages.push({ stageId: stage.stageId, status: stage.status, input: stage.input })
    });

    assert.equal(result?.status, 'completed');
    assert.equal(result?.assistantMessage, 'handoff ok');
    assert.equal(result?.sessionRuntimePatch?.claudeCodeSessionId, 'fresh-handoff');
    assert.equal(result?.sessionRuntimePatch?.claudeCodeSessionCwd, projectPath);
    assert.match(result?.sessionRuntimePatch?.claudeContextSummary ?? '', /old user request 0/);
    assert.equal(result?.sessionRuntimePatch?.claudeContextSummaryTurnCount, 5);
    assert.equal(result?.sessionRuntimePatch?.claudeContextSummaryCoverage?.strategy, 'extractive');
    assert.equal(result?.sessionRuntimePatch?.claudeContextSummaryCoverage?.messageCount, 10);
    assert.equal(result?.sessionRuntimePatch?.claudeContextSummaryCoverage?.sourceRuntimeSessionId, 'old-claude-session');
    assert.match(result?.sessionRuntimePatch?.claudeContextSummary ?? '', /provider keys out of logs/);
    assert.match(result?.sessionRuntimePatch?.claudeContextSummaryCoverage?.audit?.decisions.join('\n') ?? '', /use SQLite/);
    assert.match(result?.sessionRuntimePatch?.claudeContextSummaryCoverage?.audit?.constraints.join('\n') ?? '', /provider keys/);
    assert.match(result?.sessionRuntimePatch?.claudeContextSummaryCoverage?.audit?.openTasks.join('\n') ?? '', /browser workflow/);
    assert.deepEqual(hookEvents, ['PreCompact:context_appended:precompact_context:auto']);
    assert.equal(stages.some((stage) => stage.stageId === 'stage:claude_context_handoff'), true);
    assert.equal(stages.some((stage) => stage.stageId?.includes('stage:lifecycle_hook:PreCompact:precompact_context')), true);

    const invocations = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
    const freshInvocation = invocations.find((entry) =>
      entry.argv.includes('--include-partial-messages') &&
      !entry.argv.includes('--version')
    );
    assert.ok(freshInvocation);
    assert.equal(freshInvocation.argv.includes('--resume'), false);
    assert.match(freshInvocation.argv.at(-1) ?? '', /Claude runtime long-context summary/);
    assert.match(freshInvocation.argv.at(-1) ?? '', /old user request 0/);
    assert.match(freshInvocation.argv.at(-1) ?? '', /PreCompact hook context/);
  } finally {
    if (previousCliPath === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = previousCliPath;
    }
    if (previousForceCli === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = previousForceCli;
    }
    if (previousLogPath === undefined) {
      delete process.env.FAKE_CLAUDE_LOG;
    } else {
      process.env.FAKE_CLAUDE_LOG = previousLogPath;
    }
    if (previousProviderSummary === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CONTEXT_SUMMARY_PROVIDER;
    } else {
      process.env.FUNPLAY_CLAUDE_CONTEXT_SUMMARY_PROVIDER = previousProviderSummary;
    }
    await rm(projectPath, { recursive: true, force: true });
    await rm(fakeCliDir, { recursive: true, force: true });
  }
});

test('Claude Code runtime retries stale resume and persists fresh CLI session', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-fake-claude-project-'));
  const fakeCliDir = await mkdtemp(join(tmpdir(), 'funplay-fake-claude-cli-'));
  const previousCliPath = process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
  const previousForceCli = process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
  const previousLogPath = process.env.FAKE_CLAUDE_LOG;
  try {
    const fakeCliPath = join(fakeCliDir, 'fake-claude.js');
    const logPath = join(fakeCliDir, 'fake-claude.log');
    await writeFile(
      fakeCliPath,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const logPath = process.env.FAKE_CLAUDE_LOG;",
        "const argv = process.argv.slice(2);",
        "if (logPath) fs.appendFileSync(logPath, JSON.stringify({ argv, env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL }, cwd: process.cwd() }) + '\\n');",
        "if (argv.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }",
        "if (argv.includes('--resume')) { console.error('resume session missing'); process.exit(1); }",
        "const events = [",
        "  { type: 'system', subtype: 'init', session_id: 'fresh-session', model: 'claude-sonnet-4-6', tools: ['Read', 'TodoWrite'] },",
        "  { type: 'stream_event', event: { type: 'content_block_delta', delta: { thinking: 'thinking' } } },",
        "  { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hello ' } } },",
        "  { type: 'assistant', uuid: 'tool-event', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/App.tsx' } }] } },",
        "  { type: 'tool_progress', tool_use_id: 'toolu_1', tool_name: 'Read', elapsed_time_seconds: 1.2 },",
        "  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'read result' }] }] } },",
        "  { type: 'assistant', uuid: 'text-event', message: { content: [{ type: 'text', text: 'hello world' }] } },",
        "  { type: 'result', subtype: 'success', result: 'hello world', is_error: false, session_id: 'fresh-session' }",
        "];",
        "for (const event of events) console.log(JSON.stringify(event));"
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeCliPath, 0o755);
    process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = fakeCliPath;
    process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = '1';
    process.env.FAKE_CLAUDE_LOG = logPath;

    let project = buildProject(projectPath);
    const activeSession = getActiveProjectSession(project);
    project = replaceProjectSession(project, {
      ...activeSession,
      runtimeOverrides: {
        runtimeId: 'claude-code-sdk',
        claudeCodeSessionId: 'stale-session',
        claudeCodeSessionCwd: projectPath
      }
    });
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const toolResults: string[] = [];
    const hookEvents: string[] = [];
    const stages: Array<{ stageId?: string; status?: string; input?: unknown; summary?: string }> = [];

    const result = await runRuntimeForTest(claudeCodeSdkRuntime, {
      project,
      message: '继续分析',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-6',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context,
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      lifecycleHooks: normalizeAgentLifecycleHookConfig({
        rules: [{
          id: 'audit_claude_read_result',
          event: 'PostToolUse',
          matcher: 'Read',
          action: {
            type: 'audit',
            message: 'Claude read result observed.'
          }
        }]
      }),
      onTextDelta: (delta) => textDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      onToolResult: (toolResult) => toolResults.push(toolResult.content),
      onLifecycleHook: (hook) => {
        hookEvents.push([
          hook.event,
          hook.status,
          hook.ruleId,
          hook.trigger.toolUseId,
          hook.trigger.toolName,
          hook.trigger.status
        ].join(':'));
      },
      onStage: (stage) => stages.push({ stageId: stage.stageId, status: stage.status, input: stage.input, summary: stage.summary })
    });

    assert.equal(result?.status, 'completed');
    assert.equal(result?.assistantMessage, 'hello world');
    assert.deepEqual(result?.sessionRuntimePatch, {
      claudeCodeSessionId: 'fresh-session',
      claudeCodeSessionCwd: projectPath
    });
    assert.equal(textDeltas.join(''), 'hello world');
    assert.equal(thinkingDeltas.join(''), 'thinking');
    assert.deepEqual(toolResults, ['read result']);
    assert.deepEqual(hookEvents, ['PostToolUse:matched:audit_claude_read_result:toolu_1:Read:completed']);
    const postToolHookStage = stages.find((stage) => stage.stageId?.includes('stage:lifecycle_hook:PostToolUse:audit_claude_read_result'));
    assert.equal(postToolHookStage?.status, 'completed');
    assert.match(postToolHookStage?.summary ?? '', /Claude read result observed/);
    assert.match(JSON.stringify(postToolHookStage?.input ?? {}), /read result/);
    assert.equal(stages.some((stage) => stage.stageId === 'stage:claude_resume_fallback'), true);
    assert.equal(stages.some((stage) => stage.stageId === 'stage:claude_cli_init'), true);
    const coreStage = stages.find((stage) => stage.stageId === 'stage:claude_agent_core_v2' && stage.status === 'completed');
    assert.ok(coreStage);
    const coreState = (coreStage.input as { coreState?: { state?: string; history?: Array<{ to?: string }> } } | undefined)?.coreState;
    const providerStep = (coreStage.input as { providerStep?: { finishReason?: string; text?: string } } | undefined)?.providerStep;
    const runController = (coreStage.input as {
      runController?: {
        state?: string;
        nextAction?: string;
        providerStepCount?: number;
        completedToolUseIds?: string[];
        lastDecision?: {
          outcome?: string;
          terminal?: boolean;
        };
      };
    } | undefined)?.runController;
    assert.equal(coreState?.state, 'completed');
    assert.equal(coreState?.history?.some((transition) => transition.to === 'executing_tools'), true);
    assert.equal(providerStep?.finishReason, 'stop');
    assert.equal(providerStep?.text, 'hello world');
    assert.equal(runController?.state, 'completed');
    assert.equal(runController?.nextAction, 'complete');
    assert.equal(runController?.providerStepCount, 2);
    assert.deepEqual(runController?.completedToolUseIds, ['toolu_1']);
    assert.equal(runController?.lastDecision?.outcome, 'complete');
    assert.equal(runController?.lastDecision?.terminal, true);

    const invocations = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string>; cwd: string });
    assert.equal(invocations.some((entry) => entry.argv.includes('--version')), true);
    assert.equal(invocations.some((entry) => entry.argv.includes('--resume') && entry.argv.includes('stale-session')), true);
    const freshInvocation = invocations.find((entry) =>
      entry.argv.includes('--include-partial-messages') &&
      !entry.argv.includes('--resume') &&
      !entry.argv.includes('--version')
    );
    assert.ok(freshInvocation);
    assert.equal(await realpath(freshInvocation.cwd), await realpath(projectPath));
    assert.equal(freshInvocation.env.ANTHROPIC_API_KEY, 'test-key');
    assert.equal(freshInvocation.env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
  } finally {
    if (previousCliPath === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = previousCliPath;
    }
    if (previousForceCli === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = previousForceCli;
    }
    if (previousLogPath === undefined) {
      delete process.env.FAKE_CLAUDE_LOG;
    } else {
      process.env.FAKE_CLAUDE_LOG = previousLogPath;
    }
    await rm(projectPath, { recursive: true, force: true });
    await rm(fakeCliDir, { recursive: true, force: true });
  }
});

test('Claude Code runtime runs UserPromptSubmit and Stop lifecycle hooks', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-prompt-stop-hooks-'));
  const fakeCliDir = await mkdtemp(join(tmpdir(), 'funplay-claude-prompt-stop-cli-'));
  const previousCliPath = process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
  const previousForceCli = process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
  const previousLogPath = process.env.FAKE_CLAUDE_LOG;
  try {
    const fakeCliPath = join(fakeCliDir, 'fake-claude.js');
    const logPath = join(fakeCliDir, 'fake-claude.log');
    await writeFile(
      fakeCliPath,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const logPath = process.env.FAKE_CLAUDE_LOG;",
        "const argv = process.argv.slice(2);",
        "if (logPath) fs.appendFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');",
        "if (argv.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }",
        "const events = [",
        "  { type: 'system', subtype: 'init', session_id: 'prompt-stop-session', model: 'claude-sonnet-4-6', tools: ['Read'] },",
        "  { type: 'assistant', uuid: 'text-event', message: { content: [{ type: 'text', text: 'prompt stop ok' }] } },",
        "  { type: 'result', subtype: 'success', result: 'prompt stop ok', is_error: false, session_id: 'prompt-stop-session' }",
        "];",
        "for (const event of events) console.log(JSON.stringify(event));"
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeCliPath, 0o755);
    process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = fakeCliPath;
    process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = '1';
    process.env.FAKE_CLAUDE_LOG = logPath;

    const project = buildProject(projectPath);
    const hookEvents: string[] = [];
    const stages: Array<{ stageId?: string; status?: string; summary?: string }> = [];
    const result = await runRuntimeForTest(claudeCodeSdkRuntime, {
      project,
      message: '总结项目结构',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-6',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '总结项目结构'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      lifecycleHooks: normalizeAgentLifecycleHookConfig({
        rules: [
          {
            id: 'claude_prompt_context',
            event: 'UserPromptSubmit',
            action: {
              type: 'append_context',
              context: 'UserPromptSubmit hook context: keep answer concise.'
            }
          },
          {
            id: 'claude_stop_audit',
            event: 'Stop',
            action: {
              type: 'audit',
              message: 'Claude stop observed.'
            }
          }
        ]
      }),
      onLifecycleHook: (hook) => hookEvents.push(`${hook.event}:${hook.status}:${hook.ruleId}:${hook.trigger.status ?? ''}`),
      onStage: (stage) => stages.push({ stageId: stage.stageId, status: stage.status, summary: stage.summary })
    });

    assert.equal(result?.status, 'completed');
    assert.equal(result?.assistantMessage, 'prompt stop ok');
    assert.deepEqual(hookEvents, [
      'UserPromptSubmit:context_appended:claude_prompt_context:',
      'Stop:matched:claude_stop_audit:completed'
    ]);
    assert.equal(stages.some((stage) => stage.stageId?.includes('stage:lifecycle_hook:UserPromptSubmit:claude_prompt_context')), true);
    assert.equal(stages.some((stage) => stage.stageId?.includes('stage:lifecycle_hook:Stop:claude_stop_audit')), true);

    const invocations = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
    const promptInvocation = invocations.find((entry) =>
      entry.argv.includes('--include-partial-messages') &&
      !entry.argv.includes('--version')
    );
    assert.ok(promptInvocation);
    assert.match(promptInvocation.argv.at(-1) ?? '', /UserPromptSubmit hook context: keep answer concise/);
  } finally {
    if (previousCliPath === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = previousCliPath;
    }
    if (previousForceCli === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = previousForceCli;
    }
    if (previousLogPath === undefined) {
      delete process.env.FAKE_CLAUDE_LOG;
    } else {
      process.env.FAKE_CLAUDE_LOG = previousLogPath;
    }
    await rm(projectPath, { recursive: true, force: true });
    await rm(fakeCliDir, { recursive: true, force: true });
  }
});

test('Claude Code runtime clears stale resume id when fresh retry also fails', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-fake-claude-clear-project-'));
  const fakeCliDir = await mkdtemp(join(tmpdir(), 'funplay-fake-claude-clear-cli-'));
  const previousCliPath = process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
  const previousForceCli = process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
  try {
    const fakeCliPath = join(fakeCliDir, 'fake-claude.js');
    await writeFile(
      fakeCliPath,
      [
        '#!/usr/bin/env node',
        'const argv = process.argv.slice(2);',
        "if (argv.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }",
        "if (argv.includes('--resume')) { console.error('resume session missing'); process.exit(1); }",
        "console.error('fresh provider failed');",
        'process.exit(2);'
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeCliPath, 0o755);
    process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = fakeCliPath;
    process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = '1';

    let project = buildProject(projectPath);
    const activeSession = getActiveProjectSession(project);
    project = replaceProjectSession(project, {
      ...activeSession,
      runtimeOverrides: {
        runtimeId: 'claude-code-sdk',
        claudeCodeSessionId: 'stale-session',
        claudeCodeSessionCwd: projectPath
      }
    });
    const result = await runRuntimeForTest(claudeCodeSdkRuntime, {
      project,
      message: '继续分析',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-6',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(result?.status, 'fallback');
    assert.equal(result?.sessionRuntimePatch?.claudeCodeSessionId, '');
    assert.equal(result?.sessionRuntimePatch?.claudeCodeSessionCwd, projectPath);
    assert.match(result?.fallbackDetail ?? '', /fresh provider failed/);
  } finally {
    if (previousCliPath === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = previousCliPath;
    }
    if (previousForceCli === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = previousForceCli;
    }
    await rm(projectPath, { recursive: true, force: true });
    await rm(fakeCliDir, { recursive: true, force: true });
  }
});

test('Claude external audited writes create rollback checkpoints', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-external-write-'));
  const fakeCliDir = await mkdtemp(join(tmpdir(), 'funplay-claude-external-write-cli-'));
  const previousCliPath = process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
  const previousForceCli = process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'existing.txt'), 'old content', 'utf8');
    await writeFile(join(projectPath, 'src', 'removed.txt'), 'remove me', 'utf8');
    const fakeCliPath = join(fakeCliDir, 'fake-claude.js');
    await writeFile(
      fakeCliPath,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const argv = process.argv.slice(2);",
        "if (argv.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }",
        "fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });",
        "fs.writeFileSync(path.join(process.cwd(), 'src', 'existing.txt'), 'changed content');",
        "fs.writeFileSync(path.join(process.cwd(), 'src', 'added.txt'), 'new content');",
        "fs.rmSync(path.join(process.cwd(), 'src', 'removed.txt'), { force: true });",
        "const events = [",
        "  { type: 'system', subtype: 'init', session_id: 'external-write-session', model: 'claude-sonnet-4-6', tools: ['Read', 'Write', 'Edit'] },",
        "  { type: 'assistant', uuid: 'text-event', message: { content: [{ type: 'text', text: 'files changed' }] } },",
        "  { type: 'result', subtype: 'success', result: 'files changed', is_error: false, session_id: 'external-write-session' }",
        "];",
        "for (const event of events) console.log(JSON.stringify(event));"
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeCliPath, 0o755);
    process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = fakeCliPath;
    process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = '1';

    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/existing.txt 并创建 src/added.txt');
    const stages: Array<{ stageId: string; input?: Record<string, unknown> }> = [];
    const result = await runRuntimeForTest(claudeCodeSdkRuntime, {
      project,
      message: '修改 src/existing.txt，创建 src/added.txt，并删除 src/removed.txt',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
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
      checkpointSnapshotId: 'snapshot_external_write_rollback',
      onStage: (stage) => stages.push({ stageId: stage.stageId, input: stage.input })
    });

    assert.equal(result?.status, 'completed');
    assert.equal(await readFile(join(projectPath, 'src', 'existing.txt'), 'utf8'), 'changed content');
    assert.equal(await readFile(join(projectPath, 'src', 'added.txt'), 'utf8'), 'new content');
    assert.equal(existsSync(join(projectPath, 'src', 'removed.txt')), false);
    const auditStage = stages.find((stage) => stage.stageId === 'stage:external_write_audit');
    assert.ok(auditStage);
    assert.equal(auditStage.input?.checkpointPolicy, 'external_rollback_available');
    assert.deepEqual(auditStage.input?.rollbackFiles, ['src/added.txt', 'src/existing.txt', 'src/removed.txt']);
    const writeModeStage = stages.find((stage) => stage.stageId === 'stage:claude_write_mode');
    assert.ok(writeModeStage);
    assert.equal(writeModeStage.input?.writeMode, 'external-audited');
    assert.equal(writeModeStage.input?.externalWriteRollback, true);
    assert.equal((writeModeStage.input?.toolPolicy as { requiresWorkspaceWritePermission?: boolean } | undefined)?.requiresWorkspaceWritePermission, true);

    const rollback = await executeAgentToolAction(
      project,
      {
        type: 'checkpoint_rollback',
        reason: 'test rollback external audited writes'
      },
      {
        checkpointSnapshotId: 'snapshot_external_write_rollback'
      }
    );
    assert.equal(rollback.ok, true);
    assert.equal(await readFile(join(projectPath, 'src', 'existing.txt'), 'utf8'), 'old content');
    assert.equal(await readFile(join(projectPath, 'src', 'removed.txt'), 'utf8'), 'remove me');
    assert.equal(existsSync(join(projectPath, 'src', 'added.txt')), false);
  } finally {
    if (previousCliPath === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = previousCliPath;
    }
    if (previousForceCli === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = previousForceCli;
    }
    await rm(projectPath, { recursive: true, force: true });
    await rm(fakeCliDir, { recursive: true, force: true });
  }
});

test('Claude read-only write requests stop before external writes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-claude-denied-write-'));
  const fakeCliDir = await mkdtemp(join(tmpdir(), 'funplay-claude-denied-write-cli-'));
  const previousCliPath = process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
  const previousForceCli = process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'existing.txt'), 'before', 'utf8');
    const fakeCliPath = join(fakeCliDir, 'fake-claude.js');
    await writeFile(
      fakeCliPath,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const argv = process.argv.slice(2);",
        "if (argv.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }",
        "fs.writeFileSync(path.join(process.cwd(), 'src', 'existing.txt'), 'should not run');",
        "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'unexpected', is_error: false, session_id: 'denied-write-session' }));"
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeCliPath, 0o755);
    process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = fakeCliPath;
    process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = '1';

    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/existing.txt');
    const stages: Array<{ stageId: string; input?: Record<string, unknown>; status?: string }> = [];
    const result = await runRuntimeForTest(claudeCodeSdkRuntime, {
      project,
      message: '修改 src/existing.txt',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-6',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context,
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      checkpointSnapshotId: 'snapshot_denied_write',
      onStage: (stage) => stages.push({ stageId: stage.stageId, input: stage.input, status: stage.status })
    });

    assert.equal(result?.status, 'fallback');
    assert.match(result?.fallbackDetail ?? '', /write_permission_denied/);
    assert.equal(await readFile(join(projectPath, 'src', 'existing.txt'), 'utf8'), 'before');
    const permissionStage = stages.find((stage) => stage.stageId === 'stage:permission' && stage.status === 'failed');
    assert.ok(permissionStage);
    assert.equal((permissionStage.input?.toolPolicy as { requiresWorkspaceWritePermission?: boolean } | undefined)?.requiresWorkspaceWritePermission, true);
  } finally {
    if (previousCliPath === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_CLI_PATH = previousCliPath;
    }
    if (previousForceCli === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = previousForceCli;
    }
    await rm(projectPath, { recursive: true, force: true });
    await rm(fakeCliDir, { recursive: true, force: true });
  }
});

test('openai-compatible providers bypass AI SDK language models for native tools', () => {
  const timestamp = new Date().toISOString();
  assert.throws(
    () => createLanguageModel({
      id: 'provider_openai_compat',
      name: 'OpenAI Compat',
      protocol: 'openai-compatible',
      baseUrl: 'https://example.com/v1',
      apiKey: '',
      hasStoredApiKey: false,
      model: 'gpt-test',
      apiMode: 'chat',
      enabled: true,
      isDefault: false,
      notes: '',
      createdAt: timestamp,
      updatedAt: timestamp
    }),
    /Funplay native protocol adapters/
  );
});

test('read-only workspace tools are registered through the tool registry', () => {
  const tools = listReadOnlyWorkspaceToolDefinitions();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'ask_user',
      'browser_console',
      'browser_list',
      'browser_screenshot',
      'browser_snapshot',
      'checkpoint_diff',
      'diagnose_engine_status',
      'find_files',
      'funplay_list_tasks',
      'funplay_memory_get',
      'funplay_memory_recent',
      'funplay_memory_search',
      'funplay_notify',
      'inspect_game_project',
      'list_agent_skill_files',
      'list_agent_skills',
      'list_asset_generation_capabilities',
      'list_mcp_resources',
      'list_mcp_tools',
      'media_attach_file',
      'preview_file_diff',
      'preview_patch',
      'read_agent_skill',
      'read_agent_skill_file',
      'read_document',
      'read_file',
      'read_mcp_resource',
      'refresh_engine_runtime_state',
      'run_subagent',
      'run_subagents',
      'scan_file_tree',
      'search_project_content',
      'subagent_start',
      'subagent_status',
      'summarize_directory',
      'terminal_list',
      'terminal_read',
      'update_todo_list',
      'web_fetch',
      'web_search'
    ]
  );
  assert.equal(tools.every((tool) => tool.risk === 'low' && tool.readOnly && tool.checkpointPolicy === 'none'), true);
});

test('tool registry includes write and MCP metadata boundaries', () => {
  assert.deepEqual(
    listAgentToolDefinitions().map((tool) => tool.name).sort(),
    [
      'ask_user',
      'browser_click',
      'browser_close',
      'browser_console',
      'browser_list',
      'browser_navigate',
      'browser_open',
      'browser_screenshot',
      'browser_snapshot',
      'browser_type',
      'call_mcp_tool',
      'checkpoint_diff',
      'checkpoint_rollback',
      'create_directory',
      'diagnose_engine_status',
      'edit_file',
      'find_files',
      'funplay_cancel_task',
      'funplay_list_tasks',
      'funplay_memory_get',
      'funplay_memory_recent',
      'funplay_memory_remember',
      'funplay_memory_search',
      'funplay_notify',
      'funplay_schedule_task',
      'generate_asset',
      'image_generate',
      'import_generated_asset',
      'inspect_game_project',
      'install_engine_bridge',
      'list_agent_skill_files',
      'list_agent_skills',
      'list_asset_generation_capabilities',
      'list_mcp_resources',
      'list_mcp_tools',
      'media_attach_file',
      'media_save_base64',
      'multi_edit',
      'open_engine_hub',
      'open_engine_project',
      'patch_file',
      'preview_file_diff',
      'preview_patch',
      'read_agent_skill',
      'read_agent_skill_file',
      'read_document',
      'read_file',
      'read_mcp_resource',
      'refresh_engine_runtime_state',
      'run_command',
      'run_subagent',
      'run_subagents',
      'scan_file_tree',
      'search_project_content',
      'subagent_start',
      'subagent_status',
      'summarize_directory',
      'terminal_list',
      'terminal_read',
      'terminal_start',
      'terminal_stop',
      'terminal_write',
      'update_todo_list',
      'web_fetch',
      'web_search',
      'write_file'
    ]
  );

  const writeFile = getAgentToolDefinition('write_file');
  assert.equal(writeFile?.readOnly, false);
  assert.equal(writeFile?.risk, 'medium');
  assert.equal(writeFile?.checkpointPolicy, 'before_write');
  assert.deepEqual(
    writeFile?.toAction({
      path: 'src/a.ts',
      content: 'export {};',
      reason: 'test'
    }),
    {
      type: 'write_file',
      path: 'src/a.ts',
      content: 'export {};',
      reason: 'test'
    }
  );

  const createDirectory = getAgentToolDefinition('create_directory');
  assert.equal(createDirectory?.readOnly, false);
  assert.equal(createDirectory?.risk, 'medium');
  assert.equal(createDirectory?.checkpointPolicy, 'before_write');
  assert.deepEqual(
    createDirectory?.toAction({
      path: 'assets/images',
      reason: 'test'
    }),
    {
      type: 'create_directory',
      path: 'assets/images',
      reason: 'test'
    }
  );

  const callMcpTool = getAgentToolDefinition('call_mcp_tool');
  assert.equal(callMcpTool?.risk, 'high');
  assert.equal(callMcpTool?.checkpointPolicy, 'external_best_effort');

  const editFile = getAgentToolDefinition('edit_file');
  assert.equal(editFile?.readOnly, false);
  assert.equal(editFile?.risk, 'medium');
  assert.equal(editFile?.checkpointPolicy, 'before_write');

  const multiEdit = getAgentToolDefinition('multi_edit');
  assert.equal(multiEdit?.readOnly, false);
  assert.equal(multiEdit?.risk, 'medium');
  assert.equal(multiEdit?.checkpointPolicy, 'before_write');

  const runCommand = getAgentToolDefinition('run_command');
  assert.equal(runCommand?.readOnly, false);
  assert.equal(runCommand?.risk, 'high');
  assert.equal(runCommand?.checkpointPolicy, 'external_best_effort');

  const updateTodoList = getAgentToolDefinition('update_todo_list');
  assert.equal(updateTodoList?.readOnly, true);
  assert.equal(updateTodoList?.risk, 'low');
  assert.equal(updateTodoList?.title, '任务清单');
  assert.deepEqual(
    updateTodoList?.toAction({
      todos: [
        {
          id: 'inspect',
          content: 'Read affected files',
          status: 'in_progress',
          priority: 'high'
        }
      ]
    }),
    {
      type: 'update_todo_list',
      items: [
        {
          id: 'inspect',
          content: 'Read affected files',
          status: 'in_progress',
          priority: 'high'
        }
      ]
    }
  );
});

test('native tool permission delegates registered write tools through broker', async () => {
  const denied = await resolveNativeToolPermission(
    {
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    },
    {
      toolName: 'write_file',
      input: {
        path: 'src/App.tsx'
      },
      isWrite: true
    }
  );
  assert.equal(denied, 'deny');

  const requested: Array<{
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    toolName?: string;
  }> = [];
  const allowed = await resolveNativeToolPermission(
    {
      permission: {
        mode: 'ask',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      requestPermission: async (request) => {
        requested.push(request);
        return 'allow';
      }
    },
    {
      toolName: 'call_mcp_tool',
      input: {
        toolName: 'execute_code'
      },
      isWrite: true
    }
  );

  assert.equal(allowed, 'allow');
  assert.equal(requested[0]?.risk, 'high');
  assert.equal(requested[0]?.toolName, 'call_mcp_tool');
  assert.match(requested[0]?.detail ?? '', /检查点策略：external_best_effort/);
});

test('permission broker covers Claude external write subjects', async () => {
  const requests: Array<{
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
  }> = [];
  const context = {
    permission: {
      mode: 'ask' as const,
      allowWriteTools: false,
      allowSessionWriteTools: false
    },
    requestPermission: async (request: {
      title: string;
      detail: string;
      risk: 'low' | 'medium' | 'high';
      toolName?: string;
    }) => {
      requests.push(request);
      return 'allow' as const;
    }
  };

  assert.equal(
    await resolveAgentToolPermission(context, {
      tool: {
        name: 'claude_code_external_write',
        title: 'Claude Code External Write Mode',
        risk: 'high',
        readOnly: false,
        permissionPolicy: 'ask',
        checkpointPolicy: 'external_best_effort'
      },
      input: {
        runtimeId: 'claude-code-sdk'
      }
    }),
    'allow'
  );

  assert.equal(requests.length, 1);
  assert.equal(requests.every((request) => request.risk === 'high'), true);
  assert.equal(requests.every((request) => /external_best_effort/.test(request.detail)), true);
});

test('native tool adapter exposes write tools only behind explicit option', async () => {
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listNativeWorkspaceToolNames().includes('write_file'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('ask_user'), true);
  assert.equal(listNativeWorkspaceToolNames().includes('create_directory'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('edit_file'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('multi_edit'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('patch_file'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('checkpoint_rollback'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('funplay_memory_remember'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('funplay_schedule_task'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('media_save_base64'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('image_generate'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('generate_asset'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('import_generated_asset'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('open_engine_hub'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('open_engine_project'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('install_engine_bridge'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('run_command'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('terminal_start'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('browser_open'), false);
  assert.equal(listNativeWorkspaceToolNames().includes('browser_navigate'), false);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('create_directory'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('write_file'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('edit_file'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('multi_edit'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('patch_file'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('checkpoint_rollback'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('funplay_memory_remember'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('funplay_schedule_task'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('media_save_base64'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('image_generate'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('generate_asset'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('import_generated_asset'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('open_engine_hub'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('open_engine_project'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeWriteTools: true }).includes('install_engine_bridge'), true);
  assert.equal(listNativeWorkspaceToolNames().includes('call_mcp_tool'), false);
  assert.equal(listNativeWorkspaceToolNames({ includeMcpToolCalls: true }).includes('call_mcp_tool'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeCommandTools: true }).includes('run_command'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeCommandTools: true }).includes('terminal_start'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeCommandTools: true }).includes('terminal_write'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeCommandTools: true }).includes('terminal_stop'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeCommandTools: true }).includes('browser_open'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeCommandTools: true }).includes('browser_navigate'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeCommandTools: true }).includes('browser_click'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeCommandTools: true }).includes('browser_type'), true);
  assert.equal(listNativeWorkspaceToolNames({ includeCommandTools: true }).includes('browser_close'), true);

  const project = buildProject('/tmp/funplay-runtime-test');
  assert.deepEqual(
    Object.keys(createNativeWorkspaceTools({ project })).sort(),
    [
      'ask_user',
      'browser_console',
      'browser_list',
      'browser_screenshot',
      'browser_snapshot',
      'checkpoint_diff',
      'diagnose_engine_status',
      'find_files',
      'funplay_list_tasks',
      'funplay_memory_get',
      'funplay_memory_recent',
      'funplay_memory_search',
      'funplay_notify',
      'inspect_game_project',
      'list_agent_skill_files',
      'list_agent_skills',
      'list_asset_generation_capabilities',
      'list_mcp_resources',
      'list_mcp_tools',
      'media_attach_file',
      'preview_file_diff',
      'preview_patch',
      'read_agent_skill',
      'read_agent_skill_file',
      'read_document',
      'read_file',
      'read_mcp_resource',
      'refresh_engine_runtime_state',
      'run_subagent',
      'run_subagents',
      'scan_file_tree',
      'search_project_content',
      'subagent_start',
      'subagent_status',
      'summarize_directory',
      'terminal_list',
      'terminal_read',
      'update_todo_list',
      'web_fetch',
      'web_search'
    ]
  );
  assert.deepEqual(
    Object.keys(createNativeWorkspaceTools({ project, includeWriteTools: true })).sort(),
    [
      'ask_user',
      'browser_console',
      'browser_list',
      'browser_screenshot',
      'browser_snapshot',
      'checkpoint_diff',
      'checkpoint_rollback',
      'create_directory',
      'diagnose_engine_status',
      'edit_file',
      'find_files',
      'funplay_cancel_task',
      'funplay_list_tasks',
      'funplay_memory_get',
      'funplay_memory_recent',
      'funplay_memory_remember',
      'funplay_memory_search',
      'funplay_notify',
      'funplay_schedule_task',
      'generate_asset',
      'image_generate',
      'import_generated_asset',
      'inspect_game_project',
      'install_engine_bridge',
      'list_agent_skill_files',
      'list_agent_skills',
      'list_asset_generation_capabilities',
      'list_mcp_resources',
      'list_mcp_tools',
      'media_attach_file',
      'media_save_base64',
      'multi_edit',
      'open_engine_hub',
      'open_engine_project',
      'patch_file',
      'preview_file_diff',
      'preview_patch',
      'read_agent_skill',
      'read_agent_skill_file',
      'read_document',
      'read_file',
      'read_mcp_resource',
      'refresh_engine_runtime_state',
      'run_subagent',
      'run_subagents',
      'scan_file_tree',
      'search_project_content',
      'subagent_start',
      'subagent_status',
      'summarize_directory',
      'terminal_list',
      'terminal_read',
      'update_todo_list',
      'web_fetch',
      'web_search',
      'write_file'
    ]
  );
  assert.deepEqual(
    Object.keys(createNativeWorkspaceTools({ project, includeMcpToolCalls: true })).sort(),
    [
      'ask_user',
      'browser_console',
      'browser_list',
      'browser_screenshot',
      'browser_snapshot',
      'call_mcp_tool',
      'checkpoint_diff',
      'diagnose_engine_status',
      'find_files',
      'funplay_list_tasks',
      'funplay_memory_get',
      'funplay_memory_recent',
      'funplay_memory_search',
      'funplay_notify',
      'inspect_game_project',
      'list_agent_skill_files',
      'list_agent_skills',
      'list_asset_generation_capabilities',
      'list_mcp_resources',
      'list_mcp_tools',
      'media_attach_file',
      'preview_file_diff',
      'preview_patch',
      'read_agent_skill',
      'read_agent_skill_file',
      'read_document',
      'read_file',
      'read_mcp_resource',
      'refresh_engine_runtime_state',
      'run_subagent',
      'run_subagents',
      'scan_file_tree',
      'search_project_content',
      'subagent_start',
      'subagent_status',
      'summarize_directory',
      'terminal_list',
      'terminal_read',
      'update_todo_list',
      'web_fetch',
      'web_search'
    ]
  );
  assert.deepEqual(
    Object.keys(createNativeWorkspaceTools({ project, includeCommandTools: true })).sort(),
    [
      'ask_user',
      'browser_click',
      'browser_close',
      'browser_console',
      'browser_list',
      'browser_navigate',
      'browser_open',
      'browser_screenshot',
      'browser_snapshot',
      'browser_type',
      'checkpoint_diff',
      'diagnose_engine_status',
      'find_files',
      'funplay_list_tasks',
      'funplay_memory_get',
      'funplay_memory_recent',
      'funplay_memory_search',
      'funplay_notify',
      'inspect_game_project',
      'list_agent_skill_files',
      'list_agent_skills',
      'list_asset_generation_capabilities',
      'list_mcp_resources',
      'list_mcp_tools',
      'media_attach_file',
      'preview_file_diff',
      'preview_patch',
      'read_agent_skill',
      'read_agent_skill_file',
      'read_document',
      'read_file',
      'read_mcp_resource',
      'refresh_engine_runtime_state',
      'run_command',
      'run_subagent',
      'run_subagents',
      'scan_file_tree',
      'search_project_content',
      'subagent_start',
      'subagent_status',
      'summarize_directory',
      'terminal_list',
      'terminal_read',
      'terminal_start',
      'terminal_stop',
      'terminal_write',
      'update_todo_list',
      'web_fetch',
      'web_search'
    ]
  );
});

test('native tool pool centralizes AI SDK and OpenAI-compatible tool definitions', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-tool-pool-'));
  const server = await startTestMcpServer();
  try {
    const project = buildProject(projectPath);
    const plugin = buildMcpPlugin(server.baseUrl);
    const pool = await createNativeToolPool({
      params: {
        project,
        message: 'inspect native tool pool',
        plugins: [plugin],
        context: buildGenericWorkspaceContext(project, [plugin], getActiveProjectSession(project).id, 'inspect native tool pool'),
        permission: {
          mode: 'full-access',
          allowWriteTools: true,
          allowSessionWriteTools: false
        }
      },
      mode: {
        includeWriteTools: true,
        includeMcpToolCalls: true,
        includeCommandTools: true
      }
    });

    const definitionNames = pool.definitions.map((definition) => definition.name).sort();
    assert.deepEqual(Object.keys(pool.toolSet).sort(), definitionNames);
    assert.deepEqual(pool.openAiCompatibleTools.map((definition) => definition.name).sort(), definitionNames);
    assert.deepEqual([...pool.names].sort(), definitionNames);
    assert.equal(pool.names.includes('write_file'), true);
    assert.equal(pool.names.includes('run_command'), true);
    assert.equal(pool.names.includes('call_mcp_tool'), true);
    assert.equal(pool.names.includes('mcp__test_mcp__unity_echo'), true);
    const dynamicMcpTool = pool.openAiCompatibleTools.find((definition) => definition.name === 'mcp__test_mcp__unity_echo');
    assert.deepEqual((dynamicMcpTool?.parameters as { properties?: unknown } | undefined)?.properties, {
      value: {
        type: 'string'
      }
    });
  } finally {
    await server.close();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native tool loop permission copy distinguishes build from plan', () => {
  const buildInstructions = createNativeToolLoopPermissionInstructions({
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }, {
    includeWriteTools: false,
    includeMcpToolCalls: false,
    includeCommandTools: false
  }).join('\n');
  assert.match(buildInstructions, /当前界面模式：Build/);
  assert.doesNotMatch(buildInstructions, /当前界面模式：Plan/);

  const buildWithWriteTools = createNativeToolLoopPermissionInstructions({
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }, {
    includeWriteTools: true,
    includeMcpToolCalls: false,
    includeCommandTools: false
  }).join('\n');
  assert.match(buildWithWriteTools, /host 会在执行点完成权限、checkpoint 和拒绝处理/);
  assert.match(buildWithWriteTools, /write_file/);
  assert.doesNotMatch(buildWithWriteTools, /本轮写入权限/);

  const planInstructions = createNativeToolLoopPermissionInstructions({
    permission: {
      mode: 'read-only',
      allowWriteTools: false,
      allowSessionWriteTools: false
    }
  }, {
    includeWriteTools: false,
    includeMcpToolCalls: false,
    includeCommandTools: true
  }).join('\n');
  assert.match(planInstructions, /当前界面模式：Plan/);
  assert.match(planInstructions, /项目写入工具未出现在工具列表/);
  assert.match(planInstructions, /host 会在执行点完成权限判断/);
  assert.doesNotMatch(planInstructions, /执行前必须获得用户确认/);
});

test('runtime prompts describe Funplay HTML preview inline script support', () => {
  const nativePrompt = createNativeRuntimeSystemPrompt();
  assert.match(nativePrompt, /Funplay 项目预览能力/);
  assert.match(nativePrompt, /支持普通 HTML5\/Canvas 网页游戏所需的内联 JavaScript/);
  assert.match(nativePrompt, /不要默认声称“嵌入式浏览器无法运行内联脚本”/);
  assert.match(nativePrompt, /不要默认要求用户双击 HTML 或改用外部浏览器/);
  assert.match(nativePrompt, /音频、背景音乐或 WebAudio 仍可能需要用户首次点击\/交互后才会播放/);
  assert.match(nativePrompt, /Default response language: reply to the user in English/);
  assert.match(createNativeRuntimeSystemPrompt('zh-CN'), /默认回复语言：请使用简体中文回答用户/);

  const claudePrompt = createClaudeSystemPrompt();
  assert.match(claudePrompt, /Funplay project preview capability/);
  assert.match(claudePrompt, /supports inline JavaScript/);
  assert.match(claudePrompt, /Do not claim that the embedded browser cannot run inline scripts/);
  assert.match(claudePrompt, /Do not default to telling the user to double-click the HTML file/);
  assert.match(claudePrompt, /Audio, background music, or WebAudio may still require the user to click\/interact once/);
  assert.match(claudePrompt, /Default response language: reply to the user in English/);
  assert.match(createClaudeSystemPrompt(undefined, undefined, 'zh-CN'), /默认回复语言：请使用简体中文回答用户/);
});

test('native provider step timeout follows opencode-style five minute provider boundary', () => {
  assert.equal(NATIVE_MAIN_PROVIDER_STEP_TIMEOUT_MS, 300_000);
  assert.equal(NATIVE_SUBAGENT_PROVIDER_STEP_TIMEOUT_MS, 300_000);

  const timeoutError = new Error('Native OpenAI-compatible provider step timed out after 300s.');
  timeoutError.name = 'NativeProviderStepTimeoutError';
  const diagnostic = classifyNativeRuntimeError({
    error: timeoutError,
    provider: {
      id: 'provider_timeout',
      name: 'OpenAI-compatible',
      protocol: 'openai-compatible',
      apiMode: 'chat',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'gpt-test',
      enabled: true,
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  });

  assert.equal(diagnostic.code, 'native_provider_timeout');
  assert.match(diagnostic.summary, /Provider 单轮响应超时/);
});

test('native subagent tool is read-only and delegates to internal executor', async () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const tools = createNativeWorkspaceTools({
    project,
    runSubagent: async (action) => ({
      ok: true,
      summary: `subagent:${action.task}:${action.scope ?? 'all'}`
    })
  });

  const result = await executeNativeWorkspaceTool(tools, 'run_subagent', {
    task: 'Find renderer entrypoints',
    scope: 'src'
  });

  assert.equal(result.ok, true);
  assert.match(String(result.summary), /subagent:Find renderer entrypoints:src/);
  assert.equal(listNativeWorkspaceToolNames({ excludeTools: ['run_subagent'] }).includes('run_subagent'), false);
  assert.equal(listNativeWorkspaceToolNames({ excludeTools: ['run_subagent', 'run_subagents'] }).includes('run_subagents'), false);
});

test('native parallel subagent tool delegates multiple read-only tasks', async () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const tools = createNativeWorkspaceTools({
    project,
    runSubagents: async (action) => ({
      ok: true,
      summary: action.tasks.map((task) => `parallel:${task.task}:${task.scope ?? 'all'}`).join('\n')
    })
  });

  const result = await executeNativeWorkspaceTool(tools, 'run_subagents', {
    tasks: [
      {
        task: 'Find renderer entrypoints',
        scope: 'src'
      },
      {
        task: 'Find runtime services',
        scope: 'electron/main'
      }
    ],
    maxSteps: 4
  });

  assert.equal(result.ok, true);
  assert.match(String(result.summary), /parallel:Find renderer entrypoints:src/);
  assert.match(String(result.summary), /parallel:Find runtime services:electron\/main/);
});

test('native subagent tools emit SubagentStop lifecycle hooks after delegated completion', async () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const hookEvents: string[] = [];
  const stageIds: string[] = [];
  const tools = createNativeWorkspaceTools({
    project,
    lifecycleHooks: normalizeAgentLifecycleHookConfig({
      rules: [{
        id: 'subagent_stop_audit',
        event: 'SubagentStop',
        matcher: 'run_subagent',
        action: {
          type: 'audit',
          message: 'Subagent completed.'
        }
      }]
    }),
    onLifecycleHook: (hook) => hookEvents.push(`${hook.event}:${hook.status}:${hook.ruleId}:${hook.trigger.status}`),
    emitLifecycleHookStage: (stage) => stageIds.push(stage.stageId),
    runSubagent: async (action) => ({
      ok: true,
      summary: `subagent:${action.task}:${action.scope ?? 'all'}`
    })
  });

  const result = await executeNativeWorkspaceTool(tools, 'run_subagent', {
    task: 'Find renderer entrypoints',
    scope: 'src'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(hookEvents, ['SubagentStop:matched:subagent_stop_audit:completed']);
  assert.equal(stageIds.some((stageId) => stageId.includes('stage:lifecycle_hook:SubagentStop:subagent_stop_audit')), true);
});

test('native background subagent tools delegate start and status handlers', async () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const tools = createNativeWorkspaceTools({
    project,
    startSubagent: async (action) => ({
      ok: true,
      summary: `started:${action.name ?? 'unnamed'}:${action.task}`
    }),
    readSubagentStatus: async (action) => ({
      ok: true,
      summary: `status:${action.taskId ?? 'all'}:${action.includeCompleted ?? true}`
    })
  });

  const startResult = await executeNativeWorkspaceTool(tools, 'subagent_start', {
    name: 'Runtime scan',
    task: 'Find runtime services',
    scope: 'electron/main',
    maxSteps: 4
  });
  assert.equal(startResult.ok, true);
  assert.match(String(startResult.summary), /started:Runtime scan:Find runtime services/);

  const statusResult = await executeNativeWorkspaceTool(tools, 'subagent_status', {
    taskId: 'subagent_123',
    includeCompleted: false
  });
  assert.equal(statusResult.ok, true);
  assert.match(String(statusResult.summary), /status:subagent_123:false/);
});

test('native tool adapter compacts oversized tool results', async () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const longSummary = `${'head-'.repeat(3000)}TAIL_MARKER`;
  const tools = createNativeWorkspaceTools({
    project,
    runSubagent: async () => ({
      ok: true,
      summary: longSummary
    })
  });

  const result = await executeNativeWorkspaceTool(tools, 'run_subagent', {
    task: 'Return large output'
  });

  assert.equal(result.ok, true);
  assert.equal(result.summaryTruncated, true);
  assert.equal(result.originalSummaryLength, longSummary.length);
  assert.ok(String(result.summary).length <= NATIVE_TOOL_OUTPUT_MAX_CHARS);
  assert.match(String(result.summary), /Native tool output truncated/);
  assert.match(String(result.summary), /TAIL_MARKER/);
});

test('native ask_user tool delegates to user input request handler', async () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const tools = createNativeWorkspaceTools({
    project,
    requestUserInput: async (action) => {
      assert.equal(action.multiSelect, true);
      return {
        ok: true,
        summary: `Asked: ${action.question}`
      };
    }
  });

  const result = await executeNativeWorkspaceTool(tools, 'ask_user', {
    question: 'Which target should be updated?',
    options: [
      { id: 'home', label: 'Home screen' },
      { id: 'settings', label: 'Settings screen' }
    ],
    multiSelect: true,
    allowFreeText: false
  });

  assert.equal(result.ok, true);
  assert.match(String(result.summary), /Which target should be updated/);
});

test('native update_todo_list tool tolerates malformed OpenAI-compatible input', async () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const tools = createNativeWorkspaceTools({
    project
  });

  const missingItems = await executeNativeWorkspaceTool(tools, 'update_todo_list', {});
  const invalidStatus = await executeNativeWorkspaceTool(tools, 'update_todo_list', {
    items: [
      {
        id: 'step_1',
        content: 'Recover from malformed provider input',
        status: 'unknown'
      }
    ]
  });
  const todosAlias = await executeNativeWorkspaceTool(tools, 'update_todo_list', {
    todos: JSON.stringify([
      {
        id: 'step_2',
        content: 'Continue after provider alias input',
        status: 'in_progress',
        priority: 'high'
      },
      {
        id: 'step_3',
        content: 'Skip obsolete task',
        status: 'cancelled',
        priority: 'low'
      }
    ])
  });

  assert.equal(missingItems.ok, true);
  assert.match(String(missingItems.summary), /任务清单为空/);
  assert.equal(invalidStatus.ok, true);
  assert.match(String(invalidStatus.summary), /pending/);
  assert.match(String(invalidStatus.summary), /Recover from malformed provider input/);
  assert.equal(todosAlias.ok, true);
  assert.match(String(todosAlias.summary), /in_progress/);
  assert.match(String(todosAlias.summary), /high/);
  assert.match(String(todosAlias.summary), /cancelled/);
  assert.match(String(todosAlias.summary), /low/);
  assert.match(String(todosAlias.summary), /Continue after provider alias input/);
});

test('native memory tools search, read, and remember project notes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-memory-tools-'));
  try {
    await mkdir(join(projectPath, 'memory', 'daily'), { recursive: true });
    await writeFile(join(projectPath, 'memory.md'), '# Memory\n\n- Prefer compact UI #ux #memory/user-preference\n', 'utf8');
    await writeFile(join(projectPath, 'memory', 'daily', '2026-04-24.md'), '# 2026-04-24\n\n- Added native tools #runtime #memory/task-state\n', 'utf8');
    const project = buildProject(projectPath);

    const search = await executeAgentToolAction(project, {
      type: 'funplay_memory_search',
      query: 'native tools',
      fileType: 'daily',
      memoryKind: 'task_state'
    });
    assert.equal(search.ok, true);
    assert.match(search.summary, /memory\/daily\/2026-04-24\.md/);

    const read = await executeAgentToolAction(project, {
      type: 'funplay_memory_get',
      filePath: 'memory.md'
    });
    assert.equal(read.ok, true);
    assert.match(read.summary, /Prefer compact UI/);

    const remembered = await executeAgentToolAction(project, {
      type: 'funplay_memory_remember',
      note: 'Native runtime can call memory tools',
      memoryType: 'longterm',
      memoryKind: 'decision',
      tags: ['runtime']
    });
    assert.equal(remembered.ok, true);
    assert.match(remembered.summary, /decision/);
    assert.match(await readFile(join(projectPath, 'memory.md'), 'utf8'), /Native runtime can call memory tools #runtime #memory\/decision/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native notification tools send, schedule, list, and cancel tasks', async () => {
  const notify = await executeAgentToolAction(buildProject(), {
    type: 'funplay_notify',
    title: 'Runtime notification',
    body: 'Native callable notification',
    priority: 'low'
  });
  assert.equal(notify.ok, true);
  assert.match(notify.summary, /Runtime notification/);

  const schedule = await executeAgentToolAction(buildProject(), {
    type: 'funplay_schedule_task',
    name: 'Runtime reminder',
    prompt: 'Check native notification tool',
    scheduleType: 'once',
    scheduleValue: new Date(Date.now() + 3_600_000).toISOString(),
    priority: 'low',
    durable: false
  });
  assert.equal(schedule.ok, true);
  const taskId = schedule.summary.match(/ID: (task_[a-z0-9]+)/)?.[1];
  assert.ok(taskId);

  const listed = await executeAgentToolAction(buildProject(), {
    type: 'funplay_list_tasks',
    status: 'active'
  });
  assert.equal(listed.ok, true);
  assert.match(listed.summary, /Runtime reminder/);

  const cancelled = await executeAgentToolAction(buildProject(), {
    type: 'funplay_cancel_task',
    taskId
  });
  assert.equal(cancelled.ok, true);
  assert.match(cancelled.summary, new RegExp(taskId));
});

test('native notification tools emit Notification lifecycle hooks after completion', async () => {
  const project = buildProject();
  const hookEvents: string[] = [];
  const stageIds: string[] = [];
  const tools = createNativeWorkspaceTools({
    project,
    lifecycleHooks: normalizeAgentLifecycleHookConfig({
      rules: [{
        id: 'notification_audit',
        event: 'Notification',
        matcher: 'funplay_notify',
        action: {
          type: 'audit',
          message: 'Notification completed.'
        }
      }]
    }),
    onLifecycleHook: (hook) => hookEvents.push(`${hook.event}:${hook.status}:${hook.ruleId}:${hook.trigger.status}`),
    emitLifecycleHookStage: (stage) => stageIds.push(stage.stageId)
  });

  const result = await executeNativeWorkspaceTool(tools, 'funplay_notify', {
    title: 'Runtime lifecycle notification',
    body: 'Native callable notification hook',
    priority: 'low'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(hookEvents, ['Notification:matched:notification_audit:completed']);
  assert.equal(stageIds.some((stageId) => stageId.includes('stage:lifecycle_hook:Notification:notification_audit')), true);
});

test('native tool adapter forwards checkpoint snapshot to write tools', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-adapter-checkpoint-'));
  try {
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'notes.md'), 'before', 'utf8');
    const tools = createNativeWorkspaceTools({
      project,
      checkpointSnapshotId: 'snapshot_adapter_test',
      includeWriteTools: true,
      permissionContext: {
        permission: {
          mode: 'full-access',
          allowWriteTools: true,
          allowSessionWriteTools: false
        }
      }
    });

    const writeResult = await executeNativeWorkspaceTool(tools, 'write_file', {
      path: 'notes.md',
      content: 'after',
      reason: 'adapter test'
    });

    assert.equal(writeResult.ok, true);
    assert.equal(await readFile(join(projectPath, 'notes.md'), 'utf8'), 'after');

    const restored = await restoreFileCheckpoint(project, 'snapshot_adapter_test');
    assert.deepEqual(restored.restoredFiles, ['notes.md']);
    assert.equal(await readFile(join(projectPath, 'notes.md'), 'utf8'), 'before');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native tool adapter forwards plugins to MCP workspace tools', async () => {
  const server = await startTestMcpServer();
  try {
    const project = buildProject('/tmp/funplay-runtime-test');
    const tools = createNativeWorkspaceTools({
      project,
      plugins: [buildMcpPlugin(server.baseUrl)],
      includeMcpToolCalls: true,
      permissionContext: {
        permission: {
          mode: 'full-access',
          allowWriteTools: true,
          allowSessionWriteTools: false
        }
      }
    });

    const toolsResult = await executeNativeWorkspaceTool(tools, 'list_mcp_tools', {
      pluginId: 'plugin_test_mcp'
    });
    assert.equal(toolsResult.ok, true);
    assert.match(String(toolsResult.summary), /unity\.echo/);
    assert.deepEqual(toolsResult.mcp, {
      pluginId: 'plugin_test_mcp',
      pluginKind: 'engine',
      operation: 'list_tools',
      target: 'tools',
      timeoutMs: 45000,
      contentPartCount: 1,
      schemaGuard: 'passed'
    });

    const resourcesResult = await executeNativeWorkspaceTool(tools, 'list_mcp_resources', {
      pluginId: 'plugin_test_mcp'
    });
    assert.equal(resourcesResult.ok, true);
    assert.match(String(resourcesResult.summary), /unity:\/\/project\/context/);
    assert.deepEqual(resourcesResult.mcp, {
      pluginId: 'plugin_test_mcp',
      pluginKind: 'engine',
      operation: 'list_resources',
      target: 'resources',
      timeoutMs: 45000,
      contentPartCount: 1,
      schemaGuard: 'passed'
    });

    const resourceResult = await executeNativeWorkspaceTool(tools, 'read_mcp_resource', {
      pluginId: 'plugin_test_mcp',
      uri: 'unity://project/context'
    });
    assert.equal(resourceResult.ok, true);
    assert.match(String(resourceResult.summary), /resource:unity:\/\/project\/context/);
    assert.deepEqual(resourceResult.mcp, {
      pluginId: 'plugin_test_mcp',
      pluginKind: 'engine',
      operation: 'read_resource',
      target: 'unity://project/context',
      timeoutMs: 45000,
      contentPartCount: 1,
      schemaGuard: 'passed'
    });

    const callResult = await executeNativeWorkspaceTool(tools, 'call_mcp_tool', {
      pluginId: 'plugin_test_mcp',
      toolName: 'unity.echo',
      args: {
        value: 'ok'
      }
    });
    assert.equal(callResult.ok, true);
    assert.match(String(callResult.summary), /tool:unity\.echo/);
    assert.equal((callResult.mcp as { operation?: string } | undefined)?.operation, 'call_tool');
    assert.equal((callResult.mcp as { target?: string } | undefined)?.target, 'unity.echo');
    assert.equal((callResult.mcp as { argsSize?: number } | undefined)?.argsSize, JSON.stringify({ value: 'ok' }).length);
    assert.equal((callResult.mcp as { schemaGuard?: string } | undefined)?.schemaGuard, 'passed');

    const oversizedArgsResult = await executeNativeWorkspaceTool(tools, 'call_mcp_tool', {
      pluginId: 'plugin_test_mcp',
      toolName: 'unity.echo',
      args: {
        value: 'x'.repeat(70000)
      }
    });
    assert.equal(oversizedArgsResult.ok, false);
    assert.equal((oversizedArgsResult.mcp as { schemaGuard?: string } | undefined)?.schemaGuard, 'failed');
    assert.equal((oversizedArgsResult.mcp as { failureKind?: string } | undefined)?.failureKind, 'args_too_large');
    assert.equal(server.requests.includes('resources/read'), true);
    assert.equal(server.requests.includes('tools/call'), true);
  } finally {
    await server.close();
  }
});

test('native tool adapter serializes unsafe MCP tool calls', async () => {
  const server = await startTestMcpServer({
    toolCallDelayMs: 60
  });
  try {
    const project = buildProject('/tmp/funplay-runtime-test');
    const tools = createNativeWorkspaceTools({
      project,
      plugins: [buildMcpPlugin(server.baseUrl)],
      includeMcpToolCalls: true,
      permissionContext: {
        permission: {
          mode: 'full-access',
          allowWriteTools: true,
          allowSessionWriteTools: false
        }
      }
    });

    const [first, second] = await Promise.all([
      executeNativeWorkspaceTool(tools, 'call_mcp_tool', {
        pluginId: 'plugin_test_mcp',
        toolName: 'unity.first'
      }),
      executeNativeWorkspaceTool(tools, 'call_mcp_tool', {
        pluginId: 'plugin_test_mcp',
        toolName: 'unity.second'
      })
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(server.getMaxActiveToolCalls(), 1);
  } finally {
    await server.close();
  }
});

test('native MCP materializer exposes Claude-style direct tools with execution permission', async () => {
  const server = await startTestMcpServer();
  try {
    const project = buildProject('/tmp/funplay-runtime-test');
    const plugin = buildMcpPlugin(server.baseUrl);
    const materialized = await materializeNativeMcpTools({
      plugins: [plugin]
    });
    assert.equal(materialized.failures.length, 0);
    assert.equal(materialized.tools[0]?.name, 'mcp__test_mcp__unity_echo');
    assert.equal(materialized.tools[0]?.readOnly, false);
    assert.equal(materialized.tools[0]?.risk, 'high');
    assert.deepEqual(materialized.tools[0]?.inputJsonSchema, {
      type: 'object',
      properties: {
        value: {
          type: 'string'
        }
      }
    });

    const permissionRequests: Array<{ toolName?: string; risk: 'low' | 'medium' | 'high'; mcpToolName?: string; mcpPermissionKey?: string }> = [];
    const tools = createNativeWorkspaceTools({
      project,
      plugins: [plugin],
      dynamicTools: materialized.tools,
      permissionContext: {
        permission: {
          mode: 'ask',
          allowWriteTools: false,
          allowSessionWriteTools: false
        },
        requestPermission: async (request) => {
          permissionRequests.push({
            toolName: request.toolName,
            risk: request.risk,
            mcpToolName: request.impact?.mcp?.toolName,
            mcpPermissionKey: request.impact?.mcp?.permissionKey
          });
          return 'allow';
        }
      }
    });

    const result = await executeNativeWorkspaceTool(tools, 'mcp__test_mcp__unity_echo', {
      value: 'ok'
    });
    assert.equal(result.ok, true);
    assert.match(String(result.summary), /tool:unity\.echo/);
    assert.equal(permissionRequests[0]?.toolName, 'mcp__test_mcp__unity_echo');
    assert.equal(permissionRequests[0]?.risk, 'high');
    assert.equal(permissionRequests[0]?.mcpToolName, 'unity.echo');
    assert.equal(permissionRequests[0]?.mcpPermissionKey, makeSessionMcpToolPermissionKey(plugin.id, 'unity.echo'));
    assert.equal((result.mcp as { pluginId?: string } | undefined)?.pluginId, 'plugin_test_mcp');
    assert.equal((result.mcp as { target?: string } | undefined)?.target, 'unity.echo');
    assert.equal((result.mcp as { exposedName?: string } | undefined)?.exposedName, 'mcp__test_mcp__unity_echo');
    assert.match((result.mcp as { policySummary?: string } | undefined)?.policySummary ?? '', /permission=ask/);
    assert.equal(server.requests.includes('tools/list'), true);
    assert.equal(server.requests.includes('tools/call'), true);
  } finally {
    await server.close();
  }
});

test('native MCP policy overrides tool risk and deny execution', async () => {
  const server = await startTestMcpServer();
  try {
    const project = buildProject('/tmp/funplay-runtime-test');
    const readAllowedPlugin: McpPlugin = {
      ...buildMcpPlugin(server.baseUrl),
      defaultToolPermission: 'allow',
      defaultToolRisk: 'read'
    };
    const materialized = await materializeNativeMcpTools({
      plugins: [readAllowedPlugin]
    });
    assert.equal(materialized.tools[0]?.readOnly, true);
    assert.equal(materialized.tools[0]?.risk, 'low');
    assert.equal(materialized.tools[0]?.permissionPolicy, 'always');

    const deniedPlugin: McpPlugin = {
      ...buildMcpPlugin(server.baseUrl),
      toolPolicies: {
        'unity.echo': {
          permission: 'deny'
        }
      }
    };
    const deniedMaterialized = await materializeNativeMcpTools({
      plugins: [deniedPlugin]
    });
    assert.equal(deniedMaterialized.tools.length, 0);

    const deniedResult = await executeAgentToolAction(project, {
      type: 'call_mcp_tool',
      pluginId: deniedPlugin.id,
      toolName: 'unity.echo',
      args: {
        value: 'blocked'
      }
    }, {
      plugins: [deniedPlugin]
    });
    assert.equal(deniedResult.ok, false);
    assert.equal(deniedResult.isError, true);
    assert.equal(deniedResult.mcp?.failureKind, 'permission_denied');
  } finally {
    await server.close();
  }
});

test('native generic MCP calls reuse session-scoped MCP approvals', async () => {
  const server = await startTestMcpServer();
  try {
    const project = buildProject('/tmp/funplay-runtime-test');
    const plugin = buildMcpPlugin(server.baseUrl);
    const permissionKey = makeSessionMcpToolPermissionKey(plugin.id, 'unity.echo');
    let permissionRequestCount = 0;
    const tools = createNativeWorkspaceTools({
      project,
      plugins: [plugin],
      includeMcpToolCalls: true,
      permissionContext: {
        permission: {
          mode: 'ask',
          allowWriteTools: false,
          allowSessionWriteTools: false,
          allowedWriteTools: [],
          allowedMcpTools: [permissionKey]
        },
        requestPermission: async () => {
          permissionRequestCount += 1;
          return 'deny';
        }
      }
    });

    const result = await executeNativeWorkspaceTool(tools, 'call_mcp_tool', {
      pluginId: plugin.id,
      toolName: 'unity.echo',
      args: {
        value: 'approved'
      }
    });

    assert.equal(result.ok, true);
    assert.equal(permissionRequestCount, 0);
    assert.match(String(result.summary), /tool:unity\.echo/);
  } finally {
    await server.close();
  }
});

test('raw MCP control plane allows bounded diagnostic methods only', async () => {
  const server = await startTestMcpServer();
  try {
    const plugin = buildMcpPlugin(server.baseUrl);
    const result = await sendRawMcpControlRequest(plugin, 'tools/list', {});

    assert.equal(result.method, 'tools/list');
    assert.equal(result.pluginId, plugin.id);
    assert.equal(result.truncated, false);
    assert.match(JSON.stringify(result.result), /unity\.echo/);
    assert.throws(() => assertRawMcpMethodAllowed('tools/call'), /not allowed/);
    await assert.rejects(
      sendRawMcpControlRequest(plugin, 'tools/call', {
        name: 'unity.echo'
      }),
      /not allowed/
    );
  } finally {
    await server.close();
  }
});

test('raw MCP control plane returns failed diagnostic results for offline endpoints', async () => {
  const plugin = buildMcpPlugin('http://127.0.0.1:65530/');
  const result = await sendRawMcpControlRequest(plugin, 'tools/list', {});

  assert.equal(result.method, 'tools/list');
  assert.equal(result.pluginId, plugin.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.responseSize, 0);
  assert.match(result.error ?? '', /fetch failed|ECONNREFUSED/);
});

test('native tool-loop strategy reports explicit fallback reasons', () => {
  assert.deepEqual(
    resolveNativeToolLoopStrategy({
      nativeToolCallingEnabled: false,
      sessionMode: 'plan',
      providerProtocol: 'anthropic'
    }),
    {
      useNativeToolLoop: false,
      reason: 'native_tool_calling_disabled',
      summary: 'Native 真实 tool-calling 已被配置关闭；本轮将降级为普通模型回复。'
    }
  );

  assert.equal(
    resolveNativeToolLoopStrategy({
      nativeToolCallingEnabled: true,
      sessionMode: 'code',
      providerProtocol: 'anthropic'
    }).reason,
    'native_tool_calling_selected'
  );

  assert.equal(
    resolveNativeToolLoopStrategy({
      nativeToolCallingEnabled: true,
      sessionMode: 'ask',
      providerProtocol: 'anthropic'
    }).reason,
    'native_tool_calling_selected'
  );

  assert.equal(
    resolveNativeToolLoopStrategy({
      nativeToolCallingEnabled: true,
      sessionMode: 'plan',
      providerProtocol: 'openai-compatible',
      openAiCompatibleApiMode: 'chat'
    }).reason,
    'native_tool_calling_selected'
  );

  assert.equal(
    resolveNativeToolLoopStrategy({
      nativeToolCallingEnabled: true,
      sessionMode: 'plan',
      providerProtocol: 'openai-compatible',
      openAiCompatibleApiMode: 'chat',
      openAiCompatibleToolCallingVerified: false
    }).reason,
    'openai_compatible_streaming_tool_calls_disabled'
  );

  assert.equal(
    resolveNativeToolLoopStrategy({
      nativeToolCallingEnabled: true,
      sessionMode: 'plan',
      providerProtocol: 'openai-compatible',
      openAiCompatibleApiMode: 'responses',
      openAiCompatibleToolCallingVerified: true
    }).reason,
    'native_tool_calling_selected'
  );

  assert.equal(
    resolveNativeToolLoopStrategy({
      nativeToolCallingEnabled: true,
      sessionMode: 'plan',
      providerProtocol: 'anthropic'
    }).useNativeToolLoop,
    true
  );
});

test('native runtime does not short-circuit trivial greetings without a provider', async () => {
  const project = buildProject('/tmp/funplay-native-greeting');
  const textDeltas: string[] = [];
  const stages: string[] = [];
  const result = await runRuntimeForTest(nativeRuntime, {
    project,
    message: '您好',
    provider: undefined,
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '您好'),
    permission: {
      mode: 'read-only',
      allowWriteTools: false,
      allowSessionWriteTools: false
    },
    onTextDelta: (delta) => textDeltas.push(delta),
    onStage: (stage) => stages.push(stage.stageId)
  });

  assert.equal(result.status, 'fallback');
  assert.equal(textDeltas.join(''), '');
  assert.equal(stages.includes('stage:provider'), true);
  assert.equal(stages.includes('stage:direct_reply'), false);
  assert.equal(stages.includes('stage:tool_loop'), false);
});

test('native runtime localizes provider-missing fallback to UI language', async () => {
  const project = buildProject('/tmp/funplay-native-provider-missing-language');
  const result = await runRuntimeForTest(nativeRuntime, {
    project,
    message: 'hello',
    uiLanguage: 'en-US',
    provider: undefined,
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, 'hello'),
    permission: {
      mode: 'read-only',
      allowWriteTools: false,
      allowSessionWriteTools: false
    }
  });

  assert.equal(result.status, 'fallback');
  assert.match(result.assistantMessage, /No AI Provider is currently available/);
  assert.doesNotMatch(result.assistantMessage, /当前没有可用的 AI Provider/);
});

test('native build mode exposes write tools before intent heuristic matches', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-build-tools-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'chat_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '可以。'
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

    const result = await runRuntimeForTest(nativeRuntime, {
      project,
      message: '先看看项目情况',
      provider: {
        id: 'provider_openai_compatible_ask_tools',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '先看看项目情况'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    });

    assert.equal(result.status, 'completed');
    const toolNames = (requests[0]?.tools as Array<{ function?: { name?: string } }> | undefined)
      ?.map((tool) => tool.function?.name)
      .filter(Boolean);
    assert.ok(toolNames?.includes('create_directory'));
    assert.ok(toolNames?.includes('write_file'));
    assert.ok(toolNames?.includes('run_command'));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native plan mode exposes command tools but not write tools', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-plan-tools-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'chat_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '可以。'
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

    const result = await runRuntimeForTest(nativeRuntime, {
      project,
      message: '先看看项目情况',
      provider: {
        id: 'provider_openai_compatible_plan_tools',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '先看看项目情况'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(result.status, 'completed');
    const toolNames = (requests[0]?.tools as Array<{ function?: { name?: string } }> | undefined)
      ?.map((tool) => tool.function?.name)
      .filter(Boolean);
    assert.equal(toolNames?.includes('create_directory'), false);
    assert.equal(toolNames?.includes('write_file'), false);
    assert.equal(toolNames?.includes('run_command'), true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native Xiaomi MiMo tool-loop map error is not retried without tools', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-mimo-tool-no-retry-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        error: {
          message: "Cannot read properties of undefined (reading 'map')"
        }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }) as typeof fetch;

    const result = await runRuntimeForTest(nativeRuntime, {
      project,
      message: '先看看项目情况',
      provider: {
        id: 'provider_mimo_retry',
        name: 'Xiaomi MiMo',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKey: 'test-key',
        model: 'mimo-v2.5-pro',
        upstreamModel: 'mimo-v2.5-pro',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '先看看项目情况'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    });

    assert.equal(result.status, 'fallback');
    assert.match(result.assistantMessage, /AI Provider 返回了错误/);
    assert.equal(Array.isArray(requests[0]?.tools), true);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native OpenAI-compatible direct reply uses streaming chat completions', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-direct-stream-'));
  const originalFetch = globalThis.fetch;
  const previousNativeTools = process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS;
  try {
    process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS = 'false';
    const project = buildProject(projectPath);
    let capturedBody: Record<string, unknown> = {};
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response([
        'data: {"id":"chat_direct","model":"mimo-v2.5-pro","choices":[{"delta":{"reasoning_content":"思考"},"finish_reason":null}]}',
        '',
        'data: {"id":"chat_direct","model":"mimo-v2.5-pro","choices":[{"delta":{"content":"流式"},"finish_reason":null}]}',
        '',
        'data: {"id":"chat_direct","model":"mimo-v2.5-pro","choices":[{"delta":{"content":"成功。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
        '',
        'data: [DONE]',
        '',
        ''
      ].join('\n'), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream'
        }
      });
    }) as typeof fetch;

    const result = await runRuntimeForTest(nativeRuntime, {
      project,
      message: '你好',
      provider: {
        id: 'provider_mimo_stream',
        name: 'Xiaomi MiMo',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKey: 'test-key',
        model: 'mimo-v2.5-pro',
        upstreamModel: 'mimo-v2.5-pro',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '你好'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      onTextDelta: (delta) => textDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta)
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.assistantMessage, '流式成功。');
    assert.equal(capturedBody.stream, true);
    assert.equal('tools' in capturedBody, false);
    assert.equal(textDeltas.join(''), '流式成功。');
    assert.equal(thinkingDeltas.at(-1), '思考');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousNativeTools === undefined) {
      delete process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS;
    } else {
      process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS = previousNativeTools;
    }
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native runtime runs SessionStart hooks before provider input build', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-session-start-hook-'));
  const originalFetch = globalThis.fetch;
  const previousNativeTools = process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS;
  try {
    process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS = 'false';
    const project = buildProject(projectPath);
    let capturedBody: Record<string, unknown> = {};
    const hookEvents: string[] = [];
    const stageIds: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response([
        'data: {"id":"chat_session_start","choices":[{"delta":{"content":"收到上下文。"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
        ''
      ].join('\n'), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream'
        }
      });
    }) as typeof fetch;

    const result = await runRuntimeForTest(nativeRuntime, {
      project,
      message: '你好',
      provider: {
        id: 'provider_session_start',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '你好'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      lifecycleHooks: normalizeAgentLifecycleHookConfig({
        rules: [{
          id: 'session_context',
          event: 'SessionStart',
          action: {
            type: 'append_context',
            context: 'Session hook context: preserve Claude Code lifecycle parity.'
          }
        }]
      }),
      onLifecycleHook: (hook) => hookEvents.push(`${hook.event}:${hook.status}:${hook.ruleId}`),
      onStage: (stage) => stageIds.push(stage.stageId)
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.assistantMessage, '收到上下文。');
    assert.deepEqual(hookEvents, ['SessionStart:context_appended:session_context']);
    assert.equal(stageIds.some((stageId) => stageId.includes('stage:lifecycle_hook:SessionStart:session_context')), true);
    assert.match(JSON.stringify(capturedBody), /Session hook context: preserve Claude Code lifecycle parity/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousNativeTools === undefined) {
      delete process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS;
    } else {
      process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS = previousNativeTools;
    }
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native reply text normalizer decodes escaped paragraph breaks', () => {
  assert.equal(normalizeModelReplyText('您好\\n\\n当前可以继续。'), '您好\n\n当前可以继续。');
  assert.equal(normalizeModelReplyText('"您好\\n\\n当前可以继续。"'), '您好\n\n当前可以继续。');
  assert.equal(normalizeModelReplyText('换行符是 `\\n`。'), '换行符是 `\\n`。');
});

test('openai-compatible native tool loop executes direct function tools', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-tool-loop-'));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(projectPath, 'notes.md'), 'hello from file', 'utf8');
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_tool_call',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '我先读取文件。',
                tool_calls: [
                  {
                    id: 'call_read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"notes.md"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '文件里写着 hello from file。'
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

    const toolResults: Array<{ content: string; isError?: boolean }> = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '读取 notes.md',
      provider: {
        id: 'provider_openai_compatible',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '读取 notes.md'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    }, {
      emitToolResult: (toolResult) => {
        toolResults.push({
          content: toolResult.content,
          isError: toolResult.isError
        });
      }
    });

    assert.equal(requests.length, 2);
    assert.equal(((requests[0].tools as Array<{ function?: { name?: string } }>).some((tool) => tool.function?.name === 'read_file')), true);
    assert.equal((requests[1].messages as Array<{ role?: string; content?: string }>).some((message) => message.role === 'assistant' && message.content === '我先读取文件。'), true);
    assert.equal((requests[1].messages as Array<{ role?: string }>).some((message) => message.role === 'tool'), true);
    assert.equal(result.assistantMessage, '文件里写着 hello from file。');
    assert.deepEqual(result.toolCalls, ['read_file']);
    assert.equal(result.stepCount, 2);
    assert.match(toolResults[0]?.content ?? '', /hello from file/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop applies PreToolUse hooks before workspace side effects', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-hook-block-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_hook_tool_call',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '我尝试写文件。',
                tool_calls: [
                  {
                    id: 'call_write_blocked',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"blocked.txt","content":"should-not-exist"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_hook_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '写入被 Hook 阻止。'
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

    const hookStatuses: string[] = [];
    const toolResults: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '写 blocked.txt',
      provider: {
        id: 'provider_openai_compatible_hook',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写 blocked.txt'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      },
      lifecycleHooks: normalizeAgentLifecycleHookConfig({
        rules: [{
          id: 'block_writes',
          event: 'PreToolUse',
          matcher: 'write_file',
          action: {
            type: 'block',
            message: 'Project policy blocks generated writes.'
          }
        }]
      }),
      onLifecycleHook: (hook) => {
        hookStatuses.push(hook.status);
      }
    }, {
      includeWriteTools: true,
      emitToolResult: (toolResult) => {
        toolResults.push(toolResult.content);
      }
    });

    assert.equal(requests.length, 2);
    assert.equal(result.assistantMessage, '写入被 Hook 阻止。');
    assert.deepEqual(hookStatuses, ['blocked']);
    assert.equal(existsSync(join(projectPath, 'blocked.txt')), false);
    assert.match(toolResults.join('\n'), /生命周期 Hook 阻止了工具 write_file/);
    assert.match(JSON.stringify(requests[1]), /Project policy blocks generated writes/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop exposes MCP tools as direct Claude-style functions', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-mcp-tool-loop-'));
  const server = await startTestMcpServer();
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const plugin = buildMcpPlugin(server.baseUrl);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith(server.baseUrl)) {
        return await originalFetch(url, init);
      }
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_mcp_tool_call',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '我调用项目 MCP。',
                tool_calls: [
                  {
                    id: 'call_mcp_echo',
                    type: 'function',
                    function: {
                      name: 'mcp__test_mcp__unity_echo',
                      arguments: '{"value":"ok"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_mcp_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'MCP 工具调用完成。'
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

    const toolResults: Array<{ content: string; mcp?: unknown }> = [];
    const stages: Array<{ stageId?: string; status?: string; input?: unknown }> = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '调用 MCP echo',
      provider: {
        id: 'provider_openai_compatible',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [plugin],
      context: buildGenericWorkspaceContext(project, [plugin], getActiveProjectSession(project).id, '调用 MCP echo'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: false
      }
    }, {
      includeMcpToolCalls: true,
      emitToolResult: (toolResult) => {
        toolResults.push({
          content: toolResult.content,
          mcp: toolResult.mcp
        });
      },
      emitStage: (stage) => stages.push(stage)
    });

    const firstRequestTools = requests[0].tools as Array<{ function?: { name?: string; parameters?: Record<string, unknown> } }>;
    const mcpTool = firstRequestTools.find((toolDefinition) => toolDefinition.function?.name === 'mcp__test_mcp__unity_echo');
    assert.ok(mcpTool);
    assert.deepEqual(mcpTool.function?.parameters?.properties, {
      value: {
        type: 'string'
      }
    });
    assert.equal((requests[1].messages as Array<{ role?: string; name?: string }>).some((message) => message.role === 'tool' && message.name === 'mcp__test_mcp__unity_echo'), true);
    assert.equal(result.assistantMessage, 'MCP 工具调用完成。');
    assert.deepEqual(result.toolCalls, ['mcp__test_mcp__unity_echo']);
    assert.match(toolResults[0]?.content ?? '', /tool:unity\.echo/);
    assert.equal((toolResults[0]?.mcp as { target?: string } | undefined)?.target, 'unity.echo');
    assert.equal(result.coreState?.state, 'completed');
    assert.equal(result.coreState?.history.some((transition) => transition.to === 'executing_tools'), true);
    const coreStage = stages.find((stage) => stage.stageId === 'stage:native_agent_core_v2' && stage.status === 'completed');
    assert.ok(coreStage);
    const providerStep = (coreStage.input as { providerStep?: { finishReason?: string; text?: string } } | undefined)?.providerStep;
    assert.equal(providerStep?.finishReason, 'stop');
    assert.equal(providerStep?.text, 'MCP 工具调用完成。');
    const runController = (coreStage.input as {
      runController?: {
        state?: string;
        nextAction?: string;
        providerStepCount?: number;
        completedToolUseIds?: string[];
        lastDecision?: {
          outcome?: string;
          terminal?: boolean;
        };
      };
    } | undefined)?.runController;
    assert.equal(runController?.state, 'completed');
    assert.equal(runController?.nextAction, 'complete');
    assert.equal(runController?.providerStepCount, 2);
    assert.deepEqual(runController?.completedToolUseIds, ['call_mcp_echo']);
    assert.equal(runController?.lastDecision?.outcome, 'complete');
    assert.equal(runController?.lastDecision?.terminal, true);
    assert.equal(server.requests.includes('tools/list'), true);
    assert.equal(server.requests.includes('tools/call'), true);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop refreshes MCP tools between turns', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-mcp-refresh-'));
  const server = await startTestMcpServer({
    toolsListByCall: [
      [
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
      ],
      [
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
        },
        {
          name: 'unity.second',
          description: 'Second dynamic tool',
          inputSchema: {
            type: 'object',
            properties: {
              label: {
                type: 'string'
              }
            }
          }
        }
      ]
    ]
  });
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const plugin = buildMcpPlugin(server.baseUrl);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith(server.baseUrl)) {
        return await originalFetch(url, init);
      }
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_mcp_refresh_first',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '先调用已有 MCP 工具。',
                tool_calls: [
                  {
                    id: 'call_mcp_echo',
                    type: 'function',
                    function: {
                      name: 'mcp__test_mcp__unity_echo',
                      arguments: '{"value":"first"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          id: 'chat_mcp_refresh_second',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '发现新增 MCP 工具。',
                tool_calls: [
                  {
                    id: 'call_mcp_second',
                    type: 'function',
                    function: {
                      name: 'mcp__test_mcp__unity_second',
                      arguments: '{"label":"second"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_mcp_refresh_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '动态 MCP 工具刷新完成。'
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

    const stageSummaries: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '测试 MCP 动态刷新',
      provider: {
        id: 'provider_openai_compatible',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [plugin],
      context: buildGenericWorkspaceContext(project, [plugin], getActiveProjectSession(project).id, '测试 MCP 动态刷新'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: false
      }
    }, {
      includeMcpToolCalls: true,
      emitStage: (stage) => {
        if (stage.stageId === 'stage:native_mcp_tool_refresh') {
          stageSummaries.push(stage.summary);
        }
      }
    });

    const firstRequestTools = requests[0].tools as Array<{ function?: { name?: string } }>;
    const secondRequestTools = requests[1].tools as Array<{ function?: { name?: string } }>;
    assert.equal(firstRequestTools.some((toolDefinition) => toolDefinition.function?.name === 'mcp__test_mcp__unity_second'), false);
    assert.equal(secondRequestTools.some((toolDefinition) => toolDefinition.function?.name === 'mcp__test_mcp__unity_second'), true);
    assert.deepEqual(result.toolCalls, ['mcp__test_mcp__unity_echo', 'mcp__test_mcp__unity_second']);
    assert.equal(result.assistantMessage, '动态 MCP 工具刷新完成。');
    assert.equal(server.requests.filter((method) => method === 'tools/list').length >= 2, true);
    assert.equal(stageSummaries.some((summary) => summary.includes('mcp__test_mcp__unity_second')), true);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop converts thrown tool execution into structured tool result', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-tool-error-result-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_tool_call_error',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '我先运行命令。',
                tool_calls: [
                  {
                    id: 'call_bad_command',
                    type: 'function',
                    function: {
                      name: 'run_command',
                      arguments: '{"command":""}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_final_after_tool_error',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '工具错误已收到，我会换一种方式继续。'
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

    const toolResults: Array<{ content: string; isError?: boolean }> = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '运行一个会失败的命令',
      provider: {
        id: 'provider_openai_compatible_tool_error',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '运行一个会失败的命令'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, {
      includeCommandTools: true,
      emitToolResult: (toolResult) => {
        toolResults.push({
          content: toolResult.content,
          isError: toolResult.isError
        });
      }
    });

    assert.equal(requests.length, 2);
    assert.equal(result.assistantMessage, '工具错误已收到，我会换一种方式继续。');
    assert.equal(toolResults[0]?.isError, true);
    assert.match(toolResults[0]?.content ?? '', /Tool execution was interrupted|run_command 缺少 command/);
    assert.equal((requests[1].messages as Array<{ role?: string; content?: string }>).some((message) => (
      message.role === 'tool' &&
      /Tool execution was interrupted|run_command 缺少 command/.test(message.content ?? '')
    )), true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop injects recovery instructions after failed multi_edit', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-edit-recovery-prompt-'));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(projectPath, 'alpha.js'), 'const value = "current";\n', 'utf8');
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_bad_multi_edit',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '我先修改文件。',
                tool_calls: [
                  {
                    id: 'call_bad_multi_edit',
                    type: 'function',
                    function: {
                      name: 'multi_edit',
                      arguments: JSON.stringify({
                        path: 'alpha.js',
                        edits: [{
                          oldText: 'const value = "missing";',
                          newText: 'const value = "updated";'
                        }]
                      })
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_after_edit_recovery_prompt',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '收到编辑恢复指令。'
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

    const stages: Array<{ stageId: string; status: string; input?: unknown }> = [];
    const toolResults: Array<{ content: string; isError?: boolean }> = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '修改 alpha.js',
      provider: {
        id: 'provider_openai_compatible_edit_recovery_prompt',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 alpha.js'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitStage: (stage) => stages.push(stage.stageId),
      emitToolResult: (toolResult) => {
        toolResults.push({
          content: toolResult.content,
          isError: toolResult.isError
        });
      }
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(result.toolCalls, ['multi_edit']);
    assert.equal(toolResults[0]?.isError, true);
    assert.match(toolResults[0]?.content ?? '', /没有在 alpha\.js 中找到第 1 个编辑的 oldText/);
    assert.equal(stages.includes('stage:native_edit_failure_recovery'), true);
    const secondMessages = requests[1].messages as Array<{ role?: string; content?: string }>;
    assert.equal(secondMessages.some((message) => message.role === 'user' && /上一轮文件编辑工具失败/.test(message.content ?? '')), true);
    assert.equal(secondMessages.some((message) => /preview_patch.*patch_file/.test(message.content ?? '')), true);
    assert.equal(await readFile(join(projectPath, 'alpha.js'), 'utf8'), 'const value = "current";\n');
    assert.equal(result.assistantMessage, '收到编辑恢复指令。');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop rejects empty multi_edit before executing workspace writes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-empty-multi-edit-'));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(projectPath, 'alpha.js'), 'const value = "current";\n', 'utf8');
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_empty_multi_edit',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '我先批量修改文件。',
                tool_calls: [
                  {
                    id: 'call_empty_multi_edit',
                    type: 'function',
                    function: {
                      name: 'multi_edit',
                      arguments: '{"path":"alpha.js","edits":[]}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_after_empty_multi_edit',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '收到空编辑恢复指令。'
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

    const stages: string[] = [];
    const toolResults: Array<{ content: string; isError?: boolean }> = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '修改 alpha.js',
      provider: {
        id: 'provider_openai_compatible_empty_multi_edit',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 alpha.js'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitStage: (stage) => stages.push(stage.stageId),
      emitToolResult: (toolResult) => {
        toolResults.push({
          content: toolResult.content,
          isError: toolResult.isError
        });
      }
    });

    assert.equal(requests.length, 2);
    assert.equal(toolResults[0]?.isError, true);
    assert.match(toolResults[0]?.content ?? '', /multi_edit 参数无效/);
    assert.equal(stages.includes('stage:native_invalid_tool_input:call_empty_multi_edit'), true);
    assert.equal(stages.includes('stage:native_edit_failure_recovery'), true);
    const secondMessages = requests[1].messages as Array<{ role?: string; content?: string }>;
    assert.equal(secondMessages.some((message) => /不要调用 edits 为空的 multi_edit/.test(message.content ?? '')), true);
    assert.equal(await readFile(join(projectPath, 'alpha.js'), 'utf8'), 'const value = "current";\n');
    assert.equal(result.assistantMessage, '收到空编辑恢复指令。');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop continues when provider finishes with length and no tool calls', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-length-continuation-'));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(projectPath, 'notes.md'), 'length continuation fixture', 'utf8');
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_length_empty',
          choices: [
            {
              finish_reason: 'length',
              message: {
                role: 'assistant',
                content: ''
              }
            }
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 4096,
            total_tokens: 4196
          }
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          id: 'chat_tool_after_length',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '继续读取文件。',
                tool_calls: [
                  {
                    id: 'call_read_after_length',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"notes.md"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_final_after_length',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '已继续完成：length continuation fixture。'
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

    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '读取 notes.md',
      provider: {
        id: 'provider_openai_compatible_length',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '读取 notes.md'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(requests.length, 3);
    assert.match(JSON.stringify(requests[1].messages), /长度限制被截断/);
    assert.equal(result.assistantMessage, '已继续完成：length continuation fixture。');
    assert.deepEqual(result.toolCalls, ['read_file']);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop continues until provider returns final text', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-provider-final-'));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(projectPath, 'notes.md'), 'long loop fixture', 'utf8');
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    const toolStepCount = 40;
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length <= toolStepCount) {
        return new Response(JSON.stringify({
          id: `chat_tool_call_${requests.length}`,
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: `call_read_${requests.length}`,
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"notes.md"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_final_after_long_loop',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'provider 返回最终文本后正常结束。'
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

    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '连续读取直到模型结束',
      provider: {
        id: 'provider_openai_compatible_no_step_cap',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '连续读取直到模型结束'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(requests.length, toolStepCount + 1);
    assert.equal(result.stepCount, toolStepCount + 1);
    assert.equal(result.toolCalls.length, toolStepCount);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.assistantMessage, 'provider 返回最终文本后正常结束。');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native plan mode enters tool-loop instead of local write-permission fallback', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-plan-no-preflight-fallback-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'chat_plan_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Plan 模式下我不能直接创建文件夹，但可以给出目录规划。'
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

    const stages: Array<{ stageId: string; status?: string; summary?: string }> = [];
    const result = await runRuntimeForTest(nativeRuntime, {
      project,
      message: '在项目中新建一个文件夹用来放资源文件',
      provider: {
        id: 'provider_openai_compatible_plan',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '在项目中新建一个文件夹用来放资源文件'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      onStage: (stage) => {
        stages.push({
          stageId: stage.stageId,
          status: stage.status,
          summary: stage.summary
        });
      }
    });

    assert.equal(result?.status, 'completed');
    assert.equal(result?.assistantIntent, 'chat');
    assert.equal(result?.assistantMessage, 'Plan 模式下我不能直接创建文件夹，但可以给出目录规划。');
    assert.equal(requests.length, 1);
    const requestedToolNames = ((requests[0].tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => Boolean(name));
    assert.equal(requestedToolNames.includes('write_file'), false);
    assert.equal(requestedToolNames.includes('create_directory'), false);
    const permissionStage = stages.find((stage) => stage.stageId === 'stage:permission' && stage.status === 'completed');
    assert.match(permissionStage?.summary ?? '', /不会开放项目写入工具/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native conversation Agent Core ledger preserves tool input across completion updates', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-tool-block-input-'));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(projectPath, 'notes.md'), 'hello from native runtime', 'utf8');
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_tool_call',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_read_notes',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"notes.md"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '读到了 notes.md。'
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

    const result = await runRuntimeForTest(nativeRuntime, {
      project,
      message: '读取 notes.md',
      provider: {
        id: 'provider_openai_compatible_blocks',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '读取 notes.md'),
      activeRunId: 'run_native_output_projection',
      turnId: 'turn_native_output_projection',
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(result?.status, 'completed');
    const parts = result?.assistantMetadata?.agentCoreParts ?? [];
    const toolPart = parts.find((part) => part.kind === 'tool_call' && part.toolUseId === 'call_read_notes');
    assert.equal(toolPart?.kind, 'tool_call');
    assert.equal(toolPart?.turnId, 'turn_native_output_projection');
    assert.equal(toolPart?.runId, 'run_native_output_projection');
    assert.deepEqual(toolPart?.kind === 'tool_call' ? toolPart.input : undefined, {
      path: 'notes.md'
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop continues unfinished multi-file write replies', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-multi-write-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_multi_write_start',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_index',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"index.html","content":"<!doctype html>\\n<title>Rogue</title>"}'
                    }
                  },
                  {
                    id: 'call_style',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"style.css","content":"body { margin: 0; }"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          id: 'chat_multi_write_partial',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'index.html ✅ style.css ✅ 已写入！\n现在写最核心的 game.js'
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 3) {
        return new Response(JSON.stringify({
          id: 'chat_multi_write_continue',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_game',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"game.js","content":"console.log(\\"ready\\");"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_multi_write_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '三个文件都已写入。'
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

    const stages: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '一次性写入 index.html、style.css、game.js',
      provider: {
        id: 'provider_openai_compatible_multi_write',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '一次性写入 index.html、style.css、game.js'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitStage: (stage) => {
        stages.push(stage.stageId);
      }
    });

    assert.equal(requests.length, 4);
    assert.equal(stages.includes('stage:native_partial_write_continuation'), true);
    assert.equal(result.assistantMessage, '三个文件都已写入。');
    assert.deepEqual(result.toolCalls, ['write_file', 'write_file', 'write_file']);
    assert.equal(await readFile(join(projectPath, 'index.html'), 'utf8'), '<!doctype html>\n<title>Rogue</title>');
    assert.equal(await readFile(join(projectPath, 'style.css'), 'utf8'), 'body { margin: 0; }');
    assert.equal(await readFile(join(projectPath, 'game.js'), 'utf8'), 'console.log("ready");');
    assert.match(JSON.stringify(requests[2].messages), /继续调用协议级工具/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop replays MiMo reasoning content before controlled continuations', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-mimo-reasoning-continuation-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_mimo_write_start',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_index',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"index.html","content":"<!doctype html>"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          id: 'chat_mimo_partial',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'index.html 已写入。现在写最核心的 game.js',
                reasoning_content: 'Need to continue with the missing game.js write.'
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_mimo_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '完成。'
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

    await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '写入 index.html 和 game.js',
      provider: {
        id: 'provider_mimo_reasoning_continuation',
        name: 'Xiaomi MiMo',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKey: 'test-key',
        model: 'mimo-v2.5-pro',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写入 index.html 和 game.js'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    assert.equal(requests.length, 3);
    const replayedToolCallMessage = (requests[1].messages as Array<Record<string, unknown>>).at(-2);
    assert.deepEqual(replayedToolCallMessage, {
      role: 'assistant',
      content: null,
      reasoning_content: '',
      tool_calls: [
        {
          id: 'call_index',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: '{"path":"index.html","content":"<!doctype html>"}'
          }
        }
      ]
    });
    assert.deepEqual((requests[2].messages as Array<Record<string, unknown>>).slice(-2), [
      {
        role: 'assistant',
        content: 'index.html 已写入。现在写最核心的 game.js',
        reasoning_content: 'Need to continue with the missing game.js write.'
      },
      {
        role: 'user',
        content: String((requests[2].messages as Array<Record<string, unknown>>).at(-1)?.content)
      }
    ]);
    assert.match(JSON.stringify(requests[2].messages), /继续调用协议级工具/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop continues write promise after inspection tools', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-inspection-write-promise-'));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src/player.js'), 'export const player = {};\n', 'utf8');
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_scan_first',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_scan',
                    type: 'function',
                    function: {
                      name: 'scan_file_tree',
                      arguments: '{}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          id: 'chat_false_final',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '已有的模块都完成了，还差 game.js 和 index.html。现在一次性写完！'
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 3) {
        return new Response(JSON.stringify({
          id: 'chat_write_promised_files',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_write_game',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"src/game.js","content":"console.log(\\"game\\");"}'
                    }
                  },
                  {
                    id: 'call_write_index',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"index.html","content":"<!doctype html>\\n<title>Rogue</title>"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_write_promised_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'game.js 和 index.html 都已写入。'
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

    const stages: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '检查项目后补齐 game.js 和 index.html',
      provider: {
        id: 'provider_openai_compatible_inspection_write_promise',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '检查项目后补齐 game.js 和 index.html'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitStage: (stage) => {
        stages.push(stage.stageId);
      }
    });

    assert.equal(requests.length, 4);
    assert.equal(stages.includes('stage:native_partial_write_continuation'), true);
    assert.equal(result.assistantMessage, 'game.js 和 index.html 都已写入。');
    assert.deepEqual(result.toolCalls, ['scan_file_tree', 'write_file', 'write_file']);
    assert.equal(await readFile(join(projectPath, 'src/game.js'), 'utf8'), 'console.log("game");');
    assert.equal(await readFile(join(projectPath, 'index.html'), 'utf8'), '<!doctype html>\n<title>Rogue</title>');
    assert.match(JSON.stringify(requests[2].messages), /继续调用协议级工具/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop continues when todo list is incomplete', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-incomplete-todo-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_todo_start',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '我来拆分任务。',
                tool_calls: [
                  {
                    id: 'call_todo_start',
                    type: 'function',
                    function: {
                      name: 'update_todo_list',
                      arguments: JSON.stringify({
                        items: [
                          { id: '1', content: '写入第一个文件', status: 'in_progress' },
                          { id: '2', content: '写入第二个文件', status: 'pending' }
                        ]
                      })
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          id: 'chat_todo_write_first',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_write_first',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"first.txt","content":"first"}'
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 3) {
        return new Response(JSON.stringify({
          id: 'chat_todo_mid',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_todo_mid',
                    type: 'function',
                    function: {
                      name: 'update_todo_list',
                      arguments: JSON.stringify({
                        items: [
                          { id: '1', content: '写入第一个文件', status: 'completed' },
                          { id: '2', content: '写入第二个文件', status: 'in_progress' }
                        ]
                      })
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 4) {
        return new Response(JSON.stringify({
          id: 'chat_todo_false_final',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '我还没做完，马上继续。'
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 5) {
        return new Response(JSON.stringify({
          id: 'chat_todo_continue',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_write_second',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"second.txt","content":"second"}'
                    }
                  },
                  {
                    id: 'call_todo_done',
                    type: 'function',
                    function: {
                      name: 'update_todo_list',
                      arguments: JSON.stringify({
                        items: [
                          { id: '1', content: '写入第一个文件', status: 'completed' },
                          { id: '2', content: '写入第二个文件', status: 'completed' }
                        ]
                      })
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_todo_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '两个文件都完成。'
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

    const stages: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '写两个文件并维护 todo',
      provider: {
        id: 'provider_openai_compatible_incomplete_todo',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写两个文件并维护 todo'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitStage: (stage) => {
        stages.push(stage.stageId);
      }
    });

    assert.equal(requests.length, 6);
    assert.equal(stages.includes('stage:native_incomplete_todo_continuation'), true);
    assert.equal(result.assistantMessage, '两个文件都完成。');
    assert.deepEqual(result.toolCalls, ['update_todo_list', 'write_file', 'update_todo_list', 'write_file', 'update_todo_list']);
    assert.equal(await readFile(join(projectPath, 'first.txt'), 'utf8'), 'first');
    assert.equal(await readFile(join(projectPath, 'second.txt'), 'utf8'), 'second');
    assert.match(JSON.stringify(requests[4].messages), /未完成项/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop continues after empty final step with incomplete todo', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-empty-final-todo-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_todo_alias_start',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '我先记录任务。',
                tool_calls: [
                  {
                    id: 'call_todo_alias',
                    type: 'function',
                    function: {
                      name: 'update_todo_list',
                      arguments: JSON.stringify({
                        todos: JSON.stringify([
                          { id: '1', content: '写入缺失文件', status: 'in_progress' }
                        ])
                      })
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          id: 'chat_empty_false_final',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: null
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 3) {
        return new Response(JSON.stringify({
          id: 'chat_empty_continue',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_write_missing',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"missing.txt","content":"done"}'
                    }
                  },
                  {
                    id: 'call_todo_done',
                    type: 'function',
                    function: {
                      name: 'update_todo_list',
                      arguments: JSON.stringify({
                        items: [
                          { id: '1', content: '写入缺失文件', status: 'completed' }
                        ]
                      })
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_empty_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '缺失文件已写入。'
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

    const stages: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '写入缺失文件',
      provider: {
        id: 'provider_openai_compatible_empty_final_todo',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写入缺失文件'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitStage: (stage) => {
        stages.push(stage.stageId);
      }
    });

    assert.equal(requests.length, 4);
    assert.equal(stages.includes('stage:native_incomplete_todo_continuation'), true);
    assert.equal(result.assistantMessage, '缺失文件已写入。');
    assert.deepEqual(result.toolCalls, ['update_todo_list', 'write_file', 'update_todo_list']);
    assert.equal(await readFile(join(projectPath, 'missing.txt'), 'utf8'), 'done');
    assert.match(JSON.stringify(requests[2].messages), /<empty assistant reply>/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop resumes incomplete todo from prior assistant history', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-history-todo-'));
  const originalFetch = globalThis.fetch;
  try {
    const createdAt = new Date().toISOString();
    const project = buildProject(projectPath);
    const activeSession = getActiveProjectSession(project);
    const projectWithHistory = replaceProjectSession(project, {
      ...activeSession,
      chat: [
        {
          id: 'msg_old_user',
          role: 'user',
          content: '继续扩展网页游戏',
          createdAt
        },
        {
          id: 'msg_old_assistant',
          role: 'assistant',
          content: '',
          createdAt,
          metadata: {
            agentCoreParts: [
              {
                id: 'part_old_todo_call',
                kind: 'tool_call',
                sequence: 0,
                createdAt,
                toolUseId: 'tool_old_todo',
                name: 'update_todo_list',
                input: {
                  todos: [
                    { id: '5', content: '重写 renderer.js（掉落物/怪物/血条/光照/合成UI/死亡画面）', status: 'in_progress' },
                    { id: '6', content: '更新 index.html（引入新脚本）', status: 'pending' }
                  ]
                },
                status: 'completed'
              },
              {
                id: 'part_old_todo_result',
                kind: 'tool_result',
                sequence: 1,
                createdAt,
                toolUseId: 'tool_old_todo',
                toolName: 'update_todo_list',
                content: [
                  '任务清单已更新（2 项）：',
                  '- [in_progress] 5 (high): 重写 renderer.js（掉落物/怪物/血条/光照/合成UI/死亡画面）',
                  '- [pending] 6 (high): 更新 index.html（引入新脚本）'
                ].join('\n')
              }
            ]
          }
        }
      ]
    }, activeSession.id);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_history_empty_stop',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: null
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          id: 'chat_history_continue_tools',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_write_renderer',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"renderer.js","content":"console.log(\\"renderer done\\");"}'
                    }
                  },
                  {
                    id: 'call_history_todo_done',
                    type: 'function',
                    function: {
                      name: 'update_todo_list',
                      arguments: JSON.stringify({
                        items: [
                          { id: '5', content: '重写 renderer.js（掉落物/怪物/血条/光照/合成UI/死亡画面）', status: 'completed' },
                          { id: '6', content: '更新 index.html（引入新脚本）', status: 'completed' }
                        ]
                      })
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_history_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '历史未完成项已继续完成。'
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

    const stages: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project: projectWithHistory,
      message: '继续完成',
      provider: {
        id: 'provider_openai_compatible_history_todo',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        availableModels: [
          { modelId: 'gpt-test', capabilities: { contextWindow: 131072 } }
        ],
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(projectWithHistory, [], activeSession.id, '继续完成'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitStage: (stage) => {
        stages.push(stage.stageId);
      }
    });

    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.max_tokens, 32000);
    assert.equal(stages.includes('stage:native_incomplete_todo_continuation'), true);
    assert.equal(result.assistantMessage, '历史未完成项已继续完成。');
    assert.deepEqual(result.toolCalls, ['write_file', 'update_todo_list']);
    assert.equal(await readFile(join(projectPath, 'renderer.js'), 'utf8'), 'console.log("renderer done");');
    assert.match(JSON.stringify(requests[1].messages), /未完成项/);
    assert.match(JSON.stringify(requests[1].messages), /不要在正文里输出完整源码/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop uses provider max output token override', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-max-output-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'chat_max_output_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'ok'
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

    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '确认上下文配置',
      provider: {
        id: 'provider_openai_compatible_max_output',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '确认上下文配置'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    assert.equal(result.assistantMessage, 'ok');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.max_tokens, 8192);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop uses catalog model max output tokens when provider override is absent', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-catalog-max-output-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'chat_catalog_max_output_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'ok'
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

    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '确认目录里的模型输出上限',
      provider: {
        id: 'provider_xiaomi_catalog_max_output',
        name: 'Xiaomi MiMo',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'mimo-v2.5-pro',
        availableModels: [
          { modelId: 'mimo-v2.5-pro', capabilities: { contextWindow: 131_072, maxOutputTokens: 131_072 } }
        ],
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '确认目录里的模型输出上限'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    assert.equal(result.assistantMessage, 'ok');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.max_completion_tokens, 131072);
    assert.equal('max_tokens' in (requests[0] ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop completes empty no-tool final step without fallback', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-empty-final-no-tool-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_empty_first',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: null
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      throw new Error('Unexpected retry after empty stop.');
    }) as typeof fetch;

    const stages: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '继续',
      provider: {
        id: 'provider_openai_compatible_empty_final_no_tool',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '继续'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitStage: (stage) => {
        stages.push({
          stageId: stage.stageId,
          status: stage.status,
          input: stage.input
        });
      }
    });

    assert.equal(requests.length, 1);
    assert.equal(stages.some((stage) => stage.stageId === 'stage:native_empty_final_continuation'), false);
    assert.equal(result.assistantMessage, '');
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.coreState?.state, 'failed');
    const coreStage = stages.find((stage) => stage.stageId === 'stage:native_agent_core_v2' && stage.status === 'failed');
    assert.ok(coreStage);
    const runController = (coreStage.input as {
      runController?: {
        state?: string;
        nextAction?: string;
        lastDecision?: {
          outcome?: string;
          terminal?: boolean;
        };
      };
    } | undefined)?.runController;
    assert.equal(runController?.state, 'failed');
    assert.equal(runController?.nextAction, 'fail');
    assert.equal(runController?.lastDecision?.outcome, 'fail');
    assert.equal(runController?.lastDecision?.terminal, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible native tool loop executes textual tool markers as guarded tools', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-text-tool-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chat_text_tool_call',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: [
                  '上一轮我只是在聊天里展示了代码，但没有真正写入文件。',
                  '现在帮你写入：',
                  '[Tool] write_file { "path": "index.html", "content": "<!doctype html>\\n<title>Rogue</title>" }'
                ].join('\n')
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'chat_text_tool_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '已写入 index.html。'
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

    const toolUses: Array<{ name: string; input?: Record<string, unknown>; status: string }> = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '写入 index.html',
      provider: {
        id: 'provider_openai_compatible_text_tool',
        name: 'Xiaomi MiMo',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKey: 'test-key',
        model: 'mimo-v2.5-pro',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写入 index.html'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitToolUse: (toolUse) => {
        toolUses.push({
          name: toolUse.name,
          input: toolUse.input,
          status: toolUse.status
        });
      }
    });

    assert.equal(requests.length, 2);
    assert.equal(result.assistantMessage, '已写入 index.html。');
    assert.deepEqual(result.toolCalls, ['write_file']);
    assert.equal(await readFile(join(projectPath, 'index.html'), 'utf8'), '<!doctype html>\n<title>Rogue</title>');
    assert.equal(toolUses.some((toolUse) => toolUse.name === 'write_file' && toolUse.status === 'completed'), true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible chat tool loop replays completed historical tools as protocol messages', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-chat-tool-history-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const activeSession = getActiveProjectSession(project);
    const projectWithHistory = replaceProjectSession(project, {
      ...activeSession,
      chat: [
        {
          id: 'msg_user_history',
          role: 'user',
          content: '先读文件。',
          createdAt: new Date().toISOString()
        },
        {
          id: 'msg_assistant_history',
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          metadata: {
            agentCoreParts: [
              {
                id: 'part_history_text',
                kind: 'assistant_text',
                sequence: 0,
                createdAt: '2026-05-16T00:00:00.000Z',
                text: '我先读取文件。'
              },
              {
                id: 'part_history_read',
                kind: 'tool_call',
                sequence: 1,
                createdAt: '2026-05-16T00:00:01.000Z',
                toolUseId: 'tool_history_read',
                name: 'read_file',
                input: {
                  path: 'notes.md'
                },
                status: 'completed'
              },
              {
                id: 'part_history_result',
                kind: 'tool_result',
                sequence: 2,
                createdAt: '2026-05-16T00:00:02.000Z',
                toolUseId: 'tool_history_read',
                toolName: 'read_file',
                content: 'notes history content'
              },
              {
                id: 'part_history_unpaired',
                kind: 'tool_call',
                sequence: 3,
                createdAt: '2026-05-16T00:00:03.000Z',
                toolUseId: 'tool_history_unpaired',
                name: 'read_file',
                input: {
                  path: 'missing.md'
                },
                status: 'running'
              }
            ]
          }
        }
      ]
    });
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'chat_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '可以继续。'
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

    const result = await runOpenAiCompatibleNativeToolLoop({
      project: projectWithHistory,
      message: '继续',
      provider: {
        id: 'provider_openai_compatible',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(projectWithHistory, [], activeSession.id, '继续'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    const messages = capturedBody.messages as Array<Record<string, unknown>>;
    const assistantHistory = messages.find((message) =>
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls)
    );
    const assistantToolCalls = assistantHistory?.tool_calls as Array<Record<string, unknown>> | undefined;
    const firstToolCall = assistantToolCalls?.[0] as Record<string, unknown> | undefined;
    const firstFunction = firstToolCall?.function as Record<string, unknown> | undefined;
    const toolResult = messages.find((message) =>
      message.role === 'tool' &&
      message.tool_call_id === 'tool_history_read' &&
      message.content === 'notes history content'
    );
    const messagesJson = JSON.stringify(messages);
    assert.equal(assistantHistory?.content, '我先读取文件。');
    assert.equal(firstToolCall?.id, 'tool_history_read');
    assert.equal(firstFunction?.name, 'read_file');
    assert.match(String(firstFunction?.arguments), /notes\.md/);
    assert.ok(toolResult);
    assert.equal(messagesJson.includes('tool_history_unpaired'), true);
    assert.equal(messagesJson.includes('missing.md'), true);
    assert.match(messagesJson, /did not return a recorded result/);
    assert.equal(messagesJson.includes('Previous tool call'), false);
    assert.equal(messagesJson.includes('Previous tool result'), false);
    assert.equal(result.assistantMessage, '可以继续。');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible responses tool loop replays completed historical tools as protocol items', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-tool-history-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const activeSession = getActiveProjectSession(project);
    const projectWithHistory = replaceProjectSession(project, {
      ...activeSession,
      chat: [
        {
          id: 'msg_user_history',
          role: 'user',
          content: '先看一下项目。',
          createdAt: new Date().toISOString()
        },
        {
          id: 'msg_assistant_history',
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          metadata: {
            agentCoreParts: [
              {
                id: 'part_history_context',
                kind: 'tool_call',
                sequence: 0,
                createdAt: '2026-05-16T00:00:00.000Z',
                toolUseId: 'tool_history_context',
                name: 'inspect_workspace_context',
                input: {
                  projectName: 'Rogue',
                  projectPath: 'Rogue',
                  pluginCount: 0
                },
                status: 'completed'
              },
              {
                id: 'part_history_context_result',
                kind: 'tool_result',
                sequence: 1,
                createdAt: '2026-05-16T00:00:01.000Z',
                toolUseId: 'tool_history_context',
                toolName: 'inspect_workspace_context',
                content: 'Workspace context inspected.'
              },
              {
                id: 'part_history_unpaired',
                kind: 'tool_call',
                sequence: 2,
                createdAt: '2026-05-16T00:00:02.000Z',
                toolUseId: 'tool_history_unpaired',
                name: 'inspect_workspace_context',
                input: {
                  projectName: 'Rogue',
                  projectPath: 'Rogue',
                  pluginCount: 0
                },
                status: 'running'
              }
            ]
          }
        }
      ]
    });
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'resp_final',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: '可以继续。'
              }
            ]
          }
        ]
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }) as typeof fetch;

    const result = await runOpenAiCompatibleNativeToolLoop({
      project: projectWithHistory,
      message: '继续',
      provider: {
        id: 'provider_openai_compatible',
        name: 'Compatible Responses',
        protocol: 'openai-compatible',
        apiMode: 'responses',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(projectWithHistory, [], activeSession.id, '继续'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    const inputJson = JSON.stringify(capturedBody.input);
    assert.equal(inputJson.includes('"type":"function_call"'), true);
    assert.equal(inputJson.includes('"type":"function_call_output"'), true);
    assert.equal(inputJson.includes('Previous tool call'), false);
    assert.equal(inputJson.includes('Previous tool result'), false);
    assert.equal(inputJson.includes('inspect_workspace_context'), true);
    assert.equal(inputJson.includes('tool_history_context'), true);
    assert.equal(inputJson.includes('tool_history_unpaired'), true);
    assert.match(inputJson, /did not return a recorded result/);
    assert.match(inputJson, /Workspace context inspected/);
    assert.equal(result.assistantMessage, '可以继续。');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible responses tool loop carries raw response output into the next step', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-responses-output-'));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(projectPath, 'notes.md'), 'raw response output fixture', 'utf8');
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'resp_tool',
          output: [
            {
              type: 'reasoning',
              id: 'rs_1',
              summary: []
            },
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_read',
              name: 'read_file',
              arguments: '{"path":"notes.md"}',
              status: 'completed'
            }
          ]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        id: 'resp_final',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: '读到了 fixture。'
              }
            ]
          }
        ]
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }) as typeof fetch;

    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '读取 notes.md',
      provider: {
        id: 'provider_openai_compatible_responses_output',
        name: 'Compatible Responses',
        protocol: 'openai-compatible',
        apiMode: 'responses',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '读取 notes.md'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(result.assistantMessage, '读到了 fixture。');
    assert.equal(requests.length, 2);
    const secondInput = JSON.stringify(requests[1].input);
    assert.match(secondInput, /"type":"reasoning"/);
    assert.match(secondInput, /"id":"fc_1"/);
    assert.match(secondInput, /"type":"function_call_output"/);
    assert.match(secondInput, /"call_id":"call_read"/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('openai-compatible responses tool loop forwards text deltas before the response completes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-realtime-delta-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let resolveControllerReady: () => void = () => undefined;
    let resolveFirstDelta: () => void = () => undefined;
    const controllerReady = new Promise<void>((resolve) => {
      resolveControllerReady = resolve;
    });
    const firstDeltaReceived = new Promise<void>((resolve) => {
      resolveFirstDelta = resolve;
    });
    const sseBlock = (lines: string[]) => encoder.encode(`${lines.join('\n')}\n\n`);

    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        resolveControllerReady();
        controller.enqueue(sseBlock([
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"resp_realtime","status":"in_progress","output":[]}}'
        ]));
        controller.enqueue(sseBlock([
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"实时"}'
        ]));
      }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream'
      }
    })) as typeof fetch;

    const textEvents: Array<{ delta: string; accumulated: string }> = [];
    let runCompleted = false;
    const resultPromise = runOpenAiCompatibleNativeToolLoop({
      project,
      message: '直接回复一句话',
      provider: {
        id: 'provider_openai_compatible_realtime',
        name: 'Compatible Responses',
        protocol: 'openai-compatible',
        apiMode: 'responses',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '直接回复一句话'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      onTextDelta: (delta, accumulated) => {
        textEvents.push({ delta, accumulated });
        if (accumulated === '实时') {
          resolveFirstDelta();
        }
      }
    }).finally(() => {
      runCompleted = true;
    });

    await controllerReady;
    const firstDeltaArrivedBeforeCompletion = await Promise.race([
      firstDeltaReceived.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))
    ]);
    if (!firstDeltaArrivedBeforeCompletion) {
      streamController?.enqueue(sseBlock([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_realtime","status":"completed","output":[]}}'
      ]));
      streamController?.close();
      await resultPromise.catch(() => undefined);
    }

    assert.equal(firstDeltaArrivedBeforeCompletion, true);
    assert.equal(runCompleted, false);

    streamController?.enqueue(sseBlock([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"输出。"}'
    ]));
    streamController?.enqueue(sseBlock([
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"实时输出。"}'
    ]));
    streamController?.enqueue(sseBlock([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_realtime","status":"completed","output":[]}}'
    ]));
    streamController?.close();

    const result = await resultPromise;
    assert.equal(result.assistantMessage, '实时输出。');
    assert.deepEqual(textEvents, [
      { delta: '实时', accumulated: '实时' },
      { delta: '输出。', accumulated: '实时输出。' }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native tool loop includes tool-boundary resume context for resumed runs', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-resume-context-'));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(projectPath, 'notes.md'), 'resume context fixture', 'utf8');
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'chat_resume_final',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '继续完成。'
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

    const resumeContext: AgentRuntimeResumeContext = {
      resumedFromRunId: 'run_resume_context',
      strategy: 'resume_after_last_completed_tool',
      previousStatus: 'interrupted',
      originalInput: '读取 notes.md 后继续总结',
      checkpointSnapshotId: 'snapshot_resume_context',
      filesRestoredToCheckpoint: true,
      lastToolBoundary: {
        toolUseId: 'tool_read_notes',
        toolName: 'read_file',
        phase: 'tool_result',
        status: 'completed',
        checkpointSnapshotId: 'snapshot_resume_context',
        completedAt: new Date().toISOString(),
        summary: 'read notes.md',
        transaction: {
          id: 'tool_txn:tool_read_notes',
          toolUseId: 'tool_read_notes',
          toolName: 'read_file',
          toolClass: 'workspace',
          phase: 'completed',
          status: 'completed',
          eventCount: 3,
          startedAt: '2026-05-15T00:00:00.000Z',
          updatedAt: '2026-05-15T00:00:01.000Z',
          checkpoint: {
            policy: 'optional',
            snapshotId: 'snapshot_resume_context',
            status: 'completed'
          }
        }
      },
      resumeCursor: {
        eventId: 'event_tool_boundary',
        eventType: 'tool_boundary',
        strategy: 'resume_after_last_completed_tool',
        createdAt: '2026-05-15T00:00:01.000Z',
        checkpointSnapshotId: 'snapshot_resume_context',
        toolUseId: 'tool_read_notes',
        toolName: 'read_file',
        summary: 'read notes.md',
        transaction: {
          id: 'tool_txn:tool_read_notes',
          toolUseId: 'tool_read_notes',
          toolName: 'read_file',
          toolClass: 'workspace',
          phase: 'completed',
          status: 'completed',
          eventCount: 3,
          startedAt: '2026-05-15T00:00:00.000Z',
          updatedAt: '2026-05-15T00:00:01.000Z',
          checkpoint: {
            policy: 'optional',
            snapshotId: 'snapshot_resume_context',
            status: 'completed'
          }
        }
      },
      recentTimeline: [
        {
          id: 'stage:tool_loop',
          title: '执行 Agent 工具循环',
          target: 'stage:tool_loop',
          status: 'running',
          summary: 'interrupted during tool loop'
        }
      ]
    };

    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '读取 notes.md 后继续总结',
      provider: {
        id: 'provider_resume_compatible',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '读取 notes.md 后继续总结'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      resumeContext
    });

    assert.equal(result.assistantMessage, '继续完成。');
    assert.equal(requests.length, 1);
    const serializedMessages = JSON.stringify(requests[0].messages);
    assert.match(serializedMessages, /恢复运行上下文/);
    assert.match(serializedMessages, /resume_after_last_completed_tool/);
    assert.match(serializedMessages, /tool_read_notes/);
    assert.match(serializedMessages, /read_file/);
    assert.match(serializedMessages, /恢复工具事务摘要/);
    assert.match(serializedMessages, /tool_txn:tool_read_notes/);
    assert.match(serializedMessages, /eventCount: 3/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native tool loop aborts after a completed tool boundary and can resume from that boundary', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-abort-resume-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const abortController = new AbortController();
    const firstRequests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      firstRequests.push(JSON.parse(String(init?.body)));
      if (firstRequests.length > 1) {
        throw new Error('provider should not be called again after abort');
      }
      return new Response([
        `data: ${JSON.stringify({
          id: 'chat_abort_tool',
          model: 'gpt-test',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool_write_abort',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        path: 'step-1.txt',
                        content: 'mimo-abort-resume-741205'
                      })
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream'
        }
      });
    }) as typeof fetch;

    await assert.rejects(
      runOpenAiCompatibleNativeToolLoop({
        project,
        message: '写入第一个文件后继续完成长任务',
        provider: {
          id: 'provider_abort_resume_first',
          name: 'Compatible Chat',
          protocol: 'openai-compatible',
          apiMode: 'chat',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test-key',
          model: 'gpt-test',
          enabled: true,
          isDefault: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        plugins: [],
        context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写入第一个文件后继续完成长任务'),
        permission: {
          mode: 'full-access',
          allowWriteTools: true,
          allowSessionWriteTools: true,
          allowedWriteTools: ['*']
        },
        abortSignal: abortController.signal
      }, {
        includeWriteTools: true,
        emitToolResult: (toolResult) => {
          if (toolResult.toolUseId === 'tool_write_abort') {
            abortController.abort(new Error('abort after completed tool boundary'));
          }
        }
      }),
      /abort after completed tool boundary/
    );
    assert.equal(firstRequests.length, 1);
    assert.equal(await readFile(join(projectPath, 'step-1.txt'), 'utf8'), 'mimo-abort-resume-741205');

    const resumedRequests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      resumedRequests.push(JSON.parse(String(init?.body)));
      return new Response([
        `data: ${JSON.stringify({
          id: 'chat_abort_resume_final',
          model: 'gpt-test',
          choices: [
            {
              delta: {
                content: 'ABORT_RESUME_DONE'
              },
              finish_reason: 'stop'
            }
          ]
        })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream'
        }
      });
    }) as typeof fetch;

    const resumeContext: AgentRuntimeResumeContext = {
      resumedFromRunId: 'run_abort_resume',
      strategy: 'resume_after_last_completed_tool',
      previousStatus: 'interrupted',
      originalInput: '写入第一个文件后继续完成长任务',
      checkpointSnapshotId: 'snapshot_abort_resume',
      filesRestoredToCheckpoint: true,
      lastToolBoundary: {
        toolUseId: 'tool_write_abort',
        toolName: 'write_file',
        phase: 'tool_result',
        status: 'completed',
        checkpointSnapshotId: 'snapshot_abort_resume',
        completedAt: new Date().toISOString(),
        summary: 'write step-1.txt'
      },
      recentTimeline: [
        {
          id: 'stage:native_tool_stream',
          title: '执行兼容 Tool Loop',
          target: 'stage:native_tool_stream',
          status: 'running',
          summary: 'interrupted after one completed tool'
        }
      ]
    };
    const resumed = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '写入第一个文件后继续完成长任务',
      provider: {
        id: 'provider_abort_resume_second',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写入第一个文件后继续完成长任务'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      },
      resumeContext
    }, {
      includeWriteTools: true
    });

    assert.equal(resumed.assistantMessage, 'ABORT_RESUME_DONE');
    assert.equal(resumedRequests.length, 1);
    const serializedMessages = JSON.stringify(resumedRequests[0].messages);
    assert.match(serializedMessages, /恢复运行上下文/);
    assert.match(serializedMessages, /resume_after_last_completed_tool/);
    assert.match(serializedMessages, /tool_write_abort/);
    assert.match(serializedMessages, /write_file/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native tool loop replays duplicate tool call ids without re-executing side effects', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-duplicate-tool-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response([
          `data: ${JSON.stringify({
            id: 'chat_duplicate_tool_first',
            model: 'gpt-test',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tool_duplicate_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'duplicate.txt',
                          content: 'first-write'
                        })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })}\n\n`,
          'data: [DONE]\n\n'
        ].join(''), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream'
          }
        });
      }
      if (requests.length === 2) {
        return new Response([
          `data: ${JSON.stringify({
            id: 'chat_duplicate_tool_second',
            model: 'gpt-test',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tool_duplicate_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'duplicate.txt',
                          content: 'second-write-should-not-run'
                        })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })}\n\n`,
          'data: [DONE]\n\n'
        ].join(''), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream'
          }
        });
      }
      return new Response([
        `data: ${JSON.stringify({
          id: 'chat_duplicate_tool_final',
          model: 'gpt-test',
          choices: [
            {
              delta: {
                content: 'DUPLICATE_TOOL_DONE'
              },
              finish_reason: 'stop'
            }
          ]
        })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream'
        }
      });
    }) as typeof fetch;

    const stages: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '写入 duplicate.txt，重复工具 id 时不要重复执行副作用。',
      provider: {
        id: 'provider_duplicate_tool',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写入 duplicate.txt，重复工具 id 时不要重复执行副作用。'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitStage: (stage) => {
        stages.push(stage.stageId);
      }
    });

    assert.equal(requests.length, 3);
    assert.equal(result.toolCalls.filter((toolName) => toolName === 'write_file').length, 2);
    assert.equal(await readFile(join(projectPath, 'duplicate.txt'), 'utf8'), 'first-write');
    assert.equal(stages.includes('stage:native_duplicate_tool_result:tool_duplicate_write'), true);
    assert.match(result.assistantMessage, /DUPLICATE_TOOL_DONE/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native tool loop rejects malformed tool arguments without executing side effects', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-malformed-tool-'));
  const originalFetch = globalThis.fetch;
  try {
    const project = buildProject(projectPath);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return new Response([
          `data: ${JSON.stringify({
            id: 'chat_malformed_tool',
            model: 'gpt-test',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tool_bad_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: '{"path":"bad.txt","content":'
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })}\n\n`,
          'data: [DONE]\n\n'
        ].join(''), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream'
          }
        });
      }
      return new Response([
        `data: ${JSON.stringify({
          id: 'chat_malformed_tool_final',
          model: 'gpt-test',
          choices: [
            {
              delta: {
                content: 'MALFORMED_TOOL_RECOVERED'
              },
              finish_reason: 'stop'
            }
          ]
        })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream'
        }
      });
    }) as typeof fetch;

    const toolResults: Array<{ content: string; isError?: boolean }> = [];
    const stages: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '尝试写入 bad.txt；如果工具参数坏了，需要恢复。',
      provider: {
        id: 'provider_malformed_tool',
        name: 'Compatible Chat',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '尝试写入 bad.txt；如果工具参数坏了，需要恢复。'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitToolResult: (toolResult) => {
        toolResults.push({
          content: toolResult.content,
          isError: toolResult.isError
        });
      },
      emitStage: (stage) => {
        stages.push(stage.stageId);
      }
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(result.toolCalls, ['write_file']);
    assert.equal(toolResults[0]?.isError, true);
    assert.match(toolResults[0]?.content ?? '', /工具调用参数 JSON 无法解析/);
    assert.equal(stages.includes('stage:native_malformed_tool_arguments:tool_bad_write'), true);
    await assert.rejects(readFile(join(projectPath, 'bad.txt'), 'utf8'), /ENOENT/);
    assert.match(result.assistantMessage, /MALFORMED_TOOL_RECOVERED/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectPath, { recursive: true, force: true });
  }
});

const liveOpenAiCompatibleProviderConfigured = Boolean(
  process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL &&
  process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY &&
  process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL
);

function buildLiveOpenAiCompatibleProvider(id: string): AiProvider {
  return {
    id,
    name: 'Live E2E Provider',
    protocol: 'openai-compatible',
    apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
    baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
    apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
    model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

test('live openai-compatible provider smoke runs against a real temporary project', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider smoke.',
  timeout: 60_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-e2e-'));
  try {
    await writeFile(join(projectPath, 'notes.md'), 'Funplay live provider E2E fixture.', 'utf8');
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '请用一句话确认你能看到当前项目上下文。不要修改文件。',
      provider: {
        id: 'provider_live_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '请用一句话确认你能看到当前项目上下文。不要修改文件。'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(result.assistantMessage.trim().length > 0, true);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider calls a real read_file tool', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider tool smoke.',
  timeout: 90_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-tool-e2e-'));
  try {
    await writeFile(join(projectPath, 'notes.md'), 'mimo-live-tool-fixture-748219', 'utf8');
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '请必须调用 read_file 工具读取 notes.md，然后最终回答只输出文件里的完整标识字符串。不要猜测。',
      provider: {
        id: 'provider_live_tool_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '请必须调用 read_file 工具读取 notes.md，然后最终回答只输出文件里的完整标识字符串。不要猜测。'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(result.toolCalls.includes('read_file'), true);
    assert.match(result.assistantMessage, /mimo-live-tool-fixture-748219/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider writes through guarded workspace tools', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider write smoke.',
  timeout: 120_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-write-e2e-'));
  try {
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '必须通过工具完成，不要只在正文展示代码。',
        '第一步必须调用 create_directory 创建 assets/live。',
        '第二步必须调用 write_file 写入 assets/live/result.txt，内容必须正好是 mimo-live-write-fixture-983421。',
        '完成后最终只用一句话确认。'
      ].join('\n'),
      provider: {
        id: 'provider_live_write_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '创建 live 写入验证文件'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    assert.equal(result.toolCalls.includes('create_directory'), true);
    assert.equal(result.toolCalls.includes('write_file'), true);
    assert.equal(existsSync(join(projectPath, 'assets/live')), true);
    assert.equal(await readFile(join(projectPath, 'assets/live/result.txt'), 'utf8'), 'mimo-live-write-fixture-983421');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider respects plan-mode write boundary', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider plan-mode smoke.',
  timeout: 90_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-plan-boundary-'));
  try {
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '请在项目中创建 should-not-exist.txt，内容为 mimo-plan-boundary-482910。',
        '如果当前模式不能写文件，请不要伪造已经写入；直接说明不能在 Plan 模式下创建文件。'
      ].join('\n'),
      provider: {
        id: 'provider_live_plan_boundary_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, 'Plan 模式写入边界验证'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(result.toolCalls.includes('write_file'), false);
    assert.equal(result.toolCalls.includes('create_directory'), false);
    assert.equal(existsSync(join(projectPath, 'should-not-exist.txt')), false);
    assert.equal(result.assistantMessage.trim().length > 0, true);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider runs approved command in plan mode', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider plan command smoke.',
  timeout: 120_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-plan-command-'));
  try {
    const project = buildProject(projectPath);
    const permissionRequests: Array<{
      risk: 'low' | 'medium' | 'high';
      toolName?: string;
    }> = [];
    const toolResults: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是 Plan 模式下的可确认命令测试，必须通过工具真实执行。',
        '请严格按顺序：',
        '1. 调用 run_command，command 必须正好是 printf mimo-plan-command-approved-372914，timeoutMs 为 5000。',
        '2. 观察命令输出。',
        '3. 不要创建或修改任何文件。',
        '最终回复只输出 PLAN_COMMAND_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_plan_command_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, 'Plan 模式可确认命令验证'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      requestPermission: async (request) => {
        permissionRequests.push({
          risk: request.risk,
          toolName: request.toolName
        });
        return 'allow';
      }
    }, {
      includeCommandTools: true,
      emitToolResult: (toolResult) => {
        toolResults.push(toolResult.content);
      }
    });

    assert.equal(result.toolCalls.includes('run_command'), true);
    assert.equal(result.toolCalls.includes('write_file'), false);
    assert.equal(result.toolCalls.includes('create_directory'), false);
    assert.equal(permissionRequests[0]?.toolName, 'run_command');
    assert.equal(permissionRequests[0]?.risk, 'high');
    assert.match(toolResults.join('\n'), /mimo-plan-command-approved-372914/);
    assert.equal((await readdir(projectPath)).length, 0);
    assert.match(result.assistantMessage, /PLAN_COMMAND_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider recovers from blocked path traversal write', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider path-guard smoke.',
  timeout: 180_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-path-guard-'));
  const outsidePath = join(projectPath, '..', 'mimo-outside-escape-739216.txt');
  try {
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是路径安全与失败恢复测试，必须通过工具真实执行，不要只在正文描述。',
        '请严格按顺序：',
        '1. 调用 write_file，path 必须是 ../mimo-outside-escape-739216.txt，content 必须是 SHOULD_NOT_WRITE。',
        '2. 观察工具返回的错误。',
        '3. 然后调用 create_directory 创建 safe。',
        '4. 调用 write_file 写 safe/result.txt，内容必须正好是 mimo-path-guard-recovered-739216。',
        '最终回复只输出 PATH_GUARD_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_path_guard_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '路径安全失败恢复验证'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    const writeFileCount = result.toolCalls.filter((toolName) => toolName === 'write_file').length;
    assert.equal(writeFileCount >= 2, true);
    assert.equal(result.toolCalls.includes('create_directory'), true);
    assert.equal(existsSync(outsidePath), false);
    assert.equal(await readFile(join(projectPath, 'safe/result.txt'), 'utf8'), 'mimo-path-guard-recovered-739216');
    assert.match(result.assistantMessage, /PATH_GUARD_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test('live openai-compatible provider recovers from failed edit_file', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider edit-recovery smoke.',
  timeout: 180_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-edit-recovery-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src/service.js'), [
      'export const status = "draft";',
      'export function marker() {',
      '  return "mimo-edit-recovery-before-615204";',
      '}',
      ''
    ].join('\n'), 'utf8');

    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是工具失败恢复测试，必须通过工具真实执行，不要只在正文描述。',
        '请严格按顺序：',
        '1. 调用 edit_file 修改 src/service.js，oldText 必须正好是 "DOES_NOT_EXIST_615204"，newText 必须是 "SHOULD_FAIL"。这一步应该失败。',
        '2. 观察 edit_file 的错误后，调用 read_file 读取 src/service.js。',
        '3. 再调用 edit_file 把 mimo-edit-recovery-before-615204 替换成 mimo-edit-recovery-after-615204。',
        '4. 再调用 read_file 确认文件内容。',
        '最终回复只输出 EDIT_RECOVERY_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_edit_recovery_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '工具失败恢复验证'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    const editFileCount = result.toolCalls.filter((toolName) => toolName === 'edit_file').length;
    const readFileCount = result.toolCalls.filter((toolName) => toolName === 'read_file').length;
    const service = await readFile(join(projectPath, 'src/service.js'), 'utf8');

    assert.equal(editFileCount >= 2, true);
    assert.equal(readFileCount >= 1, true);
    assert.match(service, /mimo-edit-recovery-after-615204/);
    assert.equal(service.includes('mimo-edit-recovery-before-615204'), false);
    assert.equal(service.includes('SHOULD_FAIL'), false);
    assert.match(result.assistantMessage, /EDIT_RECOVERY_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider manages a persistent terminal session', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider terminal smoke.',
  timeout: 180_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-terminal-'));
  try {
    const project = buildProject(projectPath);
    const toolResults: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是持久终端管理测试，必须通过 terminal 工具真实执行。',
        '请严格按顺序：',
        '1. 调用 terminal_start，name 为 mimo terminal smoke，command 必须正好是 node -e "console.log(\'mimo-terminal-ready-281604\'); setInterval(() => {}, 1000)"。',
        '2. 调用 terminal_read 读取该终端输出，直到看到 mimo-terminal-ready-281604。',
        '3. 调用 terminal_stop 停止该终端，signal 使用 SIGTERM。',
        '最终回复只输出 TERMINAL_LOOP_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_terminal_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '持久终端管理验证'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeCommandTools: true,
      emitToolResult: (toolResult) => {
        toolResults.push(toolResult.content);
      }
    });

    assert.equal(result.toolCalls.includes('terminal_start'), true);
    assert.equal(result.toolCalls.includes('terminal_read'), true);
    assert.equal(result.toolCalls.includes('terminal_stop'), true);
    assert.match(toolResults.join('\n'), /mimo-terminal-ready-281604/);
    assert.match(result.assistantMessage, /TERMINAL_LOOP_DONE/);
  } finally {
    disposePersistentTerminals();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider handles ask_user and todo updates', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider user-input smoke.',
  timeout: 120_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-ask-todo-'));
  try {
    const project = buildProject(projectPath);
    const userInputRequests: Array<{ question: string; toolName?: string }> = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是用户输入与 todo 工具测试，必须通过工具真实执行。',
        '请严格按顺序：',
        '1. 调用 update_todo_list，记录两个任务：ask_user 等待偏好、finalize 输出结论。',
        '2. 调用 ask_user，问题必须询问选择哪个 marker，选项必须包含 blue-marker 和 green-marker。',
        '3. 收到用户回答后，再调用 update_todo_list，把两个任务都标记 completed。',
        '最终回复只输出 ASK_TODO_DONE 和用户回答。'
      ].join('\n'),
      provider: {
        id: 'provider_live_ask_todo_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '用户输入与 todo 验证'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      requestUserInput: async (request) => {
        userInputRequests.push({
          question: request.question,
          toolName: request.toolName
        });
        return {
          answer: 'blue-marker mimo-ask-answer-018245',
          optionId: 'blue-marker'
        };
      }
    });

    const todoCount = result.toolCalls.filter((toolName) => toolName === 'update_todo_list').length;
    assert.equal(todoCount >= 2, true);
    assert.equal(result.toolCalls.includes('ask_user'), true);
    assert.equal(userInputRequests[0]?.toolName, 'ask_user');
    assert.match(userInputRequests[0]?.question ?? '', /marker/i);
    assert.match(result.assistantMessage, /ASK_TODO_DONE/);
    assert.match(result.assistantMessage, /blue-marker/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider exercises read search summary and preview tools', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider read-suite smoke.',
  timeout: 180_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-read-suite-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'docs'), { recursive: true });
    await writeFile(join(projectPath, 'src/app.js'), [
      'export const appMarker = "mimo-read-suite-492613";',
      'export function appName() { return "reader"; }',
      ''
    ].join('\n'), 'utf8');
    await writeFile(join(projectPath, 'src/util.js'), 'export const utilMarker = "mimo-preview-patch-before";\n', 'utf8');
    await writeFile(join(projectPath, 'docs/spec.md'), '# Spec\n\nmimo-document-marker-492613\n', 'utf8');

    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是只读工具综合测试，必须通过工具真实执行。',
        '请严格按顺序调用这些工具：',
        '1. scan_file_tree。',
        '2. find_files，pattern 使用 src/*.js。',
        '3. search_project_content，query 使用 mimo-read-suite-492613。',
        '4. summarize_directory，path 使用 src。',
        '5. read_document，path 使用 docs/spec.md。',
        '6. preview_file_diff，path 使用 src/app.js，content 使用 export const appMarker = "mimo-read-suite-preview-492613"; 加换行。',
        '7. preview_patch，path 使用 src/util.js，patch 使用这个完整补丁：',
        '--- a/src/util.js',
        '+++ b/src/util.js',
        '@@ -1 +1 @@',
        '-export const utilMarker = "mimo-preview-patch-before";',
        '+export const utilMarker = "mimo-preview-patch-after";',
        '最终回复只输出 READ_SUITE_DONE 和实际调用过的工具名。不要修改文件。'
      ].join('\n'),
      provider: {
        id: 'provider_live_read_suite_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '只读工具综合验证'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    for (const toolName of ['scan_file_tree', 'find_files', 'search_project_content', 'summarize_directory', 'read_document', 'preview_file_diff', 'preview_patch']) {
      assert.equal(result.toolCalls.includes(toolName), true, `${toolName} should have been called`);
    }
    assert.equal(await readFile(join(projectPath, 'src/util.js'), 'utf8'), 'export const utilMarker = "mimo-preview-patch-before";\n');
    assert.match(result.assistantMessage, /READ_SUITE_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider performs multi edit patch diff and rollback', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider checkpoint smoke.',
  timeout: 240_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-checkpoint-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    const originalConfig = [
      'export const alpha = "old-alpha";',
      'export const beta = "old-beta";',
      'export const gamma = "old-gamma";',
      ''
    ].join('\n');
    await writeFile(join(projectPath, 'src/config.js'), originalConfig, 'utf8');

    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是 checkpoint、multi_edit、patch_file 和 rollback 测试，必须通过工具真实执行。',
        '请严格按顺序：',
        '1. 调用 multi_edit 修改 src/config.js，把 old-alpha 改成 new-alpha，把 old-beta 改成 new-beta。',
        '2. 调用 patch_file 修改 src/config.js，把 old-gamma 改成 new-gamma。patch 使用这个完整补丁：',
        '--- a/src/config.js',
        '+++ b/src/config.js',
        '@@ -1,3 +1,3 @@',
        ' export const alpha = "new-alpha";',
        ' export const beta = "new-beta";',
        '-export const gamma = "old-gamma";',
        '+export const gamma = "new-gamma";',
        '3. 调用 checkpoint_diff 查看本轮变更。',
        '4. 调用 read_file 读取 src/config.js，确认包含 new-alpha、new-beta、new-gamma。',
        '5. 调用 checkpoint_rollback 回滚本轮文件修改。',
        '6. 调用 read_file 再次读取 src/config.js，确认恢复 old-alpha、old-beta、old-gamma。',
        '最终回复只输出 CHECKPOINT_ROLLBACK_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_checkpoint_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, 'checkpoint rollback 综合验证'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      },
      checkpointSnapshotId: 'snapshot_live_checkpoint_582041'
    }, {
      includeWriteTools: true
    });

    for (const toolName of ['multi_edit', 'patch_file', 'checkpoint_diff', 'checkpoint_rollback']) {
      assert.equal(result.toolCalls.includes(toolName), true, `${toolName} should have been called`);
    }
    assert.equal(result.toolCalls.filter((toolName) => toolName === 'read_file').length >= 2, true);
    assert.equal(await readFile(join(projectPath, 'src/config.js'), 'utf8'), originalConfig);
    assert.match(result.assistantMessage, /CHECKPOINT_ROLLBACK_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider uses project memory tools', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider memory smoke.',
  timeout: 180_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-memory-'));
  try {
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是项目记忆工具测试，必须通过工具真实执行。',
        '请严格按顺序：',
        '1. 调用 funplay_memory_remember，note 必须包含 mimo-memory-marker-640128，memoryType 使用 longterm，tags 包含 agent-live 和 mimo。',
        '2. 调用 funplay_memory_recent。',
        '3. 调用 funplay_memory_search，query 使用 mimo-memory-marker-640128，limit 使用 5。',
        '4. 调用 funplay_memory_get，filePath 使用 memory.md。',
        '最终回复只输出 MEMORY_TOOLS_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_memory_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '项目记忆工具验证'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    for (const toolName of ['funplay_memory_remember', 'funplay_memory_recent', 'funplay_memory_search', 'funplay_memory_get']) {
      assert.equal(result.toolCalls.includes(toolName), true, `${toolName} should have been called`);
    }
    assert.match(await readFile(join(projectPath, 'memory.md'), 'utf8'), /mimo-memory-marker-640128/);
    assert.match(result.assistantMessage, /MEMORY_TOOLS_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider delegates to a read-only subagent', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider subagent smoke.',
  timeout: 240_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-subagent-'));
  try {
    await writeFile(join(projectPath, 'notes.md'), 'subagent-marker-mimo-918274', 'utf8');
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是只读子任务 Agent 测试，必须通过 run_subagent 工具真实执行。',
        '请严格按顺序：',
        '1. 调用 run_subagent，task 要求子任务读取 notes.md 并返回其中的完整 marker，maxSteps 使用 4。',
        '2. 根据子任务结果给最终回复。',
        '最终回复只输出 SUBAGENT_DONE 和子任务读到的 marker。'
      ].join('\n'),
      provider: {
        id: 'provider_live_subagent_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '只读子任务验证'),
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(result.toolCalls.includes('run_subagent'), true);
    assert.match(result.assistantMessage, /SUBAGENT_DONE/);
    assert.match(result.assistantMessage, /subagent-marker-mimo-918274/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider uses web media and browser-list tools', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider web/media smoke.',
  timeout: 180_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-web-media-'));
  const previousAllowLocalWeb = process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS;
  let serverStarted = false;
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Tool Smoke</title><main>mimo-web-fetch-marker-775120</main>');
  });
  try {
    process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS = '1';
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverStarted = true;
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/tool-smoke`;
    await mkdir(join(projectPath, 'media'), { recursive: true });
    await writeFile(join(projectPath, 'media/note.txt'), 'mimo-media-attach-marker-775120', 'utf8');

    const project = buildProject(projectPath);
    const toolResults: string[] = [];
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是 web、media 和 browser_list 工具测试，必须通过工具真实执行。',
        '请严格按顺序：',
        `1. 调用 web_fetch，url 使用 ${url}，maxChars 使用 2000。`,
        '2. 调用 media_attach_file，filePath 使用 media/note.txt，title 使用 Live media note。',
        '3. 调用 media_save_base64，dataBase64 使用 bWltby1tZWRpYS1zYXZlZC03NzUxMjA=，mimeType 使用 text/plain，fileName 使用 saved-live.txt，title 使用 Saved media note。',
        '4. 调用 browser_list。',
        '最终回复只输出 WEB_MEDIA_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_web_media_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, 'web media browser list 验证'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      emitToolResult: (toolResult) => {
        toolResults.push(toolResult.content);
      }
    });

    for (const toolName of ['web_fetch', 'media_attach_file', 'media_save_base64', 'browser_list']) {
      assert.equal(result.toolCalls.includes(toolName), true, `${toolName} should have been called`);
    }
    assert.match(toolResults.join('\n'), /mimo-web-fetch-marker-775120/);
    assert.match(toolResults.join('\n'), /Attached media/);
    assert.equal(await readFile(join(projectPath, '.funplay-attachments/media/saved-live.txt'), 'utf8'), 'mimo-media-saved-775120');
    assert.match(result.assistantMessage, /WEB_MEDIA_DONE/);
  } finally {
    if (previousAllowLocalWeb === undefined) {
      delete process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS;
    } else {
      process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS = previousAllowLocalWeb;
    }
    if (serverStarted) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider researches web sources and writes a plan', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider research-plan smoke.',
  timeout: 240_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-research-plan-'));
  try {
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是网络搜索、资料收集和方案编写测试，必须通过工具真实执行，不要只在正文描述。',
        '请严格按顺序：',
        '1. 调用 create_directory 创建 docs。',
        '2. 调用 web_search，query 使用 MDN Fetch API documentation，domains 必须包含 developer.mozilla.org，preferOfficial 使用 true，maxResults 使用 3，provider 使用 duckduckgo。',
        '3. 调用 web_fetch 读取 https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch，maxChars 使用 6000。',
        '4. 调用 web_fetch 读取 https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API，maxChars 使用 6000。',
        '5. 调用 write_file 写 docs/research-plan.md。文件必须包含标题 "# Fetch API Research Plan"，必须包含 marker mimo-research-plan-514902，必须包含 "Sources"、"Implementation Plan"、"Risks" 三个章节，并列出上面两个 MDN URL。',
        '6. 调用 read_file 读取 docs/research-plan.md。',
        '最终回复只输出 RESEARCH_PLAN_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_research_plan_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '网络搜索资料收集与方案编写验证'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    assert.equal(result.toolCalls.includes('web_search'), true);
    assert.equal(result.toolCalls.filter((toolName) => toolName === 'web_fetch').length >= 2, true);
    assert.equal(result.toolCalls.includes('write_file'), true);
    assert.equal(result.toolCalls.includes('read_file'), true);
    const plan = await readFile(join(projectPath, 'docs/research-plan.md'), 'utf8');
    assert.match(plan, /# Fetch API Research Plan/);
    assert.match(plan, /mimo-research-plan-514902/);
    assert.match(plan, /Sources/);
    assert.match(plan, /Implementation Plan/);
    assert.match(plan, /Risks/);
    assert.match(plan, /https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/API\/Fetch_API\/Using_Fetch/);
    assert.match(plan, /https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/API\/Fetch_API/);
    assert.match(result.assistantMessage, /RESEARCH_PLAN_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider uses notification task tools', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider notification smoke.',
  timeout: 180_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-notification-'));
  try {
    const project = buildProject(projectPath);
    const futureOnce = new Date(Date.now() + 3_600_000).toISOString();
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是通知任务工具测试，必须通过工具真实执行。',
        '请严格按顺序：',
        '1. 调用 funplay_notify，title 使用 Live notification smoke，body 使用 mimo-notify-marker-830514，priority 使用 low。',
        `2. 调用 funplay_schedule_task，name 使用 Live task smoke 830514，prompt 使用 mimo-task-marker-830514，scheduleType 使用 once，scheduleValue 使用 ${futureOnce}，priority 使用 low，notifyOnComplete 使用 false，durable 使用 false。`,
        '3. 调用 funplay_list_tasks，status 使用 active。',
        '4. 从 schedule 工具结果或 list 结果里找到 taskId，调用 funplay_cancel_task 取消它。',
        '5. 调用 funplay_list_tasks，status 使用 cancelled。',
        '最终回复只输出 NOTIFICATION_TOOLS_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_notification_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '通知任务工具验证'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    for (const toolName of ['funplay_notify', 'funplay_schedule_task', 'funplay_cancel_task']) {
      assert.equal(result.toolCalls.includes(toolName), true, `${toolName} should have been called`);
    }
    assert.equal(result.toolCalls.filter((toolName) => toolName === 'funplay_list_tasks').length >= 2, true);
    assert.match(result.assistantMessage, /NOTIFICATION_TOOLS_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider completes a long multi-tool workspace task', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider long task smoke.',
  timeout: 180_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-long-task-'));
  try {
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '执行一个长复杂 workspace 任务，必须通过工具真实完成，不要只在正文描述。',
        '请严格按下面步骤调用工具：',
        '1. 调用 create_directory 创建 app。',
        '2. 调用 create_directory 创建 docs。',
        '3. 调用 write_file 写入 app/config.json，内容必须是 {"name":"long-task","marker":"mimo-long-task-194837","ready":true}。',
        '4. 调用 write_file 写入 app/main.js，内容必须包含 export const marker = "mimo-long-task-194837";',
        '5. 调用 write_file 写入 docs/plan.md，初始内容必须包含 TODO_MARKER，不要在这一步写 DONE_MARKER。',
        '6. 调用 edit_file 修改 docs/plan.md，把 TODO_MARKER 替换成 DONE_MARKER。',
        '7. 调用 read_file 读取 docs/plan.md。',
        '8. 调用 read_file 读取 app/config.json。',
        '所有步骤完成后，最终回复只输出 COMPLEX_TASK_DONE 和你实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_long_task_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '执行长复杂 workspace 任务'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    const plan = await readFile(join(projectPath, 'docs/plan.md'), 'utf8');
    const config = JSON.parse(await readFile(join(projectPath, 'app/config.json'), 'utf8')) as Record<string, unknown>;
    const main = await readFile(join(projectPath, 'app/main.js'), 'utf8');

    assert.equal(result.toolCalls.includes('create_directory'), true);
    assert.equal(result.toolCalls.includes('write_file'), true);
    assert.equal(result.toolCalls.includes('edit_file'), true);
    assert.equal(result.toolCalls.includes('read_file'), true);
    assert.equal(config.marker, 'mimo-long-task-194837');
    assert.equal(config.ready, true);
    assert.match(main, /mimo-long-task-194837/);
    assert.match(plan, /DONE_MARKER/);
    assert.equal(plan.includes('TODO_MARKER'), false);
    assert.match(result.assistantMessage, /COMPLEX_TASK_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider writes a complex backend system', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider backend task smoke.',
  timeout: 240_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-backend-task-'));
  try {
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '写一个稍复杂但精简的无外部依赖 Node.js ESM 后端系统。必须通过工具真实写入文件，不要只在正文展示代码，每个文件尽量少于 120 行。',
        '请按步骤调用工具：',
        '1. 调用 create_directory 创建 src。',
        '2. 调用 create_directory 创建 tests。',
        '3. 调用 write_file 写 package.json，必须包含 name=mimo-live-backend-system、type=module、scripts.test="node tests/backend.test.mjs"。',
        '4. 调用 write_file 写 src/store.mjs，必须导出 createTaskStore，支持 list/create/update/remove。',
        '5. 调用 write_file 写 src/server.mjs，必须导出 createApp，包含 /health、/api/tasks、validateTaskInput、mimo-backend-system-284611，并使用 src/store.mjs。',
        '6. 调用 write_file 写 tests/backend.test.mjs，必须使用 node:assert/strict，并覆盖 health、task create、task list。',
        '7. 调用 write_file 写 README.md，必须包含 mimo-backend-system-284611 和接口说明。',
        '8. 调用 read_file 读取 package.json。',
        '9. 调用 read_file 读取 src/server.mjs。',
        '最终回复只输出 BACKEND_SYSTEM_DONE 和实际调用过的工具名。'
      ].join('\n'),
      provider: {
        id: 'provider_live_backend_task_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写一个复杂后端系统'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    const packageJson = JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf8')) as Record<string, unknown>;
    const server = await readFile(join(projectPath, 'src/server.mjs'), 'utf8');
    const store = await readFile(join(projectPath, 'src/store.mjs'), 'utf8');
    const backendTest = await readFile(join(projectPath, 'tests/backend.test.mjs'), 'utf8');
    const readme = await readFile(join(projectPath, 'README.md'), 'utf8');

    assert.equal(packageJson.name, 'mimo-live-backend-system');
    assert.equal(packageJson.type, 'module');
    assert.equal((packageJson.scripts as Record<string, unknown> | undefined)?.test, 'node tests/backend.test.mjs');
    assert.equal(result.toolCalls.includes('create_directory'), true);
    assert.equal(result.toolCalls.includes('write_file'), true);
    assert.equal(result.toolCalls.includes('read_file'), true);
    assert.match(server, /createApp/);
    assert.match(server, /\/health/);
    assert.match(server, /\/api\/tasks/);
    assert.match(server, /validateTaskInput/);
    assert.match(server, /mimo-backend-system-284611/);
    assert.match(store, /createTaskStore/);
    assert.match(store, /list/);
    assert.match(store, /create/);
    assert.match(store, /update/);
    assert.match(store, /remove/);
    assert.match(backendTest, /node:assert\/strict/);
    assert.match(readme, /mimo-backend-system-284611/);
    execFileSync('node', ['--check', join(projectPath, 'src/server.mjs')], { timeout: 10_000 });
    execFileSync('node', ['--check', join(projectPath, 'src/store.mjs')], { timeout: 10_000 });
    execFileSync('node', ['--check', join(projectPath, 'tests/backend.test.mjs')], { timeout: 10_000 });
    assert.match(result.assistantMessage, /BACKEND_SYSTEM_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider completes a test-driven backend repair loop', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider dev-loop smoke.',
  timeout: 300_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-dev-loop-'));
  try {
    await mkdir(join(projectPath, 'tests'), { recursive: true });
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      name: 'mimo-live-dev-loop-system',
      type: 'module',
      scripts: {
        test: 'node --test tests/*.test.mjs'
      }
    }, null, 2), 'utf8');
    await writeFile(join(projectPath, 'tests/task-system.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { createTaskStore } from '../src/store.mjs';",
      "import { createApp, validateTaskInput } from '../src/server.mjs';",
      '',
      "test('task store supports lifecycle with filters', () => {",
      '  const store = createTaskStore();',
      "  const created = store.create({ title: 'Ship Agent Loop', priority: 'high', tags: ['runtime', 'mimo'] });",
      "  assert.equal(created.slug, 'ship-agent-loop');",
      "  assert.equal(created.completed, false);",
      "  assert.equal(created.marker, 'mimo-dev-loop-system-593817');",
      "  const updated = store.update(created.id, { completed: true, title: 'Ship Agent Loop Final' });",
      '  assert.equal(updated.completed, true);',
      "  assert.equal(updated.slug, 'ship-agent-loop-final');",
      '  assert.equal(store.list({ completed: true }).length, 1);',
      '  assert.equal(store.remove(created.id), true);',
      '  assert.equal(store.list().length, 0);',
      '});',
      '',
      "test('input validation rejects bad task payloads', () => {",
      "  assert.equal(validateTaskInput({ title: 'Valid task', priority: 'normal' }).ok, true);",
      "  assert.equal(validateTaskInput({ title: '', priority: 'normal' }).ok, false);",
      "  assert.equal(validateTaskInput({ title: 'Bad priority', priority: 'urgent' }).ok, false);",
      "  assert.equal(validateTaskInput({ title: 'Bad tags', tags: 'runtime' }).ok, false);",
      '});',
      '',
      "test('app inject handles health and task routes', async () => {",
      '  const app = createApp();',
      "  const health = await app.inject({ method: 'GET', path: '/health' });",
      '  assert.equal(health.statusCode, 200);',
      "  assert.equal(health.json().marker, 'mimo-dev-loop-system-593817');",
      "  const created = await app.inject({ method: 'POST', path: '/api/tasks', body: { title: 'Write Runtime Test', priority: 'high', tags: ['agent'] } });",
      '  assert.equal(created.statusCode, 201);',
      '  const task = created.json().task;',
      "  assert.equal(task.slug, 'write-runtime-test');",
      "  const listed = await app.inject({ method: 'GET', path: '/api/tasks?completed=false' });",
      '  assert.equal(listed.statusCode, 200);',
      '  assert.equal(listed.json().tasks.length, 1);',
      "  const patched = await app.inject({ method: 'PATCH', path: `/api/tasks/${task.id}`, body: { completed: true } });",
      '  assert.equal(patched.statusCode, 200);',
      '  assert.equal(patched.json().task.completed, true);',
      "  const missing = await app.inject({ method: 'PATCH', path: '/api/tasks/missing', body: { completed: true } });",
      '  assert.equal(missing.statusCode, 404);',
      '});',
      ''
    ].join('\n'), 'utf8');

    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '这是一个真实开发闭环测试。项目里已经有 package.json 和 tests/task-system.test.mjs，当前测试必然失败，因为 src 文件还不存在。',
        '必须严格按这个顺序通过工具完成：',
        '1. 先调用 run_command 执行 npm test，观察初始失败输出；不要先写代码。',
        '2. 调用 create_directory 创建 src。',
        '3. 调用 write_file 实现 src/store.mjs，必须导出 createTaskStore，并满足测试里的 lifecycle/filter/marker/slug 要求。',
        '4. 调用 write_file 实现 src/server.mjs，必须导出 createApp 和 validateTaskInput，并实现 /health、/api/tasks、PATCH /api/tasks/:id 的 inject 行为。',
        '5. 再调用 run_command 执行 npm test。',
        '6. 如果 npm test 失败，必须根据 run_command 输出继续调用 read_file、edit_file 或 write_file 修复，然后再次 run_command，直到测试通过。',
        '最终回复只输出 DEV_LOOP_DONE 和实际调用过的工具名。评估器会检查至少两次 run_command 调用。'
      ].join('\n'),
      provider: {
        id: 'provider_live_dev_loop_e2e',
        name: 'Live E2E Provider',
        protocol: 'openai-compatible',
        apiMode: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_MODE === 'responses' ? 'responses' : 'chat',
        baseUrl: process.env.FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL ?? '',
        apiKey: process.env.FUNPLAY_E2E_OPENAI_COMPAT_API_KEY ?? '',
        model: process.env.FUNPLAY_E2E_OPENAI_COMPAT_MODEL ?? '',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '完成真实开发闭环测试'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      includeCommandTools: true
    });

    const runCommandCount = result.toolCalls.filter((toolName) => toolName === 'run_command').length;
    const store = await readFile(join(projectPath, 'src/store.mjs'), 'utf8');
    const server = await readFile(join(projectPath, 'src/server.mjs'), 'utf8');

    assert.equal(runCommandCount >= 2, true);
    assert.equal(result.toolCalls.includes('create_directory'), true);
    assert.equal(result.toolCalls.includes('write_file'), true);
    assert.match(store, /createTaskStore/);
    assert.match(store, /mimo-dev-loop-system-593817/);
    assert.match(server, /createApp/);
    assert.match(server, /validateTaskInput/);
    assert.match(server, /\/api\/tasks/);
    execFileSync('npm', ['test'], {
      cwd: projectPath,
      timeout: 30_000,
      stdio: 'pipe'
    });
    assert.match(result.assistantMessage, /DEV_LOOP_DONE/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider handles a weakly constrained resource setup request', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider natural asset smoke.',
  timeout: 180_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-natural-assets-'));
  try {
    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: [
        '在这个空项目里帮我整理一个小游戏资源起步目录。',
        '希望有 assets/images、assets/audio、assets/fonts、assets/misc 四类资源目录。',
        '再写一个 memory.md，记录这个资源目录用途，并包含核验标识 mimo-natural-assets-206418。',
        '你自己决定说明怎么写，实际落盘，不要只在聊天里展示。完成后简短说明。'
      ].join('\n'),
      provider: buildLiveOpenAiCompatibleProvider('provider_live_natural_assets_e2e'),
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '自然语言资源目录整理'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true
    });

    for (const directory of ['assets/images', 'assets/audio', 'assets/fonts', 'assets/misc']) {
      assert.equal(existsSync(join(projectPath, directory)), true, `${directory} should exist`);
    }
    const memory = await readFile(join(projectPath, 'memory.md'), 'utf8');
    assert.match(memory, /mimo-natural-assets-206418/);
    assert.equal(result.toolCalls.includes('create_directory'), true);
    assert.equal(result.toolCalls.includes('write_file'), true);
    assert.equal(result.assistantMessage.trim().length > 0, true);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live openai-compatible provider repairs a failing project from a natural request', {
  skip: liveOpenAiCompatibleProviderConfigured
    ? false
    : 'Set FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL, FUNPLAY_E2E_OPENAI_COMPAT_API_KEY, and FUNPLAY_E2E_OPENAI_COMPAT_MODEL to run this live provider natural repair smoke.',
  timeout: 300_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-provider-natural-repair-'));
  try {
    await mkdir(join(projectPath, 'tests'), { recursive: true });
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      name: 'mimo-natural-repair-system',
      type: 'module',
      scripts: {
        test: 'node --test tests/*.test.mjs'
      }
    }, null, 2), 'utf8');
    await writeFile(join(projectPath, 'tests/calculator.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add, divide, slugify } from '../src/calculator.mjs';",
      '',
      "test('calculator helpers work', () => {",
      '  assert.equal(add(2, 5), 7);',
      '  assert.equal(divide(8, 2), 4);',
      "  assert.equal(slugify('MiMo Natural Repair 581026'), 'mimo-natural-repair-581026');",
      '  assert.throws(() => divide(1, 0), /divide by zero/i);',
      '});',
      ''
    ].join('\n'), 'utf8');

    const project = buildProject(projectPath);
    const result = await runOpenAiCompatibleNativeToolLoop({
      project,
      message: '这个项目现在测试跑不起来。你帮我像真实开发一样看一下并修到 npm test 通过，实际改文件和运行必要命令，别只贴代码。完成后简短说明结果。',
      provider: buildLiveOpenAiCompatibleProvider('provider_live_natural_repair_e2e'),
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '自然语言修复失败测试'),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    }, {
      includeWriteTools: true,
      includeCommandTools: true
    });

    const calculator = await readFile(join(projectPath, 'src/calculator.mjs'), 'utf8');
    assert.match(calculator, /add/);
    assert.match(calculator, /divide/);
    assert.match(calculator, /slugify/);
    assert.equal(result.toolCalls.includes('run_command'), true);
    assert.equal(result.toolCalls.includes('write_file') || result.toolCalls.includes('create_directory'), true);
    execFileSync('npm', ['test'], {
      cwd: projectPath,
      timeout: 30_000,
      stdio: 'pipe'
    });
    assert.equal(result.assistantMessage.trim().length > 0, true);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('model message builder reconstructs assistant tool calls and results', () => {
  const createdAt = new Date().toISOString();
  const chat: ChatMessage[] = [
    {
      id: 'msg_user',
      role: 'user',
      content: '请读 package.json',
      createdAt
    },
    {
      id: 'msg_assistant',
      role: 'assistant',
      content: '完成。',
      createdAt,
      metadata: {
        agentCoreParts: [
          {
            id: 'part_thinking',
            kind: 'assistant_thinking',
            sequence: 0,
            createdAt,
            thinking: 'internal chain'
          },
          {
            id: 'part_text_1',
            kind: 'assistant_text',
            sequence: 1,
            createdAt,
            text: '我先读取文件。'
          },
          {
            id: 'part_tool_1',
            kind: 'tool_call',
            sequence: 2,
            createdAt,
            toolUseId: 'tool_1',
            name: 'read_file',
            input: {
              path: 'package.json'
            },
            status: 'completed'
          },
          {
            id: 'part_result_1',
            kind: 'tool_result',
            sequence: 3,
            createdAt,
            toolUseId: 'tool_1',
            toolName: 'read_file',
            content: '{"name":"funplay"}'
          },
          {
            id: 'part_text_2',
            kind: 'assistant_text',
            sequence: 4,
            createdAt,
            text: 'package.json 已读取。'
          },
          {
            id: 'part_tool_unpaired',
            kind: 'tool_call',
            sequence: 5,
            createdAt,
            toolUseId: 'tool_unpaired',
            name: 'read_file',
            input: {
              path: 'missing.md'
            },
            status: 'running'
          }
        ]
      }
    }
  ];

  const messages = buildModelMessagesFromChat(chat);
  assert.equal(messages.length, 5);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[1]?.role, 'assistant');
  assert.equal(messages[2]?.role, 'tool');
  assert.equal(messages[3]?.role, 'assistant');

  const assistantToolCallMessage = messages[1];
  if (assistantToolCallMessage?.role !== 'assistant' || !Array.isArray(assistantToolCallMessage.content)) {
    throw new Error('Expected assistant tool-call message.');
  }
  const toolCall = assistantToolCallMessage.content.find((part) => part.type === 'tool-call');
  if (!toolCall || toolCall.type !== 'tool-call') {
    throw new Error('Expected reconstructed tool-call part.');
  }
  assert.equal(toolCall.toolCallId, 'tool_1');
  assert.equal(toolCall.toolName, 'read_file');
  assert.deepEqual(toolCall.input, {
    path: 'package.json'
  });

  const toolMessage = messages[2];
  if (toolMessage?.role !== 'tool') {
    throw new Error('Expected tool result message.');
  }
  const toolResult = toolMessage.content[0];
  if (!toolResult || toolResult.type !== 'tool-result' || toolResult.output.type !== 'text') {
    throw new Error('Expected reconstructed tool-result part.');
  }
  assert.equal(toolResult.toolCallId, 'tool_1');
  assert.equal(toolResult.toolName, 'read_file');
  assert.match(toolResult.output.value, /funplay/);
  const reasoningPart = assistantToolCallMessage.content.find((part) => part.type === 'reasoning');
  if (!reasoningPart || reasoningPart.type !== 'reasoning') {
    throw new Error('Expected reconstructed assistant reasoning part.');
  }
  assert.equal(reasoningPart.text, 'internal chain');
  const syntheticToolMessage = messages[4];
  assert.equal(syntheticToolMessage?.role, 'tool');
  assert.match(JSON.stringify(syntheticToolMessage), /tool_unpaired/);
  assert.match(JSON.stringify(syntheticToolMessage), /did not return a recorded result/);
  assert.match(JSON.stringify(messages), /missing\.md/);
});

test('model message builder downgrades orphan tool results to assistant text', () => {
  const createdAt = new Date().toISOString();
  const chat: ChatMessage[] = [
    {
      id: 'msg_orphan',
      role: 'assistant',
      content: '',
      createdAt,
      metadata: {
        agentCoreParts: [
          {
            id: 'part_orphan_error',
            kind: 'tool_error',
            sequence: 0,
            createdAt,
            toolUseId: 'missing_tool',
            error: 'late result'
          }
        ]
      }
    }
  ];

  const messages = buildModelMessagesFromChat(chat);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages.some((message) => message.role === 'tool'), false);
  const assistantMessage = messages[0];
  if (assistantMessage?.role !== 'assistant' || !Array.isArray(assistantMessage.content)) {
    throw new Error('Expected assistant text fallback.');
  }
  assert.match(JSON.stringify(assistantMessage.content), /Unmatched Tool Result/);
  assert.match(JSON.stringify(assistantMessage.content), /late result/);
});

test('native tool-loop messages append current prompt after active session history', () => {
  const createdAt = new Date().toISOString();
  const project = buildProject('/tmp/funplay-runtime-test');
  const activeSession = getActiveProjectSession(project);
  const projectWithHistory = replaceProjectSession(
    project,
    {
      ...activeSession,
      chat: [
        {
          id: 'msg_old_user',
          role: 'user',
          content: '旧问题',
          createdAt
        },
        {
          id: 'msg_old_assistant',
          role: 'assistant',
          content: '旧回答',
          createdAt
        }
      ]
    },
    activeSession.id
  );

  const messages = buildNativeToolLoopMessages({
    project: projectWithHistory,
    sessionId: activeSession.id,
    currentPrompt: '当前工作区上下文：\n用户消息：继续推进',
    maxHistoryMessages: 1
  });

  assert.deepEqual(
    messages.map((message) => message.role),
    ['assistant', 'user']
  );
  const currentMessage = messages[1];
  assert.equal(currentMessage?.role, 'user');
  assert.match(String(currentMessage?.content), /继续推进/);
});

test('native tool-loop messages microcompact older tool results while preserving tool pairing', () => {
  const createdAt = new Date().toISOString();
  const project = buildProject('/tmp/funplay-runtime-test');
  const activeSession = getActiveProjectSession(project);
  const longToolOutput = `START_${'very-long-tool-output-'.repeat(500)}_END`;
  const projectWithHistory = replaceProjectSession(
    project,
    {
      ...activeSession,
      chat: [
        {
          id: 'msg_old_user',
          role: 'user',
          content: '旧问题：分析入口',
          createdAt
        },
        {
          id: 'msg_old_assistant',
          role: 'assistant',
          content: '',
          createdAt,
          metadata: {
            agentCoreParts: [
              {
                id: 'part_old_text',
                kind: 'assistant_text',
                sequence: 0,
                createdAt,
                text: '我会先读文件。'
              },
              {
                id: 'part_old_read',
                kind: 'tool_call',
                sequence: 1,
                createdAt,
                toolUseId: 'tool_old_read',
                name: 'read_file',
                input: {
                  path: 'src/App.tsx'
                },
                status: 'completed'
              },
              {
                id: 'part_old_read_result',
                kind: 'tool_result',
                sequence: 2,
                createdAt,
                toolUseId: 'tool_old_read',
                toolName: 'read_file',
                content: longToolOutput
              }
            ]
          }
        },
        {
          id: 'msg_recent_user',
          role: 'user',
          content: '近期问题',
          createdAt
        },
        {
          id: 'msg_recent_assistant',
          role: 'assistant',
          content: '近期回答',
          createdAt
        }
      ]
    },
    activeSession.id
  );

  const messages = buildNativeToolLoopMessages({
    project: projectWithHistory,
    sessionId: activeSession.id,
    currentPrompt: '当前工作区上下文：\n用户消息：继续推进',
    maxHistoryMessages: 4,
    fullDetailRecentMessages: 2
  });

  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'user', 'assistant', 'user']
  );
  assert.match(JSON.stringify(messages[1]), /read_file/);
  assert.match(JSON.stringify(messages[1]), /src\/App\.tsx/);
  assert.match(JSON.stringify(messages[2]), /Native tool result compacted/);
  assert.match(JSON.stringify(messages[2]), /START_/);
  assert.match(JSON.stringify(messages[2]), /chars omitted/);
  assert.equal(JSON.stringify(messages).includes(longToolOutput), false);
  assert.match(String(messages[4]?.content), /近期回答/);
});

test('native context handoff uses storage rowid boundary and keeps rowless in-memory messages', () => {
  const createdAt = new Date().toISOString();
  const project = buildProject('/tmp/funplay-runtime-test');
  const activeSession = getActiveProjectSession(project);
  const chat: ChatMessage[] = [
    ...Array.from({ length: 14 }, (_, index) => ({
      id: `rowid_msg_${index + 1}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: index === 0
        ? `persisted message 1 Decision: use Native runtime by default. Must preserve Build and Plan permission boundaries. TODO: finish browser verification next. ${'x'.repeat(40)}`
        : `persisted message ${index + 1} ${'x'.repeat(40)}`,
      createdAt,
      ordinal: index + 1,
      storageRowId: index + 1
    })),
    {
      id: 'in_memory_message',
      role: 'user',
      content: 'rowless in-memory message',
      createdAt,
      ordinal: 99
    }
  ];

  const summary = buildNativeContextSummaryForSession({
    session: {
      ...activeSession,
      chat
    },
    force: true,
    recentMessageCount: 4
  });

  assert.ok(summary);
  assert.equal(summary.coverage.boundaryRowId, 10);
  assert.equal(summary.coverage.boundaryOrdinal, 10);
  assert.match(summary.summary, /persisted message 1/);
  assert.match(summary.summary, /Context summary audit/);
  assert.match(summary.coverage.audit?.decisions.join('\n') ?? '', /Native runtime/);
  assert.match(summary.coverage.audit?.constraints.join('\n') ?? '', /permission boundaries/);
  assert.match(summary.coverage.audit?.openTasks.join('\n') ?? '', /browser verification/);
  assert.doesNotMatch(summary.summary, /rowless in-memory message/);

  const remaining = filterNativeMessagesAfterSummaryBoundary(chat, summary.coverage);
  assert.deepEqual(
    remaining.map((message) => message.id),
    ['rowid_msg_11', 'rowid_msg_12', 'rowid_msg_13', 'rowid_msg_14', 'in_memory_message']
  );

  const noRegression = buildNativeContextSummaryForSession({
    session: {
      ...activeSession,
      runtimeOverrides: {
        nativeContextSummary: summary.summary,
        nativeContextSummaryCoverage: summary.coverage
      },
      chat: chat.slice(0, 12)
    },
    force: true,
    recentMessageCount: 4
  });
  assert.equal(noRegression, undefined);
});

test('native context handoff falls back to ordinal boundary for legacy messages without rowid', () => {
  const createdAt = new Date().toISOString();
  const project = buildProject('/tmp/funplay-runtime-test');
  const activeSession = getActiveProjectSession(project);
  const chat: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
    id: `legacy_msg_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `legacy message ${index}`,
    createdAt,
    ordinal: index
  }));

  const summary = buildNativeContextSummaryForSession({
    session: {
      ...activeSession,
      chat
    },
    force: true,
    recentMessageCount: 4
  });

  assert.ok(summary);
  assert.equal(summary.coverage.boundaryRowId, undefined);
  assert.equal(summary.coverage.boundaryOrdinal, 7);
  assert.deepEqual(
    filterNativeMessagesAfterSummaryBoundary(chat, summary.coverage).map((message) => message.id),
    ['legacy_msg_8', 'legacy_msg_9', 'legacy_msg_10', 'legacy_msg_11']
  );
});

test('native tool-loop messages include native summary and skip covered rowid history', () => {
  const createdAt = new Date().toISOString();
  const project = buildProject('/tmp/funplay-runtime-test');
  const activeSession = getActiveProjectSession(project);
  const projectWithSummary = replaceProjectSession(
    project,
    {
      ...activeSession,
      runtimeOverrides: {
        nativeContextSummary: 'covered native summary',
        nativeContextSummaryCoverage: {
          version: 1,
          strategy: 'extractive',
          boundaryRowId: 2,
          boundaryOrdinal: 2,
          messageCount: 2,
          turnCount: 1,
          generatedAt: createdAt
        }
      },
      chat: [
        {
          id: 'covered_user',
          role: 'user',
          content: 'covered user should not be sent',
          createdAt,
          ordinal: 1,
          storageRowId: 1
        },
        {
          id: 'covered_assistant',
          role: 'assistant',
          content: 'covered assistant should not be sent',
          createdAt,
          ordinal: 2,
          storageRowId: 2
        },
        {
          id: 'remaining_user',
          role: 'user',
          content: 'remaining user should be sent',
          createdAt,
          ordinal: 3,
          storageRowId: 3
        }
      ]
    },
    activeSession.id
  );

  const messages = buildNativeToolLoopMessages({
    project: projectWithSummary,
    sessionId: activeSession.id,
    currentPrompt: 'current prompt',
    maxHistoryMessages: 8
  });

  assert.match(String(messages[0]?.content), /covered native summary/);
  assert.equal(JSON.stringify(messages).includes('covered user should not be sent'), false);
  assert.match(JSON.stringify(messages), /remaining user should be sent/);
  assert.match(JSON.stringify(messages), /current prompt/);
});

test('session write permissions are tool-scoped and revocable', () => {
  const sessionId = `session_${Date.now()}`;

  assert.equal(hasSessionWritePermission(sessionId, 'write_file'), false);
  grantSessionWritePermission(sessionId, {
    tools: ['write_file'],
    ttlMs: 10_000
  });
  assert.equal(hasSessionWritePermission(sessionId, 'write_file'), true);
  assert.equal(hasSessionWritePermission(sessionId, 'execute_code'), false);

  revokeSessionWritePermission(sessionId);
  assert.equal(hasSessionWritePermission(sessionId, 'write_file'), false);

  const editOnlySessionId = `${sessionId}_edit`;
  grantSessionWritePermission(editOnlySessionId, {
    tools: ['edit_file'],
    ttlMs: 10_000
  });
  assert.equal(hasSessionWritePermission(editOnlySessionId, 'edit_file'), true);
  assert.equal(hasSessionWritePermission(editOnlySessionId, 'write_file'), false);
  revokeSessionWritePermission(editOnlySessionId);
});

test('session MCP permissions are scoped by stable plugin tool keys', () => {
  const sessionId = `session_mcp_${Date.now()}`;
  const permissionKey = makeSessionMcpToolPermissionKey('plugin_a', 'unity.echo');
  const grant = grantSessionWritePermission(sessionId, {
    tools: [],
    mcpTools: [permissionKey],
    ttlMs: 10_000
  });

  assert.deepEqual(grant.tools, []);
  assert.deepEqual(grant.mcpTools, [permissionKey]);
  assert.equal(hasSessionWritePermission(sessionId, 'write_file'), false);
  assert.equal(hasSessionMcpToolPermission(sessionId, permissionKey), true);
  assert.deepEqual(listSessionMcpToolPermissionKeys(sessionId), [permissionKey]);

  revokeSessionWritePermission(sessionId);
  assert.equal(hasSessionMcpToolPermission(sessionId, permissionKey), false);
  restoreSessionWritePermissionGrant(sessionId, grant);
  assert.equal(hasSessionMcpToolPermission(sessionId, permissionKey), true);
  revokeSessionWritePermission(sessionId);
});

test('session write permissions restore only for matching runtime and cwd', () => {
  const sessionId = `session_context_${Date.now()}`;
  const grant = grantSessionWritePermission(sessionId, {
    tools: ['write_file'],
    ttlMs: 10_000,
    runtimeId: 'claude-code-sdk',
    cwd: '/tmp/funplay-context-a'
  });

  assert.equal(hasSessionWritePermission(sessionId, 'write_file', {
    runtimeId: 'claude-code-sdk',
    cwd: '/tmp/funplay-context-a'
  }), true);
  assert.equal(hasSessionWritePermission(sessionId, 'write_file', {
    runtimeId: 'native',
    cwd: '/tmp/funplay-context-a'
  }), false);
  assert.equal(hasSessionWritePermission(sessionId, 'write_file', {
    runtimeId: 'claude-code-sdk',
    cwd: '/tmp/funplay-context-b'
  }), false);

  revokeSessionWritePermission(sessionId);
  assert.equal(hasSessionWritePermission(sessionId, 'write_file', {
    runtimeId: 'claude-code-sdk',
    cwd: '/tmp/funplay-context-a'
  }), false);
  restoreSessionWritePermissionGrant(sessionId, grant);
  assert.equal(hasSessionWritePermission(sessionId, 'write_file', {
    runtimeId: 'claude-code-sdk',
    cwd: '/tmp/funplay-context-a'
  }), true);
  revokeSessionWritePermission(sessionId);
});

test('permission broker respects tool-scoped session grants', async () => {
  const writeFile = getAgentToolDefinition('write_file');
  const editFile = getAgentToolDefinition('edit_file');
  assert.ok(writeFile);
  assert.ok(editFile);

  const scopedContext = {
    permission: {
      mode: 'ask' as const,
      allowWriteTools: false,
      allowSessionWriteTools: true,
      allowedWriteTools: ['write_file']
    }
  };

  assert.equal(
    await resolveAgentToolPermission(scopedContext, {
      tool: writeFile
    }),
    'allow'
  );
  assert.equal(
    await resolveAgentToolPermission(scopedContext, {
      tool: editFile
    }),
    'deny'
  );

  const requested: Array<{
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    toolName?: string;
  }> = [];
  assert.equal(
    await resolveAgentToolPermission(
      {
        permission: {
          mode: 'ask' as const,
          allowWriteTools: false,
          allowSessionWriteTools: false,
          allowedWriteTools: []
        },
        requestPermission: async (request) => {
          requested.push(request);
          return 'allow_session' as const;
        }
      },
      {
        tool: editFile
      }
    ),
    'allow'
  );
  assert.equal(requested[0]?.toolName, 'edit_file');
});

test('permission broker respects session-scoped MCP grants', async () => {
  const callMcpTool = getAgentToolDefinition('call_mcp_tool');
  assert.ok(callMcpTool);
  const permissionKey = makeSessionMcpToolPermissionKey('plugin_test_mcp', 'unity.echo');

  assert.equal(
    await resolveAgentToolPermission(
      {
        permission: {
          mode: 'ask' as const,
          allowWriteTools: false,
          allowSessionWriteTools: false,
          allowedWriteTools: [],
          allowedMcpTools: [permissionKey]
        }
      },
      {
        tool: callMcpTool,
        mcp: {
          permissionKey,
          pluginId: 'plugin_test_mcp',
          pluginName: 'Test MCP',
          toolName: 'unity.echo',
          permission: 'ask',
          risk: 'write'
        }
      }
    ),
    'allow'
  );

  assert.equal(
    await resolveAgentToolPermission(
      {
        permission: {
          mode: 'ask' as const,
          allowWriteTools: false,
          allowSessionWriteTools: false,
          allowedWriteTools: [],
          allowedMcpTools: []
        }
      },
      {
        tool: callMcpTool,
        mcp: {
          permissionKey,
          pluginId: 'plugin_test_mcp',
          pluginName: 'Test MCP',
          toolName: 'unity.echo',
          permission: 'ask',
          risk: 'write'
        }
      }
    ),
    'deny'
  );
});


test('project memory service lists, edits, filters, and clears memory files', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-memory-ui-'));
  try {
    await mkdir(join(projectPath, 'memory', 'daily'), { recursive: true });
    await writeFile(join(projectPath, 'memory.md'), '# Memory\n\n- Prefer compact UI #ux #memory/user-preference\n', 'utf8');
    await writeFile(join(projectPath, 'memory', 'daily', '2026-04-24.md'), '# 2026-04-24\n\n- Shipped notification center #release #memory/decision\n', 'utf8');

    const project = buildProject(projectPath);
    const state: AppState = {
      settings: {
        baseUrl: 'http://127.0.0.1:8765/',
        profile: 'core',
        lastStatus: 'idle'
      },
      aiSettings: {
        fallbackToLocalPlanner: true
      },
      agentSettings: {
        permissionMode: 'ask',
        runtimeStrategy: 'native'
      },
      providers: [],
      mcpSettings: {},
      mcpPlugins: [],
      assetGenerationProviders: [],
      projects: [project]
    };

    const files = await listProjectMemoryFiles(state, project.id);
    assert.deepEqual(files.map((file) => file.path), ['memory.md', 'memory/daily/2026-04-24.md']);
    assert.deepEqual(files[0].tags, ['memory/user-preference', 'ux']);
    assert.deepEqual(files[0].memoryKinds, ['user_preference']);
    assert.deepEqual(files[1].tags, ['memory/decision', 'release']);
    assert.deepEqual(files[1].memoryKinds, ['decision']);

    const edited = await saveProjectMemoryFile(
      state,
      project.id,
      'memory/daily/2026-04-24.md',
      '# 2026-04-24\n\n- Added advanced memory UI #memory #memory/task-state\n'
    );
    assert.equal(edited.path, 'memory/daily/2026-04-24.md');
    assert.deepEqual(edited.tags, ['memory', 'memory/task-state']);
    assert.deepEqual(edited.memoryKinds, ['task_state']);

    const readBack = await readProjectMemoryFile(state, project.id, 'memory/daily/2026-04-24.md');
    assert.match(readBack.content, /advanced memory UI/);

    await clearProjectMemory(state, project.id, { scope: 'file', filePath: 'memory/daily/2026-04-24.md' });
    assert.equal(await readFile(join(projectPath, 'memory', 'daily', '2026-04-24.md'), 'utf8'), '# 2026-04-24\n\n');

    const dailyCleared = await clearProjectMemory(state, project.id, { scope: 'daily' });
    assert.deepEqual(dailyCleared.map((file) => file.path), ['memory.md']);

    const allCleared = await clearProjectMemory(state, project.id, { scope: 'all' });
    assert.deepEqual(allCleared.map((file) => file.path), ['memory.md']);
    assert.equal(await readFile(join(projectPath, 'memory.md'), 'utf8'), '# Memory\n\n');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('session checkpoint captures chat and can rewind active session state', () => {
  let project = buildProject();
  const activeSession = getActiveProjectSession(project);
  project = appendProjectConversationTurn(project, {
    userMessageId: 'msg_user_original',
    userMessage: '第一条消息',
    assistantMessage: '第一条回复',
    updatedAt: new Date().toISOString()
  });

  const snapshot = createSnapshot(project, 'Before second prompt', {
    sessionId: activeSession.id,
    includeSessionCheckpoint: true,
    triggerUserMessageId: 'msg_user_original'
  });
  project = {
    ...project,
    snapshots: [snapshot, ...project.snapshots]
  };
  project = appendProjectConversationTurn(project, {
    userMessage: '第二条消息',
    assistantMessage: '第二条回复',
    updatedAt: new Date().toISOString()
  });

  const checkpoint = project.snapshots[0].sessionCheckpoint;
  assert.ok(checkpoint);
  const checkpointSession = createProjectSessionRecord({
    title: checkpoint.sessionTitle,
    chat: checkpoint.chat,
    autoTitle: false
  });
  const restored = replaceProjectSession(project, {
    ...checkpointSession,
    id: checkpoint.sessionId
  }, checkpoint.sessionId);
  const restoredSession = getActiveProjectSession(restored);

  assert.equal(restoredSession.chat.some((message) => message.content === '第二条消息'), false);
  assert.equal(restoredSession.chat.at(-1)?.content, '第一条回复');
});

test('session checkpoint preview includes file diffs recorded for rollback UI', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-checkpoint-preview-'));
  try {
    await writeFile(join(projectPath, 'notes.md'), 'before\n', 'utf8');
    let project = buildProject(projectPath);
    const activeSession = getActiveProjectSession(project);
    project = appendProjectConversationTurn(project, {
      userMessage: '第一条消息',
      assistantMessage: '第一条回复',
      updatedAt: new Date().toISOString()
    });
    const snapshot = createSnapshot(project, 'Before edit', {
      sessionId: activeSession.id,
      includeSessionCheckpoint: true
    });
    project = {
      ...project,
      snapshots: [snapshot, ...project.snapshots]
    };

    const edited = await executeAgentToolAction(
      project,
      {
        type: 'edit_file',
        path: 'notes.md',
        oldText: 'before',
        newText: 'after'
      },
      {
        checkpointSnapshotId: snapshot.id
      }
    );
    assert.equal(edited.ok, true);

    const state = buildState(project) as AppState;
    const preview = await previewSessionCheckpoint(state, project.id, snapshot.id);
    assert.equal(preview.fileChanges?.length, 1);
    assert.equal(preview.fileChanges?.[0]?.path, 'notes.md');
    assert.equal(preview.fileChanges?.[0]?.status, 'modified');
    assert.match(preview.fileChanges?.[0]?.diffPreview ?? '', /-before/);
    assert.match(preview.fileChanges?.[0]?.diffPreview ?? '', /\+after/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace context compresses archived turns into summary', () => {
  let project = buildProject();
  for (let index = 0; index < 10; index += 1) {
    project = appendProjectConversationTurn(project, {
      userMessage: `用户消息 ${index + 1}`,
      assistantMessage: `助手回复 ${index + 1}`,
      updatedAt: new Date(Date.now() + index * 1000).toISOString()
    });
  }

  const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);
  const totalTurns = buildSessionConversationTurns(getActiveProjectSession(project).chat, Number.MAX_SAFE_INTEGER).length;
  assert.equal(context.recentTurns.length, 6);
  assert.equal(context.archivedTurnCount, totalTurns - context.recentTurns.length);
  assert.match(context.archivedSummary ?? '', /历史轮次/);
});

test('workspace context stays scoped to the active session', () => {
  const createdAt = new Date().toISOString();
  const baseProject = buildProject();
  const activeSession = getActiveProjectSession(baseProject);
  const activeMessage: ChatMessage = {
    id: 'active_user',
    role: 'user',
    content: 'current session only',
    createdAt
  };
  const otherMessages: ChatMessage[] = [
    {
      id: 'other_user',
      role: 'user',
      content: 'other session secret decision',
      createdAt
    },
    {
      id: 'other_assistant',
      role: 'assistant',
      content: 'other session answer',
      createdAt
    }
  ];
  const otherSession = createProjectSessionRecord({
    title: 'Other Session',
    chat: otherMessages
  });
  const project = {
    ...baseProject,
    sessions: [
      {
        ...activeSession,
        chat: [activeMessage]
      },
      otherSession
    ],
    activeSessionId: activeSession.id
  };

  const context = buildGenericWorkspaceContext(project, [], activeSession.id, 'secret decision');
  assert.deepEqual(context.crossSessionSummaries, []);
  assert.deepEqual(context.relatedSessionEvidence, []);
  assert.doesNotMatch(JSON.stringify(context), /other session secret decision/);
});

test('workspace context includes runtime environment and git snapshot', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-runtime-env-'));
  try {
    const project = buildProject(projectPath);
    const initializedGit = tryRunGit(['init'], projectPath);
    await writeFile(join(projectPath, 'sample.txt'), 'draft', 'utf8');

    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);
    assert.equal(context.runtimeEnvironment?.workingDirectory, projectPath);
    assert.equal(context.runtimeEnvironment?.platform, process.platform);
    assert.match(context.runtimeEnvironment?.currentDate ?? '', /^\d{4}-\d{2}-\d{2}$/);

    if (initializedGit) {
      assert.equal(context.runtimeEnvironment?.isGitRepository, true);
      assert.match(context.runtimeEnvironment?.git?.status ?? '', /sample\.txt/);
    }
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('project context no longer derives phase-based current goals', () => {
  const project = refreshProjectContext(buildProject());
  const activeSession = getActiveProjectSession(project);
  const context = buildGenericWorkspaceContext(project, [], activeSession.id);

  assert.equal(project.contextSummary.currentGoal, '');
  assert.equal(context.currentGoal, '');
});

test('project context does not derive phase goals from real project tasks', () => {
  const baseProject = buildProject();
  const project = refreshProjectContext({
    ...baseProject,
    tasks: [
      ...baseProject.tasks.map((task) => ({
        ...task,
        status: 'done' as const
      })),
      {
        id: 'task_real_goal',
        title: '实现上传接口',
        phase: 'Content' as const,
        status: 'pending' as const,
        owner: 'AI Assistant',
        description: '实现文件上传接口并补充验证。'
      }
    ]
  });
  const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);

  assert.equal(project.contextSummary.currentGoal, '');
  assert.equal(context.currentGoal, '');
});

test('workspace context builds a structured project context index', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-context-index-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      name: 'context-index-fixture',
      type: 'module',
      main: 'src/server.mjs',
      scripts: {
        dev: 'vite --host 127.0.0.1',
        build: 'tsc --noEmit && vite build',
        test: 'node --test tests/*.test.mjs'
      },
      dependencies: {
        fastify: '^5.0.0'
      },
      devDependencies: {
        typescript: '^5.0.0'
      }
    }, null, 2), 'utf8');
    await writeFile(join(projectPath, 'src', 'server.mjs'), 'export function createApp() {}\n', 'utf8');
    await writeFile(join(projectPath, 'src', 'main.ts'), 'console.log("main");\n', 'utf8');
    await writeFile(join(projectPath, 'vite.config.ts'), 'export default {};\n', 'utf8');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);

    assert.equal(context.projectContextIndex?.packageManager, 'npm');
    assert.deepEqual(context.projectContextIndex?.manifests[0], {
      path: 'package.json',
      kind: 'node',
      name: 'context-index-fixture'
    });
    assert.equal(context.projectContextIndex?.scripts.some((script) => script.name === 'build' && script.command.includes('vite build')), true);
    assert.equal(context.projectContextIndex?.testCommands.some((script) => script.name === 'test'), true);
    assert.equal(context.projectContextIndex?.dependencies.some((dependency) => dependency.name === 'fastify' && dependency.kind === 'runtime'), true);
    assert.equal(context.projectContextIndex?.dependencies.some((dependency) => dependency.name === 'typescript' && dependency.kind === 'dev'), true);
    assert.equal(context.projectContextIndex?.entrypoints.some((entrypoint) => entrypoint.path === 'src/server.mjs'), true);
    assert.equal(context.projectContextIndex?.entrypoints.some((entrypoint) => entrypoint.path === 'src/main.ts'), true);
    assert.equal(context.projectContextIndex?.configFiles.includes('vite.config.ts'), true);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace context discovers project-level agent instructions', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-instructions-'));
  try {
    await writeFile(join(projectPath, 'AGENTS.md'), '# Instructions\n\nAlways run npm run build before final.', 'utf8');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);

    assert.equal(context.projectInstructions.length, 1);
    assert.equal(context.projectInstructions[0]?.path, 'AGENTS.md');
    assert.match(context.projectInstructions[0]?.content ?? '', /npm run build/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace context discovers path-scoped agent instructions', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-nested-instructions-'));
  try {
    await mkdir(join(projectPath, 'src', 'feature'), { recursive: true });
    await writeFile(join(projectPath, 'AGENTS.md'), '# Root\n\nUse project defaults.', 'utf8');
    await writeFile(join(projectPath, 'src', 'AGENTS.md'), '# Src\n\nUse React hooks.', 'utf8');
    await writeFile(join(projectPath, 'src', 'feature', 'CLAUDE.md'), '# Feature\n\nPreserve feature rules.', 'utf8');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(
      project,
      [],
      getActiveProjectSession(project).id,
      '请修改 `src/feature/App.tsx` 并遵守局部规则'
    );

    assert.deepEqual(
      context.projectInstructions.map((instruction) => instruction.path),
      ['AGENTS.md', 'src/AGENTS.md', 'src/feature/CLAUDE.md']
    );
    assert.match(context.projectInstructions[1]?.content ?? '', /React hooks/);
    assert.match(context.projectInstructions[2]?.content ?? '', /feature rules/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('project instruction tracker discovers path-scoped rules from native tool inputs', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-tool-instructions-'));
  try {
    await mkdir(join(projectPath, 'src', 'feature'), { recursive: true });
    await writeFile(join(projectPath, 'AGENTS.md'), '# Root\n\nUse project defaults.', 'utf8');
    await writeFile(join(projectPath, 'src', 'AGENTS.md'), '# Src\n\nUse React hooks.', 'utf8');
    await writeFile(join(projectPath, 'src', 'feature', 'CLAUDE.md'), '# Feature\n\nPreserve feature rules.', 'utf8');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);
    const tracker = new ProjectInstructionTracker(project, context.projectInstructions);

    assert.equal(
      extractNativeToolInputInstructionQuery('read_file', { path: 'src/feature/App.tsx' }),
      'src/feature/App.tsx'
    );

    const discovered = tracker.discoverFromToolInput('read_file', { path: 'src/feature/App.tsx' });
    assert.deepEqual(
      discovered.map((instruction) => instruction.path),
      ['src/AGENTS.md', 'src/feature/CLAUDE.md']
    );
    assert.deepEqual(tracker.discoverFromToolInput('edit_file', { path: 'src/feature/App.tsx' }), []);
    assert.match(tracker.formatDynamicInstructionMessage() ?? '', /src\/AGENTS\.md/);
    assert.match(tracker.formatDynamicInstructionMessage() ?? '', /src\/feature\/CLAUDE\.md/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('archived conversation summary returns undefined for empty input', () => {
  assert.equal(summarizeArchivedConversationTurns([]), undefined);
});

test('chat message text helpers read Agent Core parts as the structured ledger', () => {
  const message: ChatMessage = {
    id: 'msg_core_text',
    role: 'assistant',
    content: '[Previous tool call] stale_tool input={}',
    createdAt: '2026-05-16T00:00:00.000Z',
    metadata: {
      agentCoreParts: [
        {
          id: 'part_tool',
          kind: 'tool_call',
          createdAt: '2026-05-16T00:00:00.000Z',
          sequence: 0,
          toolUseId: 'tool_read',
          name: 'read_file',
          input: {
            path: 'README.md'
          },
          status: 'completed'
        },
        {
          id: 'part_result',
          kind: 'tool_result',
          createdAt: '2026-05-16T00:00:01.000Z',
          sequence: 1,
          toolUseId: 'tool_read',
          toolName: 'read_file',
          content: 'README loaded'
        },
        {
          id: 'part_text',
          kind: 'assistant_text',
          createdAt: '2026-05-16T00:00:02.000Z',
          sequence: 2,
          text: 'Final answer from parts.',
          final: true
        }
      ]
    }
  };

  const contextText = getChatMessageContextText(message);
  const visibleText = getChatMessageVisibleAssistantText(message);

  assert.match(contextText, /read_file/);
  assert.match(contextText, /README loaded/);
  assert.match(contextText, /Final answer from parts/);
  assert.equal(visibleText, 'Final answer from parts.');
});

test('session runtime overrides can switch provider and model', () => {
  let project = buildProject();
  const activeSession = getActiveProjectSession(project);
  project = replaceProjectSession(project, {
    ...activeSession,
    runtimeOverrides: {
      providerId: 'provider_alt',
      model: 'gpt-override',
      upstreamModel: 'upstream-override'
    }
  }, activeSession.id);

  const provider = resolveAgentProvider(buildState(project), project);
  assert.ok(provider);
  assert.equal(provider.id, 'provider_alt');
  assert.equal(provider.model, 'gpt-override');
  assert.equal(provider.upstreamModel, 'upstream-override');
});

test('project agent policy provides a project-scoped permission default', () => {
  const project = buildProject();
  const state = buildState(project);
  const updated = updateProjectAgentPolicy(state, project.id, {
    permissionMode: 'ask'
  });

  assert.equal(updated.agentPolicy?.permissionMode, 'ask');
  assert.equal(state.projects[0].agentPolicy?.permissionMode, 'ask');
  assert.equal(getActiveProjectSession(updated).runtimeOverrides?.permissionMode, undefined);
});

test('project user skills are injected into workspace context without exposing disabled skills', () => {
  const now = new Date().toISOString();
  const project = buildProject();
  const state = buildState(project);
  const updated = updateProjectAgentPolicy(state, project.id, {
    skills: [
      {
        id: 'skill_unity_scene',
        name: 'Unity Scene Builder',
        description: 'Build Unity scenes with project naming conventions.',
        trigger: 'When the user asks for Unity scene work.',
        instruction: 'Always inspect existing scene structure before editing and verify hierarchy names.',
        enabled: true,
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'skill_disabled',
        name: 'Disabled Skill',
        instruction: 'This instruction should not be injected.',
        enabled: false,
        createdAt: now,
        updatedAt: now
      }
    ]
  });

  const context = buildGenericWorkspaceContext(updated, [], getActiveProjectSession(updated).id);

  assert.equal(context.toolContext.skills.length, 1);
  assert.equal(context.toolContext.skills[0].id, 'skill_unity_scene');
  assert.equal(context.toolContext.skills[0].name, 'Unity Scene Builder');
  assert.match(context.toolContext.skills[0].instruction, /verify hierarchy names/);
});

test('funplay skill catalog parser reads SKILL markdown metadata', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'funplay-skill-catalog-'));
  try {
    await mkdir(join(repoPath, 'skills', 'sprite-sheet'), { recursive: true });
    await writeFile(join(repoPath, 'skills', 'sprite-sheet', 'SKILL.md'), [
      '---',
      'name: sprite-sheet',
      'description: Slice sprite sheets into frames.',
      'dependencies:',
      '  - sharp',
      'inputs:',
      '  - image path',
      'outputs:',
      '  - output directory',
      'examples:',
      '  - node skills/sprite-sheet/scripts/slice.mjs ./sheet.png 4 4',
      '---',
      '',
      '# Sprite Sheet',
      '',
      'Use this skill for deterministic frame extraction.'
    ].join('\n'), 'utf8');

    const catalog = parseFunplaySkillCatalogFromDirectory(repoPath, {
      repositoryUrl: 'https://github.com/FunplayAI/funplay-skill.git',
      repositoryRef: 'main',
      commitSha: 'abc123',
      fetchedAt: '2026-04-27T00:00:00.000Z'
    });

    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, 'sprite-sheet');
    assert.equal(catalog[0].description, 'Slice sprite sheets into frames.');
    assert.deepEqual(catalog[0].dependencies, ['sharp']);
    assert.match(catalog[0].instruction, /deterministic frame extraction/);
    assert.match(catalog[0].sourceUrl, /abc123\/skills\/sprite-sheet\/SKILL\.md/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('agent skill registry discovers project and user SKILL packages with precedence', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-skill-registry-project-'));
  const userHomePath = await mkdtemp(join(tmpdir(), 'funplay-skill-registry-home-'));
  try {
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'sprite-sheet'), { recursive: true });
    await mkdir(join(userHomePath, '.claude', 'skills', 'sprite-sheet'), { recursive: true });
    await mkdir(join(userHomePath, '.claude', 'skills', 'pixel-audit'), { recursive: true });
    await writeFile(join(projectPath, '.claude', 'skills', 'sprite-sheet', 'SKILL.md'), [
      '---',
      'name: sprite-sheet',
      'description: Project sprite workflow.',
      'allowed-tools:',
      '  - read_file',
      '---',
      '',
      'Use the project sprite workflow.'
    ].join('\n'), 'utf8');
    await writeFile(join(userHomePath, '.claude', 'skills', 'sprite-sheet', 'SKILL.md'), [
      '---',
      'name: sprite-sheet',
      'description: User override workflow.',
      'disable-model-invocation: true',
      '---',
      '',
      'Use the user sprite override.'
    ].join('\n'), 'utf8');
    await writeFile(join(userHomePath, '.claude', 'skills', 'pixel-audit', 'SKILL.md'), [
      '---',
      'name: pixel-audit',
      'description: Inspect pixel art.',
      'user-invocable: false',
      '---',
      '',
      'Audit sprite clarity.'
    ].join('\n'), 'utf8');

    const registry = buildAgentSkillRegistry({ projectPath, userHomePath });

    assert.deepEqual(registry.index.map((skill) => skill.name), ['pixel-audit', 'sprite-sheet']);
    const sprite = registry.packages.find((skill) => skill.name === 'sprite-sheet');
    assert.equal(sprite?.source, 'user');
    assert.equal(sprite?.modelInvocable, false);
    assert.equal(sprite?.trustLevel, 'trusted');
    assert.equal(sprite?.verificationStatus, 'trusted_source');
    assert.match(sprite?.contentSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(sprite?.permissionPolicy, 'workspace_policy');
    assert.equal(sprite?.scriptPolicy, 'none');
    assert.match(sprite?.instruction ?? '', /user sprite override/);
    const pixelAudit = registry.index.find((skill) => skill.name === 'pixel-audit');
    assert.equal(pixelAudit?.userInvocable, false);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
    await rm(userHomePath, { recursive: true, force: true });
  }
});

test('workspace context includes filesystem skill metadata without loading full instructions', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-skill-context-'));
  try {
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'scene-check'), { recursive: true });
    await writeFile(join(projectPath, '.claude', 'skills', 'scene-check', 'SKILL.md'), [
      '---',
      'name: scene-check',
      'description: Verify scene object naming.',
      'examples:',
      '  - Check the active scene hierarchy',
      '---',
      '',
      'Full scene verification instructions should stay lazy.'
    ].join('\n'), 'utf8');

    const context = buildGenericWorkspaceContext(buildProject(projectPath), [], undefined, '检查场景');
    const skill = context.toolContext.skillIndex.find((entry) => entry.name === 'scene-check');

    assert.equal(skill?.source, 'project');
    assert.equal(skill?.description, 'Verify scene object naming.');
    assert.equal(skill?.trustLevel, 'workspace');
    assert.equal(skill?.verificationStatus, 'local_source');
    assert.equal(skill?.permissionPolicy, 'workspace_policy');
    assert.equal('instruction' in (skill ?? {}), false);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace context loads only explicitly slash-invoked filesystem skill instructions', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-skill-slash-'));
  try {
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'backend-plan'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'compact'), { recursive: true });
    await writeFile(join(projectPath, '.claude', 'skills', 'backend-plan', 'SKILL.md'), [
      '---',
      'name: backend-plan',
      'description: Plan backend changes.',
      '---',
      '',
      'Use database migration checks before coding.'
    ].join('\n'), 'utf8');
    await writeFile(join(projectPath, '.claude', 'skills', 'compact', 'SKILL.md'), [
      '---',
      'name: compact',
      'description: Should not shadow manual compact.',
      '---',
      '',
      'This should not load for /compact.'
    ].join('\n'), 'utf8');

    const context = buildGenericWorkspaceContext(buildProject(projectPath), [], undefined, '/backend-plan 设计后端模块');
    assert.equal(context.toolContext.activeSkills.length, 1);
    assert.equal(context.toolContext.activeSkills[0]?.name, 'backend-plan');
    assert.match(context.toolContext.activeSkills[0]?.instruction ?? '', /database migration checks/);

    const compactContext = buildGenericWorkspaceContext(buildProject(projectPath), [], undefined, '/compact');
    assert.equal(compactContext.toolContext.activeSkills.length, 0);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace context auto-activates model-invocable skill from metadata match', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-skill-auto-'));
  try {
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'sprite-sheet'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'private-audit'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'deploy-script'), { recursive: true });
    await writeFile(join(projectPath, '.claude', 'skills', 'sprite-sheet', 'SKILL.md'), [
      '---',
      'name: sprite-sheet',
      'description: Slice sprite sheets into animation frames.',
      '---',
      '',
      'Use deterministic frame extraction and report frame counts.'
    ].join('\n'), 'utf8');
    await writeFile(join(projectPath, '.claude', 'skills', 'private-audit', 'SKILL.md'), [
      '---',
      'name: private-audit',
      'description: Audit private builds.',
      'disable-model-invocation: true',
      '---',
      '',
      'This should not auto activate.'
    ].join('\n'), 'utf8');
    await writeFile(join(projectPath, '.claude', 'skills', 'deploy-script', 'SKILL.md'), [
      '---',
      'name: deploy-script',
      'description: Deploy with shell scripts.',
      'permission-policy: approval-required',
      'script: deploy: npm run deploy',
      '---',
      '',
      'Run deployment scripts only after explicit approval.'
    ].join('\n'), 'utf8');

    const context = buildGenericWorkspaceContext(
      buildProject(projectPath),
      [],
      undefined,
      'Please slice this sprite sheet into animation frames.'
    );
    assert.equal(context.toolContext.activeSkills.length, 1);
    assert.equal(context.toolContext.activeSkills[0]?.name, 'sprite-sheet');
    assert.equal(context.toolContext.activeSkills[0]?.activationReason, 'automatic_metadata_match');
    assert.match(context.toolContext.activeSkills[0]?.instruction ?? '', /frame extraction/);

    const privateContext = buildGenericWorkspaceContext(
      buildProject(projectPath),
      [],
      undefined,
      'Please audit private builds.'
    );
    assert.equal(privateContext.toolContext.activeSkills.length, 0);

    const deployContext = buildGenericWorkspaceContext(
      buildProject(projectPath),
      [],
      undefined,
      'Please use the deploy script workflow.'
    );
    assert.equal(deployContext.toolContext.activeSkills.length, 0);
    const deploySkill = deployContext.toolContext.skillIndex.find((skill) => skill.name === 'deploy-script');
    assert.equal(deploySkill?.permissionPolicy, 'approval_required');
    assert.equal(deploySkill?.scriptPolicy, 'approval_required');
    assert.equal(deploySkill?.declaredScripts?.[0]?.command, 'npm run deploy');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native skill tools list metadata and read a selected SKILL package', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-skill-tools-'));
  try {
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'build-plan'), { recursive: true });
    await mkdir(join(projectPath, '.claude', 'skills', 'build-plan', 'references'), { recursive: true });
    await writeFile(join(projectPath, '.claude', 'skills', 'build-plan', 'SKILL.md'), [
      '---',
      'name: build-plan',
      'description: Create implementation plans.',
      'allowed-tools: [read_file, search_project_content]',
      'permission-policy: read-only',
      'scripts:',
      '  - audit: npm run test',
      '---',
      '',
      'Always inspect the existing architecture before planning.'
    ].join('\n'), 'utf8');
    await writeFile(join(projectPath, '.claude', 'skills', 'build-plan', 'references', 'template.md'), [
      '# Template',
      '',
      '1. Inspect architecture',
      '2. Plan changes'
    ].join('\n'), 'utf8');
    await mkdir(join(projectPath, 'outside-skill-files'), { recursive: true });
    await writeFile(join(projectPath, 'outside-skill-files', 'secret.md'), 'outside', 'utf8');
    await symlink(
      join(projectPath, 'outside-skill-files'),
      join(projectPath, '.claude', 'skills', 'build-plan', 'references', 'outside')
    );
    const project = buildProject(projectPath);

    const listed = await executeAgentToolAction(project, {
      type: 'list_agent_skills',
      query: 'plan'
    });
    assert.equal(listed.ok, true);
    assert.match(listed.summary, /build-plan/);
    assert.match(listed.summary, /Allowed tools: read_file/);
    assert.match(listed.summary, /permission=read_only/);
    assert.match(listed.summary, /Declared scripts: 1/);

    const read = await executeAgentToolAction(project, {
      type: 'read_agent_skill',
      skillName: 'build-plan'
    });
    assert.equal(read.ok, true);
    assert.match(read.summary, /Always inspect the existing architecture/);
    assert.match(read.summary, /Permission policy: read_only/);
    assert.match(read.summary, /Script policy: approval_required/);
    assert.match(read.summary, /audit \[high\]: npm run test/);

    const files = await executeAgentToolAction(project, {
      type: 'list_agent_skill_files',
      skillName: 'build-plan'
    });
    assert.equal(files.ok, true);
    assert.match(files.summary, /references\/template\.md/);

    const file = await executeAgentToolAction(project, {
      type: 'read_agent_skill_file',
      skillName: 'build-plan',
      filePath: 'references/template.md'
    });
    assert.equal(file.ok, true);
    assert.match(file.summary, /Inspect architecture/);

    const escaping = await executeAgentToolAction(project, {
      type: 'read_agent_skill_file',
      skillName: 'build-plan',
      filePath: '../SKILL.md'
    });
    assert.equal(escaping.ok, false);
    assert.match(escaping.summary, /Invalid skill file path/);

    const linked = await executeAgentToolAction(project, {
      type: 'read_agent_skill_file',
      skillName: 'build-plan',
      filePath: 'references/outside/secret.md'
    });
    assert.equal(linked.ok, false);
    assert.match(linked.summary, /not readable/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('new project sessions default to agent mode and inherit project permission', () => {
  const project = buildProject();
  const state = buildState(project) as AppState;
  const policyProject = updateProjectAgentPolicy(state, project.id, {
    permissionMode: 'full-access'
  });
  const updated = createProjectSession(state, policyProject.id);
  const activeSession = getActiveProjectSession(updated);
  const context = buildGenericWorkspaceContext(updated, [], activeSession.id);
  const effectivePermission =
    activeSession.runtimeOverrides?.permissionMode ??
    updated.agentPolicy?.permissionMode ??
    state.agentSettings.permissionMode;

  assert.equal(activeSession.runtimeOverrides?.mode, undefined);
  assert.equal(context.sessionMode, 'agent');
  assert.equal(activeSession.runtimeOverrides?.permissionMode, undefined);
  assert.equal(effectivePermission, 'full-access');
});
