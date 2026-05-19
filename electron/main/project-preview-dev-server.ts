import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppState, Project, ProjectHtmlPreviewServerResult } from '../../shared/types';
import { resolveProjectRootPathForProject } from './project-file-service';
import {
  readPersistentTerminalMetadata,
  startPersistentTerminal,
  stopPersistentTerminal
} from './agent-platform/persistent-terminal-store';

const SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'preview'] as const;
const activePreviewServers = new Map<string, {
  sessionId: string;
  command: string;
  scriptName: string;
  url?: string;
}>();

interface PackageJsonLike {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

export async function startProjectHtmlPreviewServer(state: AppState, projectId: string): Promise<ProjectHtmlPreviewServerResult> {
  const project = getProjectOrThrow(state, projectId);
  const existing = activePreviewServers.get(project.id);
  if (existing) {
    try {
      const terminal = readPersistentTerminalMetadata(existing.sessionId);
      if (terminal.status === 'running') {
        const url = existing.url ?? await waitForLocalPreviewUrl(existing.sessionId);
        activePreviewServers.set(project.id, { ...existing, url });
        return {
          success: true,
          url,
          sessionId: existing.sessionId,
          command: existing.command,
          scriptName: existing.scriptName,
          reused: true,
          terminal: readPersistentTerminalMetadata(existing.sessionId)
        };
      }
    } catch {
      activePreviewServers.delete(project.id);
    }
  }

  const rootPath = resolveProjectRootPathForProject(project);
  const packageJsonPath = join(rootPath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error('当前项目没有 package.json，无法自动启动网页预览服务。');
  }

  const packageJson = parsePackageJson(await readFile(packageJsonPath, 'utf8'));
  const scriptName = selectHtmlPreviewDevScript(packageJson.scripts);
  if (!scriptName) {
    throw new Error('package.json 中没有 dev/start/serve/preview 脚本，无法自动启动网页预览服务。');
  }

  const packageManager = detectPackageManager(rootPath, packageJson.packageManager);
  const command = buildPackageRunCommand(packageManager, scriptName);
  const started = startPersistentTerminal(project, {
    name: `HTML preview: ${scriptName}`,
    command
  });
  activePreviewServers.set(project.id, {
    sessionId: started.sessionId,
    command,
    scriptName
  });

  try {
    const url = await waitForLocalPreviewUrl(started.sessionId);
    activePreviewServers.set(project.id, {
      sessionId: started.sessionId,
      command,
      scriptName,
      url
    });
    return {
      success: true,
      url,
      sessionId: started.sessionId,
      command,
      scriptName,
      reused: false,
      terminal: readPersistentTerminalMetadata(started.sessionId)
    };
  } catch (error) {
    const terminal = readPersistentTerminalMetadata(started.sessionId);
    const detail = terminal.logTail ? `\n\n${terminal.logTail}` : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  }
}

export function selectHtmlPreviewDevScript(scripts: Record<string, unknown> | undefined): string | undefined {
  return SCRIPT_PRIORITY.find((name) => typeof scripts?.[name] === 'string' && scripts[name].trim().length > 0);
}

export function stopProjectHtmlPreviewServer(projectId: string): {
  success: true;
  stopped: boolean;
  sessionId?: string;
} {
  const existing = activePreviewServers.get(projectId);
  if (!existing) {
    return {
      success: true,
      stopped: false
    };
  }
  activePreviewServers.delete(projectId);
  try {
    stopPersistentTerminal({
      sessionId: existing.sessionId,
      signal: 'SIGTERM'
    });
    return {
      success: true,
      stopped: true,
      sessionId: existing.sessionId
    };
  } catch {
    return {
      success: true,
      stopped: false,
      sessionId: existing.sessionId
    };
  }
}

export function disposeProjectHtmlPreviewServers(): void {
  for (const projectId of [...activePreviewServers.keys()]) {
    stopProjectHtmlPreviewServer(projectId);
  }
}

export function extractLocalPreviewUrl(text: string | undefined, ports: number[] = []): string | undefined {
  const source = text ?? '';
  for (const match of source.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):([1-9]\d{1,4})(?:\/[^\s'"<>)]*)?/gi)) {
    const raw = match[0].replace('://0.0.0.0:', '://localhost:');
    try {
      const url = new URL(raw);
      if (isLocalPreviewUrl(url)) {
        return url.toString();
      }
    } catch {
      continue;
    }
  }

  const port = ports.find((value) => Number.isInteger(value) && value > 0 && value <= 65535);
  return port ? `http://localhost:${port}/` : undefined;
}

function getProjectOrThrow(state: AppState, projectId: string): Project {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error('Project not found.');
  }
  return project;
}

function parsePackageJson(content: string): PackageJsonLike {
  try {
    const parsed = JSON.parse(content) as PackageJsonLike;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('package.json 不是有效的 JSON，无法自动启动网页预览服务。');
  }
}

function detectPackageManager(rootPath: string, packageManager: unknown): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const declared = typeof packageManager === 'string' ? packageManager : '';
  if (declared.startsWith('pnpm@')) return 'pnpm';
  if (declared.startsWith('yarn@')) return 'yarn';
  if (declared.startsWith('bun@')) return 'bun';
  if (declared.startsWith('npm@')) return 'npm';
  if (existsSync(join(rootPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(rootPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(rootPath, 'bun.lockb')) || existsSync(join(rootPath, 'bun.lock'))) return 'bun';
  return 'npm';
}

function buildPackageRunCommand(packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun', scriptName: string): string {
  return packageManager === 'npm'
    ? `npm run ${scriptName}`
    : `${packageManager} run ${scriptName}`;
}

async function waitForLocalPreviewUrl(sessionId: string): Promise<string> {
  let lastLog = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(250);
    const terminal = readPersistentTerminalMetadata(sessionId);
    lastLog = terminal.logTail ?? lastLog;
    const url = extractLocalPreviewUrl(terminal.logTail, terminal.detectedPorts);
    if (url) {
      return url;
    }
    if (terminal.status && terminal.status !== 'running') {
      break;
    }
  }
  throw new Error(`已启动预览命令，但没有检测到 localhost 预览地址。${lastLog ? '请检查终端输出。' : ''}`);
}

function isLocalPreviewUrl(url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && Number(url.port) > 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
