import type { ChildProcess } from 'node:child_process';
import type { Query as ClaudeAgentSdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  ensureProjectSessions,
  getActiveProjectSession
} from '../../../../shared/project-sessions';
import type { ProjectSession } from '../../../../shared/types';
import type { GenericAgentRuntimeParams } from '../types';

export const activeProcesses = new Map<string, ChildProcess>();
export const activeSdkQueries = new Map<string, ClaudeAgentSdkQuery>();

export const CLAUDE_ENV_MANAGED_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLOUD_ML_REGION',
  'ANTHROPIC_PROJECT_ID',
  'GEMINI_API_KEY'
];

export const CLAUDE_READ_ONLY_TOOLS = ['Task', 'Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'AskUserQuestion'] as const;
export const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'] as const;
export const CLAUDE_NATIVE_WEB_TOOLS = ['WebFetch', 'WebSearch'] as const;
export const FUNPLAY_MCP_TOOL_NAMES = [
  'funplay_memory_search',
  'funplay_memory_get',
  'funplay_memory_recent',
  'funplay_memory_remember',
  'funplay_notify',
  'funplay_schedule_task',
  'funplay_list_tasks',
  'funplay_cancel_task',
  'funplay_web_search',
  'funplay_web_fetch',
  'funplay_media_attach_file',
  'funplay_media_save_base64',
  'funplay_image_generate'
] as const;
export const FUNPLAY_MCP_SERVER_TOOL_NAMES = [
  ...FUNPLAY_MCP_TOOL_NAMES,
  'mcp__funplay-memory__funplay_memory_search',
  'mcp__funplay-memory__funplay_memory_get',
  'mcp__funplay-memory__funplay_memory_recent',
  'mcp__funplay-memory__funplay_memory_remember',
  'mcp__funplay-notify__funplay_notify',
  'mcp__funplay-notify__funplay_schedule_task',
  'mcp__funplay-notify__funplay_list_tasks',
  'mcp__funplay-notify__funplay_cancel_task',
  'mcp__funplay-web__funplay_web_search',
  'mcp__funplay-web__funplay_web_fetch',
  'mcp__funplay-media__funplay_media_attach_file',
  'mcp__funplay-media__funplay_media_save_base64',
  'mcp__funplay-image-gen__funplay_image_generate'
] as const;
export const FUNPLAY_WORKSPACE_WRITE_TOOL_NAMES = [
  'funplay_workspace_write_file',
  'funplay_workspace_edit_file',
  'funplay_workspace_multi_edit',
  'funplay_workspace_patch_file',
  'funplay_workspace_run_command',
  'funplay_workspace_checkpoint_diff',
  'funplay_workspace_checkpoint_rollback'
] as const;
export const FUNPLAY_WORKSPACE_WRITE_SERVER_TOOL_NAMES = [
  ...FUNPLAY_WORKSPACE_WRITE_TOOL_NAMES,
  'mcp__funplay-workspace-write__funplay_workspace_write_file',
  'mcp__funplay-workspace-write__funplay_workspace_edit_file',
  'mcp__funplay-workspace-write__funplay_workspace_multi_edit',
  'mcp__funplay-workspace-write__funplay_workspace_patch_file',
  'mcp__funplay-workspace-write__funplay_workspace_run_command',
  'mcp__funplay-workspace-write__funplay_workspace_checkpoint_diff',
  'mcp__funplay-workspace-write__funplay_workspace_checkpoint_rollback'
] as const;
export const MEDIA_RESULT_MARKER = '__MEDIA_RESULT__';
export const CLAUDE_CONTEXT_COMPACT_MIN_MESSAGES = 18;
export const CLAUDE_CONTEXT_RECENT_MESSAGE_KEEP = 12;
export const CLAUDE_CONTEXT_COMPACT_TRIGGER_CHARS = 28000;
export const CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
export const CLAUDE_CONTEXT_COMPACT_TARGET_RATIO = 0.68;
export const CLAUDE_CONTEXT_MESSAGE_MAX_CHARS = 900;
export const CLAUDE_CONTEXT_SUMMARY_MAX_CHARS = 12000;
export const CLAUDE_CONTEXT_SUMMARY_VERSION = 2;
export const CLAUDE_CONTEXT_COMPRESSION_MAX_FAILURES = 3;
export const CLAUDE_IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const CLAUDE_IMAGE_ATTACHMENT_MAX_COUNT = 100;
export const CLAUDE_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES = 25 * 1024 * 1024;
export const CLAUDE_SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const CLAUDE_TOOL_TIMEOUT_SECONDS = Number.parseInt(process.env.FUNPLAY_CLAUDE_TOOL_TIMEOUT_SECONDS ?? '300', 10);
export const EXTERNAL_WRITE_SINGLE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const EXTERNAL_WRITE_TOTAL_MAX_BYTES = 200 * 1024 * 1024;
export const EXTERNAL_WRITE_SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'release']);
export const EXTERNAL_WRITE_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.zip',
  '.mp3',
  '.wav',
  '.mp4',
  '.mov',
  '.ttf',
  '.otf',
  '.dll'
]);
export const CLAUDE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  sonnet: 200000,
  opus: 200000,
  haiku: 200000,
  'claude-sonnet-4': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-opus-4': 200000,
  'claude-opus-4-20250514': 200000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4': 200000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-4-5-20251001': 200000
};
export const CLAUDE_CONTEXT_LOOKUP_KEYS = Object.keys(CLAUDE_MODEL_CONTEXT_WINDOWS)
  .slice()
  .sort((left, right) => right.length - left.length);
export const claudeContextCompressionFailures = new Map<string, number>();

export function getClaudeRuntimeSession(params: GenericAgentRuntimeParams): ProjectSession {
  const ensured = ensureProjectSessions(params.project);
  return (
    ensured.sessions.find((session) => session.id === params.context.activeSessionId) ??
    getActiveProjectSession(ensured)
  );
}
