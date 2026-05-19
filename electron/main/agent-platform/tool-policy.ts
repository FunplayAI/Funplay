import type { GenericAgentRuntimeParams } from './types';

export type AgentToolIntentKind = 'workspace_write' | 'command' | 'memory_write' | 'notification';
export type AgentToolIntentConfidence = 'none' | 'medium' | 'high';

export interface AgentToolIntentSignal {
  kind: AgentToolIntentKind;
  detected: boolean;
  confidence: AgentToolIntentConfidence;
  evidence: string[];
}

export interface AgentToolPolicyDecision {
  workspaceWrite: AgentToolIntentSignal;
  command: AgentToolIntentSignal;
  memoryWrite: AgentToolIntentSignal;
  notification: AgentToolIntentSignal;
  requiresWorkspaceWritePermission: boolean;
  exposesHighRiskTools: boolean;
  summary: string;
  evidence: string[];
}

interface AgentToolPolicyInput {
  message: string;
  currentGoal?: string;
  recentMessages?: Array<{
    role?: string;
    content: string;
  }>;
}

interface IntentPattern {
  label: string;
  regex: RegExp;
  confidence: Exclude<AgentToolIntentConfidence, 'none'>;
}

const workspaceWritePatterns: IntentPattern[] = [
  {
    label: 'explicit-file-write',
    regex: /(修改|编辑|重构|重写|创建|新建|新增|删除|写入|覆盖|更新|生成|实现|集成|引入).{0,32}(文件|文件夹|目录|代码|项目|页面|组件|脚本|函数|类|测试|游戏|应用|工程|资源|素材|src|assets|readme|\.tsx?|\.jsx?|\.html|\.css|\.json|\.md|\.cs|\.py|\.go|\.rs)/i,
    confidence: 'high'
  },
  {
    label: 'explicit-directory-create',
    regex: /(创建|新建|新增|生成).{0,32}(文件夹|目录|资源目录|素材目录|asset folder|assets folder|folder|directory)/i,
    confidence: 'high'
  },
  {
    label: 'code-change',
    regex: /(改代码|改文件|更新文件|生成文件|应用补丁|打补丁|修复代码|实现功能|添加功能|删除文件|创建文件|新建文件|创建目录|新建目录|创建文件夹|新建文件夹)/i,
    confidence: 'high'
  },
  {
    label: 'path-edit',
    regex: /\b(edit|modify|patch|rewrite|change|update|create|delete|remove|write)\b.{0,40}([./\w-]+\.(tsx?|jsx?|css|json|md|cs|py|go|rs|sh|mjs|cjs)|src\/|assets\/|electron\/|shared\/|tests\/)/i,
    confidence: 'high'
  },
  {
    label: 'project-implementation',
    regex: /\b(implement|refactor|fix|add|remove|create|update|rewrite)\b.{0,40}\b(code|file|component|page|feature|test|project|app|script|module|function|class)\b/i,
    confidence: 'high'
  },
  {
    label: 'patch-command',
    regex: /\b(apply_patch|patch file|edit file|write file|create file|delete file|modify file|change file|update file)\b/i,
    confidence: 'high'
  }
];

const commandPatterns: IntentPattern[] = [
  {
    label: 'run-command',
    regex: /(运行|执行|测试|构建|检查|诊断|命令|终端|脚本|启动|安装依赖|run|execute|test|build|check|lint|typecheck|diagnose|command|terminal|script|npm|pnpm|yarn|pytest|cargo|go test)/i,
    confidence: 'high'
  }
];

const memoryWritePatterns: IntentPattern[] = [
  {
    label: 'memory-write',
    regex: /(记住|保存到记忆|记录下来|remember|save.*memory|store.*memory|memorize)/i,
    confidence: 'medium'
  }
];

const notificationPatterns: IntentPattern[] = [
  {
    label: 'notification-side-effect',
    regex: /(提醒|通知|闹钟|稍后提醒|定时|日程|取消提醒|notify|notification|remind|reminder|schedule|alert|cancel task)/i,
    confidence: 'medium'
  }
];

function normalizeText(input: AgentToolPolicyInput): string {
  return [
    input.message,
    input.currentGoal
  ].filter(Boolean).join('\n').toLowerCase();
}

function isContinuationRequest(message: string): boolean {
  return /(^|\s)(继续|继续完成|继续推进|继续扩展|接着|接着做|完成剩下|把剩下的做完|全部写完|改完了吗|扩展完了吗|continue|keep going|finish it|finish the rest)(\s|$|[。！？!?])/i.test(message.trim());
}

function normalizeContinuationContext(input: AgentToolPolicyInput): string {
  if (!isContinuationRequest(input.message)) {
    return '';
  }
  return (input.recentMessages ?? [])
    .slice(-8)
    .map((message) => message.content)
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function evaluateSignal(kind: AgentToolIntentKind, text: string, patterns: IntentPattern[]): AgentToolIntentSignal {
  const matches = patterns.filter((pattern) => pattern.regex.test(text));
  const high = matches.some((match) => match.confidence === 'high');
  return {
    kind,
    detected: matches.length > 0,
    confidence: matches.length === 0 ? 'none' : high ? 'high' : 'medium',
    evidence: matches.map((match) => match.label)
  };
}

function evaluateSignalWithContinuationContext(
  kind: AgentToolIntentKind,
  baseText: string,
  continuationText: string,
  patterns: IntentPattern[]
): AgentToolIntentSignal {
  const base = evaluateSignal(kind, baseText, patterns);
  if (base.detected || !continuationText.trim()) {
    return base;
  }
  const fromContinuation = evaluateSignal(kind, continuationText, patterns);
  if (!fromContinuation.detected) {
    return base;
  }
  return {
    ...fromContinuation,
    evidence: ['continuation-context', ...fromContinuation.evidence]
  };
}

export function resolveAgentToolPolicy(input: AgentToolPolicyInput): AgentToolPolicyDecision;
export function resolveAgentToolPolicy(params: Pick<GenericAgentRuntimeParams, 'message' | 'context'>): AgentToolPolicyDecision;
export function resolveAgentToolPolicy(input: AgentToolPolicyInput | Pick<GenericAgentRuntimeParams, 'message' | 'context'>): AgentToolPolicyDecision {
  const currentGoal = 'context' in input ? input.context.currentGoal : input.currentGoal;
  const recentMessages = 'context' in input ? input.context.recentMessages : input.recentMessages;
  const text = normalizeText({
    message: input.message,
    currentGoal,
    recentMessages
  });
  const continuationText = normalizeContinuationContext({
    message: input.message,
    currentGoal,
    recentMessages
  });
  const workspaceWrite = evaluateSignalWithContinuationContext('workspace_write', text, continuationText, workspaceWritePatterns);
  const command = evaluateSignalWithContinuationContext('command', text, continuationText, commandPatterns);
  const memoryWrite = evaluateSignalWithContinuationContext('memory_write', text, continuationText, memoryWritePatterns);
  const notification = evaluateSignalWithContinuationContext('notification', text, continuationText, notificationPatterns);
  const signals = [workspaceWrite, command, memoryWrite, notification];
  const evidence = signals.flatMap((signal) => signal.evidence.map((item) => `${signal.kind}:${item}`));
  const requiresWorkspaceWritePermission = workspaceWrite.detected;
  const exposesHighRiskTools = signals.some((signal) => signal.detected);
  const detectedKinds = signals.filter((signal) => signal.detected).map((signal) => signal.kind);

  return {
    workspaceWrite,
    command,
    memoryWrite,
    notification,
    requiresWorkspaceWritePermission,
    exposesHighRiskTools,
    summary: detectedKinds.length ? `Detected tool intents: ${detectedKinds.join(', ')}` : 'No high-risk tool intent detected.',
    evidence
  };
}

export function formatToolPolicyForStage(policy: AgentToolPolicyDecision): Record<string, unknown> {
  return {
    summary: policy.summary,
    evidence: policy.evidence,
    requiresWorkspaceWritePermission: policy.requiresWorkspaceWritePermission,
    exposesHighRiskTools: policy.exposesHighRiskTools,
    workspaceWrite: {
      detected: policy.workspaceWrite.detected,
      confidence: policy.workspaceWrite.confidence,
      evidence: policy.workspaceWrite.evidence
    },
    command: {
      detected: policy.command.detected,
      confidence: policy.command.confidence,
      evidence: policy.command.evidence
    },
    memoryWrite: {
      detected: policy.memoryWrite.detected,
      confidence: policy.memoryWrite.confidence,
      evidence: policy.memoryWrite.evidence
    },
    notification: {
      detected: policy.notification.detected,
      confidence: policy.notification.confidence,
      evidence: policy.notification.evidence
    }
  };
}
