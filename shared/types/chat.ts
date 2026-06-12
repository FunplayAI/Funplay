import type { RuntimeDiagnosticSeverity, RuntimeRecoveryAction } from './diagnostics';

export type ChatRole = 'user' | 'assistant';
export type ChatMessageIntent = 'chat' | 'fallback';
export type ChatContentBlockType = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'fallback';
export type ChatMediaBlockType = 'image' | 'audio' | 'file';
export type PromptAttachmentKind = 'image' | 'file';

export interface ChatMediaBlock {
  type: ChatMediaBlockType;
  mimeType?: string;
  data?: string;
  localPath?: string;
  mediaId?: string;
  title?: string;
}

export interface AgentToolChangedFile {
  path: string;
  operation: 'created' | 'modified' | 'directory_created' | 'patched' | 'restored' | 'failed';
  size?: number;
  replacementCount?: number;
  addedLines?: number;
  removedLines?: number;
  hunkCount?: number;
  error?: string;
}

export interface AgentToolCommandResult {
  command: string;
  cwd: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  outputTruncated?: boolean;
}

export interface AgentToolTerminalResult {
  sessionId?: string;
  name?: string;
  status?: string;
  nextSeq?: number;
  cwd?: string;
  command?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  serviceKind?: 'shell' | 'dev-server' | 'test-runner';
  detectedPorts?: number[];
  outputChunkCount?: number;
  totalOutputChars?: number;
  logTail?: string;
}

export interface AgentToolBrowserResult {
  sessionId?: string;
  url?: string;
  title?: string;
  viewport?: {
    width: number;
    height: number;
  };
  screenshotPath?: string;
  consoleMessageCount?: number;
}

export interface AgentToolEditMetrics {
  strategy: 'write_file' | 'search_replace' | 'multi_edit' | 'unified_patch' | 'checkpoint_rollback';
  patchFirst: boolean;
  preflight: 'passed' | 'failed' | 'not_applicable';
  changedFileCount?: number;
  replacementCount?: number;
  editCount?: number;
  hunkCount?: number;
  addedLines?: number;
  removedLines?: number;
  failureKind?: 'missing_match' | 'ambiguous_match' | 'invalid_patch' | 'path_error' | 'unknown';
  recoveryHint?: string;
}

export interface AgentToolMcpResult {
  pluginId?: string;
  pluginKind?: string;
  operation: 'list_tools' | 'list_resources' | 'read_resource' | 'call_tool';
  target: string;
  exposedName?: string;
  policySummary?: string;
  /** Structured read-only flag from the resolved MCP tool policy; authoritative over policySummary text. */
  readOnly?: boolean;
  timeoutMs: number;
  argsSize?: number;
  contentPartCount?: number;
  schemaGuard: 'passed' | 'failed';
  failureKind?:
    | 'missing_plugin'
    | 'invalid_uri'
    | 'invalid_tool_name'
    | 'args_too_large'
    | 'permission_denied'
    | 'timeout'
    | 'unknown';
}

export interface AgentToolArtifact {
  type: 'file' | 'image' | 'browser_screenshot' | 'terminal' | 'command_output';
  path?: string;
  title?: string;
  mimeType?: string;
  size?: number;
}

export interface PromptAttachment {
  id: string;
  name: string;
  path: string;
  relativePath?: string;
  mimeType?: string;
  kind: PromptAttachmentKind;
  size: number;
  previewDataUrl?: string;
}

export interface PromptAttachmentImportItem {
  name?: string;
  path?: string;
  mimeType?: string;
  size?: number;
  dataUrl?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  ordinal?: number;
  storageRowId?: number;
  metadata?: ChatMessageMetadata;
}

export type ChatContentBlock =
  | {
      id?: string;
      type: 'text';
      text: string;
    }
  | {
      id?: string;
      type: 'thinking';
      thinking: string;
      title?: string;
    }
  | {
      id?: string;
      type: 'tool_use';
      toolUseId: string;
      name: string;
      title?: string;
      summary?: string;
      activity?: string;
      input?: Record<string, unknown>;
      status?: 'pending' | 'running' | 'completed' | 'failed';
    }
  | {
      id?: string;
      type: 'tool_result';
      toolUseId: string;
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
      transaction?: import('./agent').AgentToolTransactionSummary;
    }
  | {
      id?: string;
      type: 'fallback';
      text: string;
      reason?: string;
    };

export interface ChatMessageProcessActivity {
  id: string;
  type: 'tool' | 'stage' | 'context' | 'timeout';
  offset: number;
  status: 'running' | 'completed' | 'failed';
  title: string;
  summary?: string;
  toolUseIds?: string[];
  stageId?: string;
  transaction?: import('./agent').AgentToolTransactionSummary;
  createdAt: string;
}

export interface ChatMessageMetadata {
  intent?: ChatMessageIntent;
  activitySummary?: string;
  executionSummary?: string;
  promptAttachments?: PromptAttachment[];
  agentStartedAt?: string;
  agentFinishedAt?: string;
  operationLog?: import('./project').AgentOperationRecord[];
  agentProcessText?: string;
  agentProcessActivities?: ChatMessageProcessActivity[];
  agentCoreParts?: import('./agent-core').AgentCoreMessagePart[];
  tokenUsage?: import('./agent').RuntimeUsageTotals;
  taskTitles?: string[];
  assetNames?: string[];
  diagnosticCode?: string;
  severity?: RuntimeDiagnosticSeverity;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
}
