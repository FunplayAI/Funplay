import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter as pathDelimiter, dirname, join, normalize, resolve, sep } from 'node:path';
import type {
  ClaudeCodeExecutableSource,
  ClaudeCodeExecutableCandidate,
  ClaudeCodeExecutableResolution
} from './types';

const nodeRequire = createRequire(import.meta.url);

export class ClaudeResumeFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeResumeFailedError';
  }
}

export function expandHomePath(value: string, home = homedir()): string {
  return value.replace(/^~(?=$|[\\/])/, home);
}

function getHomeDirectoryFromEnv(baseEnv: NodeJS.ProcessEnv = process.env): string {
  return baseEnv.HOME || baseEnv.USERPROFILE || homedir();
}

export function getPathFromEnv(baseEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  return baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path;
}

function normalizeExecutableCandidate(value: string): string {
  return normalize(expandHomePath(value.trim()));
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

export function resolveAsarUnpackedPath(filePath: string): string {
  return filePath.includes(`${sep}app.asar${sep}`)
    ? filePath.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
    : filePath;
}

function tryResolveModulePath(specifier: string): string | undefined {
  try {
    return resolveAsarUnpackedPath(nodeRequire.resolve(specifier));
  } catch {
    return undefined;
  }
}

export function isMuslRuntime(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  const report = typeof process.report?.getReport === 'function'
    ? process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
    : undefined;
  const header = report?.header;
  return !header?.glibcVersionRuntime;
}

export function resolveClaudeAgentSdkNativePackageName(): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `@anthropic-ai/claude-agent-sdk-darwin-${arch}`;
  }
  if (platform === 'win32' && (arch === 'arm64' || arch === 'x64')) {
    return `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
  }
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64')) {
    return `@anthropic-ai/claude-agent-sdk-linux-${arch}${isMuslRuntime() ? '-musl' : ''}`;
  }
  return undefined;
}

export function resolveBundledClaudeCodeExecutablePath(): string | undefined {
  const packageName = resolveClaudeAgentSdkNativePackageName();
  if (!packageName) {
    return undefined;
  }
  return tryResolveModulePath(`${packageName}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`) ??
    tryResolveModulePath(`${packageName}/claude`);
}

export function resolveScriptFromCmd(commandPath: string): string | undefined {
  if (!/\.(cmd|bat)$/i.test(commandPath)) {
    return undefined;
  }
  try {
    const content = readFileSync(commandPath, 'utf8');
    const commandDir = dirname(commandPath);
    const patterns = [
      /"%~dp0\\([^"]*claude[^"]*\.js)"/i,
      /%~dp0\\(\S*claude\S*\.js)/i,
      /"%dp0%\\([^"]*claude[^"]*\.js)"/i,
      /node(?:\.exe)?"?\s+"?([^"\r\n]*claude[^"\r\n]*\.js)"?/i
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (!match?.[1]) {
        continue;
      }
      const scriptPath = resolve(commandDir, match[1]);
      if (existsSync(scriptPath)) {
        return scriptPath;
      }
    }
  } catch {
    // Ignore unreadable wrapper scripts. The caller can still try the wrapper path.
  }
  return undefined;
}

function resolveSdkExecutablePathForCommand(commandPath: string): string | undefined {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath)) {
    return resolveScriptFromCmd(commandPath);
  }
  return commandPath;
}

export function shouldSpawnClaudeCommandWithShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function getWindowsPathExtensions(baseEnv: NodeJS.ProcessEnv = process.env): string[] {
  const pathext = baseEnv.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  return pathext
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function resolveCommandFromPath(command: string, baseEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  const normalizedCommand = normalizeExecutableCandidate(command);
  if (hasPathSeparator(normalizedCommand)) {
    return existsSync(normalizedCommand) ? normalizedCommand : undefined;
  }

  const pathValue = buildExpandedPath(baseEnv) ?? getPathFromEnv(baseEnv) ?? '';
  const extensions = process.platform === 'win32' ? ['', ...getWindowsPathExtensions(baseEnv)] : [''];
  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${normalizedCommand}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function collectClaudeCodeExecutableCandidates(baseEnv: NodeJS.ProcessEnv = process.env): ClaudeCodeExecutableCandidate[] {
  const candidates: ClaudeCodeExecutableCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (pathValue: string | undefined, source: ClaudeCodeExecutableSource): void => {
    if (!pathValue?.trim()) {
      return;
    }
    const normalized = normalizeExecutableCandidate(pathValue);
    if (seen.has(`${source}:${normalized}`)) {
      return;
    }
    seen.add(`${source}:${normalized}`);
    candidates.push({
      path: normalized,
      source,
      exists: hasPathSeparator(normalized) ? existsSync(normalized) : undefined,
      sdkExecutablePath: resolveSdkExecutablePathForCommand(normalized)
    });
  };

  addCandidate(baseEnv.FUNPLAY_CLAUDE_CODE_CLI_PATH, 'env');
  addCandidate(resolveCommandFromPath('claude', baseEnv), 'path');
  addCandidate(resolveBundledClaudeCodeExecutablePath(), 'sdk-bundled');
  addCandidate('claude', 'fallback');
  return candidates;
}

export function resolveClaudeCodeExecutable(baseEnv: NodeJS.ProcessEnv = process.env): ClaudeCodeExecutableResolution {
  const diagnostics: string[] = [];
  for (const candidate of collectClaudeCodeExecutableCandidates(baseEnv)) {
    if (candidate.source !== 'fallback' && candidate.exists === false) {
      diagnostics.push(`${candidate.source}:${candidate.path}:missing`);
      continue;
    }
    if (candidate.source !== 'fallback' && hasPathSeparator(candidate.path) && !existsSync(candidate.path)) {
      diagnostics.push(`${candidate.source}:${candidate.path}:missing`);
      continue;
    }
    const sdkExecutablePath = candidate.sdkExecutablePath && existsSync(candidate.sdkExecutablePath)
      ? candidate.sdkExecutablePath
      : undefined;
    if (candidate.source !== 'fallback' || candidate.path) {
      return {
        command: candidate.path,
        source: candidate.source,
        sdkExecutablePath,
        diagnostics
      };
    }
  }
  return {
    command: 'claude',
    source: 'fallback',
    diagnostics
  };
}

export function resolveClaudeCodeCliCommand(): string {
  return resolveClaudeCodeExecutable().command;
}

export function buildExpandedPath(baseEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  const current = getPathFromEnv(baseEnv);
  const home = getHomeDirectoryFromEnv(baseEnv);
  const appData = baseEnv.APPDATA;
  const localAppData = baseEnv.LOCALAPPDATA;
  const extras = process.platform === 'win32'
    ? [
        appData ? join(appData, 'npm') : undefined,
        localAppData ? join(localAppData, 'npm') : undefined,
        join(home, '.npm-global', 'bin'),
        join(home, '.claude', 'bin'),
        join(home, '.bun', 'bin'),
        join(home, '.local', 'bin'),
        join(home, '.nvm', 'current', 'bin')
      ]
    : [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        join(home, '.npm-global', 'bin'),
        join(home, 'npm-global', 'bin'),
        join(home, '.claude', 'bin'),
        join(home, '.bun', 'bin'),
        join(home, '.local', 'bin'),
        join(home, '.nvm', 'current', 'bin')
      ];
  const parts = [...(current ? current.split(pathDelimiter) : []), ...extras].filter((part): part is string => Boolean(part));
  return [...new Set(parts)].join(pathDelimiter) || current;
}
