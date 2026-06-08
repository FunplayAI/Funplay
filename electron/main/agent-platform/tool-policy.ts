import type { GenericAgentRuntimeParams } from './types';

export type AgentToolIntentKind = 'workspace_write' | 'command' | 'engine' | 'media' | 'mcp' | 'memory_write' | 'notification';
export type AgentToolIntentConfidence = 'none' | 'medium' | 'high';
export type AgentExecutionProfileId = 'read_only' | 'side_effect' | 'build';
export type AgentToolFamily =
  | 'read_only'
  | 'workspace_write'
  | 'command'
  | 'browser'
  | 'engine'
  | 'media'
  | 'mcp'
  | 'memory'
  | 'notification';
export type AgentSideEffectPolicy = 'none' | 'host_controlled';
export type AgentVerificationPolicy = 'none' | 'write_blocking';

export interface AgentToolIntentSignal {
  kind: AgentToolIntentKind;
  detected: boolean;
  confidence: AgentToolIntentConfidence;
  evidence: string[];
}

export interface AgentToolPolicyDecision {
  workspaceWrite: AgentToolIntentSignal;
  command: AgentToolIntentSignal;
  engine: AgentToolIntentSignal;
  media: AgentToolIntentSignal;
  mcp: AgentToolIntentSignal;
  memoryWrite: AgentToolIntentSignal;
  notification: AgentToolIntentSignal;
  executionProfile: {
    id: AgentExecutionProfileId;
    allowedToolFamilies: AgentToolFamily[];
    sideEffectPolicy: AgentSideEffectPolicy;
    verificationPolicy: AgentVerificationPolicy;
    evidence: string[];
  };
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
    regex: /(修改|编辑|重构|重写|创建|新建|新增|删除|写入|覆盖|更新|生成|实现|集成|引入).{0,32}(文件|文件夹|目录|代码|项目|页面|组件|脚本|函数|类|测试|游戏|应用|工程|src|readme|\.tsx?|\.jsx?|\.html|\.css|\.json|\.md|\.cs|\.py|\.go|\.rs)/i,
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

const enginePatterns: IntentPattern[] = [
  {
    label: 'engine-open',
    regex: /(打开|启动|运行|唤起|连接).{0,32}(unity|cocos|creator|engine|引擎|编辑器|editor|hub|launcher|dashboard|项目工程|工程项目)/i,
    confidence: 'high'
  },
  {
    label: 'engine-bridge',
    regex: /(安装|接入|配置|修复|刷新|检测|诊断).{0,32}(mcp|bridge|funplay bridge|unity package|cocos|creator|引擎桥|桥接|引擎状态|unity|engine)/i,
    confidence: 'high'
  },
  {
    label: 'engine-tool-name',
    regex: /\b(open_engine_project|open_engine_hub|install_engine_bridge|refresh_engine_runtime_state|diagnose_engine_status)\b/i,
    confidence: 'high'
  }
];

const mediaPatterns: IntentPattern[] = [
  {
    label: 'media-generate',
    regex: /(生成|创建|制作|绘制|产出|生成一张|做一张).{0,32}(图片|图像|图标|插画|立绘|贴图|纹理|素材|音效|音频|音乐|sprite|asset|image|icon|illustration|texture|sound|audio|music)/i,
    confidence: 'high'
  },
  {
    label: 'media-attach-preview',
    regex: /(预览|查看|展示|读取|附加|引用|attach|preview|show|inspect).{0,32}(图片|图像|素材|音频|媒体|media|image|asset|png|jpe?g|webp|gif|svg|mp3|wav|ogg)/i,
    confidence: 'medium'
  },
  {
    label: 'media-tool-name',
    regex: /\b(media_attach_file|media_save_base64|image_generate|generate_asset|import_generated_asset|list_asset_generation_capabilities)\b/i,
    confidence: 'high'
  }
];

const mcpPatterns: IntentPattern[] = [
  {
    label: 'mcp-explicit',
    regex: /\b(mcp|mcp server|mcp tool|mcp tools|mcp__[\w-]+__[\w.-]+|call_mcp_tool|list_mcp_tools|list_mcp_resources|read_mcp_resource)\b/i,
    confidence: 'high'
  },
  {
    label: 'mcp-cn-explicit',
    regex: /(调用|使用|列出|发现|读取|检查|连接|通过).{0,24}(mcp|MCP|插件工具|外部工具|server 工具|服务器工具)/i,
    confidence: 'high'
  },
  {
    label: 'mcp-resource',
    regex: /(读取|查看|列出|检查).{0,24}(mcp resource|mcp resources|MCP 资源|资源模板|resource template)/i,
    confidence: 'medium'
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

function resolveExecutionProfile(input: {
  workspaceWrite: AgentToolIntentSignal;
  command: AgentToolIntentSignal;
  engine: AgentToolIntentSignal;
  media: AgentToolIntentSignal;
  mcp: AgentToolIntentSignal;
  memoryWrite: AgentToolIntentSignal;
  notification: AgentToolIntentSignal;
  evidence: string[];
}): AgentToolPolicyDecision['executionProfile'] {
  if (input.workspaceWrite.detected) {
    const allowedToolFamilies: AgentToolFamily[] = ['read_only', 'workspace_write', 'command', 'browser', 'mcp', 'memory'];
    if (input.engine.detected) {
      allowedToolFamilies.push('engine');
    }
    if (input.media.detected) {
      allowedToolFamilies.push('media');
    }
    if (input.notification.detected) {
      allowedToolFamilies.push('notification');
    }
    return {
      id: 'build',
      allowedToolFamilies,
      sideEffectPolicy: 'host_controlled',
      verificationPolicy: 'write_blocking',
      evidence: input.evidence
    };
  }

  if (input.command.detected || input.engine.detected || input.media.detected || input.mcp.detected || input.memoryWrite.detected || input.notification.detected) {
    const allowedToolFamilies: AgentToolFamily[] = ['read_only', 'command', 'browser'];
    if (input.engine.detected) {
      allowedToolFamilies.push('engine');
    }
    if (input.media.detected) {
      allowedToolFamilies.push('media');
    }
    if (input.mcp.detected) {
      allowedToolFamilies.push('mcp');
    }
    if (input.memoryWrite.detected) {
      allowedToolFamilies.push('memory');
    }
    if (input.notification.detected) {
      allowedToolFamilies.push('notification');
    }
    return {
      id: 'side_effect',
      allowedToolFamilies,
      sideEffectPolicy: 'host_controlled',
      verificationPolicy: 'none',
      evidence: input.evidence
    };
  }

  return {
    id: 'read_only',
    allowedToolFamilies: ['read_only', 'command', 'browser', 'engine'],
    sideEffectPolicy: 'none',
    verificationPolicy: 'none',
    evidence: input.evidence
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
  const engine = evaluateSignalWithContinuationContext('engine', text, continuationText, enginePatterns);
  const media = evaluateSignalWithContinuationContext('media', text, continuationText, mediaPatterns);
  const mcp = evaluateSignalWithContinuationContext('mcp', text, continuationText, mcpPatterns);
  const memoryWrite = evaluateSignalWithContinuationContext('memory_write', text, continuationText, memoryWritePatterns);
  const notification = evaluateSignalWithContinuationContext('notification', text, continuationText, notificationPatterns);
  const signals = [workspaceWrite, command, engine, media, mcp, memoryWrite, notification];
  const evidence = signals.flatMap((signal) => signal.evidence.map((item) => `${signal.kind}:${item}`));
  const executionProfile = resolveExecutionProfile({
    workspaceWrite,
    command,
    engine,
    media,
    mcp,
    memoryWrite,
    notification,
    evidence
  });
  const requiresWorkspaceWritePermission = workspaceWrite.detected;
  const exposesHighRiskTools = signals.some((signal) => signal.detected);
  const detectedKinds = signals.filter((signal) => signal.detected).map((signal) => signal.kind);

  return {
    workspaceWrite,
    command,
    engine,
    media,
    mcp,
    memoryWrite,
    notification,
    executionProfile,
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
    executionProfile: policy.executionProfile,
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
    engine: {
      detected: policy.engine.detected,
      confidence: policy.engine.confidence,
      evidence: policy.engine.evidence
    },
    media: {
      detected: policy.media.detected,
      confidence: policy.media.confidence,
      evidence: policy.media.evidence
    },
    mcp: {
      detected: policy.mcp.detected,
      confidence: policy.mcp.confidence,
      evidence: policy.mcp.evidence
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
