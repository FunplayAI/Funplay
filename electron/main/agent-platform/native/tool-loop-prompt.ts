import type { GenericAgentRuntimeParams } from '../types';
import { createNativeRuntimeUserPrompt } from './prompt';

export function createNativeToolLoopPermissionInstructions(params: Pick<GenericAgentRuntimeParams, 'permission'>, options: {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
}): string[] {
  const hasSideEffectTools = options.includeWriteTools || options.includeMcpToolCalls || options.includeCommandTools;

  const modeLine =
    hasSideEffectTools
      ? params.permission.mode === 'read-only'
        ? '当前界面模式：Plan。工具列表由 host 生成，实际权限只在工具执行点判定。'
        : '当前界面模式：Build。工具列表由 host 生成，实际权限只在工具执行点判定。'
      : params.permission.mode === 'read-only'
        ? '当前界面模式：Plan。工具列表由 host 生成，实际权限只在工具执行点判定。'
        : params.permission.mode === 'ask'
          ? '当前界面模式：Build。工具列表由 host 生成，实际权限只在工具执行点判定。'
          : '当前界面模式：Build。工具列表由 host 生成，实际权限只在工具执行点判定。';

  const writeLine = options.includeWriteTools
    ? 'create_directory、write_file、edit_file、multi_edit、patch_file 等项目写入工具出现在工具列表中；当用户任务需要实际修改项目时应调用对应工具，host 会在执行点完成权限、checkpoint 和拒绝处理。不要根据模式自行声称工具被禁用。'
    : params.permission.mode === 'read-only'
      ? options.includeCommandTools
        ? 'create_directory、write_file、edit_file、multi_edit、patch_file 等项目写入工具未出现在工具列表中；不要声称已经写入文件。run_command、terminal_start 等命令工具可用于检查和验证，host 会在执行点完成权限判断。'
        : '项目写入工具未出现在工具列表中；不要声称已经写入文件。'
      : params.permission.mode === 'ask'
        ? '当前工具列表不包含项目写入工具；不要声称已经写入文件。'
        : '当前工具列表不包含项目写入工具；不要声称已经写入文件。';

  return [modeLine, writeLine];
}

export function createNativeToolLoopPrompt(params: GenericAgentRuntimeParams, toolNames: string[], options: {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
  dynamicMcpToolNames?: string[];
}): string {
  return [
    createNativeRuntimeUserPrompt(params, undefined, {
      includeRecentTurns: false
    }),
    '',
    ...createNativeToolLoopPermissionInstructions(params, options),
    '你可以使用这些工具来理解项目：',
    ...toolNames.map((toolName) => `- ${toolName}`),
    '',
    '规则：',
    '- 对多步骤任务，使用 update_todo_list 维护简短任务清单；优先传 todos 数组，可用 pending/in_progress/completed/cancelled 状态，并在关键步骤完成时更新状态。',
    '- 如果缺少继续执行所必需的用户偏好、业务选择或冲突决策，可调用 ask_user 向用户提一个简短明确的问题；不要用 ask_user 做工具权限确认，也不要询问可以通过读取项目或搜索自行确定的信息。',
    '- 当用户目标涉及游戏、可玩页面、资源目录、Unity、素材或玩法验证时，优先调用 inspect_game_project 识别 Web/Unity 结构、资源工作流和验证路径。',
    '- 对范围明确、可独立调查的问题，可调用 run_subagent；如果有 2-4 个互不重叠的调查方向，优先 run_subagents 并行收集证据；较长的旁路调查可用 subagent_start 后用 subagent_status 读取结果；不要把用户的主任务整体转交给子任务。',
    '- 写入项目记忆时用 funplay_memory_remember，并设置 memoryKind：用户偏好 user_preference、稳定项目事实 project_fact、已确认决策 decision、临时任务状态 task_state。',
    options.includeWriteTools
      ? '- 用户任务需要创建目录、创建文件、修改文件或回滚文件时，调用 create_directory、write_file、edit_file、multi_edit、patch_file 或 checkpoint_rollback；host 会在工具执行点处理权限、checkpoint、拒绝和错误回放。同一文件多处修改优先用 multi_edit；能构造 unified diff 时可先 preview_patch 再 patch_file；完整重写前可用 preview_file_diff 检查变更范围；需要汇总本轮文件变更时用 checkpoint_diff。'
      : params.permission.mode === 'read-only'
        ? '- 当前工具列表不包含项目写入工具；如用户要求实现或修改文件，不要伪造写入，可给计划、方案或建议切换到 Build。'
        : '- 当前工具列表只包含只读工具；不要声称已经写入文件。',
    options.includeWriteTools
      ? '- 调用 edit_file/multi_edit 时，oldText 必须逐字来自最近 read_file 输出并且唯一匹配；如果编辑失败、上下文不确定或需要多处结构性修改，先 read_file，再优先 preview_patch + patch_file。不要调用 edits 为空的 multi_edit。'
      : '',
    options.includeMcpToolCalls
      ? options.dynamicMcpToolNames?.length
        ? '- MCP Server tools 已按 Claude 风格直接暴露为 mcp__server__tool 工具；优先直接调用这些 mcp__ 工具并按其 schema 传参。list_mcp_tools/list_mcp_resources 用于重新发现或排查，call_mcp_tool 仅作动态工具缺失时的备用入口。'
        : '- 需要使用 MCP 时，先用 list_mcp_tools 或 list_mcp_resources 发现当前项目启用的 MCP 能力；确认 toolName/inputSchema 后再调用 call_mcp_tool，确认 uri 后再调用 read_mcp_resource。host 会在 MCP 工具执行点处理权限、拒绝和错误回放。'
      : '- 不要调用 MCP 写入工具；如需 Unity 状态，先用 list_mcp_resources 发现可读资源，再 read_mcp_resource。',
    '- 查网页资料时可用 web_search/web_fetch；技术资料优先设置 preferOfficial=true，用户指定站点时使用 domains 过滤。',
    options.includeCommandTools
      ? params.permission.mode === 'read-only'
        ? '- 为了只读检查、测试、构建诊断或验证页面而确实需要时，可调用 run_command、terminal_start/terminal_write/terminal_stop 或 browser_open/browser_navigate/browser_click/browser_type/browser_close；host 会在执行点处理权限、拒绝和错误回放；run_command 只能执行会自行结束的命令，不能使用 & 启动后台任务，持续任务必须用 terminal_start。'
        : '- 用户任务需要运行测试、构建、诊断命令、持久 dev server 或浏览器验证时，可调用 run_command、terminal_start/terminal_write/terminal_stop 或 browser_open/browser_navigate/browser_click/browser_type/browser_close；host 会在执行点处理权限、拒绝和错误回放；run_command 只能执行会自行结束的命令，不能使用 & 启动后台任务；持续任务必须用 terminal_start，然后用 terminal_read 观察日志；网页验证优先 browser_open 后用 browser_snapshot/browser_screenshot/browser_console。'
      : '- 不要运行 shell 命令。',
    '- 需要使用工具时必须返回协议级 tool_calls/function calls；不要把工具调用写成 `[Tool] name {...}`、JSON 代码块或普通正文。',
    '- 如果问题已经能回答，就直接结束并给用户最终答复。',
    '- 如果需要引用文件或目录，优先给出项目内相对路径。',
    '- 回答面向小白用户，直接、清楚、可执行。'
  ].join('\n');
}
