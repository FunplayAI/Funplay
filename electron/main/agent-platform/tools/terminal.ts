import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'run_command',
  title: 'Run Command',
  description: '在当前项目目录内执行会自行结束的 shell 命令。适合运行测试、构建、诊断脚本或只读检查；禁止使用 & 启动后台任务，dev server/watch/HTTP server 必须用 terminal_start；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    command: z.string().min(1).describe('要执行的 shell 命令，例如 npm test。'),
    cwd: z.string().optional().describe('可选，项目内相对工作目录。默认项目根目录。'),
    timeoutMs: z.number().int().min(1000).max(120000).optional().describe('可选，命令超时时间，默认 30000ms，最大 120000ms。'),
    reason: z.string().optional().describe('为什么需要执行这个命令。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'run_command',
    command: String(input.command),
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'terminal_start',
  title: 'Start Terminal',
  description: '启动一个持久 shell 终端会话，可选立即执行初始命令。适合启动 dev server、watch 任务或需要后续复用 shell 状态的工作流；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    name: z.string().optional().describe('可选终端名称，例如 dev server。'),
    command: z.string().optional().describe('可选初始命令，例如 npm run dev。为空则只启动 shell。'),
    cwd: z.string().optional().describe('可选，项目内相对工作目录。默认项目根目录。'),
    reason: z.string().optional().describe('为什么需要启动持久终端。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'terminal_start',
    name: typeof input.name === 'string' ? input.name : undefined,
    command: typeof input.command === 'string' ? input.command : undefined,
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'terminal_read',
  title: 'Read Terminal',
  description: '读取持久终端会话输出。可传 sinceSeq 增量读取，返回 nextSeq 供下次继续读取。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('终端会话 ID，例如 term_xxxxxxxx。'),
    sinceSeq: z.number().int().min(0).optional().describe('只读取 seq 大于该值的输出。'),
    maxChars: z.number().int().min(1000).max(30000).optional().describe('最多返回多少字符，默认 12000。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'terminal_read',
    sessionId: String(input.sessionId),
    sinceSeq: typeof input.sinceSeq === 'number' ? input.sinceSeq : undefined,
    maxChars: typeof input.maxChars === 'number' ? input.maxChars : undefined
  })
});

registerAgentTool({
  name: 'terminal_write',
  title: 'Write Terminal',
  description: '向持久终端会话 stdin 写入内容。适合在同一 shell 中继续执行命令或向交互进程发送输入；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('终端会话 ID，例如 term_xxxxxxxx。'),
    input: z.string().min(1).describe('要写入 stdin 的文本。可包含控制字符。'),
    appendNewline: z.boolean().optional().describe('是否自动追加换行。默认 true。'),
    reason: z.string().optional().describe('为什么需要写入终端。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'terminal_write',
    sessionId: String(input.sessionId),
    input: String(input.input),
    appendNewline: typeof input.appendNewline === 'boolean' ? input.appendNewline : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'terminal_list',
  title: 'List Terminals',
  description: '列出当前项目的持久终端会话、状态、工作目录和初始命令。',
  inputSchema: z.object({}),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: () => ({
    type: 'terminal_list'
  })
});

registerAgentTool({
  name: 'terminal_stop',
  title: 'Stop Terminal',
  description: '停止一个持久终端会话。默认发送 SIGTERM，可选 SIGINT/SIGKILL；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('终端会话 ID，例如 term_xxxxxxxx。'),
    signal: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']).optional().describe('停止信号。默认 SIGTERM。'),
    reason: z.string().optional().describe('为什么需要停止终端。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'terminal_stop',
    sessionId: String(input.sessionId),
    signal: input.signal,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});
