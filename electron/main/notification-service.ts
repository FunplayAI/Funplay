import electron from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AppNotification,
  AppNotificationPriority,
  ScheduledNotificationTask,
  ScheduledNotificationTaskType
} from '../../shared/types';
import { makeId, nowIso } from '../../shared/utils';

type NotificationDispatch = (notification: AppNotification) => void;

interface ElectronNotificationConstructor {
  isSupported?: () => boolean;
  new(options: { title: string; body?: string }): { show: () => void };
}

const MAX_QUEUE_SIZE = 50;
const MAX_TIMEOUT_MS = 2_147_483_647;
const notificationQueue: AppNotification[] = [];
const tasks = new Map<string, ScheduledNotificationTask>();
const taskTimers = new Map<string, NodeJS.Timeout>();
const SystemNotification: ElectronNotificationConstructor | undefined = (electron as { Notification?: ElectronNotificationConstructor }).Notification;

let dispatchNotification: NotificationDispatch | undefined;
let storagePath = '';

function notificationTasksPath(userDataPath: string): string {
  return join(userDataPath, 'funplay-notification-tasks.json');
}

async function persistDurableTasks(): Promise<void> {
  if (!storagePath) {
    return;
  }
  const durableTasks = [...tasks.values()].filter((task) => task.durable && task.status === 'active');
  await writeFile(storagePath, JSON.stringify(durableTasks, null, 2), 'utf8');
}

async function loadDurableTasks(): Promise<void> {
  if (!storagePath) {
    return;
  }

  try {
    const parsed = JSON.parse(await readFile(storagePath, 'utf8')) as ScheduledNotificationTask[];
    for (const task of parsed) {
      if (task?.id && task.status === 'active') {
        tasks.set(task.id, task);
      }
    }
  } catch {
    await persistDurableTasks();
  }
}

function pushNotification(notification: AppNotification): void {
  notificationQueue.push(notification);
  while (notificationQueue.length > MAX_QUEUE_SIZE) {
    notificationQueue.shift();
  }
  dispatchNotification?.(notification);
}

export async function sendAppNotification(input: {
  title: string;
  body: string;
  priority?: AppNotificationPriority;
  source?: string;
}): Promise<AppNotification> {
  const notification: AppNotification = {
    id: makeId('notification'),
    title: input.title.trim() || 'Funplay',
    body: input.body.trim(),
    priority: input.priority ?? 'normal',
    source: input.source,
    createdAt: nowIso()
  };

  pushNotification(notification);

  if (notification.priority !== 'low' && SystemNotification?.isSupported?.()) {
    try {
      new SystemNotification({
        title: notification.title,
        body: notification.body
      }).show();
    } catch {
      // System notification failures should not fail the MCP tool call.
    }
  }

  return notification;
}

export function drainAppNotifications(): AppNotification[] {
  const items = [...notificationQueue];
  notificationQueue.length = 0;
  return items;
}

function parseInterval(value: string): number {
  const match = value.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    throw new Error('Interval must look like 30s, 15m, 2h, or 1d.');
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === 's' ? 1000 :
      unit === 'm' ? 60_000 :
        unit === 'h' ? 3_600_000 :
          86_400_000;
  return amount * multiplier;
}

function parseCronField(value: string, min: number, max: number): number[] {
  if (value === '*') {
    return Array.from({ length: max - min + 1 }, (_item, index) => min + index);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Unsupported cron field: ${value}`);
  }
  return [parsed];
}

function getNextCronTime(expression: string, after = new Date()): Date {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Cron must have 5 fields, for example "0 9 * * *".');
  }
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parts[2];
  const month = parts[3];
  const dayOfWeek = parts[4];
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') {
    throw new Error('Only daily-style cron is supported for now: minute hour * * *.');
  }

  const cursor = new Date(after.getTime() + 60_000);
  cursor.setSeconds(0, 0);
  for (let day = 0; day < 370; day += 1) {
    const candidateDay = new Date(cursor);
    candidateDay.setDate(cursor.getDate() + day);
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(candidateDay);
        candidate.setHours(hour, minute, 0, 0);
        if (candidate.getTime() > after.getTime()) {
          return candidate;
        }
      }
    }
  }
  throw new Error('Cron expression has no occurrence within the next year.');
}

function computeNextRun(scheduleType: ScheduledNotificationTaskType, scheduleValue: string, after = new Date()): string {
  if (scheduleType === 'once') {
    const timestamp = Date.parse(scheduleValue);
    if (!Number.isFinite(timestamp)) {
      throw new Error('Once schedule must be an ISO timestamp.');
    }
    return new Date(timestamp).toISOString();
  }
  if (scheduleType === 'interval') {
    return new Date(after.getTime() + parseInterval(scheduleValue)).toISOString();
  }
  return getNextCronTime(scheduleValue, after).toISOString();
}

function scheduleTimer(task: ScheduledNotificationTask): void {
  const existing = taskTimers.get(task.id);
  if (existing) {
    clearTimeout(existing);
  }

  if (task.status !== 'active' || !task.nextRun) {
    return;
  }

  const delay = Math.max(0, Date.parse(task.nextRun) - Date.now());
  const timer = setTimeout(() => {
    void fireScheduledTask(task.id);
  }, Math.min(delay, MAX_TIMEOUT_MS));
  taskTimers.set(task.id, timer);
}

async function fireScheduledTask(taskId: string): Promise<void> {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'active') {
    return;
  }

  await sendAppNotification({
    title: task.name,
    body: task.prompt,
    priority: task.priority,
    source: 'funplay-notify'
  });

  const updatedAt = nowIso();
  if (task.scheduleType === 'once') {
    tasks.set(task.id, {
      ...task,
      status: 'completed',
      nextRun: undefined,
      updatedAt
    });
    taskTimers.delete(task.id);
  } else {
    const nextRun = computeNextRun(task.scheduleType, task.scheduleValue);
    const updated = {
      ...task,
      nextRun,
      updatedAt
    };
    tasks.set(task.id, updated);
    scheduleTimer(updated);
  }
  await persistDurableTasks();
}

export async function initializeNotificationService(userDataPath: string, dispatch: NotificationDispatch): Promise<void> {
  dispatchNotification = dispatch;
  await mkdir(userDataPath, { recursive: true });
  storagePath = notificationTasksPath(userDataPath);
  await loadDurableTasks();
  for (const task of tasks.values()) {
    scheduleTimer(task);
  }
}

export async function scheduleNotificationTask(input: {
  name: string;
  prompt: string;
  scheduleType: ScheduledNotificationTaskType;
  scheduleValue: string;
  priority?: AppNotificationPriority;
  notifyOnComplete?: boolean;
  durable?: boolean;
}): Promise<ScheduledNotificationTask> {
  const createdAt = nowIso();
  const task: ScheduledNotificationTask = {
    id: makeId('task'),
    name: input.name.trim() || 'Scheduled notification',
    prompt: input.prompt.trim(),
    scheduleType: input.scheduleType,
    scheduleValue: input.scheduleValue.trim(),
    priority: input.priority ?? 'normal',
    notifyOnComplete: input.notifyOnComplete ?? true,
    status: 'active',
    nextRun: computeNextRun(input.scheduleType, input.scheduleValue),
    durable: input.durable ?? true,
    createdAt,
    updatedAt: createdAt
  };
  tasks.set(task.id, task);
  scheduleTimer(task);
  await persistDurableTasks();
  return task;
}

export function listNotificationTasks(): ScheduledNotificationTask[] {
  return [...tasks.values()].sort((left, right) => (left.nextRun ?? '').localeCompare(right.nextRun ?? ''));
}

export async function cancelNotificationTask(taskId: string): Promise<{ success: true }> {
  const task = tasks.get(taskId);
  if (task) {
    tasks.set(taskId, {
      ...task,
      status: 'cancelled',
      nextRun: undefined,
      updatedAt: nowIso()
    });
  }
  const timer = taskTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    taskTimers.delete(taskId);
  }
  await persistDurableTasks();
  return { success: true };
}
