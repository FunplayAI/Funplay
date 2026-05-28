import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'run_subagent',
  title: 'Run Subagent',
  description: '启动一个只读子任务 Agent 独立探索文件、搜索项目、读取网页或检索记忆，并返回压缩结论。适合范围明确、可旁路调查的问题；不会写入文件、运行命令或调用高风险工具。',
  inputSchema: z.object({
    task: z.string().min(1).max(1200).describe('子任务要回答或调查的具体问题。'),
    scope: z.string().max(500).optional().describe('可选范围，例如目录、文件、模块或外部资料方向。'),
    expectedOutput: z.string().max(500).optional().describe('期望输出形态，例如列出风险、找入口文件、总结差距。'),
    maxSteps: z.number().int().min(1).max(200).optional().describe('子任务最多模型轮次，默认 32，最大 200。通常不需要填写；预算耗尽时会强制总结。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'run_subagent',
    task: String(input.task),
    scope: typeof input.scope === 'string' ? input.scope : undefined,
    expectedOutput: typeof input.expectedOutput === 'string' ? input.expectedOutput : undefined,
    maxSteps: typeof input.maxSteps === 'number' ? input.maxSteps : undefined
  })
});

registerAgentTool({
  name: 'run_subagents',
  title: 'Run Parallel Subagents',
  description: '并行启动 2-4 个只读子任务 Agent，分别探索不同问题，再把结果合并返回主链。适合大型代码定位、风险排查或多方向资料收集；不会写入文件、运行命令或调用高风险工具。',
  inputSchema: z.object({
    tasks: z.array(z.object({
      task: z.string().min(1).max(1200).describe('子任务要回答或调查的具体问题。'),
      scope: z.string().max(500).optional().describe('可选范围，例如目录、文件、模块或外部资料方向。'),
      expectedOutput: z.string().max(500).optional().describe('期望输出形态，例如列出风险、找入口文件、总结差距。')
    })).min(2).max(4).describe('要并行执行的只读子任务，建议互不重叠。'),
    maxSteps: z.number().int().min(1).max(200).optional().describe('每个子任务最多模型轮次，默认 32，最大 200。通常不需要填写；预算耗尽时会强制总结。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'run_subagents',
    tasks: Array.isArray(input.tasks)
      ? input.tasks.map((taskInput) => {
          const task = typeof taskInput === 'object' && taskInput !== null && !Array.isArray(taskInput)
            ? taskInput as Record<string, unknown>
            : {};
          return {
            task: String(task.task ?? ''),
            scope: typeof task.scope === 'string' ? task.scope : undefined,
            expectedOutput: typeof task.expectedOutput === 'string' ? task.expectedOutput : undefined
          };
        })
      : [],
    maxSteps: typeof input.maxSteps === 'number' ? input.maxSteps : undefined
  })
});

registerAgentTool({
  name: 'subagent_start',
  title: 'Start Background Subagent',
  description: '启动一个后台只读子任务 Agent，并立即返回 taskId。适合长一点的旁路调查；之后用 subagent_status 读取状态和结果。不会写入文件、运行命令或调用高风险工具。',
  inputSchema: z.object({
    task: z.string().min(1).max(1200).describe('后台子任务要回答或调查的具体问题。'),
    name: z.string().max(120).optional().describe('可选任务名称，便于状态列表识别。'),
    scope: z.string().max(500).optional().describe('可选范围，例如目录、文件、模块或外部资料方向。'),
    expectedOutput: z.string().max(500).optional().describe('期望输出形态，例如列出风险、找入口文件、总结差距。'),
    maxSteps: z.number().int().min(1).max(200).optional().describe('后台子任务最多模型轮次，默认 32，最大 200。通常不需要填写；预算耗尽时会强制总结。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'subagent_start',
    task: String(input.task),
    name: typeof input.name === 'string' ? input.name : undefined,
    scope: typeof input.scope === 'string' ? input.scope : undefined,
    expectedOutput: typeof input.expectedOutput === 'string' ? input.expectedOutput : undefined,
    maxSteps: typeof input.maxSteps === 'number' ? input.maxSteps : undefined
  })
});

registerAgentTool({
  name: 'subagent_status',
  title: 'Read Background Subagent Status',
  description: '读取后台只读子任务的状态和结果。可传 taskId 读取单个任务，不传则列出当前会话最近任务。',
  inputSchema: z.object({
    taskId: z.string().optional().describe('可选，subagent_start 返回的 taskId。'),
    includeCompleted: z.boolean().optional().describe('列表模式下是否包含已完成/失败任务，默认 true。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'subagent_status',
    taskId: typeof input.taskId === 'string' ? input.taskId : undefined,
    includeCompleted: typeof input.includeCompleted === 'boolean' ? input.includeCompleted : undefined
  })
});
