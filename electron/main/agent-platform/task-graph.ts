import type {
  AgentOperationStatus,
  AgentRunKind,
  AgentRuntimeRunStatus,
  AgentRuntimeTimelineEntry,
  AgentToolChangedFile,
  AgentTaskGraph,
  AgentTaskGraphNode,
  AgentTaskGraphNodeKind,
  AgentTaskGraphNodeStatus,
  AgentTaskSubagentRecord,
  AgentTaskSubagentStatus
} from '../../../shared/types';

function normalizeText(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function criterion(id: string, description: string): NonNullable<AgentTaskGraphNode['successCriteria']>[number] {
  return {
    id,
    description,
    status: 'pending'
  };
}

function mapOperationStatus(status: AgentOperationStatus): AgentTaskGraphNodeStatus {
  if (status === 'pending') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'skipped';
}

function createNode(
  kind: AgentTaskGraphNodeKind,
  title: string,
  dependsOn: string[] = [],
  options: {
    successCriteria?: string[];
    rollbackStrategy?: AgentTaskGraphNode['rollbackStrategy'];
  } = {}
): AgentTaskGraphNode {
  return {
    id: `node_${kind}`,
    kind,
    title,
    status: dependsOn.length === 0 ? 'running' : 'pending',
    dependsOn,
    successCriteria: options.successCriteria?.map((description, index) => criterion(`${kind}_criterion_${index + 1}`, description)),
    rollbackStrategy: options.rollbackStrategy
  };
}

function markCriteria(
  criteria: AgentTaskGraphNode['successCriteria'],
  status: NonNullable<AgentTaskGraphNode['successCriteria']>[number]['status'],
  updatedAt: string,
  evidence?: string
): AgentTaskGraphNode['successCriteria'] {
  return criteria?.map((item) => item.status === 'pending'
    ? {
        ...item,
        status,
        evidence: evidence ?? item.evidence,
        updatedAt
      }
    : item);
}

function subagentStatusFromToolStatus(status: 'pending' | 'running' | 'completed' | 'failed'): AgentTaskSubagentStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'pending';
  return 'running';
}

function stringField(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = input?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function createSubagentRecords(tool: {
  toolUseId: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
}, updatedAt: string): AgentTaskSubagentRecord[] {
  const status = subagentStatusFromToolStatus(tool.status);
  if (tool.name === 'run_subagent' || tool.name === 'subagent_start') {
    return [{
      id: `${tool.toolUseId}:0`,
      toolUseId: tool.toolUseId,
      mode: tool.name === 'subagent_start' ? 'background' : 'single',
      task: stringField(tool.input, 'task') ?? '(missing task)',
      scope: stringField(tool.input, 'scope'),
      expectedOutput: stringField(tool.input, 'expectedOutput'),
      maxSteps: numberField(tool.input, 'maxSteps'),
      status,
      readOnly: true,
      updatedAt
    }];
  }
  if (tool.name !== 'run_subagents') {
    return [];
  }
  const tasks = Array.isArray(tool.input?.tasks) ? tool.input.tasks : [];
  return tasks.map((item, index): AgentTaskSubagentRecord => {
    const task = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    return {
      id: `${tool.toolUseId}:${index}`,
      toolUseId: tool.toolUseId,
      mode: 'parallel',
      task: stringField(task, 'task') ?? '(missing task)',
      scope: stringField(task, 'scope'),
      expectedOutput: stringField(task, 'expectedOutput'),
      maxSteps: numberField(tool.input, 'maxSteps'),
      status,
      readOnly: true,
      updatedAt
    };
  });
}

function mergeSubagentRecords(
  existing: AgentTaskSubagentRecord[] | undefined,
  incoming: AgentTaskSubagentRecord[]
): AgentTaskSubagentRecord[] | undefined {
  if (!incoming.length) {
    return existing;
  }
  const byId = new Map((existing ?? []).map((record) => [record.id, record]));
  for (const record of incoming) {
    byId.set(record.id, {
      ...byId.get(record.id),
      ...record
    });
  }
  return [...byId.values()].slice(-24);
}

function classifyTimelineEntry(entry: Pick<AgentRuntimeTimelineEntry, 'phase' | 'title' | 'target'>): AgentTaskGraphNodeKind {
  const haystack = [
    normalizeText(entry.phase),
    normalizeText(entry.title),
    normalizeText(entry.target)
  ].join(' ');

  if (/\b(test|build|verify|verification|browser|playwright|mcp|benchmark|gate)\b/.test(haystack)) {
    return 'verify';
  }
  if (/\b(repair|fix|retry|recover|resume)\b/.test(haystack)) {
    return 'repair';
  }
  if (/\b(plan|task graph|breakdown|decompose)\b/.test(haystack)) {
    return 'plan';
  }
  if (/\b(release|report|export|handoff|summary)\b/.test(haystack)) {
    return 'handoff';
  }
  return 'execute';
}

function terminalForRunStatus(status: AgentRuntimeRunStatus): AgentTaskGraphNodeStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'blocked';
  return 'running';
}

export function createAgentTaskGraph(params: {
  runId: string;
  kind: AgentRunKind;
  goal?: string;
  createdAt: string;
  checkpointSnapshotId?: string;
}): AgentTaskGraph {
  const goal = params.goal?.trim() || `${params.kind} agent run`;
  const rollbackStrategy: AgentTaskGraphNode['rollbackStrategy'] = params.checkpointSnapshotId
    ? {
        kind: 'checkpoint',
        summary: 'Use checkpoint_rollback to restore files changed during this run if verification fails or the user asks to undo.',
        checkpointSnapshotId: params.checkpointSnapshotId
      }
    : {
        kind: 'manual',
        summary: 'No checkpoint was recorded for this run; rely on changed-file metadata and manual reversal if rollback is needed.'
      };
  const intake = createNode('intake', 'Capture task intent', [], {
    successCriteria: ['The user goal and active project/session are captured in the persisted run.'],
    rollbackStrategy: { kind: 'none', summary: 'No project side effects happen during intake.' }
  });
  const plan = createNode('plan', 'Build persistent task graph', [intake.id], {
    successCriteria: [
      'The run has persisted task steps with dependencies and success criteria.',
      'Any subagent exploration is read-only, bounded, and tied back to the parent task graph.'
    ],
    rollbackStrategy: { kind: 'none', summary: 'Planning changes only runtime metadata.' }
  });
  const execute = createNode('execute', 'Execute project changes', [plan.id], {
    successCriteria: ['Required file/tool changes complete through guarded tools.', 'Changed files are tracked for review and rollback.'],
    rollbackStrategy
  });
  const verify = createNode('verify', 'Run automatic verification loop', [execute.id], {
    successCriteria: ['Relevant build, test, command, browser, MCP, or manual checks pass or are explicitly skipped with reason.'],
    rollbackStrategy
  });
  const handoff = createNode('handoff', 'Prepare replayable handoff', [verify.id], {
    successCriteria: ['Final handoff records completed work, verification outcome, changed files, and residual risk.'],
    rollbackStrategy
  });

  return {
    id: `graph_${params.runId}`,
    runId: params.runId,
    goal,
    status: 'running',
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
    currentNodeId: intake.id,
    nodes: [intake, plan, execute, verify, handoff]
  };
}

export function updateAgentTaskGraphFromTimelineEntry(
  graph: AgentTaskGraph | undefined,
  entry: AgentRuntimeTimelineEntry,
  updatedAt: string
): AgentTaskGraph | undefined {
  if (!graph) {
    return undefined;
  }

  const kind = classifyTimelineEntry(entry);
  const status = mapOperationStatus(entry.status);
  const nodeIndex = graph.nodes.findIndex((node) => node.kind === kind);

  if (nodeIndex < 0) {
    return {
      ...graph,
      updatedAt
    };
  }

  const nextNodes = graph.nodes.map((node, index) => {
    if (index < nodeIndex && (node.status === 'pending' || node.status === 'running')) {
      return {
        ...node,
        status: 'completed' as const,
        successCriteria: markCriteria(node.successCriteria, 'passed', updatedAt, entry.summary ?? entry.title),
        finishedAt: node.finishedAt ?? entry.startedAt ?? updatedAt
      };
    }

    if (index !== nodeIndex) {
      return node;
    }

    const timelineEntryIds = Array.from(new Set([...(node.timelineEntryIds ?? []), entry.id]));
    return {
      ...node,
      status,
      startedAt: node.startedAt ?? entry.startedAt ?? updatedAt,
      finishedAt: entry.finishedAt ?? (status === 'completed' || status === 'failed' || status === 'skipped' ? updatedAt : node.finishedAt),
      summary: entry.summary ?? node.summary,
      errorMessage: entry.errorMessage ?? node.errorMessage,
      timelineEntryIds,
      successCriteria: status === 'completed'
        ? markCriteria(node.successCriteria, 'passed', updatedAt, entry.summary ?? entry.title)
        : status === 'failed'
          ? markCriteria(node.successCriteria, 'failed', updatedAt, entry.errorMessage ?? entry.summary ?? entry.title)
          : status === 'skipped'
            ? markCriteria(node.successCriteria, 'skipped', updatedAt, entry.summary ?? entry.title)
            : node.successCriteria
    };
  });

  return {
    ...graph,
    updatedAt,
    currentNodeId: nextNodes[nodeIndex]?.id ?? graph.currentNodeId,
    nodes: nextNodes
  };
}

export function updateAgentTaskGraphFromToolUse(
  graph: AgentTaskGraph | undefined,
  tool: {
    toolUseId: string;
    name: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  },
  updatedAt: string
): AgentTaskGraph | undefined {
  if (!graph) {
    return undefined;
  }

  const subagentRecords = createSubagentRecords(tool, updatedAt);
  if (!subagentRecords.length) {
    return graph;
  }

  const nodes = graph.nodes.map((node) => {
    if (node.kind !== 'plan') {
      return node;
    }
    return {
      ...node,
      startedAt: node.startedAt ?? updatedAt,
      status: node.status === 'pending' ? 'running' as const : node.status,
      successCriteria: markCriteria(node.successCriteria, tool.status === 'failed' ? 'failed' : 'passed', updatedAt, 'Subagent exploration is read-only and max-step bounded.'),
      subagentTasks: mergeSubagentRecords(node.subagentTasks, subagentRecords)
    };
  });

  return {
    ...graph,
    updatedAt,
    currentNodeId: graph.currentNodeId ?? nodes.find((node) => node.kind === 'plan')?.id,
    nodes
  };
}

export function updateAgentTaskGraphFromSubagentResult(
  graph: AgentTaskGraph | undefined,
  result: {
    toolUseId: string;
    toolName?: string;
    content: string;
    isError?: boolean;
  },
  updatedAt: string
): AgentTaskGraph | undefined {
  if (!graph || !['run_subagent', 'run_subagents', 'subagent_start', 'subagent_status'].includes(result.toolName ?? '')) {
    return graph;
  }

  const nodes = graph.nodes.map((node) => {
    if (node.kind !== 'plan' || !node.subagentTasks?.length) {
      return node;
    }
    const status: AgentTaskSubagentStatus = result.isError ? 'failed' : 'completed';
    return {
      ...node,
      successCriteria: markCriteria(node.successCriteria, result.isError ? 'failed' : 'passed', updatedAt, result.content.slice(0, 220)),
      subagentTasks: node.subagentTasks.map((task) => task.toolUseId === result.toolUseId
        ? {
            ...task,
            status,
            resultPreview: result.content.slice(0, 500),
            updatedAt
          }
        : task)
    };
  });

  return {
    ...graph,
    updatedAt,
    nodes
  };
}

export function updateAgentTaskGraphFromToolResult(
  graph: AgentTaskGraph | undefined,
  result: {
    toolName?: string;
    changedFiles?: AgentToolChangedFile[];
    isError?: boolean;
  },
  updatedAt: string
): AgentTaskGraph | undefined {
  if (!graph || !result.changedFiles?.length) {
    return graph;
  }

  const changedFiles = result.changedFiles
    .map((file) => file.path)
    .filter(Boolean)
    .slice(0, 50);
  if (!changedFiles.length) {
    return graph;
  }

  const nodes = graph.nodes.map((node) => {
    if (node.kind !== 'execute' && node.kind !== 'repair' && node.kind !== 'verify') {
      return node;
    }
    const existingFiles = node.rollbackStrategy?.changedFiles ?? [];
    return {
      ...node,
      successCriteria: result.isError
        ? node.successCriteria
        : markCriteria(node.successCriteria, 'passed', updatedAt, `Changed files: ${changedFiles.join(', ')}`),
      rollbackStrategy: node.rollbackStrategy
        ? {
            ...node.rollbackStrategy,
            changedFiles: [...new Set([...existingFiles, ...changedFiles])].slice(0, 80),
            updatedAt
          }
        : node.rollbackStrategy
    };
  });

  return {
    ...graph,
    updatedAt,
    nodes
  };
}

export function finalizeAgentTaskGraph(
  graph: AgentTaskGraph | undefined,
  status: AgentRuntimeRunStatus,
  updatedAt: string
): AgentTaskGraph | undefined {
  if (!graph) {
    return undefined;
  }

  const terminalStatus = terminalForRunStatus(status);
  const nodes = graph.nodes.map((node) => {
    if (node.status === 'completed' || node.status === 'failed' || node.status === 'skipped') {
      return node;
    }
    if (status === 'completed') {
      return {
        ...node,
        status: 'skipped' as const,
        successCriteria: markCriteria(node.successCriteria, 'skipped', updatedAt, 'Run completed before this step was needed.'),
        finishedAt: node.finishedAt ?? updatedAt
      };
    }
    if (node.status === 'running') {
      return {
        ...node,
        status: terminalStatus,
        finishedAt: node.finishedAt ?? updatedAt
      };
    }
    return node;
  });

  return {
    ...graph,
    status,
    updatedAt,
    currentNodeId: nodes.find((node) => node.status === 'running' || node.status === 'blocked')?.id ?? graph.currentNodeId,
    nodes
  };
}
