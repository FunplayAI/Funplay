import type {
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTransactionSummary,
  ChatContentBlock,
  ChatMediaBlock,
  ChatMessageProcessActivity,
  ProjectSessionRuntimeId,
  RuntimeRecoveryAction
} from '../../../../shared/types';

export interface ToolExecutionEntry {
  id: string;
  name: string;
  title?: string;
  summary?: string;
  activity?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input?: Record<string, unknown>;
  result?: {
    content: string;
    isError?: boolean;
    media?: ChatMediaBlock[];
    changedFiles?: AgentToolChangedFile[];
    browser?: AgentToolBrowserResult;
    edit?: AgentToolEditMetrics;
    mcp?: AgentToolMcpResult;
    artifacts?: AgentToolArtifact[];
    transaction?: AgentToolTransactionSummary;
  };
}

export interface StageExecutionEntry {
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
  transaction?: AgentToolTransactionSummary;
}

export type StreamActivityEntry = ChatMessageProcessActivity;

export interface WebCitationEntry {
  id: string;
  title: string;
  url: string;
  provider?: string;
  snippet?: string;
  publishedAt?: string;
  description?: string;
}

export type RenderableChatEntry =
  | {
      type: 'block';
      block: ChatContentBlock;
      key: string;
    }
  | {
      type: 'tool';
      tool: ToolExecutionEntry;
      key: string;
    };

export type ToolActivityKind = 'read' | 'search' | 'write' | 'command' | 'mcp' | 'task' | 'other';
