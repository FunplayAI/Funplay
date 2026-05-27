import type { GenericAgentRuntimeParams } from '../types';
import { FUNPLAY_HTML_PREVIEW_CAPABILITY_PROMPT_ZH } from '../preview-capabilities';
import { createResponseLanguageContextLine, createResponseLanguageInstruction, type RuntimeUiLanguage } from '../response-language';

export interface NativeRuntimeWorkspaceEvidence {
  fileTreeSummary?: string;
  directorySummaries: Array<{
    path: string;
    summary: string;
  }>;
  searchResults: Array<{
    path: string;
    excerpts: string[];
  }>;
  filesRead: Array<{
    path: string;
    content: string;
    truncated?: boolean;
  }>;
}

export interface NativeRuntimeUserPromptOptions {
  includeRecentTurns?: boolean;
}

function formatResumeContext(params: GenericAgentRuntimeParams): string {
  const context = params.resumeContext;
  if (!context) {
    return '';
  }
  const transaction = context.resumeCursor?.transaction ?? context.lastToolBoundary?.transaction;
  const transactionSummary = transaction
    ? [
        '恢复工具事务摘要：',
        `- transactionId: ${transaction.id}`,
        `- toolUseId: ${transaction.toolUseId}`,
        `- toolName: ${transaction.toolName}`,
        `- toolClass: ${transaction.toolClass}`,
        `- phase/status: ${transaction.phase}/${transaction.status}`,
        `- eventCount: ${transaction.eventCount}`,
        transaction.permission
          ? `- permission: ${transaction.permission.policy}/${transaction.permission.risk}${transaction.permission.decision ? `/${transaction.permission.decision}` : ''}${transaction.permission.requestId ? ` request=${transaction.permission.requestId}` : ''}`
          : '',
        transaction.checkpoint
          ? `- checkpoint: ${transaction.checkpoint.policy}${transaction.checkpoint.status ? `/${transaction.checkpoint.status}` : ''}${transaction.checkpoint.snapshotId ? ` snapshot=${transaction.checkpoint.snapshotId}` : ''}`
          : ''
      ].filter(Boolean).join('\n')
    : '';

  return [
    '恢复运行上下文：',
    JSON.stringify(
      {
        resumedFromRunId: context.resumedFromRunId,
        strategy: context.strategy,
        previousStatus: context.previousStatus,
        coreState: context.coreState,
        checkpointSnapshotId: context.checkpointSnapshotId,
        filesRestoredToCheckpoint: context.filesRestoredToCheckpoint,
        lastError: context.lastError,
        lastToolBoundary: context.lastToolBoundary,
        resumeCursor: context.resumeCursor,
        recentTimeline: context.recentTimeline
      },
      null,
      2
    ),
    '恢复规则：',
    '- 当前运行是在中断或失败后继续，不是全新任务。',
    '- 如果 lastToolBoundary.status 是 completed，把该工具视为已经完成；不要重复执行同一个工具，除非用户请求或后续检查证明必须重试。',
    transaction ? '- 如果恢复工具事务摘要显示 status 为 completed，把该 transactionId/toolUseId 视为 host 已经落盘的完成边界；不要为了“补写”而重复执行同一工具。' : '',
    '- 如果文件已恢复到 checkpoint，先基于当前文件状态继续，不要假设中断后的外部修改仍存在。',
    '- 优先从上一个工具边界之后继续推进，并在最终回复中说明恢复后的处理结果。',
    transactionSummary
  ].filter(Boolean).join('\n');
}

export function createNativeRuntimeSystemPrompt(uiLanguage?: RuntimeUiLanguage): string {
  return [
    '你是 Funplay 桌面应用中的通用 AI Agent。',
    '你的职责是帮助用户围绕当前项目进行连续对话、解释、规划、文件理解和下一步建议。',
    '项目可能是代码项目、文档项目、Web 项目、Unity 项目或普通文件夹；不要默认理解为游戏项目。',
    '用户多为小白，回复必须直接、清晰、可执行。',
    '如果提到文件路径，优先使用项目内相对路径。',
    '不要声称已经修改文件或执行工具，除非上下文明确给出了工具执行结果。',
    FUNPLAY_HTML_PREVIEW_CAPABILITY_PROMPT_ZH,
    createResponseLanguageInstruction(uiLanguage),
    '允许使用 Markdown，但保持结构简洁。'
  ].join('\n');
}

export function createNativeRuntimeUserPrompt(
  params: GenericAgentRuntimeParams,
  workspaceEvidence?: NativeRuntimeWorkspaceEvidence,
  options: NativeRuntimeUserPromptOptions = {}
): string {
  const includeRecentTurns = options.includeRecentTurns ?? true;

  return [
    '当前工作区上下文：',
    createResponseLanguageContextLine(params.uiLanguage),
    JSON.stringify(
      {
        projectId: params.context.projectId,
        projectName: params.context.projectName,
        projectPath: params.context.projectPath,
        platform: params.context.platform,
        runtimeEnvironment: params.context.runtimeEnvironment,
        projectBrief: params.context.projectBrief,
        currentGoal: params.context.currentGoal,
        projectContextIndex: params.context.projectContextIndex,
        sessionMode: params.context.sessionMode,
        sessionEffort: params.context.sessionEffort,
        runtimeSummary: params.context.runtimeSummary,
        executionPlanSummary: params.context.executionPlanSummary,
        lifecycleHookContext: params.lifecycleHookContext,
        activeSessionId: params.context.activeSessionId,
        archivedTurnCount: params.context.archivedTurnCount,
        toolContext: params.context.toolContext
      },
      null,
      2
    ),
    params.context.archivedSummary
      ? ['', `更早历史摘要（${params.context.archivedTurnCount} 轮）：`, params.context.archivedSummary].join('\n')
      : '',
    params.resumeContext ? ['', formatResumeContext(params)].join('\n') : '',
    params.context.projectInstructions.length
      ? [
          '',
          '项目级 Agent 指令（来自工作区文件，优先遵守）：',
          ...params.context.projectInstructions.map((instruction) =>
            [
              `## ${instruction.path}${instruction.truncated ? ' (truncated)' : ''}`,
              instruction.content
            ].join('\n')
          )
        ].join('\n\n')
      : '',
    params.lifecycleHookContext?.length
      ? [
          '',
          '生命周期 Hook 附加上下文（由 host 运行器注入）：',
          ...params.lifecycleHookContext.map((context, index) => `## Hook Context ${index + 1}\n${context}`)
        ].join('\n\n')
      : '',
    params.context.toolContext.skills.length
      ? [
          '',
          '用户赋予的 Agent Skills（项目设置中启用，按触发场景采用）：',
          ...params.context.toolContext.skills.map((skill) =>
            [
              `## ${skill.name}`,
              skill.description ? `用途：${skill.description}` : '',
              skill.trigger ? `触发场景：${skill.trigger}` : '',
              skill.dependencies?.length ? `依赖：${skill.dependencies.join(', ')}` : '',
              skill.examples?.length ? ['示例：', ...skill.examples.map((example) => `- ${example}`)].join('\n') : '',
              '执行准则：',
              skill.instruction
            ].filter(Boolean).join('\n')
          )
        ].join('\n\n')
      : '',
    params.context.toolContext.activeSkills.length
      ? [
          '',
          '本轮显式调用的文件系统 Agent Skills（已按需加载完整 SKILL.md）：',
          ...params.context.toolContext.activeSkills.map((skill) =>
            [
              `## ${skill.name}`,
              skill.description ? `用途：${skill.description}` : '',
              `来源：${skill.source}`,
              `信任：${skill.trustLevel} · 验证：${skill.verificationStatus}`,
              `权限策略：${skill.permissionPolicy}（只约束 Skill 工作流，不授予工具权限）`,
              `脚本策略：${skill.scriptPolicy}${skill.declaredScripts?.length ? ` · 声明脚本 ${skill.declaredScripts.length} 个，必须通过普通工具权限流程执行` : ''}`,
              skill.allowedTools?.length ? `建议工具：${skill.allowedTools.join(', ')}` : '',
              '执行准则：',
              skill.instruction
            ].filter(Boolean).join('\n')
          )
        ].join('\n\n')
      : '',
    params.context.toolContext.skillIndex.length
      ? [
          '',
          '可用文件系统 Agent Skills（只列 metadata，完整指令按需读取）：',
          '如果用户明确点名某个 Skill，或任务明显匹配某个 Skill，先用 list_agent_skills/read_agent_skill 读取完整 SKILL.md，再执行。',
          ...params.context.toolContext.skillIndex.map((skill) =>
            [
              `## ${skill.name}`,
              skill.description ? `用途：${skill.description}` : '',
              `来源：${skill.source}`,
              `可调用：user=${skill.userInvocable ? 'yes' : 'no'} model=${skill.modelInvocable ? 'yes' : 'no'}`,
              `信任：${skill.trustLevel} · 验证：${skill.verificationStatus}`,
              `权限策略：${skill.permissionPolicy}`,
              skill.declaredScripts?.length ? `声明脚本：${skill.declaredScripts.length} 个（不能直接执行，需普通工具权限）` : '',
              skill.allowedTools?.length ? `建议工具：${skill.allowedTools.join(', ')}` : ''
            ].filter(Boolean).join('\n')
          )
        ].join('\n\n')
      : '',
    includeRecentTurns && params.context.recentTurns.length
      ? [
          '',
          '最近会话轮次：',
          ...params.context.recentTurns.map((turn, index) =>
            [
              `## Turn ${index + 1}`,
              turn.userMessage ? `User:\n${turn.userMessage}` : '',
              ...turn.assistantMessages.map((message, messageIndex) =>
                `Assistant ${messageIndex + 1}${message.intent ? ` (${message.intent})` : ''}:\n${message.content}`
              )
            ]
              .filter(Boolean)
              .join('\n\n')
          )
        ].join('\n\n')
      : '',
    workspaceEvidence?.fileTreeSummary
      ? ['', '工作区文件树摘要：', workspaceEvidence.fileTreeSummary].join('\n')
      : '',
    workspaceEvidence?.directorySummaries.length
      ? [
          '',
          '相关目录摘要：',
          ...workspaceEvidence.directorySummaries.map((directory) => `[${directory.path}]\n${directory.summary}`)
        ].join('\n\n')
      : '',
    workspaceEvidence?.searchResults.length
      ? [
          '',
          '项目搜索结果：',
          ...workspaceEvidence.searchResults.map((result) => `[${result.path}]\n${result.excerpts.join('\n')}`)
        ].join('\n\n')
      : '',
    workspaceEvidence?.filesRead.length
      ? [
          '',
          '已读取的相关文件：',
          ...workspaceEvidence.filesRead.map((file) =>
            [`[${file.path}]${file.truncated ? ' (truncated)' : ''}`, file.content].join('\n')
          )
        ].join('\n\n')
      : '',
    '',
    `用户消息：${params.message}`,
    '',
    '请直接回复用户。'
  ].join('\n');
}

export function buildNativeRuntimeThinkingPrelude(params: GenericAgentRuntimeParams): string {
  const lines = [
    `当前项目：${params.context.projectName}`,
    params.context.projectPath ? `项目路径：${params.context.projectPath}` : '',
    `最近消息数：${params.context.recentMessages.length}`,
    `已挂载插件数：${params.context.toolContext.plugins.length}`,
    `已启用 Skills：${params.context.toolContext.skills.length}`,
    `用户目标：${params.message}`
  ].filter(Boolean);

  return lines.join('\n');
}

export function buildNativeRuntimePluginProbeSummary(params: GenericAgentRuntimeParams): string {
  if (params.context.toolContext.plugins.length === 0) {
    return '';
  }

  return params.context.toolContext.plugins
    .map((plugin) => {
      const endpointLabel = plugin.hasEndpoint ? '已配置端点' : '未配置端点';
      const enabledLabel = plugin.enabled ? '启用' : '禁用';
      return `- ${plugin.name} (${plugin.kind}) · ${enabledLabel} · ${endpointLabel}`;
    })
    .join('\n');
}
