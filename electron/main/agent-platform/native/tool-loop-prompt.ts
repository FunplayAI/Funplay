import type { GenericAgentRuntimeParams } from '../types';
import { FUNPLAY_HTML_PREVIEW_CAPABILITY_PROMPT_ZH } from '../preview-capabilities';
import { createResponseLanguageInstruction } from '../response-language';
import { createNativeRuntimeDynamicContextPrompt, formatNativeRuntimeEnvironmentBlock } from './prompt';
import type { NativeRuntimeToolDefinition } from './tool-adapter';

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

function formatToolPromptLine(toolName: string, definition?: NativeRuntimeToolDefinition): string {
  if (!definition) {
    return `- ${toolName}`;
  }
  const canonical = definition.toolLanguage?.canonicalName && definition.toolLanguage.canonicalName !== definition.name
    ? `；Claude-like：${definition.toolLanguage.canonicalName}`
    : '';
  const hint = definition.toolLanguage?.usageHint ? `；${definition.toolLanguage.usageHint}` : '';
  return `- ${definition.name} — ${definition.title}${canonical}${hint}`;
}

function formatNativeToolLanguageGuide(definitions: NativeRuntimeToolDefinition[]): string[] {
  const semanticTools = definitions.filter((definition) => definition.toolLanguage?.canonicalName);
  const byCanonical = new Map<string, NativeRuntimeToolDefinition[]>();
  for (const definition of semanticTools) {
    const canonical = definition.toolLanguage?.canonicalName;
    if (!canonical) {
      continue;
    }
    byCanonical.set(canonical, [...(byCanonical.get(canonical) ?? []), definition]);
  }
  const preferredOrder = [
    'Read',
    'LS',
    'Glob',
    'Grep',
    'Bash',
    'Edit',
    'MultiEdit',
    'ApplyPatch',
    'TodoWrite',
    'Task',
    'WebSearch',
    'WebFetch'
  ];
  const lines = preferredOrder
    .map((canonical) => {
      const items = byCanonical.get(canonical);
      if (!items?.length) {
        return undefined;
      }
      const names = items.map((definition) => definition.name).join(' / ');
      const hint = items.map((definition) => definition.toolLanguage?.usageHint).find(Boolean);
      return `- ${canonical} → ${names}${hint ? `；${hint}` : ''}`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return [];
  }
  return [
    '',
    'Native 工具语言（按 Claude Code 心智模型选择，再调用右侧真实工具名）：',
    ...lines
  ];
}

export interface NativeToolLoopSystemPromptOptions {
  toolDefinitions: NativeRuntimeToolDefinition[];
}

// Tool buckets are derived from the materialized tool pool instead of being
// re-plumbed through every caller: the pool is the single source of truth for
// what the model can actually call this run.
function deriveNativeToolLoopFlags(definitions: NativeRuntimeToolDefinition[]): {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
  dynamicMcpToolNames: string[];
} {
  const names = new Set(definitions.map((definition) => definition.name));
  const dynamicMcpToolNames = [...names].filter((name) => name.startsWith('mcp__'));
  return {
    includeWriteTools: names.has('write_file') || names.has('edit_file') || names.has('patch_file'),
    includeMcpToolCalls: dynamicMcpToolNames.length > 0 || names.has('call_mcp_tool') || names.has('list_mcp_tools'),
    includeCommandTools: names.has('run_command') || names.has('terminal_start'),
    dynamicMcpToolNames
  };
}

// The full static-per-run system prompt for the native tool loop. Everything in
// here must be deterministic given (params, toolDefinitions): identity, the
// run-start environment snapshot, tool listings, and all doctrine/rule text.
// Per-turn data stays out of this prompt so providers can prefix-cache it.
export function createNativeToolLoopSystemPrompt(
  params: GenericAgentRuntimeParams,
  options: NativeToolLoopSystemPromptOptions
): string {
  const definitions = options.toolDefinitions;
  const flags = deriveNativeToolLoopFlags(definitions);

  return [
    '你是 Funplay 桌面工作台中的通用 AI Agent（native runtime）。',
    '你负责围绕当前项目完成连续对话、调查、规划，并在工具与权限允许时实际执行修改和验证。',
    '项目可能是代码项目、文档项目、Web 项目、Unity 项目或普通文件夹；不要默认理解为游戏项目。',
    FUNPLAY_HTML_PREVIEW_CAPABILITY_PROMPT_ZH,
    createResponseLanguageInstruction(params.uiLanguage),
    '',
    formatNativeRuntimeEnvironmentBlock(params.context),
    '',
    ...createNativeToolLoopPermissionInstructions(params, flags),
    '你可以使用这些工具来理解和推进项目：',
    ...definitions.map((definition) => formatToolPromptLine(definition.name, definition)),
    ...formatNativeToolLanguageGuide(definitions),
    '',
    '工具调用准则：',
    '- 需要使用工具时必须返回协议级 tool_calls/function calls；不要把工具调用写成 `[Tool] name {...}`、JSON 代码块或普通正文。',
    '- 互不依赖的只读调查（read_file/glob/grep/list_dir/search_files 等）应在同一个回复里并行发起多个工具调用，减少往返。',
    '- 优先使用专用工具而不是等价的 shell 命令：读文件用 read_file 而不是 cat，找文件用 glob/grep 工具而不是 find/grep 命令。',
    '- 工具执行结果就是事实来源：edit_file/write_file 成功后不要为了“确认”再次 read_file 同一文件。',
    '- 当用户目标涉及游戏、可玩页面、资源目录、Unity、素材或玩法验证时，优先调用 inspect_game_project 识别 Web/Unity 结构、资源工作流和验证路径。',
    '- 对范围明确、可独立调查的问题，可调用 run_subagent；如果有 2-4 个互不重叠的调查方向，优先 run_subagents 并行收集证据；较长的旁路调查可用 subagent_start 后用 subagent_status 读取结果；不要把用户的主任务整体转交给子任务。',
    '- 如果缺少继续执行所必需的用户偏好、业务选择或冲突决策，可调用 ask_user 向用户提一个简短明确的问题；不要用 ask_user 做工具权限确认，也不要询问可以通过读取项目或搜索自行确定的信息。',
    '- 写入项目记忆时用 funplay_memory_remember，并设置 memoryKind：用户偏好 user_preference、稳定项目事实 project_fact、已确认决策 decision、临时任务状态 task_state。',
    '- 查网页资料时可用 web_search/web_fetch；技术资料优先设置 preferOfficial=true，用户指定站点时使用 domains 过滤。',
    flags.includeMcpToolCalls
      ? flags.dynamicMcpToolNames.length
        ? '- MCP Server tools 已按 Claude 风格直接暴露为 mcp__server__tool 工具；优先直接调用这些 mcp__ 工具并按其 schema 传参。list_mcp_tools/list_mcp_resources 用于重新发现或排查，call_mcp_tool 仅作动态工具缺失时的备用入口。'
        : '- 需要使用 MCP 时，先用 list_mcp_tools 或 list_mcp_resources 发现当前项目启用的 MCP 能力；确认 toolName/inputSchema 后再调用 call_mcp_tool，确认 uri 后再调用 read_mcp_resource。host 会在 MCP 工具执行点处理权限、拒绝和错误回放。'
      : '- 不要调用 MCP 写入工具；如需 Unity 状态，先用 list_mcp_resources 发现可读资源，再 read_mcp_resource。',
    flags.includeCommandTools
      ? params.permission.mode === 'read-only'
        ? '- 为了只读检查、测试、构建诊断或验证页面而确实需要时，可调用 run_command、terminal_start/terminal_write/terminal_stop 或 browser_open/browser_navigate/browser_click/browser_type/browser_close；host 会在执行点处理权限、拒绝和错误回放；run_command 只能执行会自行结束的命令，不能使用 & 启动后台任务，持续任务必须用 terminal_start。'
        : '- 用户任务需要运行测试、构建、诊断命令、持久 dev server 或浏览器验证时，可调用 run_command、terminal_start/terminal_write/terminal_stop 或 browser_open/browser_navigate/browser_click/browser_type/browser_close；host 会在执行点处理权限、拒绝和错误回放；run_command 只能执行会自行结束的命令，不能使用 & 启动后台任务；持续任务必须用 terminal_start，然后用 terminal_read 观察日志；网页验证优先 browser_open 后用 browser_snapshot/browser_screenshot/browser_console。'
      : '- 不要运行 shell 命令。',
    '',
    '编辑协议：',
    flags.includeWriteTools
      ? '- 用户任务需要创建目录、创建文件、修改文件或回滚文件时，调用 create_directory、write_file、edit_file、multi_edit、patch_file 或 checkpoint_rollback；host 会在工具执行点处理权限、checkpoint、拒绝和错误回放。'
      : params.permission.mode === 'read-only'
        ? '- 当前工具列表不包含项目写入工具；如用户要求实现或修改文件，不要伪造写入，可给计划、方案或建议切换到 Build。'
        : '- 当前工具列表只包含只读工具；不要声称已经写入文件。',
    '- 修改文件前必须先用 read_file 读取目标片段；edit_file/multi_edit 的 oldText 必须逐字来自最近一次 read_file 输出并且唯一匹配。',
    '- 同一文件多处修改优先用 multi_edit（不要调用 edits 为空的 multi_edit）；能构造 unified diff 时可先 preview_patch 再 patch_file；完整重写前可用 preview_file_diff 检查变更范围。',
    '- 如果编辑失败、上下文不确定或需要多处结构性修改，先重新 read_file，再优先 preview_patch + patch_file；不要原样重试已经失败的编辑。',
    '- 需要汇总本轮文件变更时用 checkpoint_diff。',
    '',
    '验证要求：',
    '- 执行了写入、命令或其他副作用后，优先运行项目自带的检查命令（测试 / 类型检查 / 构建 / 页面验证之一）确认结果。',
    '- 没有看到对应的工具执行结果之前，不要声称已经修改文件、执行命令或完成任务；未经验证的结论必须明确标注。',
    '',
    '任务清单纪律：',
    '- 对多步骤任务，使用 update_todo_list 维护简短任务清单；优先传 todos 数组，可用 pending/in_progress/completed/cancelled 状态，并在关键步骤完成时更新状态。',
    '- 同一时间只保留一个 in_progress 条目；完成或放弃时立即更新，不要留下永远 pending 的清单。',
    '',
    '回复风格：',
    '- 回答面向小白用户，直接、清楚、可执行。',
    '- 如果需要引用文件或目录，优先给出项目内相对路径。',
    '- 如果问题已经能回答，就直接结束并给用户最终答复。',
    '- 允许使用 Markdown，但保持结构简洁。'
  ].join('\n');
}

// Per-turn prompt for the native tool loop. The toolNames/options parameters are
// kept for caller compatibility, but all static rule text now lives in
// createNativeToolLoopSystemPrompt — this returns only the dynamic context block
// that is appended as the LAST user message of the request.
export function createNativeToolLoopPrompt(params: GenericAgentRuntimeParams, _toolNames: string[], _options: {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
  dynamicMcpToolNames?: string[];
  toolDefinitions?: NativeRuntimeToolDefinition[];
}): string {
  return createNativeRuntimeDynamicContextPrompt(params);
}
