import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentLifecycleHookResultToRuntimeEvent,
  evaluateAgentLifecycleHooks,
  executeAgentLifecycleHookCommand,
  loadAgentLifecycleHookConfigForProject,
  matchesAgentLifecycleHookRule,
  normalizeAgentLifecycleHookConfig,
  runAgentLifecycleHooks
} from '../../electron/main/agent-platform/agent-hooks.ts';
import { runtimeEventToAgentCoreParts } from '../../shared/agent-core-v2.ts';
import { buildAgentReplayLog } from '../../electron/main/agent-platform/replay-log.ts';
import type { AgentRuntimeEvent, AgentRuntimeStatus } from '../../shared/types.ts';
import { buildProject } from './test-helpers.ts';

test('agent lifecycle hooks parse Claude-style settings into bounded platform rules', () => {
  const config = normalizeAgentLifecycleHookConfig({
    hooks: {
      PreToolUse: [
        {
          matcher: 'write_*|edit_file',
          hooks: [
            {
              type: 'block',
              message: 'Do not write generated files.'
            },
            {
              type: 'command',
              command: 'npm run test:runtime',
              timeoutMs: 999_999
            }
          ]
        }
      ],
      UnknownEvent: [
        {
          hooks: [{ type: 'audit' }]
        }
      ]
    }
  }, {
    source: 'project',
    sourcePath: '.claude/settings.json'
  });

  assert.equal(config.rules.length, 2);
  assert.equal(config.rules[0]?.event, 'PreToolUse');
  assert.equal(config.rules[0]?.matcher, 'write_*|edit_file');
  assert.equal(config.rules[0]?.action.type, 'block');
  assert.equal(config.rules[0]?.source, 'project');
  assert.equal(config.rules[1]?.action.type, 'command');
  assert.equal(config.rules[1]?.action.timeoutMs, 120_000);
  assert.equal(config.diagnostics.some((item) => item.message.includes('UnknownEvent')), true);
});

test('agent lifecycle hooks match tool events and evaluate block context and command outcomes', () => {
  const config = normalizeAgentLifecycleHookConfig({
    rules: [
      {
        id: 'audit_reads',
        event: 'PreToolUse',
        matcher: 'read_*',
        action: {
          type: 'audit',
          message: 'Read tool observed.'
        }
      },
      {
        id: 'block_writes',
        event: 'PreToolUse',
        matcher: 'write_file',
        action: {
          type: 'block',
          message: 'Generated files must not be overwritten.'
        }
      },
      {
        id: 'append_prompt_context',
        event: 'UserPromptSubmit',
        matcher: '*backend*',
        action: {
          type: 'append_context',
          context: 'Remember to update API tests.'
        }
      },
      {
        id: 'command_after_stop',
        event: 'Stop',
        action: {
          type: 'command',
          command: 'npm run build'
        }
      }
    ]
  });

  assert.equal(matchesAgentLifecycleHookRule(config.rules[0]!, {
    event: 'PreToolUse',
    toolName: 'read_file'
  }), true);
  assert.equal(matchesAgentLifecycleHookRule(config.rules[0]!, {
    event: 'PreToolUse',
    toolName: 'write_file'
  }), false);

  const write = evaluateAgentLifecycleHooks(config, {
    event: 'PreToolUse',
    toolUseId: 'tool_write',
    toolName: 'write_file'
  });
  const prompt = evaluateAgentLifecycleHooks(config, {
    event: 'UserPromptSubmit',
    prompt: 'Build a backend service'
  });
  const stop = evaluateAgentLifecycleHooks(config, {
    event: 'Stop',
    status: 'completed'
  });

  assert.equal(write.blocked, true);
  assert.equal(write.results[0]?.status, 'blocked');
  assert.equal(write.results[0]?.blockReason, 'Generated files must not be overwritten.');
  assert.deepEqual(prompt.appendedContext, ['Remember to update API tests.']);
  assert.equal(prompt.results[0]?.status, 'context_appended');
  assert.equal(stop.pendingCommands.length, 1);
  assert.equal(stop.pendingCommands[0]?.status, 'requires_permission');
  assert.equal(stop.pendingCommands[0]?.command, 'npm run build');
});

test('agent lifecycle hook events become replayable Agent Core system parts and metrics', () => {
  const config = normalizeAgentLifecycleHookConfig({
    rules: [
      {
        id: 'block_shell',
        event: 'PreToolUse',
        matcher: 'run_command',
        action: {
          type: 'block',
          message: 'Commands are blocked in this workspace.'
        }
      }
    ]
  }, {
    source: 'workspace',
    sourcePath: '.funplay/hooks.json'
  });
  const hook = evaluateAgentLifecycleHooks(config, {
    event: 'PreToolUse',
    runId: 'arun_hooks',
    projectId: 'project_hooks',
    toolUseId: 'tool_command',
    toolName: 'run_command'
  }).results[0]!;
  const runtimeEvent: AgentRuntimeEvent = {
    id: 'event_hook',
    createdAt: '2026-05-16T00:00:00.000Z',
    ...agentLifecycleHookResultToRuntimeEvent(hook)
  };
  const parts = runtimeEventToAgentCoreParts(runtimeEvent);
  const run: AgentRuntimeStatus = {
    id: 'arun_hooks',
    kind: 'conversation',
    projectId: 'project_hooks',
    startedAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:01.000Z',
    status: 'failed',
    canResume: false,
    events: [runtimeEvent]
  };
  const log = buildAgentReplayLog(run, '2026-05-16T00:00:02.000Z');

  assert.equal(runtimeEvent.status, 'failed');
  assert.equal(parts[0]?.kind, 'system_event');
  assert.equal(parts[0]?.kind === 'system_event' ? parts[0].metadata?.type : undefined, 'hook');
  assert.equal(log.metrics?.hookEventCount, 1);
  assert.equal(log.agentCore?.hookEvents[0]?.actionType, 'block');
  assert.equal(log.agentCore?.hookEvents[0]?.status, 'blocked');
  assert.equal(log.agentCore?.parts.some((part) => part.kind === 'system_event' && part.metadata?.type === 'hook'), true);
});

test('agent lifecycle command hooks require host permission before executing run_command', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-hook-deny-'));
  try {
    const config = normalizeAgentLifecycleHookConfig({
      rules: [{
        id: 'write_marker',
        event: 'Stop',
        action: {
          type: 'command',
          command: 'node -e "require(\'node:fs\').writeFileSync(\'hook-marker.txt\',\'denied\')"'
        }
      }]
    });
    const hook = evaluateAgentLifecycleHooks(config, {
      event: 'Stop',
      status: 'completed'
    }).pendingCommands[0]!;
    const executed = await executeAgentLifecycleHookCommand(hook, {
      project: buildProject(projectPath),
      permissionContext: {
        permission: {
          mode: 'ask',
          allowWriteTools: false,
          allowSessionWriteTools: false
        },
        requestPermission: async () => 'deny'
      }
    });

    assert.equal(executed.status, 'permission_denied');
    assert.equal(executed.permissionDecision, 'deny');
    assert.equal(executed.transaction?.toolClass, 'command');
    assert.equal(executed.transaction?.toolName, 'run_command');
    assert.equal(executed.transaction?.status, 'failed');
    assert.equal(executed.transaction?.permission?.decision, 'deny');
    assert.equal(executed.transaction?.eventCount, 4);
    const runtimeEvent: AgentRuntimeEvent = {
      id: 'event_hook_command_deny',
      createdAt: '2026-05-16T00:00:00.000Z',
      ...agentLifecycleHookResultToRuntimeEvent(executed)
    };
    const parts = runtimeEventToAgentCoreParts(runtimeEvent);
    const hookPartTransaction = parts[0]?.kind === 'system_event' && parts[0].metadata?.transaction && typeof parts[0].metadata.transaction === 'object'
      ? parts[0].metadata.transaction as { toolName?: string; status?: string }
      : undefined;
    const log = buildAgentReplayLog({
      id: 'arun_hook_command_deny',
      kind: 'conversation',
      projectId: 'project_hooks',
      startedAt: '2026-05-16T00:00:00.000Z',
      updatedAt: '2026-05-16T00:00:01.000Z',
      status: 'failed',
      canResume: false,
      events: [runtimeEvent]
    });
    assert.equal(hookPartTransaction?.toolName, 'run_command');
    assert.equal(hookPartTransaction?.status, 'failed');
    assert.equal(log.agentCore?.hookEvents[0]?.transaction?.toolName, 'run_command');
    assert.equal(log.agentCore?.toolTransactions[0]?.toolUseId, executed.transaction?.toolUseId);
    assert.equal(log.agentCore?.toolTransactions[0]?.status, 'failed');
    assert.equal(existsSync(join(projectPath, 'hook-marker.txt')), false);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('agent lifecycle command hooks execute through workspace run_command after approval', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-hook-allow-'));
  try {
    const config = normalizeAgentLifecycleHookConfig({
      hooks: {
        Stop: [{
          matcher: '*',
          hooks: [{
            type: 'command',
            command: 'node -e "require(\'node:fs\').writeFileSync(\'hook-marker.txt\',\'allowed\')"',
            timeoutMs: 10_000
          }]
        }]
      }
    });
    const hook = evaluateAgentLifecycleHooks(config, {
      event: 'Stop',
      status: 'completed'
    }).pendingCommands[0]!;
    const executed = await executeAgentLifecycleHookCommand(hook, {
      project: buildProject(projectPath),
      permissionContext: {
        permission: {
          mode: 'ask',
          allowWriteTools: false,
          allowSessionWriteTools: false
        },
        requestPermission: async (request) => {
          assert.equal(request.toolName, 'run_command');
          assert.match(request.detail, /Hook/);
          assert.match(request.impact?.commands?.[0] ?? '', /hook-marker/);
          return 'allow';
        }
      }
    });

    assert.equal(executed.status, 'command_completed');
    assert.equal(executed.permissionDecision, 'allow');
    assert.equal(executed.commandResult?.ok, true);
    assert.equal(executed.transaction?.toolClass, 'command');
    assert.equal(executed.transaction?.toolName, 'run_command');
    assert.equal(executed.transaction?.status, 'completed');
    assert.equal(executed.transaction?.permission?.decision, 'allow');
    assert.equal(executed.transaction?.eventCount, 5);
    assert.match(executed.commandResult?.command?.command ?? '', /hook-marker/);
    assert.equal(await readFile(join(projectPath, 'hook-marker.txt'), 'utf8'), 'allowed');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('agent lifecycle runner loads project settings and emits ordered hook outcomes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-hook-runner-'));
  try {
    await mkdir(join(projectPath, '.claude'), { recursive: true });
    await writeFile(join(projectPath, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          matcher: '*backend*',
          hooks: [{
            type: 'command',
            command: 'node -e "require(\'node:fs\').writeFileSync(\'prompt-hook.txt\',\'ok\')"',
            timeout: 5
          }, {
            type: 'append_context',
            context: 'Add backend regression tests.'
          }]
        }]
      }
    }), 'utf8');

    const project = buildProject(projectPath);
    const config = loadAgentLifecycleHookConfigForProject(project, {
      includeUser: false
    });
    const emitted: string[] = [];
    const emittedStageTransactionToolNames: Array<string | undefined> = [];
    const emittedStageInputTransactionStatuses: Array<string | undefined> = [];
    const result = await runAgentLifecycleHooks(config, {
      event: 'UserPromptSubmit',
      prompt: 'Build backend service'
    }, {
      project,
      cwd: projectPath,
      permissionContext: {
        permission: {
          mode: 'ask',
          allowWriteTools: false,
          allowSessionWriteTools: false
        },
        requestPermission: async () => 'allow'
      },
      emitHook: (hook) => emitted.push(hook.status),
      emitStage: (stage) => {
        emittedStageTransactionToolNames.push(stage.transaction?.toolName);
        const transaction = stage.input?.transaction;
        emittedStageInputTransactionStatuses.push(transaction && typeof transaction === 'object' && 'status' in transaction
          ? String(transaction.status)
          : undefined);
      }
    });

    assert.equal(config.rules.length, 2);
    assert.deepEqual(result.appendedContext, ['Add backend regression tests.']);
    assert.equal(result.commandResults[0]?.status, 'command_completed');
    assert.deepEqual(emitted, ['requires_permission', 'context_appended', 'command_completed']);
    assert.equal(emittedStageTransactionToolNames.at(-1), 'run_command');
    assert.equal(emittedStageInputTransactionStatuses.at(-1), 'completed');
    assert.equal(await readFile(join(projectPath, 'prompt-hook.txt'), 'utf8'), 'ok');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
