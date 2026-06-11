import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  DEFAULT_PROJECT_SESSION_MODE,
  buildSessionConversationTurns,
  ensureProjectSessions,
  getActiveProjectSession,
  getChatMessageContextText,
  summarizeArchivedConversationTurns
} from '../../../shared/project-sessions';
import type { AgentOperationRecord, ChatMessage, McpPlugin, Project } from '../../../shared/types';
import type { GenericAgentWorkspaceContext, GenericProjectContextIndex } from './types';
import { buildAgentSkillRegistry, resolveAgentSkillActivations } from './skill-registry';

type GenericWorkspaceEvidence = NonNullable<GenericAgentWorkspaceContext['workspaceEvidence']>;

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
const MAX_CROSS_SESSION_SUMMARIES = 6;
const MAX_RELATED_SESSION_EVIDENCE = 6;
const MAX_WORKSPACE_EVIDENCE_ITEMS = 8;
const MAX_WORKSPACE_EVIDENCE_CHARS = 1800;
const MAX_WORKSPACE_EVIDENCE_FILE_BYTES = 240_000;
const MAX_RECENT_VERIFICATION_FAILURE_FILES = 4;
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
  'vitest.config.ts',
  'vitest.config.js',
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'cypress.config.ts',
  'cypress.config.js',
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

function parsePackageManagerSpec(value: unknown): GenericProjectContextIndex['packageManager'] {
  const spec = stringFromUnknown(value);
  if (!spec) {
    return undefined;
  }
  const match = /^(npm|pnpm|yarn|bun)(?:@|$)/i.exec(spec);
  const name = match?.[1]?.toLowerCase();
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun'
    ? name
    : undefined;
}

function detectPackageManager(rootPath: string): GenericProjectContextIndex['packageManager'] {
  const packageJson = readJsonFile(rootPath, 'package.json');
  const declared = parsePackageManagerSpec(packageJson?.packageManager);
  if (declared) return declared;
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
  // Cross-platform containment check. The old `startsWith(`${rootPath}/`)` broke
  // on Windows, where resolve() yields backslash paths and the forward-slash
  // prefix never matched. path.relative normalises separators per platform.
  if (absolutePath === rootPath) {
    return true;
  }
  const rel = relative(rootPath, absolutePath);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function normalizeWorkspaceEvidencePath(rootPath: string, token: string): string | undefined {
  const cleaned = token
    .trim()
    .replace(/^file:\/\//, '')
    .replace(/^[@'"`({\[<]+|['"`)}\]>,.;]+$/g, '')
    .replace(/:(\d+)(:\d+)?$/, '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');

  if (!cleaned || cleaned.includes('://')) {
    return undefined;
  }

  const absolutePath = cleaned.startsWith('/') ? resolve(cleaned) : resolve(rootPath, cleaned);
  if (!isPathInsideRoot(rootPath, absolutePath)) {
    return undefined;
  }

  const normalized = relative(rootPath, absolutePath).replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('..') || normalized.split('/').includes('..')) {
    return undefined;
  }

  return normalized;
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

function parseReferenceLine(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function extractPathReferencesFromText(text = ''): Array<{ path: string; line?: number }> {
  const references: Array<{ path: string; line?: number }> = [];
  const seen = new Set<string>();
  const pattern = /((?:file:\/\/)?(?:\/|\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?::(\d+)(?::\d+)?)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && references.length < MAX_RECENT_VERIFICATION_FAILURE_FILES * 3) {
    const path = match[1] ?? '';
    const line = parseReferenceLine(match[2]);
    const key = `${path}:${line ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    references.push(line !== undefined ? { path, line } : { path });
  }
  return references;
}

function isRecentVerificationFailureOperation(record: AgentOperationRecord): boolean {
  if (record.status !== 'failed') {
    return false;
  }
  const haystack = [
    record.id,
    record.phase,
    record.title,
    record.target
  ].filter(Boolean).join('\n').toLowerCase();
  return haystack.includes('native_active_verification') ||
    haystack.includes('verification_handoff') ||
    haystack.includes('active verification');
}

function extractVerificationReferencesFromOperation(record: AgentOperationRecord): Array<{ path: string; line?: number }> {
  const references: Array<{ path: string; line?: number }> = [];
  const seen = new Set<string>();
  const push = (path: string | undefined, line?: number): void => {
    if (!path) {
      return;
    }
    const key = `${path}:${line ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    references.push(line !== undefined ? { path, line } : { path });
  };

  const input = recordFromUnknown(record.input);
  const diagnosis = recordFromUnknown(input.diagnosis);
  const diagnosisReferences = Array.isArray(diagnosis.references) ? diagnosis.references : [];
  for (const reference of diagnosisReferences) {
    const value = recordFromUnknown(reference);
    push(stringFromUnknown(value.path), parseReferenceLine(value.line));
  }

  const evidenceText = [
    record.summary,
    record.errorMessage,
    stringFromUnknown(diagnosis.summary),
    stringFromUnknown(diagnosis.suggestedFocus),
    ...(Array.isArray(diagnosis.evidence) ? diagnosis.evidence.map((value) => typeof value === 'string' ? value : '') : [])
  ].filter(Boolean).join('\n');
  for (const reference of extractPathReferencesFromText(evidenceText)) {
    push(reference.path, reference.line);
  }

  return references;
}

function collectRecentVerificationFailureFiles(messages: ChatMessage[]): Array<{ path: string; line?: number }> {
  const candidates: Array<{ path: string; line?: number }> = [];
  const seen = new Set<string>();
  const push = (candidate: { path: string; line?: number }): void => {
    const key = `${candidate.path}:${candidate.line ?? ''}`;
    if (seen.has(key) || candidates.length >= MAX_RECENT_VERIFICATION_FAILURE_FILES) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  for (const message of messages.slice(-8).reverse()) {
    const operationLog = message.metadata?.operationLog ?? [];
    for (const record of operationLog.slice().reverse()) {
      if (!isRecentVerificationFailureOperation(record)) {
        continue;
      }
      for (const reference of extractVerificationReferencesFromOperation(record)) {
        push(reference);
      }
      if (candidates.length >= MAX_RECENT_VERIFICATION_FAILURE_FILES) {
        return candidates;
      }
    }
  }

  return candidates;
}

function extractContextTerms(message = ''): string[] {
  const normalized = message.toLowerCase();
  const latinTerms = [...normalized.matchAll(/\b[a-z][a-z0-9_-]{2,}\b/g)].map((match) => match[0]);
  const cjkTerms = [...message.matchAll(/[\u4e00-\u9fa5]{2,}/g)].flatMap((match) => {
    const value = match[0];
    return value.length > 8 ? [value.slice(0, 8)] : [value];
  });
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'with',
    'this',
    'that',
    'please',
    'implement',
    'agent'
  ]);
  return [...new Set([...latinTerms, ...cjkTerms].filter((term) => !stopWords.has(term)))]
    .slice(0, 16);
}

function summarizeSessionMessages(messages: string[], maxChars: number): {
  summary: string;
  truncated?: boolean;
} {
  const raw = messages
    .map((content) => content.trim())
    .filter(Boolean)
    .join('\n\n');
  const truncated = truncateWithFlag(raw, maxChars);
  return {
    summary: truncated.value ?? '',
    truncated: truncated.truncated
  };
}

function collectCrossSessionSummaries(
  project: Project,
  activeSessionId: string,
  terms: string[]
): GenericAgentWorkspaceContext['crossSessionSummaries'] {
  return [...(project.sessions ?? [])]
    .filter((session) =>
      session.id !== activeSessionId &&
      session.chat.length > 0 &&
      Boolean(session.runtimeOverrides?.nativeContextSummary)
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_CROSS_SESSION_SUMMARIES)
    .map((session) => {
      const summarySource = session.runtimeOverrides?.nativeContextSummary;
      const summarySourcePreview = summarySource ? truncateWithFlag(summarySource.trim(), 900) : undefined;
      const summarized = summarySourcePreview
        ? {
            summary: summarySourcePreview.value ?? '',
            truncated: summarySourcePreview.truncated
          }
        : summarizeSessionMessages([], 900);
      const matchedTerm = terms.find((term) =>
        `${session.title}\n${summarized.summary}`.toLowerCase().includes(term.toLowerCase())
      );
      return {
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messageCount: session.chat.length,
        latestSummary: summarized.summary,
        source: matchedTerm ? `matched:${matchedTerm}` : summarySource ? 'runtime_summary' : 'recent_messages',
        truncated: summarized.truncated
      };
    });
}

function collectRelatedSessionEvidence(
  project: Project,
  activeSessionId: string,
  terms: string[]
): GenericAgentWorkspaceContext['relatedSessionEvidence'] {
  if (terms.length === 0) {
    return [];
  }
  const evidence: GenericAgentWorkspaceContext['relatedSessionEvidence'] = [];
  for (const session of project.sessions ?? []) {
    if (session.id === activeSessionId || session.chat.length === 0) {
      continue;
    }
    const summarySource = session.runtimeOverrides?.nativeContextSummary;
    if (!summarySource) {
      continue;
    }
    const haystack = summarySource;
    const haystackLower = haystack.toLowerCase();
    const matchedTerm = terms.find((term) => haystackLower.includes(term.toLowerCase()));
    if (!matchedTerm) {
      continue;
    }
    const matchIndex = Math.max(0, haystackLower.indexOf(matchedTerm.toLowerCase()));
    const start = Math.max(0, matchIndex - 280);
    const rawExcerpt = haystack.slice(start, matchIndex + matchedTerm.length + 520).trim();
    const excerpt = truncateWithFlag(rawExcerpt, 900);
    evidence.push({
      sessionId: session.id,
      title: session.title,
      matchedTerm,
      excerpt: excerpt.value ?? '',
      source: 'chat_search',
      truncated: excerpt.truncated || start > 0
    });
  }
  return evidence
    .sort((left, right) => left.title.localeCompare(right.title))
    .slice(0, MAX_RELATED_SESSION_EVIDENCE);
}

function readWorkspaceEvidenceFile(rootPath: string, relativePath: string, line?: number): {
  excerpt?: string;
  truncated?: boolean;
} {
  const normalized = normalizeWorkspaceEvidencePath(rootPath, relativePath);
  if (!normalized) {
    return {};
  }
  const absolutePath = resolve(rootPath, normalized);
  if (!isPathInsideRoot(rootPath, absolutePath) || !existsSync(absolutePath)) {
    return {};
  }
  try {
    const fileStat = statSync(absolutePath);
    if (!fileStat.isFile() || fileStat.size > MAX_WORKSPACE_EVIDENCE_FILE_BYTES) {
      return {};
    }
    const raw = readFileSync(absolutePath, 'utf8');
    if (line !== undefined) {
      const lines = raw.split(/\r?\n/);
      const startIndex = Math.max(0, line - 8);
      const endIndex = Math.min(lines.length, line + 7);
      const excerpt = lines
        .slice(startIndex, endIndex)
        .map((value, index) => `${startIndex + index + 1}: ${value}`)
        .join('\n');
      const truncated = truncateWithFlag(excerpt, MAX_WORKSPACE_EVIDENCE_CHARS);
      return {
        excerpt: truncated.value,
        truncated: truncated.truncated || startIndex > 0 || endIndex < lines.length
      };
    }
    const truncated = truncateWithFlag(raw, MAX_WORKSPACE_EVIDENCE_CHARS);
    return {
      excerpt: truncated.value,
      truncated: truncated.truncated
    };
  } catch {
    return {};
  }
}

function collectWorkspaceEvidence(input: {
  project: Project;
  projectContextIndex?: GenericProjectContextIndex;
  message?: string;
  recentMessages?: Array<{
    content: string;
  }>;
  recentVerificationFailureFiles?: Array<{
    path: string;
    line?: number;
  }>;
  crossSessionSummaries: GenericAgentWorkspaceContext['crossSessionSummaries'];
  relatedSessionEvidence: GenericAgentWorkspaceContext['relatedSessionEvidence'];
}): GenericAgentWorkspaceContext['workspaceEvidence'] {
  const rootPath = resolveProjectPath(input.project);
  const evidence: GenericWorkspaceEvidence = [];
  const seen = new Set<string>();
  const pushEvidence = (item: GenericWorkspaceEvidence[number]): void => {
    const key = `${item.kind}:${item.path ?? item.title ?? item.source}`;
    if (seen.has(key) || evidence.length >= MAX_WORKSPACE_EVIDENCE_ITEMS) {
      return;
    }
    seen.add(key);
    evidence.push(item);
  };

  if (rootPath) {
    const currentMessagePathTokens = extractInstructionPathTokens(input.message);
    const recentMessagePathTokens = [
      ...new Set(
        (input.recentMessages ?? [])
          .slice(-8)
          .flatMap((message) => extractInstructionPathTokens(message.content))
      )
    ];
    const pathCandidates: Array<{
      path: string;
      kind: GenericWorkspaceEvidence[number]['kind'];
      source: string;
      line?: number;
    }> = [
      ...currentMessagePathTokens.map((path) => ({
        path,
        kind: 'message_path' as const,
        source: 'user_message_path'
      })),
      ...(input.recentVerificationFailureFiles ?? []).map((file) => ({
        path: file.path,
        kind: 'verification_failure_file' as const,
        source: 'recent_verification_failure',
        ...(file.line !== undefined ? { line: file.line } : {})
      })),
      ...recentMessagePathTokens.map((path) => ({
        path,
        kind: 'message_path' as const,
        source: 'recent_message_path'
      })),
      ...(input.projectContextIndex?.recentFiles ?? []).map((file) => ({
        path: file.path,
        kind: 'recent_file' as const,
        source: 'git_recent_file'
      })),
      ...(input.projectContextIndex?.entrypoints ?? []).map((entrypoint) => ({
        path: entrypoint.path,
        kind: 'entrypoint' as const,
        source: entrypoint.reason
      }))
    ];

    for (const candidate of pathCandidates) {
      if (evidence.length >= MAX_WORKSPACE_EVIDENCE_ITEMS) {
        break;
      }
      const path = normalizeWorkspaceEvidencePath(rootPath, candidate.path);
      if (!path) {
        continue;
      }
      const file = readWorkspaceEvidenceFile(rootPath, path, candidate.line);
      if (!file.excerpt) {
        continue;
      }
      pushEvidence({
        kind: candidate.kind,
        source: candidate.source,
        path,
        title: candidate.line ? `${path}:${candidate.line}` : path,
        excerpt: file.excerpt,
        truncated: file.truncated
      });
    }
  }

  for (const session of input.relatedSessionEvidence) {
    pushEvidence({
      kind: 'related_session',
      source: session.source ?? 'related_session',
      title: session.title,
      excerpt: session.excerpt,
      truncated: session.truncated
    });
  }

  for (const session of input.crossSessionSummaries) {
    pushEvidence({
      kind: 'session_summary',
      source: session.source ?? 'cross_session_summary',
      title: session.title,
      excerpt: session.latestSummary,
      truncated: session.truncated
    });
  }

  return evidence;
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
  const projectContextIndex = collectProjectContextIndex(ensured);
  const contextTerms = extractContextTerms(message);
  const crossSessionSummaries = collectCrossSessionSummaries(ensured, activeSession.id, contextTerms);
  const relatedSessionEvidence = collectRelatedSessionEvidence(ensured, activeSession.id, contextTerms);
  const recentMessages = activeSession.chat.slice(-10).map((message) => ({
    role: message.role,
    content: trimContent(getChatMessageContextText(message)),
    createdAt: message.createdAt
  }));
  const recentVerificationFailureFiles = collectRecentVerificationFailureFiles(activeSession.chat);
  const workspaceEvidence = collectWorkspaceEvidence({
    project: ensured,
    projectContextIndex,
    message,
    recentMessages,
    recentVerificationFailureFiles,
    crossSessionSummaries,
    relatedSessionEvidence
  });

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
    projectContextIndex,
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
    recentMessages,
    crossSessionSummaries,
    relatedSessionEvidence,
    workspaceEvidence,
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
