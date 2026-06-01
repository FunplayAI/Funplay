import type {
  AgentOperationRecord,
  AgentOperationStatus,
  AgentCoreMessagePart,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolCommandResult,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTerminalResult,
  AgentToolTransactionSummary,
  AgentRuntimeResumeContext,
  AgentLifecycleHookConfig,
  AgentLifecycleHookEvaluationResult,
  AgentUserInputOption,
  AgentUserInputResponse,
  AgentPermissionImpact,
  PromptAttachment,
  AiProvider,
  AgentPermissionMode,
  ClaudeRuntimeWriteMode,
  AppState,
  ChatMessageMetadata,
  ChatMediaBlock,
  ChatMessageIntent,
  GameAgentRun,
  GameAgentStep,
  McpPlugin,
  ProjectSession,
  ProjectSessionRuntimeId,
  Project,
  RuntimeDiagnosticSeverity,
  RuntimeRecoveryAction,
  RuntimeUsage,
  AgentSkillActivation,
  AgentSkillIndexEntry
} from '../../../shared/types';

export type GenericAgentTaskKind = 'bootstrap' | 'conversation';
export type GenericAgentPhase = 'thinking' | 'streaming';
export type GenericAgentRuntimeId = ProjectSessionRuntimeId;
export type GenericAgentRuntimeOutputEvent =
  | {
      type: 'status';
      phase: GenericAgentPhase;
      message: string;
    }
  | {
      type: 'text_delta';
      delta: string;
      accumulated: string;
    }
  | {
      type: 'thinking_delta';
      delta: string;
      accumulated: string;
    }
  | {
      type: 'tool_use';
      tool: {
        toolUseId: string;
        name: string;
        title?: string;
        summary?: string;
        activity?: string;
        input?: Record<string, unknown>;
        status: 'pending' | 'running' | 'completed' | 'failed';
      };
    }
  | {
      type: 'tool_result';
      result: {
        toolUseId: string;
        toolName?: string;
        content: string;
        isError?: boolean;
        media?: ChatMediaBlock[];
        changedFiles?: AgentToolChangedFile[];
        command?: AgentToolCommandResult;
        terminal?: AgentToolTerminalResult;
        browser?: AgentToolBrowserResult;
        edit?: AgentToolEditMetrics;
        mcp?: AgentToolMcpResult;
        artifacts?: AgentToolArtifact[];
        transaction?: AgentToolTransactionSummary;
      };
    }
  | {
      type: 'stage';
      stage: {
        stageId: string;
        phase?: string;
        title: string;
        target: string;
        status: AgentOperationStatus;
        input?: Record<string, unknown>;
        summary?: string;
        errorMessage?: string;
        runtimeId?: ProjectSessionRuntimeId;
        providerId?: string;
        model?: string;
        upstreamModel?: string;
        diagnosticCode?: string;
        severity?: RuntimeDiagnosticSeverity;
        errorCode?: string;
        suggestedAction?: string;
        recoveryActions?: RuntimeRecoveryAction[];
        transaction?: AgentToolTransactionSummary;
      };
    }
  | {
      type: 'permission_request';
      request: {
        requestId: string;
        title: string;
        detail: string;
        risk: 'low' | 'medium' | 'high';
        toolName?: string;
        impact?: AgentPermissionImpact;
      };
    }
  | {
      type: 'user_input_request';
      request: {
        requestId: string;
        title: string;
        question: string;
        detail?: string;
        options?: AgentUserInputOption[];
        multiSelect?: boolean;
        allowFreeText?: boolean;
        placeholder?: string;
        toolName?: string;
      };
    }
  | {
      type: 'usage';
      usage: RuntimeUsage;
    }
  | {
      type: 'lifecycle_hook';
      hook: AgentLifecycleHookEvaluationResult;
    }
  | {
      type: 'agent_core_parts';
      parts: AgentCoreMessagePart[];
    };
export type GenericAgentRuntimeCapabilityKey =
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

export interface GenericAgentRuntimeCapabilities {
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

export interface GenericAgentToolContext {
  plugins: Array<{
    id: string;
    name: string;
    kind: McpPlugin['kind'];
    enabled: boolean;
    hasEndpoint: boolean;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description?: string;
    trigger?: string;
    instruction: string;
    enabled: boolean;
    source?: string;
    sourceId?: string;
    dependencies?: string[];
    examples?: string[];
  }>;
  skillIndex: AgentSkillIndexEntry[];
  activeSkills: AgentSkillActivation[];
}

export interface GenericProjectContextIndex {
  generatedAt: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  manifests: Array<{
    path: string;
    kind: 'node' | 'unity';
    name?: string;
  }>;
  scripts: Array<{
    name: string;
    command: string;
    source: string;
  }>;
  testCommands: Array<{
    name: string;
    command: string;
    source: string;
  }>;
  dependencies: Array<{
    name: string;
    version: string;
    kind: 'runtime' | 'dev' | 'peer' | 'unity';
    source: string;
  }>;
  entrypoints: Array<{
    path: string;
    reason: string;
  }>;
  configFiles: string[];
  recentFiles: Array<{
    path: string;
    status: string;
  }>;
  truncated?: boolean;
}

export interface GenericAgentWorkspaceContext {
  projectId: string;
  projectName: string;
  projectPath?: string;
  platform?: string;
  runtimeEnvironment?: {
    workingDirectory?: string;
    platform: NodeJS.Platform;
    shell?: string;
    currentDate: string;
    timezone?: string;
    isGitRepository?: boolean;
    git?: {
      root?: string;
      branch?: string;
      user?: string;
      status?: string;
      statusTruncated?: boolean;
      recentCommits?: string;
      recentCommitsTruncated?: boolean;
    };
  };
  projectBrief?: string;
  currentGoal?: string;
  projectContextIndex?: GenericProjectContextIndex;
  runtimeSummary?: string;
  executionPlanSummary?: string;
  activeSessionId?: string;
  sessionMode?: import('../../../shared/types').ProjectSessionMode;
  sessionEffort?: import('../../../shared/types').ProjectSessionEffort;
  archivedTurnCount: number;
  archivedSummary?: string;
  recentTurns: Array<{
    id: string;
    startedAt: string;
    userMessage?: string;
    assistantMessages: Array<{
      id: string;
      content: string;
      createdAt: string;
      intent?: ChatMessageIntent;
    }>;
  }>;
  recentMessages: Array<{
    role: string;
    content: string;
    createdAt: string;
  }>;
  crossSessionSummaries: Array<{
    sessionId: string;
    title: string;
    updatedAt: string;
    messageCount: number;
    latestSummary: string;
    source?: string;
    truncated?: boolean;
  }>;
  relatedSessionEvidence: Array<{
    sessionId: string;
    title: string;
    matchedTerm: string;
    excerpt: string;
    source?: string;
    truncated?: boolean;
  }>;
  workspaceEvidence?: Array<{
    kind: 'message_path' | 'recent_file' | 'entrypoint' | 'session_summary' | 'related_session' | 'verification_failure_file';
    source: string;
    path?: string;
    title?: string;
    excerpt: string;
    truncated?: boolean;
  }>;
  projectInstructions: Array<{
    path: string;
    content: string;
    truncated?: boolean;
  }>;
  toolContext: GenericAgentToolContext;
}

export interface GenericAgentRuntimeParams {
  project: Project;
  message: string;
  attachments?: PromptAttachment[];
  uiLanguage?: 'zh-CN' | 'en-US';
  provider?: AiProvider;
  plugins: McpPlugin[];
  context: GenericAgentWorkspaceContext;
  appState?: AppState;
  persistAppState?: (state: AppState) => Promise<void>;
  permission: {
    mode: AgentPermissionMode;
    allowWriteTools: boolean;
    allowSessionWriteTools: boolean;
    allowedWriteTools?: string[];
    allowedMcpTools?: string[];
  };
  activeRunId?: string;
  lifecycleHooks?: AgentLifecycleHookConfig;
  lifecycleHookContext?: string[];
  turnId?: string;
  resumeContext?: AgentRuntimeResumeContext;
  checkpointSnapshotId?: string;
  abortSignal?: AbortSignal;
  nativeContextRetryAttempted?: boolean;
  emitRuntimeEvent?: (event: GenericAgentRuntimeOutputEvent) => void;
  onStatus?: (phase: GenericAgentPhase, message: string) => void;
  onTextDelta?: (delta: string, accumulated: string) => void;
  onThinkingDelta?: (delta: string, accumulated: string) => void;
  onToolUse?: (tool: {
    toolUseId: string;
    name: string;
    title?: string;
    summary?: string;
    activity?: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }) => void;
  onToolResult?: (result: {
    toolUseId: string;
    toolName?: string;
    content: string;
    isError?: boolean;
    media?: ChatMediaBlock[];
    changedFiles?: AgentToolChangedFile[];
    command?: AgentToolCommandResult;
    terminal?: AgentToolTerminalResult;
    browser?: AgentToolBrowserResult;
    edit?: AgentToolEditMetrics;
    mcp?: AgentToolMcpResult;
    artifacts?: AgentToolArtifact[];
    transaction?: AgentToolTransactionSummary;
  }) => void;
  onStage?: (stage: {
    stageId: string;
    phase?: string;
    title: string;
    target: string;
    status: AgentOperationStatus;
    input?: Record<string, unknown>;
    summary?: string;
    errorMessage?: string;
    runtimeId?: ProjectSessionRuntimeId;
    providerId?: string;
    model?: string;
    upstreamModel?: string;
    diagnosticCode?: string;
    severity?: RuntimeDiagnosticSeverity;
    errorCode?: string;
    suggestedAction?: string;
    recoveryActions?: RuntimeRecoveryAction[];
    transaction?: AgentToolTransactionSummary;
  }) => void;
  onPermissionRequest?: (request: {
    requestId: string;
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    toolName?: string;
    impact?: AgentPermissionImpact;
  }) => void;
  requestPermission?: (request: {
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    toolName?: string;
    impact?: AgentPermissionImpact;
  }) => Promise<'allow' | 'allow_session' | 'deny'>;
  onUserInputRequest?: (request: {
    requestId: string;
    title: string;
    question: string;
    detail?: string;
    options?: AgentUserInputOption[];
    multiSelect?: boolean;
    allowFreeText?: boolean;
    placeholder?: string;
    toolName?: string;
  }) => void;
  requestUserInput?: (request: {
    title?: string;
    question: string;
    detail?: string;
    options?: AgentUserInputOption[];
    multiSelect?: boolean;
    allowFreeText?: boolean;
    placeholder?: string;
    toolName?: string;
  }) => Promise<AgentUserInputResponse>;
  onUsage?: (usage: RuntimeUsage) => void;
  onAgentCoreParts?: (parts: AgentCoreMessagePart[]) => void;
  onLifecycleHook?: (hook: AgentLifecycleHookEvaluationResult) => void;
}

export interface GenericAgentRuntimeResult {
  assistantMessage: string;
  assistantMetadata?: Partial<ChatMessageMetadata>;
  assistantIntent: ChatMessageIntent;
  fallbackDetail?: string;
  status: GameAgentRun['status'];
  operationLog?: AgentOperationRecord[];
  usedProviderId?: string;
  usedModel?: string;
  diagnosticCode?: string;
  severity?: RuntimeDiagnosticSeverity;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
  sessionRuntimePatch?: Partial<NonNullable<ProjectSession['runtimeOverrides']>>;
  effectiveCapabilities?: Partial<GenericAgentRuntimeCapabilities> & {
    claudeWriteMode?: ClaudeRuntimeWriteMode;
  };
  steps: GameAgentStep[];
}

export type GenericAgentRuntimeStreamEvent =
  | GenericAgentRuntimeOutputEvent
  | {
      type: 'result';
      result: GenericAgentRuntimeResult;
    };

export interface GenericAgentRuntime {
  id: GenericAgentRuntimeId;
  displayName: string;
  description: string;
  capabilities: GenericAgentRuntimeCapabilities;
  isAvailable: () => boolean;
  interrupt: (runIdOrSessionId: string) => void;
  dispose: () => void;
  executeEventStream: (params: GenericAgentRuntimeParams) => AsyncIterable<GenericAgentRuntimeStreamEvent>;
}

export interface GenericAgentTaskBase {
  kind: GenericAgentTaskKind;
  project: Project;
  provider?: AiProvider;
  mcpPlugins?: McpPlugin[];
  enginePlugin?: McpPlugin;
  assetPlugin?: McpPlugin;
  qaPlugin?: McpPlugin;
  customPlugin?: McpPlugin;
}

export interface GenericAgentBootstrapTask extends GenericAgentTaskBase {
  kind: 'bootstrap';
  input: import('../../../shared/types').CreateProjectInput;
}

export interface GenericAgentConversationTask extends GenericAgentTaskBase {
  kind: 'conversation';
  appState?: AppState;
  persistAppState?: (state: AppState) => Promise<void>;
  activeRunId?: string;
  sessionId?: string;
  userMessageId?: string;
  checkpointSnapshotId?: string;
  message: string;
  displayMessage?: string;
  attachments?: PromptAttachment[];
  uiLanguage?: 'zh-CN' | 'en-US';
  resumeContext?: AgentRuntimeResumeContext;
  abortSignal?: AbortSignal;
  onStatus?: (phase: GenericAgentPhase, message: string) => void;
  onTextDelta?: (delta: string, accumulated: string) => void;
  onThinkingDelta?: (delta: string, accumulated: string) => void;
  onToolUse?: GenericAgentRuntimeParams['onToolUse'];
  onToolResult?: GenericAgentRuntimeParams['onToolResult'];
  onStage?: GenericAgentRuntimeParams['onStage'];
  onPermissionRequest?: GenericAgentRuntimeParams['onPermissionRequest'];
  requestPermission?: GenericAgentRuntimeParams['requestPermission'];
  onUserInputRequest?: GenericAgentRuntimeParams['onUserInputRequest'];
  requestUserInput?: GenericAgentRuntimeParams['requestUserInput'];
  onUsage?: GenericAgentRuntimeParams['onUsage'];
  onAgentCoreParts?: GenericAgentRuntimeParams['onAgentCoreParts'];
}

export type GenericAgentTask = GenericAgentBootstrapTask | GenericAgentConversationTask;
