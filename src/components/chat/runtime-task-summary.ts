import type { AgentCoreMessagePart } from '../../../shared/types';

export type RuntimeTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface RuntimeTaskItem {
  id?: string;
  content: string;
  status: RuntimeTaskStatus;
  priority?: 'high' | 'medium' | 'low';
}

export interface RuntimeTaskSummary {
  items: RuntimeTaskItem[];
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  cancelled: number;
}

export interface RuntimeTaskToolSource {
  name: string;
  input?: Record<string, unknown>;
  resultContent?: string;
}

export function buildRuntimeTaskSummaryFromTools(tools: RuntimeTaskToolSource[]): RuntimeTaskSummary | null {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (!isTodoListTool(tool.name)) {
      continue;
    }
    const items = parseRuntimeTaskItems(tool.input) ?? parseRuntimeTaskItemsFromSummary(tool.resultContent);
    if (!items?.length) {
      continue;
    }
    return summarizeRuntimeTasks(items);
  }
  return null;
}

export function buildRuntimeTaskSummaryFromAgentCoreParts(parts: AgentCoreMessagePart[] | undefined): RuntimeTaskSummary | null {
  if (!parts?.length) {
    return null;
  }
  const toolInputs = new Map<string, RuntimeTaskToolSource>();
  const tools: RuntimeTaskToolSource[] = [];
  for (const part of [...parts].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  })) {
    if (part.kind === 'tool_call') {
      const source: RuntimeTaskToolSource = {
        name: part.name,
        input: part.input
      };
      toolInputs.set(part.toolUseId, source);
      tools.push(source);
      continue;
    }
    if (part.kind === 'tool_result' || part.kind === 'tool_error') {
      const existing = toolInputs.get(part.toolUseId);
      const content = part.kind === 'tool_error' ? part.error : part.content;
      if (existing) {
        existing.resultContent = content;
      } else if (part.toolName) {
        tools.push({
          name: part.toolName,
          resultContent: content
        });
      }
    }
  }
  return buildRuntimeTaskSummaryFromTools(tools);
}

export function isTodoListTool(name: string): boolean {
  return /update[_\s-]?todo[_\s-]?list|todo[_\s-]?write|todowrite|task[_\s-]?list|任务清单/i.test(name);
}

function summarizeRuntimeTasks(items: RuntimeTaskItem[]): RuntimeTaskSummary {
  const visibleItems = items.slice(0, 20);
  return {
    items: visibleItems,
    total: visibleItems.length,
    completed: visibleItems.filter((item) => item.status === 'completed').length,
    inProgress: visibleItems.filter((item) => item.status === 'in_progress').length,
    pending: visibleItems.filter((item) => item.status === 'pending').length,
    cancelled: visibleItems.filter((item) => item.status === 'cancelled').length
  };
}

function parseRuntimeTaskItems(input: Record<string, unknown> | undefined): RuntimeTaskItem[] | undefined {
  if (!input) {
    return undefined;
  }
  const candidates = [
    input.items,
    input.todos,
    input.todoList,
    input.tasks
  ];
  for (const candidate of candidates) {
    const rawItems = normalizeTodoCandidate(candidate);
    if (!rawItems) {
      continue;
    }
    const items = rawItems
      .map(normalizeRuntimeTaskItem)
      .filter((item): item is RuntimeTaskItem => Boolean(item));
    if (items.length > 0) {
      return items;
    }
  }
  return undefined;
}

function normalizeTodoCandidate(value: unknown): unknown[] | undefined {
  const parsed = typeof value === 'string' ? parseJsonValue(value) : value;
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    for (const key of ['items', 'todos', 'todoList', 'tasks']) {
      if (Array.isArray(record[key])) {
        return record[key] as unknown[];
      }
    }
  }
  return undefined;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeRuntimeTaskItem(value: unknown): RuntimeTaskItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const content = readStringField(record, ['content', 'task', 'title', 'name']);
  const status = normalizeRuntimeTaskStatus(record.status);
  if (!content || !status) {
    return undefined;
  }
  const priority = normalizeRuntimeTaskPriority(record.priority);
  const id = readStringField(record, ['id']);
  return {
    id: id || undefined,
    content,
    status,
    priority
  };
}

function parseRuntimeTaskItemsFromSummary(content: string | undefined): RuntimeTaskItem[] | undefined {
  if (!content) {
    return undefined;
  }
  const items = content
    .split('\n')
    .map((line): RuntimeTaskItem | undefined => {
      const match = line.match(/^-\s+\[(pending|in_progress|completed|cancelled)\]\s+([^(:]+)?(?:\s+\((high|medium|low)\))?:\s+(.+)$/i);
      if (!match) {
        return undefined;
      }
      const status = normalizeRuntimeTaskStatus(match[1]);
      const contentValue = match[4]?.trim();
      if (!status || !contentValue) {
        return undefined;
      }
      return {
        id: match[2]?.trim() || undefined,
        content: contentValue,
        status,
        priority: normalizeRuntimeTaskPriority(match[3])
      };
    })
    .filter((item): item is RuntimeTaskItem => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function normalizeRuntimeTaskStatus(value: unknown): RuntimeTaskStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled'
    ? value
    : undefined;
}

function normalizeRuntimeTaskPriority(value: unknown): RuntimeTaskItem['priority'] | undefined {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined;
}

function readStringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}
