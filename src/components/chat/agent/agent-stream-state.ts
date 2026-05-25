import type {
  AgentCoreMessagePart,
  AgentPermissionImpact,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentUserInputOption,
  ChatMediaBlock,
  ProjectSessionRuntimeId,
  RuntimeRecoveryAction
} from '../../../../shared/types';

export interface AgentPromptStreamState {
  streamId: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  content: string;
  thinkingContent: string;
  toolUses: Array<{
    toolUseId: string;
    name: string;
    title?: string;
    summary?: string;
    activity?: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }>;
  toolResults: Array<{
    toolUseId: string;
    content: string;
    isError?: boolean;
    media?: ChatMediaBlock[];
    changedFiles?: AgentToolChangedFile[];
    browser?: AgentToolBrowserResult;
    edit?: AgentToolEditMetrics;
    mcp?: AgentToolMcpResult;
    artifacts?: AgentToolArtifact[];
  }>;
  stages: Array<{
    stageId: string;
    phase?: string;
    title: string;
    target: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    input?: Record<string, unknown>;
    summary?: string;
    errorMessage?: string;
    runtimeId?: ProjectSessionRuntimeId;
    providerId?: string;
    model?: string;
    errorCode?: string;
    suggestedAction?: string;
    recoveryActions?: RuntimeRecoveryAction[];
  }>;
  activityItems: Array<{
    id: string;
    type: 'tool' | 'stage' | 'context' | 'timeout';
    offset: number;
    status: 'running' | 'completed' | 'failed';
    title: string;
    summary?: string;
    toolUseIds?: string[];
    stageId?: string;
    createdAt: string;
  }>;
  agentCoreParts?: AgentCoreMessagePart[];
  pendingPermission?: {
    requestId: string;
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    impact?: AgentPermissionImpact;
  };
  pendingUserInput?: {
    requestId: string;
    title: string;
    question: string;
    detail?: string;
    options?: AgentUserInputOption[];
    multiSelect?: boolean;
    allowFreeText?: boolean;
    placeholder?: string;
  };
  phase: string;
  statusMessage: string;
  startedAt: string;
}
