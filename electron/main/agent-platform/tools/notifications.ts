import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'funplay_notify',
  title: 'Notify',
  description: '立即发送应用内/系统通知。低优先级仅应用内，normal/urgent 也尝试系统通知。',
  inputSchema: z.object({
    title: z.string().min(1).describe('通知标题。'),
    body: z.string().describe('通知正文。'),
    priority: z.enum(['low', 'normal', 'urgent']).optional().describe('通知优先级。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'funplay_notify',
    title: String(input.title),
    body: String(input.body),
    priority: input.priority
  })
});

registerAgentTool({
  name: 'funplay_schedule_task',
  title: 'Schedule Notification Task',
  description: '创建提醒通知任务。支持 once(ISO timestamp)、interval(30m/2h) 或 daily cron(0 9 * * *)。',
  inputSchema: z.object({
    name: z.string().min(1).describe('提醒名称。'),
    prompt: z.string().min(1).describe('提醒正文。'),
    scheduleType: z.enum(['cron', 'interval', 'once']).describe('调度类型。'),
    scheduleValue: z.string().min(1).describe('ISO 时间、interval 或 cron 表达式。'),
    priority: z.enum(['low', 'normal', 'urgent']).optional(),
    notifyOnComplete: z.boolean().optional(),
    durable: z.boolean().optional()
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'funplay_schedule_task',
    name: String(input.name),
    prompt: String(input.prompt),
    scheduleType: input.scheduleType,
    scheduleValue: String(input.scheduleValue),
    priority: input.priority,
    notifyOnComplete: typeof input.notifyOnComplete === 'boolean' ? input.notifyOnComplete : undefined,
    durable: typeof input.durable === 'boolean' ? input.durable : undefined
  })
});

registerAgentTool({
  name: 'funplay_list_tasks',
  title: 'List Notification Tasks',
  description: '列出已计划的提醒通知任务。',
  inputSchema: z.object({
    status: z.enum(['active', 'completed', 'cancelled', 'all']).optional().describe('可选状态过滤。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'funplay_list_tasks',
    status: input.status
  })
});

registerAgentTool({
  name: 'funplay_cancel_task',
  title: 'Cancel Notification Task',
  description: '取消指定提醒通知任务。',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('任务 ID。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'funplay_cancel_task',
    taskId: String(input.taskId)
  })
});
