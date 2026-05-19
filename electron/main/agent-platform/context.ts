import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import {
  DEFAULT_PROJECT_SESSION_MODE,
  buildSessionConversationTurns,
  ensureProjectSessions,
  getActiveProjectSession,
  getChatMessageContextText,
  summarizeArchivedConversationTurns
} from '../../../shared/project-sessions';
import type { McpPlugin, Project } from '../../../shared/types';
import type { GenericAgentWorkspaceContext, GenericProjectContextIndex } from './types';
import { buildAgentSkillRegistry, resolveAgentSkillActivations } from './skill-registry';

function trimContent(content: string, maxLength = 1600): string {
  return content.length > maxLength ? `${content.slice(0, maxLength)}…` : content;
}

const PROJECT_INSTRUCTION_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '.claude/settings.md',
  '.cursorrules'
];
const SUBDIRECTORY_PROJECT_INSTRUCTION_CANDIDATES = [
  'AGENTS.md',
  'agents.md',
  'CLAUDE.md',
  'claude.md',
  '.cursorrules'
];
const MAX_PROJECT_INSTRUCTION_FILES = 8;
const MAX_PROJECT_INSTRUCTION_FILE_CHARS = 6000;
const MAX_PROJECT_INSTRUCTION_TOTAL_CHARS = 12000;
const MAX_PROJECT_INSTRUCTION_PATH_TOKENS = 12;
const MAX_GIT_STATUS_CHARS = 1200;
const MAX_GIT_LOG_CHARS = 1000;
const MAX_CONTEXT_INDEX_DEPENDENCIES = 40;
const MAX_CONTEXT_INDEX_ENTRYPOINTS = 18;
const MAX_CONTEXT_INDEX_CONFIG_FILES = 24;
const MAX_CONTEXT_INDEX_RECENT_FILES = 24;
const CONTEXT_INDEX_CONFIG_CANDIDATES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'electron.vite.config.ts',
  'electron.vite.config.js',
  'next.config.js',
  'next.config.mjs',
  'astro.config.mjs',
  'svelte.config.js',
  'tailwind.config.ts',
  'tailwind.config.js',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'ProjectSettings/ProjectVersion.txt',
  'Packages/manifest.json'
];
const CONTEXT_INDEX_ENTRYPOINT_CANDIDATES = [
  'src/main.tsx',
  'src/main.ts',
  'src/index.tsx',
  'src/index.ts',
  'src/App.tsx',
  'src/App.ts',
  'src/server.ts',
  'src/server.js',
  'src/server.mjs',
  'electron/main/index.ts',
  'electron/preload/index.ts',
  'index.html',
  'main.py',
  'app.py'
];

function resolveProjectPath(project: Project): string | undefined {
  const projectPath = project.engine?.projectPath?.trim();
  if (!projectPath) {
    return undefined;
  }

  return resolve(projectPath.replace(/^~/, process.env.HOME ?? '~'));
}

function truncateWithFlag(value: string | undefined, maxLength: number): {
  value?: string;
  truncated?: boolean;
} {
  if (!value) {
    return {};
  }

  return value.length > maxLength
    ? {
        value: `${value.slice(0, maxLength)}…`,
        truncated: true
      }
    : {
        value,
        truncated: false
      };
}

function runGit(rootPath: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: rootPath,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return undefined;
  }
}

function collectRuntimeEnvironment(project: Project): GenericAgentWorkspaceContext['runtimeEnvironment'] {
  const rootPath = resolveProjectPath(project);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const environment: GenericAgentWorkspaceContext['runtimeEnvironment'] = {
    workingDirectory: rootPath,
    platform: process.platform,
    shell: process.env.SHELL ? basename(process.env.SHELL) : undefined,
    currentDate: new Date().toISOString().slice(0, 10),
    timezone
  };

  if (!rootPath) {
    return environment;
  }

  const isGitRepository = runGit(rootPath, ['rev-parse', '--is-inside-work-tree']) === 'true';
  environment.isGitRepository = isGitRepository;
  if (!isGitRepository) {
    return environment;
  }

  const status = truncateWithFlag(runGit(rootPath, ['status', '--short']), MAX_GIT_STATUS_CHARS);
  const recentCommits = truncateWithFlag(runGit(rootPath, ['log', '--oneline', '-5']), MAX_GIT_LOG_CHARS);
  environment.git = {
    root: runGit(rootPath, ['rev-parse', '--show-toplevel']),
    branch: runGit(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    user: runGit(rootPath, ['config', 'user.name']) || undefined,
    status: status.value,
    statusTruncated: status.truncated,
    recentCommits: recentCommits.value,
    recentCommitsTruncated: recentCommits.truncated
  };

  return environment;
}

function readJsonFile(rootPath: string, relativePath: string): Record<string, unknown> | undefined {
  const absolutePath = resolve(rootPath, relativePath);
  if (!isPathInsideRoot(rootPath, absolutePath) || !existsSync(absolutePath)) {
    return undefined;
  }
  try {
    const fileStat = statSync(absolutePath);
    if (!fileStat.isFile() || fileStat.size > 300_000) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function detectPackageManager(rootPath: string): GenericProjectContextIndex['packageManager'] {
  if (existsSync(resolve(rootPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(rootPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(resolve(rootPath, 'bun.lockb')) || existsSync(resolve(rootPath, 'bun.lock'))) return 'bun';
  if (existsSync(resolve(rootPath, 'package-lock.json')) || existsSync(resolve(rootPath, 'package.json'))) return 'npm';
  return undefined;
}

function collectPackageJsonEntrypoints(packageJson: Record<string, unknown>): Array<{ path: string; reason: string }> {
  const entrypoints: Array<{ path: string; reason: string }> = [];
  for (const key of ['main', 'module', 'browser']) {
    const value = stringFromUnknown(packageJson[key]);
    if (value) {
      entrypoints.push({ path: value.replace(/^\.\//, ''), reason: `package.json ${key}` });
    }
  }
  const bin = packageJson.bin;
  if (typeof bin === 'string') {
    entrypoints.push({ path: bin.replace(/^\.\//, ''), reason: 'package.json bin' });
  } else {
    for (const value of Object.values(recordFromUnknown(bin))) {
      const path = stringFromUnknown(value);
      if (path) {
        entrypoints.push({ path: path.replace(/^\.\//, ''), reason: 'package.json bin' });
      }
    }
  }
  const exportsField = packageJson.exports;
  const visitExports = (value: unknown): void => {
    if (entrypoints.length >= MAX_CONTEXT_INDEX_ENTRYPOINTS) {
      return;
    }
    if (typeof value === 'string') {
      entrypoints.push({ path: value.replace(/^\.\//, ''), reason: 'package.json exports' });
      return;
    }
    for (const child of Object.values(recordFromUnknown(value))) {
      visitExports(child);
    }
  };
  visitExports(exportsField);
  return entrypoints;
}

function collectExistingEntrypoints(rootPath: string, candidates: Array<{ path: string; reason: string }>): Array<{ path: string; reason: string }> {
  const seen = new Set<string>();
  const entrypoints: Array<{ path: string; reason: string }> = [];
  for (const candidate of candidates) {
    const normalized = candidate.path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || seen.has(normalized)) {
      continue;
    }
    const absolutePath = resolve(rootPath, normalized);
    if (!isPathInsideRoot(rootPath, absolutePath) || !existsSync(absolutePath)) {
      continue;
    }
    try {
      if (!statSync(absolutePath).isFile()) {
        continue;
      }
      seen.add(normalized);
      entrypoints.push({ path: normalized, reason: candidate.reason });
    } catch {
      continue;
    }
    if (entrypoints.length >= MAX_CONTEXT_INDEX_ENTRYPOINTS) {
      break;
    }
  }
  return entrypoints;
}

function collectUnitySceneEntrypoints(rootPath: string): Array<{ path: string; reason: string }> {
  const assetsPath = resolve(rootPath, 'Assets');
  if (!existsSync(assetsPath)) {
    return [];
  }
  try {
    return readdirSync(assetsPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.unity$/i.test(entry.name))
      .slice(0, 6)
      .map((entry) => ({ path: `Assets/${entry.name}`, reason: 'Unity scene' }));
  } catch {
    return [];
  }
}

function collectProjectContextIndex(project: Project): GenericProjectContextIndex | undefined {
  const rootPath = resolveProjectPath(project);
  if (!rootPath || !existsSync(rootPath)) {
    return undefined;
  }

  const index: GenericProjectContextIndex = {
    generatedAt: new Date().toISOString(),
    packageManager: detectPackageManager(rootPath),
    manifests: [],
    scripts: [],
    testCommands: [],
    dependencies: [],
    entrypoints: [],
    configFiles: [],
    recentFiles: []
  };

  const addDependency = (name: string, version: unknown, kind: GenericProjectContextIndex['dependencies'][number]['kind'], source: string): void => {
    if (index.dependencies.length >= MAX_CONTEXT_INDEX_DEPENDENCIES || typeof version !== 'string') {
      index.truncated = index.dependencies.length >= MAX_CONTEXT_INDEX_DEPENDENCIES || index.truncated;
      return;
    }
    index.dependencies.push({ name, version, kind, source });
  };

  const packageJson = readJsonFile(rootPath, 'package.json');
  if (packageJson) {
    const packageName = stringFromUnknown(packageJson.name);
    index.manifests.push({ path: 'package.json', kind: 'node', name: packageName });
    const scripts = recordFromUnknown(packageJson.scripts);
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== 'string') continue;
      index.scripts.push({ name, command, source: 'package.json' });
      if (/test|spec|e2e|check|build|typecheck|lint/i.test(name) || /\b(test|vitest|jest|playwright|tsc|eslint)\b/i.test(command)) {
        index.testCommands.push({ name, command, source: 'package.json' });
      }
    }
    for (const [name, version] of Object.entries(recordFromUnknown(packageJson.dependencies))) {
      addDependency(name, version, 'runtime', 'package.json');
    }
    for (const [name, version] of Object.entries(recordFromUnknown(packageJson.devDependencies))) {
      addDependency(name, version, 'dev', 'package.json');
    }
    for (const [name, version] of Object.entries(recordFromUnknown(packageJson.peerDependencies))) {
      addDependency(name, version, 'peer', 'package.json');
    }
    index.entrypoints.push(...collectPackageJsonEntrypoints(packageJson));
  }

  const unityManifest = readJsonFile(rootPath, 'Packages/manifest.json');
  if (unityManifest) {
    index.manifests.push({ path: 'Packages/manifest.json', kind: 'unity' });
    for (const [name, version] of Object.entries(recordFromUnknown(unityManifest.dependencies))) {
      addDependency(name, version, 'unity', 'Packages/manifest.json');
    }
  }

  index.configFiles = CONTEXT_INDEX_CONFIG_CANDIDATES
    .filter((candidate) => existsSync(resolve(rootPath, candidate)))
    .slice(0, MAX_CONTEXT_INDEX_CONFIG_FILES);

  index.entrypoints = collectExistingEntrypoints(rootPath, [
    ...index.entrypoints,
    ...CONTEXT_INDEX_ENTRYPOINT_CANDIDATES.map((path) => ({ path, reason: 'common entrypoint' })),
    ...collectUnitySceneEntrypoints(rootPath)
  ]);

  const gitStatus = runGit(rootPath, ['status', '--short']);
  if (gitStatus) {
    index.recentFiles = gitStatus
      .split('\n')
      .map((line) => {
        const status = line.slice(0, 2).trim() || line.slice(0, 2);
        const path = line.slice(3).trim().replace(/^"|"$/g, '').split(' -> ').at(-1) ?? '';
        return path ? { status, path } : undefined;
      })
      .filter((file): file is { path: string; status: string } => Boolean(file))
      .slice(0, MAX_CONTEXT_INDEX_RECENT_FILES);
  }

  return index;
}

export function formatProjectContextIndexSummary(index: GenericProjectContextIndex | undefined): string {
  if (!index) {
    return '';
  }
  return [
    index.packageManager ? `Package manager: ${index.packageManager}` : '',
    index.manifests.length ? `Manifests: ${index.manifests.map((manifest) => manifest.path).join(', ')}` : '',
    index.scripts.length ? `Scripts: ${index.scripts.map((script) => `${script.name}=${script.command}`).slice(0, 12).join('; ')}` : '',
    index.testCommands.length ? `Validation commands: ${index.testCommands.map((script) => `${script.name}=${script.command}`).slice(0, 8).join('; ')}` : '',
    index.entrypoints.length ? `Entrypoints: ${index.entrypoints.map((entrypoint) => `${entrypoint.path} (${entrypoint.reason})`).join(', ')}` : '',
    index.configFiles.length ? `Config files: ${index.configFiles.slice(0, 12).join(', ')}` : '',
    index.recentFiles.length ? `Recent changes: ${index.recentFiles.map((file) => `${file.status} ${file.path}`).join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

function isPathInsideRoot(rootPath: string, absolutePath: string): boolean {
  return absolutePath === rootPath || absolutePath.startsWith(`${rootPath}/`);
}

function normalizeInstructionPathToken(token: string): string | undefined {
  const normalized = token
    .trim()
    .replace(/^[@'"`({\[<]+|['"`)}\]>,.;]+$/g, '')
    .replace(/:(\d+)(:\d+)?$/, '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');

  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized.includes('://')) {
    return undefined;
  }
  if (normalized.split('/').includes('..') || /\s/.test(normalized)) {
    return undefined;
  }
  if (!normalized.includes('/') && !/\.[A-Za-z0-9]{1,12}$/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function extractInstructionPathTokens(message = ''): string[] {
  const rawTokens = [
    ...[...message.matchAll(/`([^`\n]{1,180})`/g)].map((match) => match[1]),
    ...[...message.matchAll(/@((?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)(?=\s|$|[,，。；;:])/g)].map((match) => match[1]),
    ...[...message.matchAll(/\b((?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?::\d+(?::\d+)?)?)\b/g)].map((match) => match[1]),
    ...[...message.matchAll(/\b([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?)\b/g)].map((match) => match[1])
  ];

  return [...new Set(
    rawTokens
      .map((token) => normalizeInstructionPathToken(token))
      .filter((token): token is string => Boolean(token))
  )].slice(0, MAX_PROJECT_INSTRUCTION_PATH_TOKENS);
}

function resolveInstructionDirectoriesForToken(rootPath: string, token: string): string[] {
  const absolutePath = resolve(rootPath, token);
  if (!isPathInsideRoot(rootPath, absolutePath)) {
    return [];
  }

  let relativeDirectory = token;
  try {
    const fileStat = statSync(absolutePath);
    if (fileStat.isFile()) {
      relativeDirectory = dirname(token);
    } else if (!fileStat.isDirectory()) {
      return [];
    }
  } catch {
    const lastSegment = token.split('/').at(-1) ?? token;
    relativeDirectory = lastSegment.includes('.') ? dirname(token) : token;
  }

  const normalizedDirectory = relativeDirectory.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalizedDirectory || normalizedDirectory === '.') {
    return [];
  }

  const segments = normalizedDirectory.split('/').filter(Boolean);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

function collectInstructionDirectories(rootPath: string, message?: string): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();

  for (const token of extractInstructionPathTokens(message)) {
    for (const directory of resolveInstructionDirectoriesForToken(rootPath, token)) {
      const absolutePath = resolve(rootPath, directory);
      if (!isPathInsideRoot(rootPath, absolutePath) || seen.has(directory)) {
        continue;
      }
      seen.add(directory);
      directories.push(directory);
    }
  }

  return directories;
}

export function collectProjectInstructions(
  project: Project,
  message?: string
): GenericAgentWorkspaceContext['projectInstructions'] {
  const rootPath = resolveProjectPath(project);
  if (!rootPath) {
    return [];
  }

  const instructions: GenericAgentWorkspaceContext['projectInstructions'] = [];
  const seenInstructionPaths = new Set<string>();
  let totalChars = 0;

  const addInstruction = (candidate: string): void => {
    if (instructions.length >= MAX_PROJECT_INSTRUCTION_FILES || totalChars >= MAX_PROJECT_INSTRUCTION_TOTAL_CHARS) {
      return;
    }

    const absolutePath = resolve(rootPath, candidate);
    const seenKey = absolutePath.toLowerCase();
    if (!isPathInsideRoot(rootPath, absolutePath) || seenInstructionPaths.has(seenKey)) {
      return;
    }

    try {
      if (!existsSync(absolutePath)) {
        return;
      }
      const fileStat = statSync(absolutePath);
      if (!fileStat.isFile() || fileStat.size > 200_000) {
        return;
      }

      const rawContent = readFileSync(absolutePath, 'utf8').trim();
      if (!rawContent) {
        return;
      }

      const remaining = MAX_PROJECT_INSTRUCTION_TOTAL_CHARS - totalChars;
      const maxChars = Math.min(MAX_PROJECT_INSTRUCTION_FILE_CHARS, remaining);
      const truncated = rawContent.length > maxChars;
      const content = truncated ? `${rawContent.slice(0, maxChars)}…` : rawContent;
      seenInstructionPaths.add(seenKey);
      instructions.push({
        path: candidate,
        content,
        truncated
      });
      totalChars += content.length;
    } catch {
      // Ignore unreadable instruction files; normal workspace context should still work.
    }
  };

  for (const candidate of PROJECT_INSTRUCTION_CANDIDATES) {
    addInstruction(candidate);
  }

  for (const directory of collectInstructionDirectories(rootPath, message)) {
    for (const candidate of SUBDIRECTORY_PROJECT_INSTRUCTION_CANDIDATES) {
      addInstruction(`${directory}/${candidate}`);
    }
  }

  return instructions;
}

export function buildGenericWorkspaceContext(
  project: Project,
  plugins: McpPlugin[],
  sessionId?: string,
  message?: string
): GenericAgentWorkspaceContext {
  const ensured = ensureProjectSessions(project);
  const activeSession =
    ensured.sessions.find((session) => session.id === (sessionId ?? ensured.activeSessionId)) ??
    getActiveProjectSession(ensured);
  const allTurns = buildSessionConversationTurns(activeSession.chat, Number.MAX_SAFE_INTEGER);
  const recentTurns = allTurns.slice(-6);
  const archivedTurns = allTurns.slice(0, -6);

  const enabledSkills = (ensured.agentPolicy?.skills ?? []).filter((skill) => skill.enabled);
  const filesystemSkills = buildAgentSkillRegistry({
    projectPath: ensured.engine?.projectPath
  });
  const activeFilesystemSkills = resolveAgentSkillActivations({
    projectPath: ensured.engine?.projectPath,
    message
  });

  return {
    projectId: ensured.id,
    projectName: ensured.name,
    projectPath: ensured.engine?.projectPath,
    platform: ensured.engine?.platform,
    runtimeEnvironment: collectRuntimeEnvironment(ensured),
    projectBrief: ensured.contextSummary?.projectBrief || ensured.blueprint?.premise || ensured.pitch,
    currentGoal: ensured.contextSummary?.currentGoal,
    projectContextIndex: collectProjectContextIndex(ensured),
    runtimeSummary: ensured.runtimeState
      ? [
          `projectExists=${ensured.runtimeState.projectExists}`,
          `projectOpen=${ensured.runtimeState.projectOpen}`,
          `bridgeInstalled=${ensured.runtimeState.bridgeInstalled}`,
          ensured.runtimeState.activeSceneSummary ? `activeScene=${ensured.runtimeState.activeSceneSummary}` : '',
          ensured.runtimeState.recentConsoleSummary ? `console=${ensured.runtimeState.recentConsoleSummary}` : ''
        ].filter(Boolean).join('; ')
      : undefined,
    executionPlanSummary: ensured.currentExecutionPlan
      ? [
          ensured.currentExecutionPlan.summary,
          ...ensured.currentExecutionPlan.actions.slice(0, 6).map((action) =>
            `${action.status}: ${action.pluginKind}/${action.title} -> ${action.objective}`
          )
        ].join('\n')
      : undefined,
    activeSessionId: activeSession.id,
    sessionMode: DEFAULT_PROJECT_SESSION_MODE,
    sessionEffort: activeSession.runtimeOverrides?.effort ?? 'auto',
    archivedTurnCount: archivedTurns.length,
    archivedSummary: summarizeArchivedConversationTurns(archivedTurns),
    recentTurns,
    recentMessages: activeSession.chat.slice(-10).map((message) => ({
      role: message.role,
      content: trimContent(getChatMessageContextText(message)),
      createdAt: message.createdAt
    })),
    crossSessionSummaries: [],
    relatedSessionEvidence: [],
    projectInstructions: collectProjectInstructions(ensured, message),
    toolContext: {
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        kind: plugin.kind,
        enabled: plugin.enabled,
        hasEndpoint: Boolean(plugin.baseUrl?.trim())
      })),
      skills: enabledSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        trigger: skill.trigger,
        instruction: skill.instruction,
        enabled: skill.enabled,
        source: skill.source,
        sourceId: skill.sourceId,
        dependencies: skill.dependencies,
        examples: skill.examples
      })),
      skillIndex: filesystemSkills.index,
      activeSkills: activeFilesystemSkills
    }
  };
}
