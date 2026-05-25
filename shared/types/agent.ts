import type {
  AgentRunKind,
  AgentRuntimeRunStatus,
  AgentPermissionMode,
  AgentRuntimeReportId,
  AgentRunResumeStrategy,
  AgentOperationStatus,
  ProjectSessionRuntimeId,
  AgentTaskGraph,
  AgentVerificationReport,
  ClaudeContextSummaryCoverage,
  NativeContextSummaryCoverage,
} from './project';
import type {
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolCommandResult,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTerminalResult
} from './chat';
import type {
  AgentCoreMessagePart,
  AgentCorePartKind,
  AgentCoreProviderStepResult,
  AgentCoreStateTransitionRecord,
  AgentCoreStateMachineSnapshot
} from './agent-core';

export type AgentRuntimeCapabilityKey =
  | 'conversation'
  | 'toolLoop'
  | 'nativeToolCalling'
  | 'legacyJsonLoop'
  | 'workspaceWrite'
  | 'mcpTools'
  | 'sessionPermission'
  | 'checkpoint'
  | 'toolCheckpoint'
  | 'resume'
  | 'toolResume'
  | 'externalProcess'
  | 'hostControlledWrites'
  | 'contextHandoff'
  | 'externalWriteAudit'
  | 'externalWriteRollback'
  | 'intentBoundMcp'
  | 'exactlyOnceStream'
  | 'liveE2EGated';

export interface AgentRuntimeCapabilities {
  conversation: boolean;
  toolLoop: boolean;
  nativeToolCalling: boolean;
  legacyJsonLoop: boolean;
  workspaceWrite: boolean;
  mcpTools: boolean;
  sessionPermission: boolean;
  checkpoint: boolean;
  toolCheckpoint: boolean;
  resume: boolean;
  toolResume: boolean;
  externalProcess: boolean;
  hostControlledWrites: boolean;
  contextHandoff: boolean;
  externalWriteAudit: boolean;
  externalWriteRollback: boolean;
  intentBoundMcp: boolean;
  exactlyOnceStream: boolean;
  liveE2EGated: boolean;
}

export interface AgentRuntimeCapabilityReport {
  id: AgentRuntimeReportId;
  displayName: string;
  description: string;
  available: boolean;
  capabilities: AgentRuntimeCapabilities;
  notes: string[];
}

export interface AgentRuntimeTimelineEntry {
  id: string;
  phase?: string;
  title: string;
  target: string;
  status: AgentOperationStatus;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  errorMessage?: string;
}

export interface AgentRuntimeToolBoundary {
  toolUseId?: string;
  toolName?: string;
  phase?: string;
  status?: AgentOperationStatus;
  checkpointSnapshotId?: string;
  completedAt?: string;
  summary?: string;
  transaction?: AgentToolTransactionSummary;
}

export type AgentToolTransactionClass =
  | 'workspace'
  | 'command'
  | 'terminal'
  | 'browser'
  | 'mcp'
  | 'media'
  | 'memory'
  | 'user_input'
  | 'subagent'
  | 'checkpoint'
  | 'custom';

export type AgentToolTransactionPhase =
  | 'created'
  | 'validating'
  | 'awaiting_permission'
  | 'checkpointing'
  | 'executing'
  | 'recording_result'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type AgentToolTransactionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type AgentToolTransactionResultSource =
  | 'executed'
  | 'cached'
  | 'validation_failed'
  | 'synthetic_failure'
  | 'interrupted';

export interface AgentToolTransactionSummary {
  id: string;
  toolUseId: string;
  providerCallId?: string;
  toolName: string;
  toolClass: AgentToolTransactionClass;
  phase: AgentToolTransactionPhase;
  status: AgentToolTransactionStatus;
  resultSource?: AgentToolTransactionResultSource;
  eventCount: number;
  startedAt: string;
  updatedAt: string;
  timeoutMs?: number;
  permission?: {
    policy: string;
    risk: 'low' | 'medium' | 'high';
    decision?: 'allow' | 'allow_session' | 'deny';
    requestId?: string;
  };
  checkpoint?: {
    policy: string;
    snapshotId?: string;
    status?: 'not_applicable' | 'pending' | 'completed' | 'failed';
  };
}

export interface AgentRuntimeResumeCursor {
  eventId: string;
  eventType: AgentRuntimeEventType;
  strategy: AgentRunResumeStrategy;
  createdAt: string;
  checkpointSnapshotId?: string;
  toolUseId?: string;
  toolName?: string;
  summary?: string;
  transaction?: AgentToolTransactionSummary;
}

export interface AgentRuntimeResumeContext {
  resumedFromRunId: string;
  strategy: AgentRunResumeStrategy;
  previousStatus: AgentRuntimeRunStatus;
  coreState?: AgentCoreStateMachineSnapshot;
  originalInput?: string;
  checkpointSnapshotId?: string;
  filesRestoredToCheckpoint?: boolean;
  lastError?: string;
  lastToolBoundary?: AgentRuntimeToolBoundary;
  resumeCursor?: AgentRuntimeResumeCursor;
  recentTimeline?: AgentRuntimeTimelineEntry[];
}

export interface AgentRuntimeStatus {
  id: string;
  kind: AgentRunKind;
  projectId: string;
  sessionId?: string;
  runtimeId?: AgentRuntimeReportId;
  providerId?: string;
  model?: string;
  permissionMode?: AgentPermissionMode;
  startedAt: string;
  updatedAt: string;
  status: AgentRuntimeRunStatus;
  statusMessage?: string;
  streamId?: string;
  checkpointSnapshotId?: string;
  canResume: boolean;
  inputPreview?: string;
  lastError?: string;
  resumedFromRunId?: string;
  timeline?: AgentRuntimeTimelineEntry[];
  lastToolBoundary?: AgentRuntimeToolBoundary;
  resumeStrategy?: AgentRunResumeStrategy;
  resumeCursor?: AgentRuntimeResumeCursor;
  coreState?: AgentCoreStateMachineSnapshot;
  taskGraph?: AgentTaskGraph;
  verification?: AgentVerificationReport;
  usage?: RuntimeUsageTotals;
  events?: AgentRuntimeEvent[];
}

export interface AgentReplayLog {
  id: string;
  runId: string;
  exportedAt: string;
  run: AgentRuntimeStatus;
  taskGraph?: AgentTaskGraph;
  verification?: AgentVerificationReport;
  timeline: AgentRuntimeTimelineEntry[];
  events: AgentRuntimeEvent[];
  lastToolBoundary?: AgentRuntimeToolBoundary;
  toolBoundaries: AgentRuntimeToolBoundary[];
  usage?: RuntimeUsageTotals;
  metrics?: AgentReplayMetrics;
  recovery: AgentReplayRecoveryMetadata;
  agentCore?: AgentReplayAgentCoreDebugger;
  redacted?: boolean;
  redactionSummary?: {
    replacementCount: number;
  };
}

export interface AgentReplayAgentCoreDebugger {
  state?: AgentCoreStateMachineSnapshot;
  transitions: AgentCoreStateTransitionRecord[];
  parts: AgentCoreMessagePart[];
  partCounts: Partial<Record<AgentCorePartKind, number>>;
  providerSteps: Array<{
    eventId: string;
    createdAt: string;
    finishReason?: string;
    toolCallCount: number;
    hasText: boolean;
    hasThinking: boolean;
    warningCount: number;
  }>;
  toolTransactions: Array<{
    toolUseId: string;
    toolName?: string;
    toolClass?: AgentToolTransactionClass;
    phase?: AgentToolTransactionPhase;
    status?: string;
    startedAt?: string;
    completedAt?: string;
    failed?: boolean;
    eventCount?: number;
    changedFileCount?: number;
    failureKind?: string;
    checkpointSnapshotId?: string;
  }>;
  permissionDecisions: Array<{
    eventId: string;
    createdAt: string;
    summary?: string;
    decision?: string;
  }>;
  compressionPoints: Array<{
    eventId: string;
    createdAt: string;
    summary: string;
    coverage?: Record<string, unknown>;
  }>;
  hookEvents: Array<{
    eventId: string;
    createdAt: string;
    hookId: string;
    event: AgentLifecycleHookEventName;
    actionType: AgentLifecycleHookActionType;
    status: AgentLifecycleHookEvaluationStatus;
    summary: string;
    transaction?: AgentToolTransactionSummary;
  }>;
  resumeCursor?: AgentRuntimeResumeCursor;
}

export interface AgentReplayMetrics {
  eventCount: number;
  usageEventCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  tokenTurns: number;
  averageTokensPerTurn?: number;
  toolCallCount: number;
  toolResultCount: number;
  failedToolResultCount: number;
  toolRetryCount: number;
  recoveryEventCount: number;
  apiRetryCount: number;
  contextRetryCount: number;
  skillActivationCount: number;
  hookEventCount: number;
}

export interface AgentReplayRecoveryMetadata {
  canResume: boolean;
  resumeStrategy?: AgentRunResumeStrategy;
  resumeCursor?: AgentRuntimeResumeCursor;
  checkpointSnapshotId?: string;
  resumedFromRunId?: string;
  lastError?: string;
}

export interface AgentSkillCatalogItem {
  id: string;
  name: string;
  description?: string;
  dependencies: string[];
  inputs: string[];
  outputs: string[];
  examples: string[];
  instruction: string;
  sourcePath: string;
  sourceUrl: string;
  repositoryUrl: string;
  repositoryRef: string;
  commitSha?: string;
  fetchedAt: string;
}

export interface AgentSkillCatalogResult {
  repositoryUrl: string;
  repositoryRef: string;
  commitSha?: string;
  fetchedAt: string;
  cached: boolean;
  skills: AgentSkillCatalogItem[];
}

export type AgentSkillPackageSource = 'project' | 'user' | 'plugin' | 'catalog' | 'custom';
export type AgentSkillTrustLevel = 'trusted' | 'workspace' | 'untrusted';
export type AgentSkillVerificationStatus = 'trusted_source' | 'local_source' | 'unverified_source';
export type AgentSkillPermissionPolicy = 'read_only' | 'workspace_policy' | 'approval_required';
export type AgentSkillScriptPolicy = 'none' | 'approval_required';

export interface AgentSkillScriptDeclaration {
  name: string;
  command: string;
  description?: string;
  risk: 'low' | 'medium' | 'high';
}

export interface AgentSkillIndexEntry {
  id: string;
  name: string;
  description?: string;
  source: AgentSkillPackageSource;
  sourceId: string;
  sourcePath: string;
  relativePath?: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  allowedTools?: string[];
  dependencies?: string[];
  inputs?: string[];
  outputs?: string[];
  examples?: string[];
  trustLevel: AgentSkillTrustLevel;
  verificationStatus: AgentSkillVerificationStatus;
  contentSha256: string;
  permissionPolicy: AgentSkillPermissionPolicy;
  scriptPolicy: AgentSkillScriptPolicy;
  declaredScripts?: AgentSkillScriptDeclaration[];
}

export interface AgentSkillPackage extends AgentSkillIndexEntry {
  skillPath: string;
  instruction: string;
  rootPath: string;
  rawFrontmatter?: Record<string, string | string[] | boolean>;
}

export interface AgentSkillActivation {
  id: string;
  name: string;
  description?: string;
  source: AgentSkillPackageSource;
  sourceId: string;
  sourcePath: string;
  activationReason: 'explicit_slash' | 'automatic_metadata_match';
  instruction: string;
  allowedTools?: string[];
  dependencies?: string[];
  examples?: string[];
  trustLevel: AgentSkillTrustLevel;
  verificationStatus: AgentSkillVerificationStatus;
  contentSha256: string;
  permissionPolicy: AgentSkillPermissionPolicy;
  scriptPolicy: AgentSkillScriptPolicy;
  declaredScripts?: AgentSkillScriptDeclaration[];
}

export interface AgentSkillSupportingFile {
  path: string;
  size: number;
}

export interface AgentSkillRegistryConflict {
  name: string;
  resolvedSkillId: string;
  candidates: AgentSkillIndexEntry[];
}

export interface AgentSkillRegistrySourceSummary {
  source: AgentSkillPackageSource;
  sourceId: string;
  priority: number;
  skillsDir: string;
}

export interface AgentSkillRegistrySnapshot {
  generatedAt: string;
  skills: AgentSkillIndexEntry[];
  conflicts: AgentSkillRegistryConflict[];
  sourcePrecedence: AgentSkillRegistrySourceSummary[];
}

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalTokens: number;
  recordedAt: string;
  provider?: string;
  model?: string;
}

export interface RuntimeUsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export type AgentRuntimeEventType =
  | 'run_registered'
  | 'status'
  | 'timeline'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'tool_boundary'
  | 'agent_core_state'
  | 'agent_core_parts'
  | 'context_summary'
  | 'todo_update'
  | 'permission_request'
  | 'permission_resolved'
  | 'user_input_request'
  | 'user_input_resolved'
  | 'skill_activation'
  | 'hook'
  | 'usage'
  | 'run_completed'
  | 'run_interrupted'
  | 'run_failed';

export type AgentLifecycleHookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact';

export type AgentLifecycleHookActionType = 'audit' | 'append_context' | 'block' | 'command';

export type AgentLifecycleHookEvaluationStatus =
  | 'matched'
  | 'blocked'
  | 'context_appended'
  | 'requires_permission'
  | 'permission_denied'
  | 'command_completed'
  | 'command_failed'
  | 'command_skipped'
  | 'skipped';

export interface AgentLifecycleHookAction {
  type: AgentLifecycleHookActionType;
  message?: string;
  context?: string;
  command?: string;
  timeoutMs?: number;
}

export interface AgentLifecycleHookRule {
  id: string;
  event: AgentLifecycleHookEventName;
  matcher?: string;
  enabled: boolean;
  action: AgentLifecycleHookAction;
  source?: 'project' | 'user' | 'workspace' | 'runtime';
  sourcePath?: string;
}

export interface AgentLifecycleHookConfig {
  rules: AgentLifecycleHookRule[];
  diagnostics: Array<{
    level: 'info' | 'warning' | 'error';
    message: string;
    path?: string;
  }>;
}

export interface AgentLifecycleHookTrigger {
  event: AgentLifecycleHookEventName;
  runId?: string;
  projectId?: string;
  sessionId?: string;
  toolUseId?: string;
  toolName?: string;
  prompt?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentLifecycleHookEvaluationResult {
  id: string;
  ruleId: string;
  event: AgentLifecycleHookEventName;
  matcher?: string;
  actionType: AgentLifecycleHookActionType;
  status: AgentLifecycleHookEvaluationStatus;
  summary: string;
  blockReason?: string;
  context?: string;
  command?: string;
  timeoutMs?: number;
  permissionDecision?: 'allow' | 'deny';
  commandResult?: {
    ok: boolean;
    isError?: boolean;
    contentPreview: string;
    command?: AgentToolCommandResult;
  };
  transaction?: AgentToolTransactionSummary;
  source?: AgentLifecycleHookRule['source'];
  sourcePath?: string;
  trigger: AgentLifecycleHookTrigger;
}

export interface AgentRuntimeEvent {
  id: string;
  type: AgentRuntimeEventType;
  createdAt: string;
  status?: AgentRuntimeRunStatus;
  statusMessage?: string;
  timelineEntry?: AgentRuntimeTimelineEntry;
  streamDelta?: {
    deltaPreview?: string;
    deltaLength?: number;
    contentPreview: string;
    contentLength: number;
    truncated?: boolean;
    eventCount?: number;
  };
  toolUse?: {
    toolUseId: string;
    name: string;
    title?: string;
    summary?: string;
    activity?: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  };
  toolResult?: {
    toolUseId: string;
    toolName?: string;
    contentPreview: string;
    isError?: boolean;
    changedFiles?: AgentToolChangedFile[];
    command?: AgentToolCommandResult;
    terminal?: AgentToolTerminalResult;
    browser?: AgentToolBrowserResult;
    edit?: AgentToolEditMetrics;
    mcp?: AgentToolMcpResult;
    artifacts?: AgentToolArtifact[];
    transaction?: AgentToolTransactionSummary;
  };
  toolBoundary?: AgentRuntimeToolBoundary;
  coreState?: AgentCoreStateMachineSnapshot;
  agentCoreParts?: AgentCoreMessagePart[];
  providerStep?: AgentCoreProviderStepResult;
  contextSummary?: {
    summary: string;
    coverage?: ClaudeContextSummaryCoverage | NativeContextSummaryCoverage | Record<string, unknown>;
    runtimeId?: AgentRuntimeReportId;
    sourceStageId?: string;
  };
  todoUpdate?: {
    toolUseId?: string;
    items: Array<{
      id: string;
      title: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }>;
  };
  permissionRequest?: {
    requestId: string;
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    toolName?: string;
    impact?: Record<string, unknown>;
  };
  permissionResponse?: {
    requestId: string;
    decision: 'allow' | 'allow_session' | 'deny';
  };
  userInputRequest?: {
    requestId: string;
    title?: string;
    question: string;
    detail?: string;
    options?: Array<{
      id: string;
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
    allowFreeText?: boolean;
    placeholder?: string;
    toolName?: string;
  };
  userInputResponse?: {
    requestId: string;
    answerPreview?: string;
    answerLength?: number;
    optionId?: string;
    optionIds?: string[];
    cancelled?: boolean;
  };
  skillActivation?: AgentSkillActivation;
  hook?: AgentLifecycleHookEvaluationResult;
  usage?: RuntimeUsage;
  usageTotals?: RuntimeUsageTotals;
  error?: string;
  metadata?: Record<string, unknown>;
}
