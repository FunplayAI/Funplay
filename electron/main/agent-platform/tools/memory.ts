import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'funplay_memory_search',
  title: 'Search Memory',
  description: '搜索项目记忆文件，支持标签、文件类型和记忆分类过滤。适合回答历史决策、偏好、日期、待办或过去上下文。',
  inputSchema: z.object({
    query: z.string().min(1).describe('搜索关键词。'),
    tags: z.array(z.string()).optional().describe('可选标签过滤。'),
    fileType: z.enum(['all', 'daily', 'longterm']).optional().describe('可选记忆类型过滤。'),
    memoryKind: z.enum(['all', 'user_preference', 'project_fact', 'decision', 'task_state']).optional().describe('可选记忆分类过滤。'),
    limit: z.number().int().min(1).max(10).optional().describe('最多返回多少条结果。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'funplay_memory_search',
    query: String(input.query),
    tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
    fileType: input.fileType,
    memoryKind: input.memoryKind,
    limit: typeof input.limit === 'number' ? input.limit : undefined
  })
});

registerAgentTool({
  name: 'funplay_memory_get',
  title: 'Read Memory',
  description: '读取指定项目记忆文件。路径必须是 memory.md 或 memory/ 下的 Markdown 文件。',
  inputSchema: z.object({
    filePath: z.string().min(1).describe('记忆文件路径，例如 memory.md 或 memory/daily/2026-04-24.md。'),
    lineStart: z.number().int().min(1).optional().describe('可选，1-based 起始行。'),
    lineEnd: z.number().int().min(1).optional().describe('可选，1-based 结束行。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'funplay_memory_get',
    filePath: String(input.filePath),
    lineStart: typeof input.lineStart === 'number' ? input.lineStart : undefined,
    lineEnd: typeof input.lineEnd === 'number' ? input.lineEnd : undefined
  })
});

registerAgentTool({
  name: 'funplay_memory_recent',
  title: 'Recent Memory',
  description: '读取 long-term memory 和最近几天 daily memory。适合新会话开始或上下文可能影响回答时使用。',
  inputSchema: z.object({}),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: () => ({
    type: 'funplay_memory_recent'
  })
});

registerAgentTool({
  name: 'funplay_memory_remember',
  title: 'Remember',
  description: '追加一条持久项目记忆，并按偏好、项目事实、决策或临时任务状态分类。仅在用户明确要求记住，或形成稳定项目决策/偏好时使用。',
  inputSchema: z.object({
    note: z.string().min(1).describe('要记住的事实、决策、偏好或日记。'),
    memoryType: z.enum(['longterm', 'daily']).optional().describe('写入 longterm(memory.md) 或 daily。默认 daily。'),
    memoryKind: z.enum(['user_preference', 'project_fact', 'decision', 'task_state']).optional().describe('记忆分类：用户偏好、项目事实、项目决策或临时任务状态。'),
    tags: z.array(z.string()).optional().describe('可选标签。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'funplay_memory_remember',
    note: String(input.note),
    memoryType: input.memoryType,
    memoryKind: input.memoryKind,
    tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined
  })
});
