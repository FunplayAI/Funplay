import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentReplayLog, buildRedactedAgentReplayLog } from '../../electron/main/agent-platform/replay-log.ts';
import {
  createAgentTaskGraph,
  finalizeAgentTaskGraph,
  updateAgentTaskGraphFromTimelineEntry,
  updateAgentTaskGraphFromToolResult,
  updateAgentTaskGraphFromToolUse,
  updateAgentTaskGraphFromSubagentResult
} from '../../electron/main/agent-platform/task-graph.ts';
import {
  createVerificationReport,
  finalizeVerificationReport,
  updateVerificationReportFromTimelineEntry,
  updateVerificationReportFromToolResult
} from '../../electron/main/agent-platform/verification-loop.ts';
import type { AgentRuntimeStatus, AgentRuntimeTimelineEntry } from '../../shared/types.ts';

test('task graph persists stage progress across a long agent run', () => {
  const createdAt = '2026-04-27T00:00:00.000Z';
  const timelineEntry: AgentRuntimeTimelineEntry = {
    id: 'stage_build',
    phase: 'validation',
    title: 'Run build verification',
    target: 'npm run build',
    status: 'completed',
    startedAt: createdAt,
    finishedAt: '2026-04-27T00:01:00.000Z',
    summary: 'Build passed'
  };

  const graph = createAgentTaskGraph({
    runId: 'arun_test',
    kind: 'conversation',
    goal: 'ship a production agent',
    createdAt,
    checkpointSnapshotId: 'snapshot_task_graph'
  });
  const updated = updateAgentTaskGraphFromTimelineEntry(graph, timelineEntry, timelineEntry.finishedAt ?? createdAt);
  const withToolResult = updateAgentTaskGraphFromToolResult(updated, {
    toolName: 'write_file',
    changedFiles: [{
      path: 'src/agent.ts',
      operation: 'modified'
    }]
  }, '2026-04-27T00:01:30.000Z');
  const finalized = finalizeAgentTaskGraph(withToolResult, 'completed', '2026-04-27T00:02:00.000Z');

  assert.equal(finalized?.runId, 'arun_test');
  assert.equal(finalized?.status, 'completed');
  assert.equal(finalized?.nodes.find((node) => node.kind === 'verify')?.status, 'completed');
  assert.deepEqual(finalized?.nodes.find((node) => node.kind === 'verify')?.timelineEntryIds, ['stage_build']);
  assert.equal(finalized?.nodes.find((node) => node.kind === 'verify')?.successCriteria?.[0]?.status, 'passed');
  assert.equal(finalized?.nodes.find((node) => node.kind === 'execute')?.rollbackStrategy?.kind, 'checkpoint');
  assert.deepEqual(finalized?.nodes.find((node) => node.kind === 'execute')?.rollbackStrategy?.changedFiles, ['src/agent.ts']);
});

test('task graph records controlled read-only subagent orchestration', () => {
  const createdAt = '2026-04-27T00:00:00.000Z';
  const graph = createAgentTaskGraph({
    runId: 'arun_subagent',
    kind: 'conversation',
    goal: 'audit runtime architecture',
    createdAt
  });
  const withToolUse = updateAgentTaskGraphFromToolUse(graph, {
    toolUseId: 'tool_parallel',
    name: 'run_subagents',
    status: 'running',
    input: {
      maxSteps: 4,
      tasks: [
        {
          task: 'Find renderer entrypoints',
          scope: 'src',
          expectedOutput: 'entry files'
        },
        {
          task: 'Find runtime services',
          scope: 'electron/main',
          expectedOutput: 'service list'
        }
      ]
    }
  }, '2026-04-27T00:00:10.000Z');
  const withResult = updateAgentTaskGraphFromSubagentResult(withToolUse, {
    toolUseId: 'tool_parallel',
    toolName: 'run_subagents',
    content: 'Parallel subagents: 2 task(s), 0 failed.',
    isError: false
  }, '2026-04-27T00:00:20.000Z');
  const planNode = withResult?.nodes.find((node) => node.kind === 'plan');

  assert.equal(planNode?.successCriteria?.some((criterion) => criterion.status === 'passed'), true);
  assert.equal(planNode?.subagentTasks?.length, 2);
  assert.deepEqual(planNode?.subagentTasks?.map((task) => task.readOnly), [true, true]);
  assert.deepEqual(planNode?.subagentTasks?.map((task) => task.mode), ['parallel', 'parallel']);
  assert.deepEqual(planNode?.subagentTasks?.map((task) => task.status), ['completed', 'completed']);
  assert.equal(planNode?.subagentTasks?.[0]?.maxSteps, 4);
  assert.match(planNode?.subagentTasks?.[0]?.resultPreview ?? '', /Parallel subagents/);
});

test('verification report records build and test checks from timeline entries', () => {
  const createdAt = '2026-04-27T00:00:00.000Z';
  const buildEntry: AgentRuntimeTimelineEntry = {
    id: 'build',
    phase: 'validation',
    title: 'Build app',
    target: 'npm run build',
    status: 'completed',
    startedAt: createdAt,
    finishedAt: '2026-04-27T00:01:00.000Z'
  };
  const testEntry: AgentRuntimeTimelineEntry = {
    id: 'test',
    phase: 'validation',
    title: 'Run runtime tests',
    target: 'npm test',
    status: 'completed',
    startedAt: '2026-04-27T00:01:00.000Z',
    finishedAt: '2026-04-27T00:02:00.000Z'
  };

  const empty = createVerificationReport({ runId: 'arun_test', createdAt });
  const withBuild = updateVerificationReportFromTimelineEntry(empty, buildEntry, buildEntry.finishedAt ?? createdAt);
  const withTest = updateVerificationReportFromTimelineEntry(withBuild, testEntry, testEntry.finishedAt ?? createdAt);
  const finalized = finalizeVerificationReport(withTest, 'completed', '2026-04-27T00:03:00.000Z');

  assert.equal(finalized?.status, 'passed');
  assert.equal(finalized?.checks.length, 2);
  assert.deepEqual(finalized?.checks.map((check) => check.kind), ['build', 'test']);
});

test('verification report aggregates browser tool results into task-level checks', () => {
  const createdAt = '2026-04-27T00:00:00.000Z';
  const empty = createVerificationReport({ runId: 'arun_browser', createdAt });
  const withOpen = updateVerificationReportFromToolResult(empty, {
    toolUseId: 'tool_browser_open',
    toolName: 'browser_open',
    content: 'Browser session: browser_1234abcd\nTitle: Smoke Page',
    browser: {
      sessionId: 'browser_1234abcd',
      url: 'http://127.0.0.1:4173',
      title: 'Smoke Page',
      viewport: {
        width: 900,
        height: 700
      }
    }
  }, '2026-04-27T00:00:10.000Z');
  const withConsole = updateVerificationReportFromToolResult(withOpen, {
    toolUseId: 'tool_browser_console',
    toolName: 'browser_console',
    content: 'console output',
    browser: {
      sessionId: 'browser_1234abcd',
      consoleMessageCount: 2
    }
  }, '2026-04-27T00:00:20.000Z');
  const finalized = finalizeVerificationReport(updateVerificationReportFromToolResult(withConsole, {
    toolUseId: 'tool_browser_screenshot',
    toolName: 'browser_screenshot',
    content: 'Screenshot saved to /tmp/funplay-browser-inspections/smoke.png',
    browser: {
      sessionId: 'browser_1234abcd',
      screenshotPath: '/tmp/funplay-browser-inspections/smoke.png'
    },
    artifacts: [{
      type: 'browser_screenshot',
      path: '/tmp/funplay-browser-inspections/smoke.png',
      title: 'Browser screenshot'
    }]
  }, '2026-04-27T00:00:30.000Z'), 'completed', '2026-04-27T00:00:40.000Z');

  assert.equal(finalized?.status, 'passed');
  assert.equal(finalized?.checks.length, 1);
  assert.equal(finalized?.checks[0]?.kind, 'browser');
  assert.deepEqual(finalized?.checks[0]?.toolUseIds, ['tool_browser_open', 'tool_browser_console', 'tool_browser_screenshot']);
  assert.equal(finalized?.checks[0]?.browser?.title, 'Smoke Page');
  assert.equal(finalized?.checks[0]?.browser?.consoleMessageCount, 2);
  assert.equal(finalized?.checks[0]?.browser?.screenshotPath, '/tmp/funplay-browser-inspections/smoke.png');
  assert.equal(finalized?.checks[0]?.artifacts?.[0]?.type, 'browser_screenshot');
  assert.match(finalized?.checks[0]?.outputPreview ?? '', /browser_console/);
});

test('replay log exports a self-contained runtime run record', () => {
  const run: AgentRuntimeStatus = {
    id: 'arun_test',
    kind: 'conversation',
    projectId: 'proj_test',
    startedAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:01:00.000Z',
    status: 'completed',
    canResume: false,
    checkpointSnapshotId: 'snapshot_replay',
    resumeStrategy: 'resume_after_last_completed_tool',
    lastToolBoundary: {
      toolUseId: 'tool_replay',
      toolName: 'read_file',
      status: 'completed',
      checkpointSnapshotId: 'snapshot_replay'
    },
    resumeCursor: {
      eventId: 'event_tool_boundary',
      eventType: 'tool_boundary',
      strategy: 'resume_after_last_completed_tool',
      createdAt: '2026-04-27T00:00:30.000Z',
      checkpointSnapshotId: 'snapshot_replay',
      toolUseId: 'tool_replay',
      toolName: 'read_file'
    },
    coreState: {
      state: 'completed',
      history: [
        {
          from: 'executing_tools',
          to: 'recording_tool_results',
          reason: 'tool result recorded',
          createdAt: '2026-04-27T00:00:28.000Z'
        },
        {
          from: 'recording_tool_results',
          to: 'completed',
          reason: 'final text produced',
          createdAt: '2026-04-27T00:00:31.000Z'
        }
      ]
    },
    usage: {
      turns: 2,
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationTokens: 0,
      cacheReadTokens: 20,
      totalTokens: 160
    },
    timeline: [
      {
        id: 'handoff',
        title: 'Export replay log',
        target: 'Run Center',
        status: 'completed'
      }
    ],
    events: [
      {
        id: 'event_usage',
        type: 'usage',
        createdAt: '2026-04-27T00:00:10.000Z',
        status: 'running',
        usageTotals: {
          turns: 2,
          inputTokens: 100,
          outputTokens: 40,
          cacheCreationTokens: 0,
          cacheReadTokens: 20,
          totalTokens: 160
        }
      },
      {
        id: 'event_tool_use',
        type: 'tool_use',
        createdAt: '2026-04-27T00:00:20.000Z',
        status: 'running',
        toolUse: {
          toolUseId: 'tool_replay',
          name: 'read_file',
          status: 'running'
        }
      },
      {
        id: 'event_tool_result_failed',
        type: 'tool_result',
        createdAt: '2026-04-27T00:00:25.000Z',
        status: 'running',
        toolResult: {
          toolUseId: 'tool_replay',
          toolName: 'read_file',
          contentPreview: 'missing file',
          isError: true
        }
      },
      {
        id: 'event_tool_result_retry',
        type: 'tool_result',
        createdAt: '2026-04-27T00:00:28.000Z',
        status: 'running',
        toolResult: {
          toolUseId: 'tool_replay',
          toolName: 'read_file',
          contentPreview: 'recovered file',
          isError: false
        }
      },
      {
        id: 'event_api_retry',
        type: 'timeline',
        createdAt: '2026-04-27T00:00:29.000Z',
        status: 'running',
        timelineEntry: {
          id: 'stage_api_retry',
          title: 'Claude API retry',
          target: 'stage:claude_api_retry',
          status: 'completed'
        }
      },
      {
        id: 'event_context_retry',
        type: 'timeline',
        createdAt: '2026-04-27T00:00:29.500Z',
        status: 'running',
        timelineEntry: {
          id: 'stage_context_retry',
          title: 'Native context retry',
          target: 'stage:native_context_retry',
          status: 'completed'
        }
      },
      {
        id: 'event_core_state',
        type: 'agent_core_state',
        createdAt: '2026-04-27T00:00:29.750Z',
        status: 'running',
        coreState: {
          state: 'recording_tool_results',
          history: [
            {
              from: 'executing_tools',
              to: 'recording_tool_results',
              reason: 'tool result recorded',
              createdAt: '2026-04-27T00:00:28.000Z'
            }
          ]
        },
        providerStep: {
          finishReason: 'tool_calls',
          toolCalls: []
        }
      },
      {
        id: 'event_permission',
        type: 'timeline',
        createdAt: '2026-04-27T00:00:29.775Z',
        status: 'running',
        statusMessage: '权限允许：read_file',
        metadata: {
          permissionDecision: 'allow'
        }
      },
      {
        id: 'event_context_summary',
        type: 'context_summary',
        createdAt: '2026-04-27T00:00:29.800Z',
        status: 'running',
        contextSummary: {
          summary: 'Earlier context summary.',
          coverage: {
            version: 1,
            strategy: 'extractive',
            messageCount: 6,
            turnCount: 3,
            generatedAt: '2026-04-27T00:00:29.800Z'
          }
        }
      },
      {
        id: 'event_skill_activation',
        type: 'skill_activation',
        createdAt: '2026-04-27T00:00:29.850Z',
        status: 'running',
        skillActivation: {
          id: 'project:/repo:backend-plan',
          name: 'backend-plan',
          description: 'Plan backend changes.',
          source: 'project',
          sourceId: '/repo',
          sourcePath: '.claude/skills/backend-plan/SKILL.md',
          activationReason: 'explicit_slash',
          instruction: 'Plan carefully.',
          trustLevel: 'workspace',
          verificationStatus: 'local_source',
          contentSha256: 'b'.repeat(64),
          permissionPolicy: 'workspace_policy',
          scriptPolicy: 'none'
        }
      },
      {
        id: 'event_todo_update',
        type: 'todo_update',
        createdAt: '2026-04-27T00:00:29.900Z',
        status: 'running',
        todoUpdate: {
          toolUseId: 'tool_todo',
          items: [
            {
              id: 'inspect',
              title: 'Inspect replay',
              status: 'completed'
            }
          ]
        }
      },
      {
        id: 'event_tool_boundary',
        type: 'tool_boundary',
        createdAt: '2026-04-27T00:00:30.000Z',
        status: 'completed',
        toolBoundary: {
          toolUseId: 'tool_replay',
          toolName: 'read_file',
          status: 'completed',
          checkpointSnapshotId: 'snapshot_replay',
          transaction: {
            id: 'tool_txn:tool_replay',
            toolUseId: 'tool_replay',
            toolName: 'read_file',
            toolClass: 'workspace',
            phase: 'completed',
            status: 'completed',
            eventCount: 3,
            startedAt: '2026-04-27T00:00:29.000Z',
            updatedAt: '2026-04-27T00:00:30.000Z',
            checkpoint: {
              policy: 'optional',
              snapshotId: 'snapshot_replay',
              status: 'completed'
            }
          }
        }
      }
    ]
  };

  const log = buildAgentReplayLog(run, '2026-04-27T00:02:00.000Z');

  assert.equal(log.runId, run.id);
  assert.equal(log.exportedAt, '2026-04-27T00:02:00.000Z');
  assert.equal(log.timeline.length, 1);
  assert.equal(log.run.status, 'completed');
  assert.equal(log.usage?.totalTokens, 160);
  assert.equal(log.run.usage?.totalTokens, 160);
  assert.equal(log.toolBoundaries[0]?.toolUseId, 'tool_replay');
  assert.equal(log.events.at(-1)?.id, 'event_tool_boundary');
  assert.equal(log.recovery.resumeCursor?.eventId, 'event_tool_boundary');
  assert.equal(log.recovery.checkpointSnapshotId, 'snapshot_replay');
  assert.equal(log.recovery.resumeStrategy, 'resume_after_last_completed_tool');
  assert.equal(log.metrics?.usageEventCount, 1);
  assert.equal(log.metrics?.totalTokens, 160);
  assert.equal(log.metrics?.averageTokensPerTurn, 80);
  assert.equal(log.metrics?.toolCallCount, 1);
  assert.equal(log.metrics?.toolResultCount, 2);
  assert.equal(log.metrics?.failedToolResultCount, 1);
  assert.equal(log.metrics?.toolRetryCount, 1);
  assert.equal(log.metrics?.apiRetryCount, 1);
  assert.equal(log.metrics?.contextRetryCount, 1);
  assert.equal(log.metrics?.skillActivationCount, 1);
  assert.equal(log.agentCore?.state?.state, 'completed');
  assert.equal(log.agentCore?.transitions.length, 2);
  assert.equal(log.agentCore?.partCounts.tool_result, 1);
  assert.equal(log.agentCore?.partCounts.tool_error, 1);
  assert.equal(log.agentCore?.partCounts.context_summary, 1);
  assert.equal(log.agentCore?.partCounts.todo_update, 1);
  assert.equal(log.agentCore?.providerSteps.length, 1);
  assert.equal(log.agentCore?.toolTransactions[0]?.toolUseId, 'tool_replay');
  assert.equal(log.agentCore?.toolTransactions[0]?.eventCount, 3);
  assert.equal(log.agentCore?.toolTransactions[0]?.checkpointSnapshotId, 'snapshot_replay');
  assert.equal(log.agentCore?.permissionDecisions[0]?.decision, 'allow');
  assert.equal(log.agentCore?.compressionPoints[0]?.summary, 'Earlier context summary.');
  assert.equal(log.agentCore?.resumeCursor?.eventId, 'event_tool_boundary');
  assert.equal(log.agentCore?.parts.some((part) => part.kind === 'system_event' && part.metadata?.type === 'skill_activation'), true);
  assert.equal(log.agentCore?.parts.some((part) => part.kind === 'system_event' && part.state === 'recording_tool_results'), true);
});

test('redacted replay log removes provider secrets from exportable bundles', () => {
  const run: AgentRuntimeStatus = {
    id: 'arun_secret',
    kind: 'conversation',
    projectId: 'proj_secret',
    startedAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:01.000Z',
    status: 'failed',
    canResume: true,
    inputPreview: 'use api_key=sk-secretsecretsecret and token=tp-secretsecretsecret',
    events: [
      {
        id: 'event_secret',
        type: 'run_failed',
        createdAt: '2026-04-27T00:00:01.000Z',
        status: 'failed',
        error: 'Bearer sk-liveprovidersecret123456 failed'
      }
    ]
  };

  const log = buildRedactedAgentReplayLog(run, '2026-04-27T00:02:00.000Z');
  const serialized = JSON.stringify(log);

  assert.equal(log.redacted, true);
  assert.ok((log.redactionSummary?.replacementCount ?? 0) >= 3);
  assert.equal(serialized.includes('sk-secretsecretsecret'), false);
  assert.equal(serialized.includes('tp-secretsecretsecret'), false);
  assert.equal(serialized.includes('sk-liveprovidersecret123456'), false);
  assert.match(serialized, /REDACTED/);
});
