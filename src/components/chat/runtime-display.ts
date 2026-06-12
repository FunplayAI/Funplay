import { localize, type UiLanguage } from '../../i18n';

export interface RuntimeStageLike {
  stageId: string;
  phase?: string;
  title: string;
  target: string;
  summary?: string;
  errorMessage?: string;
}

const DEVELOPER_RUNTIME_PATTERNS = [
  /stage:/i,
  /stage:(?:tool_loop|native_tool|openai_compatible|runtime_fallback)/i,
  /Native\s+(?:真实\s+)?Tool\s+Loop/i,
  /OpenAI-compatible/i,
  /JSON\s*工具循环/i,
  /选择\s*AI\s*Provider/i,
  /校验工具权限/i,
  /整理(?:通用)?(?:会话|工作区)上下文/i,
  /整理工作区观察/i,
  /工作区(?:摘要|观察)/i,
  /采集插件观测/i,
  /可观测插件/i,
  /插件摘要/i,
  /会话检查点/i,
  /写入权限/i,
  /本轮未检测到写入意图/i,
  /已写入工作区摘要/i,
  /已完成所有可观测插件的结果采集/i,
  /observable plugins?/i,
  /workspace (?:observation|summary)/i,
  /permission check/i,
  /provider selection/i,
  /checkpoint/i,
  /工具循环策略/i,
  /回退(?:兼容|为| Legacy| JSON)?/i,
  /本地\s*fallback/i,
  /No tool output found for function call/i,
  /tool[-_\s]?calling/i,
  /function call/i
];

export function getVisibleRuntimeStages<TStage extends RuntimeStageLike>(
  stages: TStage[],
  developerMode: boolean
): TStage[] {
  if (developerMode) {
    return stages;
  }

  return [];
}

export function getVisibleRuntimeStatusMessage(
  statusMessage: string | undefined,
  developerMode: boolean,
  language: UiLanguage
): string | undefined {
  if (!statusMessage) {
    return statusMessage;
  }

  if (developerMode || !isDeveloperRuntimeText(statusMessage)) {
    return statusMessage;
  }

  return localize(language, 'Agent 正在执行任务…', 'Agent is working…');
}

function isDeveloperRuntimeText(value: string): boolean {
  return DEVELOPER_RUNTIME_PATTERNS.some((pattern) => pattern.test(value));
}
