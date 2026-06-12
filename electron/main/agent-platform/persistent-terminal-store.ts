import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveInteractiveShell } from './system-shell';
import { resolve } from 'node:path';
import type { AgentToolTerminalResult, Project } from '../../../shared/types';
import { makeId, nowIso } from '../../../shared/utils';
import { resolveProjectRootPathForProject } from '../project-file-service';

const MAX_TERMINAL_OUTPUT_CHARS = 200_000;
const MAX_TERMINAL_READ_CHARS = 30_000;
const MAX_TERMINAL_INPUT_CHARS = 16_000;
const MAX_TERMINAL_SESSIONS = 8;
const MAX_TERMINAL_LOG_TAIL_CHARS = 2000;
const MAX_BACKGROUND_NOTICES_PER_PROJECT = 20;

export interface PersistentTerminalStartInput {
  name?: string;
  command?: string;
  cwd?: string;
}

export interface PersistentTerminalWriteInput {
  sessionId: string;
  input: string;
  appendNewline?: boolean;
}

export interface PersistentTerminalReadInput {
  sessionId: string;
  sinceSeq?: number;
  maxChars?: number;
}

export interface PersistentTerminalStopInput {
  sessionId: string;
  signal?: 'SIGTERM' | 'SIGINT' | 'SIGKILL';
}

export interface BackgroundCommandJobStartInput {
  /** Original user-facing command (for listings and completion notices). */
  command: string;
  cwd?: string;
  /** Prepared spawn spec — possibly wrapped in a sandbox by the caller. */
  spawn: {
    shell: string;
    args: string[];
  };
  /** Optional sandbox status line surfaced in the completion notice. */
  sandboxStatus?: string;
}

interface TerminalOutputChunk {
  seq: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: string;
}

interface PersistentTerminalSession {
  id: string;
  projectId: string;
  projectName: string;
  rootPath: string;
  cwdPath: string;
  relativeCwd: string;
  name: string;
  shell: string;
  /** 'background-job' sessions are one-shot run_command background jobs; default is an interactive shell. */
  kind?: 'shell' | 'background-job';
  sandboxStatus?: string;
  command?: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'exited' | 'stopped' | 'failed';
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  process: ChildProcessWithoutNullStreams;
  chunks: TerminalOutputChunk[];
  totalChars: number;
  droppedChars: number;
  nextSeq: number;
}

const sessions = new Map<string, PersistentTerminalSession>();

/**
 * Completion notices for background command jobs, keyed by project id.
 * Drained by the native tool loop and injected into the next step through the
 * same appended-context seam lifecycle hooks use. Process-lifetime by design.
 */
const pendingBackgroundCommandNotices = new Map<string, string[]>();

function queueBackgroundCommandNotice(session: PersistentTerminalSession): void {
  // Skip late close events after disposePersistentTerminals() cleared the registry.
  if (!sessions.has(session.id)) {
    return;
  }
  const tail = buildTerminalLogTail(session);
  const notice = [
    `[后台命令完成] ${session.id}`,
    `命令：${session.command ?? '(unknown)'}`,
    `状态：${session.status}`,
    `退出码：${session.exitCode ?? 'none'}${session.signal ? `（信号 ${session.signal}）` : ''}`,
    session.sandboxStatus ?? '',
    tail ? `输出尾部：\n${tail}` : '输出尾部：(no output)'
  ]
    .filter(Boolean)
    .join('\n');
  const queue = pendingBackgroundCommandNotices.get(session.projectId) ?? [];
  queue.push(notice);
  if (queue.length > MAX_BACKGROUND_NOTICES_PER_PROJECT) {
    queue.splice(0, queue.length - MAX_BACKGROUND_NOTICES_PER_PROJECT);
  }
  pendingBackgroundCommandNotices.set(session.projectId, queue);
}

/** Drains queued background command completion notices for a project. */
export function consumePendingBackgroundCommandNotices(projectId: string): string[] {
  const queue = pendingBackgroundCommandNotices.get(projectId);
  if (!queue?.length) {
    return [];
  }
  pendingBackgroundCommandNotices.delete(projectId);
  return queue;
}

/**
 * Drains background-command completion notices for a project into a single
 * user-role turn the model reads on its next step, or undefined when none are
 * pending. The native tool loops call this at each iteration so an
 * asynchronously-finished `run_command` background job surfaces its exit code
 * and output tail without waiting for the next user turn.
 */
export function drainBackgroundCommandNoticeMessage(projectId: string): string | undefined {
  const notices = consumePendingBackgroundCommandNotices(projectId);
  if (notices.length === 0) {
    return undefined;
  }
  return ['以下后台命令已完成，请根据结果继续任务（不要逐字复述）：', '', ...notices].join('\n');
}

function signalTerminalProcess(session: PersistentTerminalSession, signal: NodeJS.Signals): void {
  const pid = session.process.pid;
  if (!pid) {
    return;
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return;
      }
    }
  }

  try {
    session.process.kill(signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      throw error;
    }
  }
}

function trim(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function resolveTerminalCwd(
  project: Project,
  cwd?: string
): {
  rootPath: string;
  cwdPath: string;
  relativeCwd: string;
} {
  const rootPath = resolveProjectRootPathForProject(project);
  const normalized = (cwd?.trim() || '.').replaceAll('\\', '/').replace(/^\.\//, '');
  const cwdPath = resolve(rootPath, normalized);
  if (cwdPath !== rootPath && !cwdPath.startsWith(`${rootPath}/`)) {
    throw new Error('非法终端工作目录。');
  }
  return {
    rootPath,
    cwdPath,
    relativeCwd:
      cwdPath === rootPath
        ? '.'
        : cwdPath
            .slice(rootPath.length + 1)
            .split('\\')
            .join('/')
  };
}

function appendChunk(session: PersistentTerminalSession, stream: TerminalOutputChunk['stream'], text: string): void {
  if (!text) {
    return;
  }

  session.chunks.push({
    seq: session.nextSeq,
    stream,
    text,
    timestamp: nowIso()
  });
  session.nextSeq += 1;
  session.totalChars += text.length;
  session.updatedAt = nowIso();

  while (session.totalChars > MAX_TERMINAL_OUTPUT_CHARS && session.chunks.length > 1) {
    const removed = session.chunks.shift();
    const removedLength = removed?.text.length ?? 0;
    session.totalChars -= removedLength;
    session.droppedChars += removedLength;
  }
}

function cleanupOldSessions(): void {
  if (sessions.size < MAX_TERMINAL_SESSIONS) {
    return;
  }

  for (const [id, session] of sessions) {
    if (session.status !== 'running') {
      sessions.delete(id);
      if (sessions.size < MAX_TERMINAL_SESSIONS) {
        return;
      }
    }
  }

  if (sessions.size >= MAX_TERMINAL_SESSIONS) {
    throw new Error(`终端会话数量已达上限 ${MAX_TERMINAL_SESSIONS}，请先停止已有会话。`);
  }
}

function getSession(sessionId: string): PersistentTerminalSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`终端会话不存在：${sessionId}`);
  }
  return session;
}

function formatSessionLine(session: PersistentTerminalSession): string {
  return [
    `[${session.id}] ${session.name}`,
    session.kind === 'background-job' ? 'type=background-command' : '',
    `status=${session.status}`,
    `cwd=${session.relativeCwd}`,
    session.pid ? `pid=${session.pid}` : '',
    session.command ? `command=${trim(session.command, 120)}` : '',
    session.exitCode !== undefined ? `exit=${session.exitCode ?? 'none'}` : '',
    session.signal ? `signal=${session.signal}` : ''
  ]
    .filter(Boolean)
    .join(' | ');
}

function classifyTerminalServiceKind(
  session: PersistentTerminalSession
): NonNullable<AgentToolTerminalResult['serviceKind']> {
  const haystack = `${session.name} ${session.command ?? ''}`.toLowerCase();
  if (/\b(vite|next|webpack|dev|serve|server|preview|localhost)\b/.test(haystack)) return 'dev-server';
  if (/\b(test|vitest|jest|playwright|node --test|npm test)\b/.test(haystack)) return 'test-runner';
  return 'shell';
}

function detectTerminalPorts(session: PersistentTerminalSession): number[] {
  const haystack = [session.command ?? '', ...session.chunks.slice(-20).map((chunk) => chunk.text)].join('\n');
  const ports = new Set<number>();
  for (const match of haystack.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|port)\D{0,20}([1-9]\d{1,4})/gi)) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      ports.add(port);
    }
  }
  return [...ports].slice(0, 8);
}

function buildTerminalLogTail(session: PersistentTerminalSession): string | undefined {
  const text = session.chunks
    .slice(-20)
    .map((chunk) => chunk.text)
    .join('');
  if (!text.trim()) {
    return undefined;
  }
  return text.length > MAX_TERMINAL_LOG_TAIL_CHARS ? text.slice(-MAX_TERMINAL_LOG_TAIL_CHARS) : text;
}

function buildTerminalMetadata(session: PersistentTerminalSession): AgentToolTerminalResult {
  return {
    sessionId: session.id,
    name: session.name,
    status: session.status,
    nextSeq: session.nextSeq,
    cwd: session.relativeCwd,
    command: session.command,
    pid: session.pid,
    exitCode: session.exitCode,
    signal: session.signal,
    serviceKind: classifyTerminalServiceKind(session),
    detectedPorts: detectTerminalPorts(session),
    outputChunkCount: session.chunks.length,
    totalOutputChars: session.totalChars,
    logTail: buildTerminalLogTail(session)
  };
}

export function startPersistentTerminal(
  project: Project,
  input: PersistentTerminalStartInput = {}
): {
  sessionId: string;
  summary: string;
  terminal: AgentToolTerminalResult;
} {
  cleanupOldSessions();
  const { rootPath, cwdPath, relativeCwd } = resolveTerminalCwd(project, input.cwd);
  const { shell, args: shellArgs } = resolveInteractiveShell();
  const id = makeId('term');
  const createdAt = nowIso();
  const child = spawn(shell, shellArgs, {
    cwd: cwdPath,
    env: {
      ...process.env,
      TERM: process.env.TERM || 'dumb'
    },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const session: PersistentTerminalSession = {
    id,
    projectId: project.id,
    projectName: project.name,
    rootPath,
    cwdPath,
    relativeCwd,
    name: input.name?.trim() || input.command?.trim().slice(0, 80) || 'Terminal',
    shell,
    command: input.command?.trim() || undefined,
    createdAt,
    updatedAt: createdAt,
    status: 'running',
    pid: child.pid,
    process: child,
    chunks: [],
    totalChars: 0,
    droppedChars: 0,
    nextSeq: 1
  };
  sessions.set(id, session);
  appendChunk(session, 'system', `Started terminal ${id} in ${relativeCwd} using ${shell}.\n`);

  child.stdout.on('data', (data: Buffer) => appendChunk(session, 'stdout', data.toString('utf8')));
  child.stderr.on('data', (data: Buffer) => appendChunk(session, 'stderr', data.toString('utf8')));
  child.on('error', (error) => {
    session.status = 'failed';
    appendChunk(session, 'system', `Terminal failed: ${error.message}\n`);
  });
  child.on('close', (code, signal) => {
    session.status = session.status === 'stopped' ? 'stopped' : 'exited';
    session.exitCode = code;
    session.signal = signal;
    appendChunk(session, 'system', `Terminal exited with code=${code ?? 'none'} signal=${signal ?? 'none'}.\n`);
  });

  if (session.command) {
    child.stdin.write(`${session.command}\n`);
    appendChunk(session, 'system', `$ ${session.command}\n`);
  }

  return {
    sessionId: id,
    terminal: buildTerminalMetadata(session),
    summary: [
      `Terminal started. ID: ${id}`,
      `Name: ${session.name}`,
      `CWD: ${relativeCwd}`,
      `PID: ${child.pid ?? '-'}`,
      session.command ? `Initial command: ${session.command}` : 'Initial command: none',
      'Use terminal_read to fetch output, terminal_write to send input, terminal_stop to terminate it.'
    ].join('\n')
  };
}

/**
 * Starts a one-shot background command job (`run_command` with `background: true`).
 * Jobs reuse the persistent terminal session registry, so terminal_read /
 * terminal_stop / terminal_list accept job ids directly; on completion a notice
 * with the exit code and output tail is queued for the next agent loop step.
 */
export function startBackgroundCommandJob(
  project: Project,
  input: BackgroundCommandJobStartInput
): {
  jobId: string;
  summary: string;
  terminal: AgentToolTerminalResult;
} {
  cleanupOldSessions();
  const { rootPath, cwdPath, relativeCwd } = resolveTerminalCwd(project, input.cwd);
  const id = makeId('job');
  const createdAt = nowIso();
  const child = spawn(input.spawn.shell, input.spawn.args, {
    cwd: cwdPath,
    env: {
      ...process.env,
      TERM: 'dumb'
    },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const session: PersistentTerminalSession = {
    id,
    projectId: project.id,
    projectName: project.name,
    rootPath,
    cwdPath,
    relativeCwd,
    name: `Background: ${trim(input.command, 60)}`,
    shell: input.spawn.shell,
    kind: 'background-job',
    sandboxStatus: input.sandboxStatus,
    command: input.command,
    createdAt,
    updatedAt: createdAt,
    status: 'running',
    pid: child.pid,
    process: child,
    chunks: [],
    totalChars: 0,
    droppedChars: 0,
    nextSeq: 1
  };
  sessions.set(id, session);
  appendChunk(session, 'system', `Started background command ${id} in ${relativeCwd}.\n$ ${input.command}\n`);

  child.stdout.on('data', (data: Buffer) => appendChunk(session, 'stdout', data.toString('utf8')));
  child.stderr.on('data', (data: Buffer) => appendChunk(session, 'stderr', data.toString('utf8')));
  child.on('error', (error) => {
    session.status = 'failed';
    appendChunk(session, 'system', `Background command failed: ${error.message}\n`);
    queueBackgroundCommandNotice(session);
  });
  child.on('close', (code, signal) => {
    session.status = session.status === 'stopped' ? 'stopped' : 'exited';
    session.exitCode = code;
    session.signal = signal;
    appendChunk(
      session,
      'system',
      `Background command exited with code=${code ?? 'none'} signal=${signal ?? 'none'}.\n`
    );
    queueBackgroundCommandNotice(session);
  });

  return {
    jobId: id,
    terminal: buildTerminalMetadata(session),
    summary: [
      `Background command started. Job ID: ${id}`,
      `Command: ${input.command}`,
      `CWD: ${relativeCwd}`,
      `PID: ${child.pid ?? '-'}`,
      'Completion (exit code + output tail) is injected into the next step automatically.',
      'Use terminal_read to poll output, terminal_stop to terminate the job.'
    ].join('\n')
  };
}

export function readPersistentTerminalMetadata(sessionId: string): AgentToolTerminalResult {
  return buildTerminalMetadata(getSession(sessionId));
}

export function snapshotPersistentTerminalOutput(sessionId: string): {
  output: string;
  size: number;
  truncated?: boolean;
} {
  const session = getSession(sessionId);
  const output = [
    `Terminal: ${session.id}`,
    `Name: ${session.name}`,
    `Status: ${session.status}`,
    `Cwd: ${session.relativeCwd}`,
    session.command ? `Command: ${session.command}` : '',
    session.pid ? `Pid: ${session.pid}` : '',
    session.exitCode !== undefined ? `Exit code: ${session.exitCode ?? 'none'}` : '',
    session.signal ? `Signal: ${session.signal}` : '',
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`,
    `Retained output chars: ${session.totalChars}`,
    session.droppedChars > 0 ? `Dropped output chars: ${session.droppedChars}` : '',
    '',
    ...session.chunks.map((chunk) => `[${chunk.seq} ${chunk.timestamp} ${chunk.stream}] ${chunk.text}`)
  ]
    .filter(Boolean)
    .join('\n');
  return {
    output,
    size: Buffer.byteLength(output, 'utf8'),
    truncated: session.droppedChars > 0 || undefined
  };
}

export function writePersistentTerminal(input: PersistentTerminalWriteInput): string {
  const session = getSession(input.sessionId);
  if (session.status !== 'running') {
    throw new Error(`终端会话未运行：${input.sessionId} (${session.status})`);
  }
  if (!session.process.stdin.writable) {
    throw new Error(`终端会话 stdin 不可写：${input.sessionId}`);
  }

  const value = input.input.slice(0, MAX_TERMINAL_INPUT_CHARS);
  const payload = input.appendNewline === false ? value : `${value}\n`;
  session.process.stdin.write(payload);
  appendChunk(session, 'system', `$ ${trim(value, 400)}${input.appendNewline === false ? '' : '\n'}`);
  return `Input sent to ${input.sessionId} (${payload.length} chars).`;
}

export function readPersistentTerminal(input: PersistentTerminalReadInput): string {
  const session = getSession(input.sessionId);
  const sinceSeq = Math.max(0, input.sinceSeq ?? 0);
  const maxChars = Math.min(MAX_TERMINAL_READ_CHARS, Math.max(1000, input.maxChars ?? 12_000));
  const chunks = session.chunks.filter((chunk) => chunk.seq > sinceSeq);
  const body = chunks.map((chunk) => `[${chunk.seq} ${chunk.stream}] ${chunk.text}`).join('');
  const truncated = body.length > maxChars;
  const output = truncated ? body.slice(Math.max(0, body.length - maxChars)) : body;
  const nextSeq = session.nextSeq;

  return [
    formatSessionLine(session),
    `nextSeq=${nextSeq}`,
    truncated ? `output=tail(${maxChars} chars)` : `output=${chunks.length} chunk(s)`,
    '',
    output || '(no new output)'
  ].join('\n');
}

export function listPersistentTerminals(project?: Project): string {
  const filtered = [...sessions.values()].filter((session) => !project || session.projectId === project.id);
  return filtered.length ? filtered.map(formatSessionLine).join('\n') : 'No terminal sessions.';
}

export function stopPersistentTerminal(input: PersistentTerminalStopInput): string {
  const session = getSession(input.sessionId);
  if (session.status !== 'running') {
    return `Terminal ${input.sessionId} already ${session.status}.`;
  }

  const signal = input.signal ?? 'SIGTERM';
  session.status = 'stopped';
  session.process.stdin.end();
  signalTerminalProcess(session, signal);
  setTimeout(() => {
    if (session.status === 'stopped' && session.exitCode === undefined && session.signal === undefined) {
      signalTerminalProcess(session, 'SIGKILL');
    }
  }, 2_000).unref?.();
  appendChunk(session, 'system', `Stop requested with ${signal}.\n`);
  return `Stop requested for ${input.sessionId} with ${signal}.`;
}

export function disposePersistentTerminals(): void {
  for (const session of sessions.values()) {
    if (session.status === 'running' || session.status === 'stopped') {
      session.status = 'stopped';
      session.process.stdin.end();
      signalTerminalProcess(session, 'SIGKILL');
    }
  }
  sessions.clear();
  pendingBackgroundCommandNotices.clear();
}
