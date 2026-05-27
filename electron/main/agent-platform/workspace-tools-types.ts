import { stat, readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolCommandResult,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTerminalResult,
  AgentUserInputOption,
  AgentUserInputResponse,
  AppNotificationPriority,
  AppState,
  AssetGenerationKind,
  ChatMediaBlock,
  EngineProjectDimension,
  EnvironmentActionKind,
  McpPlugin,
  McpPluginKind,
  PlatformChoice,
  Project,
  ProjectMemoryEntryKind,
  ProjectSetupMode,
  ScheduledNotificationTaskType
} from '../../../shared/types';
import { resolveProjectRootPathForProject } from '../project-file-service';
import type { WebSearchProvider } from './web-research-service';

export const MAX_TREE_ITEMS = 80;
export const MAX_FILE_PREVIEW_CHARS = 4000;
export const MAX_SEARCH_RESULTS = 8;
export const MAX_DIRECTORY_ITEMS = 18;
export const MAX_WRITE_OPERATIONS = 5;
export const MAX_FIND_FILE_RESULTS = 120;
export const MAX_PROJECT_SEARCH_RESULTS = 50;
export const MAX_READ_RANGE_LINES = 2000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_OUTPUT_CHARS = 64_000;
export const MAX_MEMORY_SEARCH_RESULTS = 10;
export const MAX_MEMORY_TOOL_CHARS = 12_000;
export const RECENT_MEMORY_DAYS = 3;
export const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 20_000;
export const DEFAULT_DOCUMENT_CHARS = 12_000;
export const MAX_ZIP_TEXT_BYTES = 2 * 1024 * 1024;
export const MEDIA_MIME_BY_EXTENSION = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.json', 'application/json'],
  ['.txt', 'text/plain']
]);
export const MEDIA_EXTENSION_BY_MIME = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/svg+xml', '.svg'],
  ['audio/wav', '.wav'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['application/json', '.json'],
  ['text/plain', '.txt']
]);

export interface WorkspaceWriteOperation {
  type: 'write_file';
  path: string;
  content: string;
  reason?: string;
}

export interface WorkspaceWriteResult {
  path: string;
  size: number;
  success: boolean;
  error?: string;
}

export type WorkspaceToolAction =
  | {
      type: 'ask_user';
      title?: string;
      question: string;
      detail?: string;
      options?: Array<{
        id?: string;
        label: string;
        description?: string;
      }>;
      multiSelect?: boolean;
      allowFreeText?: boolean;
      placeholder?: string;
    }
  | {
      type: 'update_todo_list';
      items: Array<{
        id?: string;
        content: string;
        status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
        priority?: 'high' | 'medium' | 'low';
      }>;
    }
  | {
      type: 'scan_file_tree';
    }
  | {
      type: 'read_file';
      path: string;
      offset?: number;
      limit?: number;
      pages?: string;
    }
  | {
      type: 'read_document';
      path: string;
      pages?: string;
      maxChars?: number;
    }
  | {
      type: 'find_files';
      pattern: string;
      path?: string;
      maxResults?: number;
    }
  | {
      type: 'search_project_content';
      query: string;
      regex?: boolean;
      glob?: string;
      path?: string;
      outputMode?: 'content' | 'files_with_matches' | 'count';
      contextBefore?: number;
      contextAfter?: number;
      caseInsensitive?: boolean;
      fileType?: string;
      limit?: number;
      offset?: number;
    }
  | {
      type: 'web_search';
      query: string;
      maxResults?: number;
      domains?: string[];
      blockedDomains?: string[];
      preferOfficial?: boolean;
      provider?: WebSearchProvider;
    }
  | {
      type: 'web_fetch';
      url: string;
      maxChars?: number;
    }
  | {
      type: 'media_attach_file';
      filePath: string;
      title?: string;
    }
  | {
      type: 'media_save_base64';
      dataBase64: string;
      mimeType?: string;
      fileName?: string;
      title?: string;
    }
  | {
      type: 'image_generate';
      prompt: string;
      size?: '1024x1024' | '1024x1536' | '1536x1024';
      model?: string;
      fileName?: string;
      title?: string;
    }
  | {
      type: 'list_asset_generation_capabilities';
      kind?: AssetGenerationKind;
    }
  | {
      type: 'generate_asset';
      title: string;
      kind: AssetGenerationKind;
      prompt: string;
      negativePrompt?: string;
      providerId?: string;
      count?: number;
      width?: number;
      height?: number;
      durationSeconds?: number;
      transparentBackground?: boolean;
      reason?: string;
    }
  | {
      type: 'import_generated_asset';
      jobId: string;
      reason?: string;
    }
  | {
      type: 'summarize_directory';
      path: string;
    }
  | {
      type: 'inspect_game_project';
    }
  | {
      type: 'diagnose_engine_status';
      platform?: PlatformChoice;
      mode?: ProjectSetupMode;
      dimension?: EngineProjectDimension;
      projectName?: string;
      projectPath?: string;
      enginePluginId?: string;
      unityEditorVersion?: string;
    }
  | {
      type: 'refresh_engine_runtime_state';
      platform?: PlatformChoice;
      projectPath?: string;
    }
  | {
      type: 'open_engine_hub';
      platform?: PlatformChoice;
      reason?: string;
    }
  | {
      type: 'open_engine_project';
      platform?: PlatformChoice;
      projectPath?: string;
      reason?: string;
    }
  | {
      type: 'install_engine_bridge';
      platform?: PlatformChoice;
      projectPath?: string;
      reason?: string;
    }
  | {
      type: 'run_engine_environment_action';
      actionId: EnvironmentActionKind;
      platform?: PlatformChoice;
      mode?: ProjectSetupMode;
      dimension?: EngineProjectDimension;
      projectName?: string;
      projectPath?: string;
      enginePluginId?: string;
      unityEditorVersion?: string;
      reason?: string;
    }
  | {
      type: 'list_agent_skills';
      query?: string;
    }
  | {
      type: 'read_agent_skill';
      skillId?: string;
      skillName?: string;
    }
  | {
      type: 'list_agent_skill_files';
      skillId?: string;
      skillName?: string;
    }
  | {
      type: 'read_agent_skill_file';
      skillId?: string;
      skillName?: string;
      filePath: string;
    }
  | {
      type: 'create_directory';
      path: string;
      reason?: string;
    }
  | {
      type: 'write_file';
      path: string;
      content: string;
      reason?: string;
    }
  | {
      type: 'edit_file';
      path: string;
      oldText: string;
      newText: string;
      replaceAll?: boolean;
      reason?: string;
    }
  | {
      type: 'multi_edit';
      path: string;
      edits: Array<{
        oldText: string;
        newText: string;
        replaceAll?: boolean;
      }>;
      reason?: string;
    }
  | {
      type: 'preview_file_diff';
      path: string;
      content: string;
    }
  | {
      type: 'preview_patch';
      path: string;
      patch: string;
    }
  | {
      type: 'patch_file';
      path: string;
      patch: string;
      reason?: string;
    }
  | {
      type: 'run_command';
      command: string;
      cwd?: string;
      timeoutMs?: number;
      reason?: string;
    }
  | {
      type: 'terminal_start';
      name?: string;
      command?: string;
      cwd?: string;
      reason?: string;
    }
  | {
      type: 'terminal_read';
      sessionId: string;
      sinceSeq?: number;
      maxChars?: number;
    }
  | {
      type: 'terminal_write';
      sessionId: string;
      input: string;
      appendNewline?: boolean;
      reason?: string;
    }
  | {
      type: 'terminal_list';
    }
  | {
      type: 'terminal_stop';
      sessionId: string;
      signal?: 'SIGTERM' | 'SIGINT' | 'SIGKILL';
      reason?: string;
    }
  | {
      type: 'browser_open';
      url: string;
      width?: number;
      height?: number;
      reason?: string;
    }
  | {
      type: 'browser_navigate';
      sessionId: string;
      url: string;
      reason?: string;
    }
  | {
      type: 'browser_snapshot';
      sessionId: string;
      maxTextChars?: number;
    }
  | {
      type: 'browser_screenshot';
      sessionId: string;
      fullPage?: boolean;
    }
  | {
      type: 'browser_click';
      sessionId: string;
      selector?: string;
      text?: string;
      reason?: string;
    }
  | {
      type: 'browser_type';
      sessionId: string;
      selector: string;
      text: string;
      clear?: boolean;
      reason?: string;
    }
  | {
      type: 'browser_console';
      sessionId: string;
    }
  | {
      type: 'browser_list';
    }
  | {
      type: 'browser_close';
      sessionId?: string;
      reason?: string;
    }
  | {
      type: 'checkpoint_diff';
    }
  | {
      type: 'checkpoint_rollback';
      reason?: string;
    }
  | {
      type: 'list_mcp_tools';
      pluginId?: string;
      pluginKind?: McpPluginKind;
    }
  | {
      type: 'list_mcp_resources';
      pluginId?: string;
      pluginKind?: McpPluginKind;
    }
  | {
      type: 'read_mcp_resource';
      pluginId?: string;
      pluginKind?: McpPluginKind;
      uri: string;
    }
  | {
      type: 'call_mcp_tool';
      pluginId?: string;
      pluginKind?: McpPluginKind;
      toolName: string;
      args?: Record<string, unknown>;
      exposedToolName?: string;
      mcpPolicySummary?: string;
    }
  | {
      type: 'funplay_memory_search';
      query: string;
      tags?: string[];
      fileType?: 'all' | 'daily' | 'longterm';
      memoryKind?: ProjectMemoryEntryKind | 'all';
      limit?: number;
    }
  | {
      type: 'funplay_memory_get';
      filePath: string;
      lineStart?: number;
      lineEnd?: number;
    }
  | {
      type: 'funplay_memory_recent';
    }
  | {
      type: 'funplay_memory_remember';
      note: string;
      memoryType?: 'longterm' | 'daily';
      memoryKind?: ProjectMemoryEntryKind;
      tags?: string[];
    }
  | {
      type: 'funplay_notify';
      title: string;
      body: string;
      priority?: AppNotificationPriority;
    }
  | {
      type: 'funplay_schedule_task';
      name: string;
      prompt: string;
      scheduleType: ScheduledNotificationTaskType;
      scheduleValue: string;
      priority?: AppNotificationPriority;
      notifyOnComplete?: boolean;
      durable?: boolean;
    }
  | {
      type: 'funplay_list_tasks';
      status?: 'active' | 'completed' | 'cancelled' | 'all';
    }
  | {
      type: 'funplay_cancel_task';
      taskId: string;
    }
  | {
      type: 'run_subagent';
      task: string;
      scope?: string;
      expectedOutput?: string;
      maxSteps?: number;
    }
  | {
      type: 'run_subagents';
      tasks: Array<{
        task: string;
        scope?: string;
        expectedOutput?: string;
      }>;
      maxSteps?: number;
    }
  | {
      type: 'subagent_start';
      task: string;
      name?: string;
      scope?: string;
      expectedOutput?: string;
      maxSteps?: number;
    }
  | {
      type: 'subagent_status';
      taskId?: string;
      includeCompleted?: boolean;
    };

export interface WorkspaceToolActionResult {
  ok: boolean;
  summary: string;
  isError?: boolean;
  media?: ChatMediaBlock[];
  changedFiles?: AgentToolChangedFile[];
  command?: AgentToolCommandResult;
  terminal?: AgentToolTerminalResult;
  browser?: AgentToolBrowserResult;
  edit?: AgentToolEditMetrics;
  mcp?: AgentToolMcpResult;
  artifacts?: AgentToolArtifact[];
}

export interface AgentToolExecutionOptions {
  plugins?: McpPlugin[];
  checkpointSnapshotId?: string;
  abortSignal?: AbortSignal;
  appState?: AppState;
  persistAppState?: (state: AppState) => Promise<void>;
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
}

export type TodoListAction = Extract<WorkspaceToolAction, { type: 'update_todo_list' }>;

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

export function mediaMimeForPath(filePath: string): string | undefined {
  return MEDIA_MIME_BY_EXTENSION.get(extname(filePath).toLowerCase());
}

export function mediaTypeForMime(mimeType: string | undefined): ChatMediaBlock['type'] {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('audio/')) return 'audio';
  return 'file';
}

export function isDocumentLikePath(filePath: string): boolean {
  return ['.pdf', '.rtf', '.docx', '.pptx', '.xlsx'].includes(extname(filePath).toLowerCase());
}

export function sanitizeMediaFileName(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .trim()
    .replace(/[\\/]/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

export function stripDataUrlPrefix(value: string): string {
  const marker = ';base64,';
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

export function ensureAttachmentDir(rootPath: string, name: string): string {
  return join(rootPath, '.funplay-attachments', name);
}

export function normalizeWorkspaceFilePath(filePath: string): string {
  const normalized = filePath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.endsWith('/') ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('非法文件路径。');
  }
  return normalized;
}

function resolveWorkspaceFilePath(rootPath: string, filePath: string): {
  absolutePath: string;
  relativePath: string;
} {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    throw new Error('非法文件路径。');
  }

  const absolutePath = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(rootPath, normalizeWorkspaceFilePath(filePath));
  const relativePath = relative(rootPath, absolutePath).replaceAll('\\', '/');
  if (!relativePath || relativePath === '.' || relativePath.startsWith('../') || relativePath === '..' || isAbsolute(relativePath)) {
    throw new Error('非法文件路径。');
  }
  return {
    absolutePath,
    relativePath
  };
}

function resolveReadableLocalFilePath(rootPath: string, filePath: string): {
  absolutePath: string;
  relativePath: string;
} {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    throw new Error('非法文件路径。');
  }

  if (!isAbsolute(trimmed)) {
    return resolveWorkspaceFilePath(rootPath, filePath);
  }

  const absolutePath = resolve(trimmed);
  const workspaceRelativePath = relative(rootPath, absolutePath).replaceAll('\\', '/');
  const relativePath =
    workspaceRelativePath &&
    workspaceRelativePath !== '.' &&
    !workspaceRelativePath.startsWith('../') &&
    workspaceRelativePath !== '..' &&
    !isAbsolute(workspaceRelativePath)
      ? workspaceRelativePath
      : absolutePath;

  return {
    absolutePath,
    relativePath
  };
}

export async function readWorkspaceFileBytes(project: Project, filePath: string, maxBytes: number): Promise<{
  rootPath: string;
  absolutePath: string;
  relativePath: string;
  bytes: Buffer;
  size: number;
}> {
  const rootPath = resolveProjectRootPathForProject(project);
  const { absolutePath, relativePath } = resolveReadableLocalFilePath(rootPath, filePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`目标不是文件：${relativePath}`);
  }
  if (fileStat.size > maxBytes) {
    throw new Error(`文件过大：${relativePath} (${fileStat.size} bytes)。`);
  }
  return {
    rootPath,
    absolutePath,
    relativePath,
    bytes: await readFile(absolutePath),
    size: fileStat.size
  };
}
