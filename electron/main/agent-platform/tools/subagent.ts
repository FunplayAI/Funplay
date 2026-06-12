import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

const subagentAgentSchema = z
  .string()
  .max(120)
  .optional()
  .describe('可选，子 Agent 定义名称，来自 <project>/.claude/agents/*.md 或 <project>/.funplay/agents/*.md。定义可附加系统提示、限制工具族（read|write|command|web|mcp）并指定模型。');
const subagentModeSchema = z
  .enum(['investigator', 'worker'])
  .optional()
  .describe('可选，子任务模式。investigator（默认）：只读调查，输出上限 8k。worker：按定义的工具族开放写入/命令工具，每个写入或命令仍逐个走与主链相同的权限审批，输出上限 16k。');
const subagentModelSchema = z
  .string()
  .max(120)
  .optional()
  .describe('可选，覆盖该子任务使用的模型 id；必须在当前 Provider 的模型列表中，未知模型会回退父模型并在结果中注明。');

registerAgentTool({
  name: 'run_subagent',
  title: 'Run Subagent',
  description: '启动一个子任务 Agent 独立完成范围明确的工作并返回压缩结论。默认 investigator 模式只读（探索文件、搜索项目、读取网页、检索记忆，输出上限 8k）；mode=worker 时按子 Agent 定义开放写入/命令工具（输出上限 16k），内部每次写入或命令仍逐个走与主链相同的权限审批，文件写入同样记录 checkpoint。可用 agent 引用项目内的子 Agent 定义。子任务内不能再启动子任务。',
  inputSchema: z.object({
    task: z.string().min(1).max(1200).describe('子任务要回答、调查或完成的具体问题。'),
    scope: z.string().max(500).optional().describe('可选范围，例如目录、文件、模块或外部资料方向。'),
    expectedOutput: z.string().max(500).optional().describe('期望输出形态，例如列出风险、找入口文件、总结差距。'),
    maxSteps: z.number().int().min(1).max(200).optional().describe('子任务最多模型轮次，默认 32，最大 200。通常不需要填写；预算耗尽时会强制总结。'),
    agent: subagentAgentSchema,
    mode: subagentModeSchema,
    model: subagentModelSchema
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
    maxSteps: typeof input.maxSteps === 'number' ? input.maxSteps : undefined,
    agent: typeof input.agent === 'string' ? input.agent : undefined,
    mode: input.mode === 'worker' || input.mode === 'investigator' ? input.mode : undefined,
    model: typeof input.model === 'string' ? input.model : undefined
  })
});

registerAgentTool({
  name: 'run_subagents',
  title: 'Run Parallel Subagents',
  description: '并行启动 2-4 个子任务 Agent，分别处理互不重叠的问题，再把结果合并返回主链。默认 investigator 模式只读；mode=worker 时按各自子 Agent 定义开放写入/命令工具，权限逐个走主链审批；worker 并行写入时各子任务范围必须互不重叠。每个子任务可用 agent 引用项目内的子 Agent 定义。',
  inputSchema: z.object({
    tasks: z.array(z.object({
      task: z.string().min(1).max(1200).describe('子任务要回答、调查或完成的具体问题。'),
      scope: z.string().max(500).optional().describe('可选范围，例如目录、文件、模块或外部资料方向。'),
      expectedOutput: z.string().max(500).optional().describe('期望输出形态，例如列出风险、找入口文件、总结差距。'),
      agent: subagentAgentSchema
    })).min(2).max(4).describe('要并行执行的子任务，建议互不重叠。'),
    maxSteps: z.number().int().min(1).max(200).optional().describe('每个子任务最多模型轮次，默认 32，最大 200。通常不需要填写；预算耗尽时会强制总结。'),
    mode: subagentModeSchema
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
            expectedOutput: typeof task.expectedOutput === 'string' ? task.expectedOutput : undefined,
            agent: typeof task.agent === 'string' ? task.agent : undefined
          };
        })
      : [],
    maxSteps: typeof input.maxSteps === 'number' ? input.maxSteps : undefined,
    mode: input.mode === 'worker' || input.mode === 'investigator' ? input.mode : undefined
  })
});

registerAgentTool({
  name: 'subagent_start',
  title: 'Start Background Subagent',
  description: '启动一个后台子任务 Agent，并立即返回 taskId。适合长一点的旁路工作；之后用 subagent_status 读取状态和结果。后台任务记录会持久化，应用重启后仍可查询；完成时会在主链下一次工具结果中附带完成通知。默认 investigator 模式只读；mode=worker 时按子 Agent 定义开放写入/命令工具，权限逐个走主链审批。',
  inputSchema: z.object({
    task: z.string().min(1).max(1200).describe('后台子任务要回答、调查或完成的具体问题。'),
    name: z.string().max(120).optional().describe('可选任务名称，便于状态列表识别。'),
    scope: z.string().max(500).optional().describe('可选范围，例如目录、文件、模块或外部资料方向。'),
    expectedOutput: z.string().max(500).optional().describe('期望输出形态，例如列出风险、找入口文件、总结差距。'),
    maxSteps: z.number().int().min(1).max(200).optional().describe('后台子任务最多模型轮次，默认 32，最大 200。通常不需要填写；预算耗尽时会强制总结。'),
    agent: subagentAgentSchema,
    mode: subagentModeSchema,
    model: subagentModelSchema
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
    maxSteps: typeof input.maxSteps === 'number' ? input.maxSteps : undefined,
    agent: typeof input.agent === 'string' ? input.agent : undefined,
    mode: input.mode === 'worker' || input.mode === 'investigator' ? input.mode : undefined,
    model: typeof input.model === 'string' ? input.model : undefined
  })
});

registerAgentTool({
  name: 'subagent_status',
  title: 'Read Background Subagent Status',
  description: '读取后台子任务的状态和结果。可传 taskId 读取单个任务，不传则列出当前会话最近任务。记录已持久化，应用重启后仍可查询；重启时仍在运行的任务会标记为 interrupted。',
  inputSchema: z.object({
    taskId: z.string().optional().describe('可选，subagent_start 返回的 taskId。'),
    includeCompleted: z.boolean().optional().describe('列表模式下是否包含已完成/失败/中断任务，默认 true。')
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
