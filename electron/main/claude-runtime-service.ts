import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { SessionMessage, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import {
  createProjectSessionRecord,
  ensureProjectSessions,
  syncProjectChatFromActiveSession
} from '../../shared/project-sessions';
import type {
  AppState,
  ChatMessage,
  ClaudeInstallDetection,
  ClaudeRuntimeSetupStatus,
  ClaudeSessionImportResult,
  ClaudeSessionSummary,
  Project
} from '../../shared/types';
import {
  collectClaudeCodeExecutableCandidates,
  resolveClaudeCodeCliCommand,
  shouldSpawnClaudeCommandWithShell
} from './agent-platform/claude/runtime';

import { makeId, nowIso } from '../../shared/utils';

const MEDIA_RESULT_MARKER = '__MEDIA_RESULT__';

function expandHome(value: string): string {
  return value.replace(/^~(?=$|\/)/, homedir());
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandOutput(command: string, args: string[], timeout = 3000): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    shell: shouldSpawnClaudeCommandWithShell(command)
  });
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function whichClaude(): string | undefined {
  const result = spawnSync('/bin/sh', ['-lc', 'command -v claude'], {
    encoding: 'utf8',
    timeout: 3000
  });
  const value = result.stdout.trim().split('\n')[0]?.trim();
  return value || undefined;
}

function normalizePathCandidate(value: string): string {
  const expanded = expandHome(value.trim());
  if (!expanded) {
    return expanded;
  }

  if (!expanded.includes('/') || !existsSync(expanded)) {
    return expanded;
  }

  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

function collectClaudeCandidates(): string[] {
  const candidates = new Set<string>();
  for (const candidate of collectClaudeCodeExecutableCandidates()) {
    if (candidate.source !== 'fallback') {
      candidates.add(normalizePathCandidate(candidate.path));
    }
  }

  const which = whichClaude();
  if (which) {
    candidates.add(normalizePathCandidate(which));
  }

  [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '~/.npm-global/bin/claude',
    '~/npm-global/bin/claude',
    '~/.bun/bin/claude',
    '~/.claude/bin/claude',
    '~/.local/bin/claude'
  ].forEach((candidate) => {
    const normalized = normalizePathCandidate(candidate);
    if (normalized && existsSync(normalized)) {
      candidates.add(normalized);
    }
  });

  candidates.add('claude');
  return [...candidates].filter(Boolean);
}

function detectInstallType(pathValue: string): ClaudeInstallDetection['installType'] {
  if (pathValue.includes('/@anthropic-ai/claude-agent-sdk-') || pathValue.includes('\\@anthropic-ai\\claude-agent-sdk-')) {
    return 'sdk-bundled';
  }
  if (pathValue.includes('/opt/homebrew/') || pathValue.includes('/usr/local/Homebrew/')) {
    return 'homebrew';
  }
  if (pathValue.includes('/node_modules/') || pathValue.includes('/.npm') || pathValue.includes('/npm-global/')) {
    return 'npm';
  }
  if (pathValue.includes('/.bun/')) {
    return 'bun';
  }
  if (/\\windowsapps\\|\\winget\\|\/windowsapps\//i.test(pathValue)) {
    return 'winget';
  }
  if (pathValue === 'claude') {
    return 'native';
  }
  return 'unknown';
}

function detectClaudeInstall(candidate: string): ClaudeInstallDetection | undefined {
  if (candidate.includes('/') && !existsSync(candidate)) {
    return undefined;
  }

  const result = spawnSync(candidate, ['--version'], {
    encoding: 'utf8',
    timeout: 3000,
    shell: shouldSpawnClaudeCommandWithShell(candidate)
  });
  if (result.status !== 0) {
    return undefined;
  }

  const version = [result.stdout, result.stderr].filter(Boolean).join('\n').trim().split('\n')[0]?.trim();
  return {
    path: candidate,
    version,
    installType: detectInstallType(candidate)
  };
}

async function hasClaudeAgentSdk(): Promise<boolean> {
  try {
    await import('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

export async function detectClaudeRuntime(): Promise<ClaudeRuntimeSetupStatus> {
  const seen = new Set<string>();
  const installs: ClaudeInstallDetection[] = [];
  for (const candidate of collectClaudeCandidates()) {
    const normalized = normalizePathCandidate(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const install = detectClaudeInstall(normalized);
    if (install) {
      installs.push(install);
    }
  }

  const selected = installs[0];
  const otherInstalls = installs.map((install, index) => ({
    ...install,
    selected: index === 0
  }));
  const sdkAvailable = await hasClaudeAgentSdk();
  return {
    hasClaude: Boolean(selected),
    claudeVersion: selected?.version,
    claudePath: selected?.path,
    claudeInstallType: selected?.installType,
    otherInstalls,
    hasSdk: sdkAvailable,
    canUseSdk: sdkAvailable,
    loginHint: selected
      ? '已检测到 Claude CLI。若首次使用，请点击登录并在终端或浏览器中完成授权。'
      : '未检测到 Claude CLI。请先安装 Claude Code CLI，或通过 FUNPLAY_CLAUDE_CODE_CLI_PATH 指定可执行文件。'
  };
}

export async function runClaudeLogin(): Promise<{ success: true; output?: string }> {
  const status = await detectClaudeRuntime();
  const command = status.claudePath || resolveClaudeCodeCliCommand();
  if (!status.hasClaude || !command) {
    throw new Error('未检测到可用的 Claude CLI，无法启动登录。');
  }

  if (process.platform === 'darwin') {
    const terminalCommand = `${shellQuote(command)} login`;
    const child = spawn('osascript', [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(terminalCommand)}`
    ], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return {
      success: true,
      output: '已在 Terminal 中启动 `claude login`。'
    };
  }

  const child = spawn(command, ['login'], {
    detached: true,
    stdio: 'ignore',
    shell: shouldSpawnClaudeCommandWithShell(command)
  });
  child.unref();
  return {
    success: true,
    output: '已启动 `claude login`。'
  };
}

function resolveProjectDirectory(project?: Project): string | undefined {
  const projectPath = project?.engine?.projectPath?.trim();
  if (!projectPath) {
    return undefined;
  }
  return resolve(expandHome(projectPath));
}

function toIsoTime(ms?: number): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function sdkSessionToSummary(session: SDKSessionInfo): ClaudeSessionSummary {
  return {
    sessionId: session.sessionId,
    title: session.customTitle || session.summary || session.firstPrompt || `Claude Session ${session.sessionId.slice(0, 8)}`,
    cwd: session.cwd,
    projectPath: session.cwd,
    preview: session.firstPrompt || session.summary,
    updatedAt: toIsoTime(session.lastModified)
  };
}

export async function listClaudeCliSessions(state: AppState, projectId?: string): Promise<ClaudeSessionSummary[]> {
  const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
  const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
  const dir = resolveProjectDirectory(project);
  const sessions = await listSessions({
    dir,
    limit: 100,
    includeWorktrees: true
  });
  return sessions
    .map(sdkSessionToSummary)
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractTextFromClaudeContent(content: unknown): string {
  if (typeof content === 'string') {
    return stripMediaMarker(content);
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (!isRecord(block)) {
        return '';
      }
      if (block.type === 'text') {
        return readString(block, 'text') ?? '';
      }
      if (block.type === 'thinking') {
        return readString(block, 'thinking') ?? '';
      }
      if (block.type === 'tool_use') {
        return [
          `[Tool Call] ${readString(block, 'name') ?? 'claude_tool'}`,
          isRecord(block.input) ? JSON.stringify(block.input, null, 2) : ''
        ].filter(Boolean).join('\n');
      }
      if (block.type === 'tool_result') {
        return [
          '[Tool Result]',
          extractTextFromClaudeContent(block.content)
        ].filter(Boolean).join('\n');
      }
      return extractTextFromClaudeContent(block.content);
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractUserTextFromClaudeContent(content: unknown): string {
  if (typeof content === 'string') {
    return stripMediaMarker(content);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text')
    .map((block) => readString(block, 'text') ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function stripMediaMarker(content: string): string {
  const markerIndex = content.indexOf(MEDIA_RESULT_MARKER);
  if (markerIndex < 0) {
    return content;
  }

  return content.slice(0, markerIndex).trim();
}

function extractMessageRecord(entry: SessionMessage): Record<string, unknown> | undefined {
  return isRecord(entry.message) ? entry.message : undefined;
}

function convertSessionMessage(entry: SessionMessage, fallbackIndex: number): ChatMessage | undefined {
  if (entry.type === 'system') {
    return undefined;
  }

  const messageRecord = extractMessageRecord(entry);
  const role = messageRecord?.role === 'assistant' || entry.type === 'assistant' ? 'assistant' : 'user';
  const contentSource = messageRecord && Object.prototype.hasOwnProperty.call(messageRecord, 'content')
    ? messageRecord.content
    : entry.message;
  const content = role === 'user'
    ? extractUserTextFromClaudeContent(contentSource)
    : extractTextFromClaudeContent(contentSource);

  if (!content.trim()) {
    return undefined;
  }

  const entryRecord = entry as unknown as Record<string, unknown>;
  const createdAt = readString(entryRecord, 'timestamp') ?? readString(entryRecord, 'created_at') ?? nowIso();
  return {
    id: entry.uuid || makeId(`claude_msg_${fallbackIndex}`),
    role,
    content,
    createdAt
  };
}

function deriveImportedTitle(info: SDKSessionInfo | undefined, messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content.trim();
  const source = info?.customTitle || info?.summary || firstUserMessage || info?.firstPrompt || 'Claude CLI Session';
  return source.length > 64 ? `${source.slice(0, 63)}…` : source;
}

export async function importClaudeCliSession(state: AppState, projectId: string, sdkSessionId: string): Promise<ClaudeSessionImportResult> {
  const projectIndex = state.projects.findIndex((item) => item.id === projectId);
  if (projectIndex === -1) {
    throw new Error('Project not found.');
  }

  const current = ensureProjectSessions(state.projects[projectIndex]);
  const existing = current.sessions.find((session) => session.runtimeOverrides?.claudeCodeSessionId === sdkSessionId);
  if (existing) {
    throw new Error(`这个 Claude CLI 会话已导入：${existing.title}`);
  }

  const { getSessionInfo, getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
  const dir = resolveProjectDirectory(current);
  let info = await getSessionInfo(sdkSessionId, dir ? { dir } : undefined);
  let rawMessages = await getSessionMessages(sdkSessionId, dir ? { dir, includeSystemMessages: false } : { includeSystemMessages: false });
  if (!rawMessages.length && dir) {
    info = await getSessionInfo(sdkSessionId);
    rawMessages = await getSessionMessages(sdkSessionId, { includeSystemMessages: false });
  }

  const messages = rawMessages
    .map((message, index) => convertSessionMessage(message, index))
    .filter((message): message is ChatMessage => Boolean(message));
  if (!messages.length) {
    throw new Error('Claude CLI 会话没有可导入的消息。');
  }

  const title = deriveImportedTitle(info, messages);
  const createdAt = messages[0]?.createdAt ?? toIsoTime(info?.lastModified) ?? nowIso();
  const updatedAt = messages[messages.length - 1]?.createdAt ?? toIsoTime(info?.lastModified) ?? createdAt;
  const session = createProjectSessionRecord({
    title,
    chat: messages,
    createdAt,
    updatedAt,
    autoTitle: false,
    runtimeOverrides: {
      runtimeId: 'claude-code-sdk',
      claudeCodeSessionId: sdkSessionId,
      claudeCodeSessionCwd: info?.cwd || dir
    }
  });

  const updatedProject = syncProjectChatFromActiveSession({
    ...current,
    updatedAt,
    sessions: [session, ...current.sessions],
    activeSessionId: session.id,
    activity: [
      {
        id: makeId('act'),
        kind: 'project',
        title: '导入 Claude CLI 会话',
        detail: `${title} · ${messages.length} messages · ${info?.cwd || dir || basename(sdkSessionId)}`,
        createdAt: updatedAt
      },
      ...current.activity
    ]
  });

  state.projects[projectIndex] = updatedProject;
  return {
    project: updatedProject,
    sessionId: session.id,
    importedMessageCount: messages.length,
    sdkSessionId,
    title
  };
}
