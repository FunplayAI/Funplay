import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

type TodoToolInputItem = {
  id?: unknown;
  content?: unknown;
  status?: unknown;
  priority?: unknown;
};

const todoToolItemSchema = z.object({
  id: z.string().optional().describe('可选，简短稳定的任务 ID。'),
  content: z.string().min(1).max(240).describe('任务内容，保持简短具体。'),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).describe('任务状态：pending、in_progress、completed 或 cancelled。'),
  priority: z.enum(['high', 'medium', 'low']).optional().describe('可选优先级：high、medium 或 low。')
});

function parseTodoAlias(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function resolveTodoItems(input: Record<string, unknown>): TodoToolInputItem[] {
  const candidates = [
    input.items,
    parseTodoAlias(input.todos)
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is TodoToolInputItem => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (Array.isArray(record.items)) {
        return record.items.filter((item): item is TodoToolInputItem => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
      }
      if (Array.isArray(record.todos)) {
        return record.todos.filter((item): item is TodoToolInputItem => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
      }
    }
  }
  return [];
}

registerAgentTool({
  name: 'ask_user',
  title: 'Ask User',
  description: '向用户提出一个必须由用户回答的问题，并暂停当前 tool loop 等待回复。只在缺少关键信息、需要用户选择方案、确认偏好或处理无法自行决定的冲突时使用；不要用它代替权限确认。',
  inputSchema: z.object({
    title: z.string().min(1).max(120).optional().describe('问题卡片标题。默认"Agent 需要你的输入"。'),
    question: z.string().min(1).max(1000).describe('要问用户的具体问题。必须清楚、可回答。'),
    detail: z.string().max(2000).optional().describe('可选补充背景，解释为什么需要用户回答。'),
    options: z.array(z.object({
      id: z.string().min(1).max(80).optional().describe('可选稳定选项 ID。'),
      label: z.string().min(1).max(160).describe('选项文本。'),
      description: z.string().max(500).optional().describe('可选选项说明。')
    })).max(5).optional().describe('可选的 2-5 个选项。默认按互斥单选处理；multiSelect 为 true 时可多选。'),
    multiSelect: z.boolean().optional().describe('是否允许用户选择多个选项。默认 false。'),
    allowFreeText: z.boolean().optional().describe('是否允许用户自由输入。默认 true。'),
    placeholder: z.string().max(200).optional().describe('自由输入框占位文字。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'ask_user',
    title: typeof input.title === 'string' ? input.title : undefined,
    question: String(input.question),
    detail: typeof input.detail === 'string' ? input.detail : undefined,
    options: Array.isArray(input.options)
      ? input.options.map((option, index) => ({
          id: typeof option.id === 'string' ? option.id : `option_${index + 1}`,
          label: String(option.label),
          description: typeof option.description === 'string' ? option.description : undefined
        }))
      : undefined,
    multiSelect: typeof input.multiSelect === 'boolean' ? input.multiSelect : undefined,
    allowFreeText: typeof input.allowFreeText === 'boolean' ? input.allowFreeText : undefined,
    placeholder: typeof input.placeholder === 'string' ? input.placeholder : undefined
  })
});

registerAgentTool({
  name: 'update_todo_list',
  title: '任务清单',
  description: '维护本轮任务的可见 todo 列表。适合复杂多步骤修改、调试或验证时记录 pending/in_progress/completed/cancelled 状态；不会修改项目文件。优先使用 todos 字段，items 仅用于兼容旧调用。',
  inputSchema: z.object({
    todos: z.array(todoToolItemSchema).max(20).optional().describe('完整 todo 列表，按当前执行顺序排列。'),
    items: z.array(todoToolItemSchema).max(20).optional().describe('兼容旧字段；新调用优先使用 todos。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => {
    const items = resolveTodoItems(input);
    return {
      type: 'update_todo_list',
      items: items
        .filter((item) => typeof item.content === 'string' && item.content.trim())
        .map((item) => {
          const priority = item.priority === 'high' || item.priority === 'medium' || item.priority === 'low'
            ? item.priority
            : undefined;
          return {
            id: typeof item.id === 'string' ? item.id : undefined,
            content: String(item.content),
            status: item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed' || item.status === 'cancelled'
              ? item.status
              : 'pending',
            ...(priority ? { priority } : {})
          };
        })
    };
  }
});
