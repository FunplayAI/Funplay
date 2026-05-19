import type {
  EnvironmentActionKind,
  EnvironmentTask,
  EnvironmentTaskStage,
  EnvironmentTaskStatus
} from '../../shared/types';
import { nowIso } from '../../shared/utils';

export const environmentTasks = new Map<string, EnvironmentTask>();
const taskProjectPaths = new Map<string, string>();

const BRIDGE_LINKED_ACTION_IDS = new Set<EnvironmentActionKind>([
  'create_unity_project',
  'import_unity_project',
  'open_unity_project',
  'install_project_bridge',
  'verify_project_path'
]);

function isTerminalTaskStatus(status: EnvironmentTaskStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function stageForTaskStatus(status: EnvironmentTaskStatus): EnvironmentTaskStage {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'needs_user') {
    return 'waiting_manual';
  }
  if (status === 'queued') {
    return 'queued';
  }
  return 'checking';
}

export function makeTaskId(): string {
  return `envtask_${Math.random().toString(36).slice(2, 10)}`;
}

export function createTask(actionId: EnvironmentActionKind, title: string, initialMessage: string): EnvironmentTask {
  const task: EnvironmentTask = {
    id: makeTaskId(),
    actionId,
    title,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    message: initialMessage,
    logs: [initialMessage],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  environmentTasks.set(task.id, task);
  return task;
}

export function bindTaskProjectPath(taskId: string, projectPath: string | undefined): void {
  const normalizedProjectPath = projectPath?.trim();
  if (!normalizedProjectPath) {
    return;
  }
  taskProjectPaths.set(taskId, normalizedProjectPath);
}

export function updateTask(
  taskId: string,
  patch: Partial<Omit<EnvironmentTask, 'id' | 'actionId' | 'createdAt'>> & { appendLog?: string }
): void {
  const current = environmentTasks.get(taskId);
  if (!current) {
    return;
  }
  if (isTerminalTaskStatus(current.status) && patch.status && patch.status !== current.status) {
    return;
  }
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => key !== 'appendLog' && typeof value !== 'undefined')
  ) as Partial<Omit<EnvironmentTask, 'id' | 'actionId' | 'createdAt'>>;

  const next: EnvironmentTask = {
    ...current,
    ...definedPatch,
    logs: patch.appendLog ? [...current.logs, patch.appendLog] : current.logs,
    updatedAt: nowIso()
  };
  environmentTasks.set(taskId, next);
}

export function completeTask(taskId: string, status: EnvironmentTaskStatus, message: string, progress = 100): void {
  updateTask(taskId, {
    status,
    stage: stageForTaskStatus(status),
    progress,
    message,
    appendLog: message
  });
}

export function taskStageUpdate(
  taskId: string,
  input: {
    stage?: EnvironmentTaskStage;
    status?: EnvironmentTaskStatus;
    progress?: number;
    message?: string;
    log?: string;
  }
): void {
  const current = environmentTasks.get(taskId);
  if (!current || isTerminalTaskStatus(current.status)) {
    return;
  }
  updateTask(taskId, {
    stage: input.stage,
    status: input.status,
    progress: input.progress,
    message: input.message,
    appendLog: input.log
  });
}

export function listEnvironmentTasksInternal(): EnvironmentTask[] {
  return [...environmentTasks.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function reconcileBridgeConnectedTasks(message = 'Unity 项目已打开，Bridge / MCP 已连通。', projectPath?: string): void {
  const candidate = listEnvironmentTasksInternal().find(
    (task) =>
      BRIDGE_LINKED_ACTION_IDS.has(task.actionId) &&
      (task.status === 'queued' || task.status === 'running' || task.status === 'needs_user') &&
      (!projectPath || taskProjectPaths.get(task.id) === projectPath)
  );

  if (candidate) {
    completeTask(candidate.id, 'completed', message);
  }
}

export function getPendingBridgeLinkedTaskProjectPath(): string | undefined {
  const candidate = listEnvironmentTasksInternal().find(
    (task) =>
      BRIDGE_LINKED_ACTION_IDS.has(task.actionId) &&
      (task.status === 'queued' || task.status === 'running' || task.status === 'needs_user')
  );
  return candidate ? taskProjectPaths.get(candidate.id) : undefined;
}

export function hasPendingBridgeLinkedTask(): boolean {
  return listEnvironmentTasksInternal().some(
    (task) =>
      BRIDGE_LINKED_ACTION_IDS.has(task.actionId) &&
      (task.status === 'queued' || task.status === 'running' || task.status === 'needs_user')
  );
}

export function listEnvironmentTasks(): EnvironmentTask[] {
  return listEnvironmentTasksInternal();
}
