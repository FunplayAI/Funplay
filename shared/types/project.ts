import type { AgentToolArtifact, AgentToolBrowserResult, AgentToolTerminalResult, ChatMessage } from './chat';
import type { McpPluginBindings, UnityHealthResult, PlatformChoice, ProjectSetupMode, EngineProjectDimension, McpPluginKind } from './unity';

export type GameTemplateId = 'generic-workspace' | 'engine-game-prototype' | '2d-roguelike' | 'narrative-adventure' | 'topdown-action';
export type TaskPhase = 'Concept' | 'Content' | 'Unity' | 'Validation';
export type TaskStatus = 'pending' | 'in_progress' | 'done';
export type AssetType = 'character' | 'environment' | 'ui' | 'audio' | 'vfx';
export type AssetStatus = 'planned' | 'generating' | 'ready';
export type ProjectStatus = 'planning' | 'active' | 'blocked';
export type ActivityKind = 'project' | 'planning' | 'bridge' | 'snapshot';
export type GameAgentRunMode = 'bootstrap' | 'update' | 'execute-plan';
export type GameAgentStepStatus = 'completed' | 'failed' | 'skipped';
export type GameAgentStepKind = 'context' | 'model' | 'planning' | 'memory' | 'fallback';
export type AgentOperationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type GameAgentPluginReportStatus = 'completed' | 'failed' | 'skipped';
export type GameAgentActionStatus = 'planned' | 'suggested' | 'running' | 'completed' | 'failed' | 'skipped';
export type GameAgentOperationType = 'tool_call' | 'resource_read';
export type AgentPermissionMode = 'full-access' | 'ask' | 'read-only';
export type ProjectSessionRuntimeId = 'native' | 'claude-code-sdk';
export type AgentRuntimeStrategy = 'auto' | ProjectSessionRuntimeId;
export type AgentRuntimeReportId = ProjectSessionRuntimeId | 'execute-plan';
export type ProjectSessionMode = 'agent';
export type ProjectSessionEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ClaudeRuntimeWriteMode = 'external-audited' | 'host-controlled';
export type AgentRunKind = 'conversation' | 'bootstrap' | 'execute-plan';
export type AgentRunResumeStrategy = 'restart_prompt' | 'resume_after_last_completed_tool' | 'resume_from_checkpoint';
export type AgentRuntimeRunStatus = 'running' | 'interrupted' | 'failed' | 'completed';
export type AgentTaskGraphStatus = AgentRuntimeRunStatus;
export type AgentTaskGraphNodeStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'skipped';
export type AgentTaskGraphNodeKind = 'intake' | 'plan' | 'execute' | 'verify' | 'repair' | 'release' | 'handoff';
export type AgentTaskSuccessCriterionStatus = 'pending' | 'passed' | 'failed' | 'skipped';
export type AgentTaskSubagentMode = 'single' | 'parallel' | 'background';
export type AgentTaskSubagentStatus = 'pending' | 'running' | 'completed' | 'failed';
export type AgentVerificationCheckKind = 'command' | 'build' | 'test' | 'browser' | 'mcp' | 'manual';
export type AgentVerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type ProjectMemoryFileKind = 'longterm' | 'daily' | 'note';
export type ProjectMemoryEntryKind = 'user_preference' | 'project_fact' | 'decision' | 'task_state';
export type ProjectMemoryClearScope = 'file' | 'daily' | 'all';

export interface TemplateOption {
  id: GameTemplateId;
  name: string;
  summary: string;
  designFocus: string;
}

export const TEMPLATE_OPTIONS: TemplateOption[] = [
  {
    id: 'generic-workspace',
    name: 'Generic Workspace',
    summary: '用于代码、文档、素材和 AI 对话协作的通用工作区。',
    designFocus: '文件管理、上下文整理、协作推进'
  },
  {
    id: 'engine-game-prototype',
    name: 'Engine Game Prototype',
    summary: '用于 Unity、Cocos 等引擎项目的中性游戏原型工作区。',
    designFocus: '引擎接入、基础场景、可运行验证'
  },
  {
    id: '2d-roguelike',
    name: '2D Roguelike',
    summary: '强调战斗循环、成长强化与地牢推进。',
    designFocus: '战斗节奏、房间体验、成长反馈'
  },
  {
    id: 'narrative-adventure',
    name: 'Narrative Adventure',
    summary: '强调对话、角色塑造与情绪推进。',
    designFocus: '叙事结构、角色关系、氛围表达'
  },
  {
    id: 'topdown-action',
    name: 'Top-down Action',
    summary: '强调即时操作、敌人反馈与技能表现。',
    designFocus: '操作手感、关卡节奏、视觉反馈'
  }
];

export interface CreateProjectInput {
  name: string;
  templateId: GameTemplateId;
  artStyle: string;
  pitch: string;
  engine?: ProjectEngineInfo;
}

export interface ProjectEngineInfo {
  platform: PlatformChoice;
  setupMode?: ProjectSetupMode;
  projectPath?: string;
  dimension?: EngineProjectDimension;
  unityEditorVersion?: string;
}

export interface ProjectRuntimeState {
  checkedAt: string;
  projectExists: boolean;
  unityProjectValid: boolean;
  projectOpen: boolean;
  bridgeInstalled: boolean;
  detectedDimension?: EngineProjectDimension;
  availableResourceUris?: string[];
  activeSceneSummary?: string;
  currentSelectionSummary?: string;
  recentConsoleSummary?: string;
  recentBridgeLogs?: string;
  mcpSettings?: {
    enabled: boolean;
    port: number;
    toolExportProfile: string;
    url: string;
  };
  bridgeHealth?: UnityHealthResult;
}

export interface ProjectBlueprint {
  premise: string;
  playerFantasy: string;
  targetAudience: string;
  artDirection: string;
  coreLoop: string[];
  pillars: string[];
  differentiators: string[];
}

export interface TaskItem {
  id: string;
  title: string;
  phase: TaskPhase;
  status: TaskStatus;
  owner: string;
  description: string;
}

export interface AssetItem {
  id: string;
  name: string;
  type: AssetType;
  status: AssetStatus;
  prompt: string;
  notes: string;
}

export interface ProjectMemoryFileSummary {
  path: string;
  title: string;
  kind: ProjectMemoryFileKind;
  memoryKinds: ProjectMemoryEntryKind[];
  tags: string[];
  excerpt: string;
  size: number;
  lineCount: number;
  updatedAt: string;
}

export interface ProjectMemoryFileContent extends ProjectMemoryFileSummary {
  content: string;
}

export interface ClaudeContextSummaryCoverage {
  version: number;
  strategy: 'provider' | 'extractive';
  sourceRuntimeSessionId?: string;
  fromMessageId?: string;
  toMessageId?: string;
  boundaryRowId?: number;
  boundaryOrdinal?: number;
  coveredMessageCount?: number;
  summaryInputMessageIds?: string[];
  messageCount: number;
  turnCount: number;
  generatedAt: string;
  audit?: ContextSummaryAudit;
}

export interface NativeContextSummaryCoverage {
  version: number;
  strategy: 'provider' | 'extractive';
  fromMessageId?: string;
  toMessageId?: string;
  boundaryRowId?: number;
  boundaryOrdinal?: number;
  coveredMessageCount?: number;
  summaryInputMessageIds?: string[];
  messageCount: number;
  turnCount: number;
  generatedAt: string;
  audit?: ContextSummaryAudit;
}

export interface ContextSummaryAudit {
  generatedAt: string;
  sourceMessageIds: string[];
  decisions: string[];
  constraints: string[];
  openTasks: string[];
}

export interface SessionWritePermissionGrant {
  tools: string[];
  mcpTools?: string[];
  grantedAt: number;
  expiresAt: number;
  runtimeId?: ProjectSessionRuntimeId;
  cwd?: string;
}

export interface ProjectSession {
  id: string;
  title: string;
  autoTitle: boolean;
  createdAt: string;
  updatedAt: string;
  runtimeOverrides?: {
    runtimeId?: ProjectSessionRuntimeId;
    providerId?: string;
    model?: string;
    upstreamModel?: string;
    permissionMode?: AgentPermissionMode;
    mode?: ProjectSessionMode;
    effort?: ProjectSessionEffort;
    context1m?: boolean;
    thinking?: Record<string, unknown>;
    outputFormat?: Record<string, unknown>;
    agents?: Record<string, unknown>;
    agent?: string;
    claudeCodeSessionId?: string;
    claudeCodeSessionCwd?: string;
    claudeContextSummary?: string;
    claudeContextSummaryUpdatedAt?: string;
    claudeContextSummaryTurnCount?: number;
    claudeContextSummaryCoverage?: ClaudeContextSummaryCoverage;
    nativeContextSummary?: string;
    nativeContextSummaryUpdatedAt?: string;
    nativeContextSummaryTurnCount?: number;
    nativeContextSummaryCoverage?: NativeContextSummaryCoverage;
    claudeWriteMode?: ClaudeRuntimeWriteMode;
    sessionWritePermissionGrant?: SessionWritePermissionGrant;
  };
  chat: ChatMessage[];
}

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  createdAt: string;
}

export interface Snapshot {
  id: string;
  note: string;
  summary: string;
  createdAt: string;
  sessionCheckpoint?: {
    sessionId: string;
    sessionTitle: string;
    activeSessionId?: string;
    triggerUserMessageId?: string;
    chat: ChatMessage[];
    capturedAt: string;
  };
}

export interface SessionCheckpointPreview {
  snapshotId: string;
  sessionId: string;
  checkpointNote: string;
  checkpointCreatedAt: string;
  triggerUserMessageId?: string;
  currentMessageCount: number;
  checkpointMessageCount: number;
  addedMessages: number;
  removedMessages: number;
  currentLatestPreview?: string;
  checkpointLatestPreview?: string;
  fileChanges?: Array<{
    path: string;
    status: 'added' | 'modified' | 'removed';
    diffPreview: string;
  }>;
  skippedFileChanges?: string[];
}

export interface ProjectAgentAggregateState {
  runningSessionCount: number;
  queuedSessionCount: number;
  pendingApprovalCount: number;
  failedSessionCount: number;
  resumableRunCount: number;
  lastActiveSessionId?: string;
  lastActiveAt?: string;
}

export interface ProjectAgentSkill {
  id: string;
  name: string;
  description?: string;
  trigger?: string;
  instruction: string;
  enabled: boolean;
  source?: 'custom' | 'funplay-skill';
  sourceId?: string;
  sourcePath?: string;
  repositoryUrl?: string;
  repositoryRef?: string;
  version?: string;
  dependencies?: string[];
  examples?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAgentPolicy {
  permissionMode?: AgentPermissionMode;
  skills?: ProjectAgentSkill[];
  updatedAt?: string;
}

export interface ProjectFileTreeChangedEvent {
  projectId: string;
  projectPath: string;
  changedAt: string;
}

export interface AgentTaskGraphNode {
  id: string;
  kind: AgentTaskGraphNodeKind;
  title: string;
  status: AgentTaskGraphNodeStatus;
  dependsOn?: string[];
  successCriteria?: AgentTaskSuccessCriterion[];
  rollbackStrategy?: AgentTaskRollbackStrategy;
  subagentTasks?: AgentTaskSubagentRecord[];
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  errorMessage?: string;
  timelineEntryIds?: string[];
  verificationCheckIds?: string[];
}

export interface AgentTaskSuccessCriterion {
  id: string;
  description: string;
  status: AgentTaskSuccessCriterionStatus;
  evidence?: string;
  updatedAt?: string;
}

export interface AgentTaskRollbackStrategy {
  kind: 'none' | 'checkpoint' | 'manual';
  summary: string;
  checkpointSnapshotId?: string;
  changedFiles?: string[];
  updatedAt?: string;
}

export interface AgentTaskSubagentRecord {
  id: string;
  toolUseId: string;
  mode: AgentTaskSubagentMode;
  task: string;
  scope?: string;
  expectedOutput?: string;
  maxSteps?: number;
  status: AgentTaskSubagentStatus;
  readOnly: true;
  resultPreview?: string;
  updatedAt: string;
}

export interface AgentTaskGraph {
  id: string;
  runId: string;
  goal: string;
  status: AgentTaskGraphStatus;
  createdAt: string;
  updatedAt: string;
  currentNodeId?: string;
  nodes: AgentTaskGraphNode[];
}

export interface AgentVerificationCheck {
  id: string;
  kind: AgentVerificationCheckKind;
  title: string;
  status: AgentVerificationStatus;
  command?: string;
  cwd?: string;
  target?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  outputPreview?: string;
  errorMessage?: string;
  timelineEntryIds?: string[];
  toolUseIds?: string[];
  browser?: AgentToolBrowserResult;
  artifacts?: AgentToolArtifact[];
}

export interface AgentVerificationReport {
  id: string;
  runId?: string;
  status: AgentVerificationStatus;
  createdAt: string;
  updatedAt: string;
  checks: AgentVerificationCheck[];
  summary?: string;
}

export interface GameAgentStep {
  id: string;
  kind: GameAgentStepKind;
  title: string;
  detail: string;
  status: GameAgentStepStatus;
}

export interface GameAgentPluginReport {
  pluginId?: string;
  pluginName: string;
  kind: McpPluginKind;
  status: GameAgentPluginReportStatus;
  resourceReads: string[];
  toolCalls: string[];
  observations: string[];
}

export interface GameAgentAction {
  id: string;
  pluginKind: McpPluginKind;
  pluginId?: string;
  title: string;
  objective: string;
  suggestedTools: string[];
  inputs: string[];
  operations: Array<{
    type: GameAgentOperationType;
    target: string;
    arguments?: Record<string, unknown>;
  }>;
  successCriteria: string[];
  status: GameAgentActionStatus;
  executedTools?: string[];
  readResources?: string[];
  outputSummary?: string;
  errorMessage?: string;
  lastRunAt?: string;
  repairSummary?: string;
  rollbackSummary?: string;
}

export interface GameAgentExecutionPlan {
  summary: string;
  rationale: string;
  actions: GameAgentAction[];
  lastExecutedAt?: string;
}

export interface AgentOperationRecord {
  id: string;
  scope: 'conversation' | 'execution-plan';
  phase?: string;
  title: string;
  pluginKind?: McpPluginKind;
  pluginId?: string;
  target: string;
  type: GameAgentOperationType | 'tool_call';
  input?: Record<string, unknown>;
  status: AgentOperationStatus;
  summary?: string;
  errorMessage?: string;
  transaction?: import('./agent').AgentToolTransactionSummary;
  startedAt?: string;
  finishedAt?: string;
}

export interface GameAgentRun {
  id: string;
  mode: GameAgentRunMode;
  input: string;
  status: 'completed' | 'fallback' | 'failed';
  usedProviderId?: string;
  usedModel?: string;
  startedAt: string;
  finishedAt: string;
  steps: GameAgentStep[];
  pluginReports: GameAgentPluginReport[];
  executionPlan?: GameAgentExecutionPlan;
  operationLog?: AgentOperationRecord[];
}

export interface ProjectMemory {
  designDirectives: string[];
  artDirectives: string[];
  technicalConstraints: string[];
  openQuestions: string[];
  updatedAt: string;
}

export interface ProjectContextSummary {
  projectBrief: string;
  currentGoal: string;
  recentDecisions: string[];
  activeTasks: string[];
  recentActivity: string[];
  compressedFrom: number;
  updatedAt: string;
}

export interface ProjectFileEntry {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

export interface ProjectFileContent {
  id: string;
  name: string;
  path: string;
  size?: number;
  content: string;
  isBinary: boolean;
  truncated: boolean;
  mimeType?: string;
  previewDataUrl?: string;
  documentPreview?: ProjectDocumentPreview;
}

export interface ProjectHtmlPreviewServerResult {
  success: true;
  url: string;
  sessionId: string;
  command: string;
  scriptName: string;
  reused: boolean;
  terminal?: AgentToolTerminalResult;
}

export interface ProjectHtmlPreviewServerStopResult {
  success: true;
  stopped: boolean;
  sessionId?: string;
}

export interface ProjectDocumentPreviewPage {
  index: number;
  title?: string;
  text: string;
  thumbnailDataUrl?: string;
}

export interface ProjectDocumentPreview {
  kind: 'pptx' | 'docx' | 'pdf';
  pageCount: number;
  extraction: string;
  pages: ProjectDocumentPreviewPage[];
  warning?: string;
}

export interface DeleteProjectResult {
  deletedProjectId: string;
  remainingProjects: Project[];
  deletedSourceFiles: boolean;
}

export interface Project {
  id: string;
  name: string;
  templateId: GameTemplateId;
  artStyle: string;
  pitch: string;
  status: ProjectStatus;
  engine?: ProjectEngineInfo;
  runtimeState?: ProjectRuntimeState;
  agentAggregateState?: ProjectAgentAggregateState;
  agentPolicy?: ProjectAgentPolicy;
  providerId?: string;
  model?: string;
  mcpPluginId?: string;
  mcpBindings: McpPluginBindings;
  createdAt: string;
  updatedAt: string;
  blueprint: ProjectBlueprint;
  tasks: TaskItem[];
  assets: AssetItem[];
  sessions: ProjectSession[];
  activeSessionId?: string;
  chat: ChatMessage[];
  activity: ActivityItem[];
  snapshots: Snapshot[];
  memory: ProjectMemory;
  contextSummary: ProjectContextSummary;
  lastAgentRun?: GameAgentRun;
  currentExecutionPlan?: GameAgentExecutionPlan;
  lastExecutedPlan?: GameAgentExecutionPlan;
}
