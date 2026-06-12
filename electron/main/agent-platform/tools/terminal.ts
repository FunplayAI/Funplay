import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'run_command',
  title: 'Run Command',
  description:
    '在当前项目目录内执行会自行结束的 shell 命令（默认运行在 workspace-write 沙箱中：全盘可读，仅项目目录与临时目录可写）。适合运行测试、构建、诊断脚本或只读检查；耗时命令可用 background:true 后台执行，完成后结果自动注入后续步骤；禁止 shell 后台符 &，dev server/watch/HTTP server 必须用 terminal_start；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    command: z.string().min(1).describe('要执行的 shell 命令，例如 npm test。'),
    cwd: z.string().optional().describe('可选，项目内相对工作目录。默认项目根目录。'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(600000)
      .optional()
      .describe('可选，命令超时时间，默认 30000ms，最大 600000ms。background:true 时忽略。'),
    background: z
      .boolean()
      .optional()
      .describe(
        '可选，true 时后台执行：立即返回 job id（job_xxxxxxxx），完成后退出码与输出尾部自动注入后续步骤；可用 terminal_read 轮询、terminal_stop 终止。'
      ),
    unsandboxed: z
      .boolean()
      .optional()
      .describe('可选，true 时请求在沙箱外执行。仅 full-access 权限模式可用，且每次都需要用户显式批准。'),
    reason: z.string().optional().describe('为什么需要执行这个命令。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  validateInput: (input, context) => {
    if (input.unsandboxed === true && context.permissionMode !== 'full-access') {
      return {
        ok: false,
        summary: `unsandboxed:true 仅在 full-access 权限模式下可用（当前模式：${context.permissionMode ?? 'unknown'}）。`,
        failureKind: 'sandbox_escape_not_allowed',
        recoveryHint: '去掉 unsandboxed 重新执行（默认 workspace-write 沙箱），或请用户切换到 full-access 模式。'
      };
    }
    return undefined;
  },
  // Sandbox escape must be approved by the user on every run; pre-approvals do not apply.
  requiresExplicitApproval: (input) => input?.unsandboxed === true,
  toAction: (input) => ({
    type: 'run_command',
    command: String(input.command),
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
    background: typeof input.background === 'boolean' ? input.background : undefined,
    unsandboxed: typeof input.unsandboxed === 'boolean' ? input.unsandboxed : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'terminal_start',
  title: 'Start Terminal',
  description:
    '启动一个持久 shell 终端会话，可选立即执行初始命令。适合启动 dev server、watch 任务或需要后续复用 shell 状态的工作流；高风险，host 会在执行点做权限判断。',
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
  description: '读取持久终端会话或后台命令 job 的输出。可传 sinceSeq 增量读取，返回 nextSeq 供下次继续读取。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('终端会话 ID（term_xxxxxxxx）或后台命令 Job ID（job_xxxxxxxx）。'),
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
  description:
    '向持久终端会话 stdin 写入内容。适合在同一 shell 中继续执行命令或向交互进程发送输入；高风险，host 会在执行点做权限判断。',
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
  description: '列出当前项目的持久终端会话与后台命令 job（type=background-command）、状态、工作目录和初始命令。',
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
  description:
    '停止一个持久终端会话或后台命令 job。默认发送 SIGTERM，可选 SIGINT/SIGKILL；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('终端会话 ID（term_xxxxxxxx）或后台命令 Job ID（job_xxxxxxxx）。'),
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
