import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter as pathDelimiter, join } from 'node:path';
import type {
  McpServerConfig as ClaudeAgentMcpServerConfig,
  PermissionMode as ClaudeAgentPermissionMode
} from '@anthropic-ai/claude-agent-sdk';
import {
  type AiProvider,
  type ClaudeContextSummaryCoverage
} from '../../../../shared/types';
import { makeId } from '../../../../shared/utils';
import { buildBuiltinAgentMcpServers } from '../builtin-mcp';
import {
  resolveProviderForClaudeCode,
  toClaudeCodeEnv
} from '../provider-resolver';
import type { GenericAgentRuntimeParams } from '../types';
import type {
  ClaudeShadowHome,
  ClaudeSdkSubprocessEnv,
  ResolvedClaudeCodeProvider,
  ClaudeMcpProfile
} from './types';
import {
  CLAUDE_ENV_MANAGED_KEYS,
  CLAUDE_NATIVE_WEB_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  CLAUDE_WRITE_TOOLS,
  getClaudeRuntimeSession
} from './constants';
import {
  buildExpandedPath,
  getPathFromEnv,
  resolveClaudeCodeExecutable
} from './executable-resolver';
import {
  shouldUseClaudeNativeWeb,
  createSystemPrompt,
  createUserPrompt
} from './prompt-builder';
import {
  resolveClaudeCodeProvider,
  resolveClaudeMcpProfile
} from './runtime';

function getAllowedTools(allowWriteTools: boolean, includeNativeWebTools: boolean): string[] {
  const readTools = includeNativeWebTools
    ? [...CLAUDE_READ_ONLY_TOOLS, ...CLAUDE_NATIVE_WEB_TOOLS]
    : [...CLAUDE_READ_ONLY_TOOLS];
  return allowWriteTools
    ? [...readTools, ...CLAUDE_WRITE_TOOLS]
    : readTools;
}

function normalizeAnthropicBaseUrl(url: string): string | undefined {
  const cleaned = url.trim().replace(/\/+$/, '');
  return cleaned || undefined;
}

function resolveClaudeCliModel(provider?: AiProvider): string | undefined {
  const resolved = resolveClaudeCodeProvider(provider);
  return resolved.canUseClaudeCode ? resolved.model : undefined;
}

function deleteManagedClaudeProviderEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_') || CLAUDE_ENV_MANAGED_KEYS.includes(key)) {
      delete env[key];
    }
  }
}

function applyResolvedClaudeCodeProviderEnv(
  baseEnv: NodeJS.ProcessEnv,
  resolved: ResolvedClaudeCodeProvider,
  options: { cleanUnsupportedProvider?: boolean } = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  if (!resolved.provider) {
    return env;
  }

  if (!resolved.injectAnthropicEnv) {
    if (options.cleanUnsupportedProvider) {
      deleteManagedClaudeProviderEnv(env);
    }
    return env;
  }

  deleteManagedClaudeProviderEnv(env);

  const apiKey = resolved.provider.apiKey.trim();
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
  }

  if (resolved.baseUrl) {
    env.ANTHROPIC_BASE_URL = resolved.baseUrl;
  }

  const roleModels = resolved.roleModels;
  if (roleModels.default) {
    env.ANTHROPIC_MODEL = roleModels.default;
  }
  if (roleModels.reasoning) {
    env.ANTHROPIC_REASONING_MODEL = roleModels.reasoning;
  }
  if (roleModels.small) {
    env.ANTHROPIC_SMALL_FAST_MODEL = roleModels.small;
  }
  if (roleModels.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = roleModels.haiku;
  }
  if (roleModels.sonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = roleModels.sonnet;
  }
  if (roleModels.opus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = roleModels.opus;
  }

  return env;
}

export function buildClaudeCodeCliEnv(provider: AiProvider | undefined, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return toClaudeCodeEnv(baseEnv, resolveProviderForClaudeCode(provider));
}

function resolveClaudeCodeResumeSession(params: GenericAgentRuntimeParams, cwd: string): string | undefined {
  const activeSession = getClaudeRuntimeSession(params);
  const sessionId = activeSession.runtimeOverrides?.claudeCodeSessionId?.trim();
  const sessionCwd = activeSession.runtimeOverrides?.claudeCodeSessionCwd?.trim();

  if (!sessionId || !sessionCwd || sessionCwd !== cwd) {
    return undefined;
  }

  return sessionId;
}

function resolveClaudeEffort(effort: GenericAgentRuntimeParams['context']['sessionEffort']): string | undefined {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return effort;
    case 'xhigh':
      return 'xhigh';
    default:
      return undefined;
  }
}

export function createClaudeCodeCliArgs(params: GenericAgentRuntimeParams, allowWriteTools: boolean, options: {
  resumeSessionId?: string;
  claudeContextSummaryOverride?: string;
  claudeContextSummaryCoverageOverride?: ClaudeContextSummaryCoverage;
} = {}): string[] {
  const useClaudeNativeWeb = shouldUseClaudeNativeWeb(params.provider);
  const profile = resolveClaudeMcpProfile(params, {
    allowWriteTools,
    supportsHostControlledWrites: false
  });
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--append-system-prompt',
    createSystemPrompt(params.provider, profile),
    '--permission-mode',
    allowWriteTools ? 'bypassPermissions' : 'dontAsk',
    '--allowedTools',
    getAllowedTools(allowWriteTools, profile.includeWeb ? useClaudeNativeWeb : false).join(',')
  ];

  if (!useClaudeNativeWeb) {
    args.push('--disallowedTools', CLAUDE_NATIVE_WEB_TOOLS.join(','));
  }

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }

  const effort = resolveClaudeEffort(params.context.sessionEffort);
  if (effort) {
    args.push('--effort', effort);
  }

  const model = resolveClaudeCliModel(params.provider);
  if (model) {
    args.push('--model', model);
  }

  args.push(createUserPrompt(params, {
    includeRecentTurns: !options.resumeSessionId,
    claudeContextSummaryOverride: options.claudeContextSummaryOverride,
    claudeContextSummaryCoverageOverride: options.claudeContextSummaryCoverageOverride
  }));
  return args;
}

function sanitizeEnvValue(value: string): string {
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function sanitizeEnvRecord(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      clean[key] = sanitizeEnvValue(value);
    }
  }
  return clean;
}

function findGitBashPath(baseEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }

  const pathValue = buildExpandedPath(baseEnv) ?? getPathFromEnv(baseEnv) ?? '';
  const pathCandidate = pathValue
    .split(pathDelimiter)
    .map((directory) => join(directory, 'bash.exe'))
    .find((candidate) => existsSync(candidate) && /\\git\\(?:usr\\bin|bin)\\bash\.exe$/i.test(candidate));
  if (pathCandidate) {
    return pathCandidate;
  }

  const roots = [
    baseEnv['ProgramFiles'],
    baseEnv['ProgramFiles(x86)'],
    baseEnv.LOCALAPPDATA ? join(baseEnv.LOCALAPPDATA, 'Programs') : undefined
  ].filter((value): value is string => Boolean(value));
  for (const root of roots) {
    for (const candidate of [
      join(root, 'Git', 'bin', 'bash.exe'),
      join(root, 'Git', 'usr', 'bin', 'bash.exe')
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stripClaudeAuthEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings.env;
  if (!isRecord(env)) {
    return settings;
  }
  const cleanedEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !CLAUDE_ENV_MANAGED_KEYS.includes(key))
  );
  return {
    ...settings,
    env: cleanedEnv
  };
}

function isClaudeAuthHomeEntry(name: string): boolean {
  const normalized = name.toLowerCase();
  if (normalized === 'settings.json' || normalized === 'claude.json') {
    return true;
  }
  return /(auth|token|credential|oauth|account|session|switch)/i.test(normalized);
}

function mirrorClaudeHomeEntry(realPath: string, shadowPath: string): void {
  try {
    const stat = lstatSync(realPath);
    try {
      if (process.platform === 'win32' && stat.isDirectory()) {
        symlinkSync(realPath, shadowPath, 'junction');
      } else {
        symlinkSync(realPath, shadowPath);
      }
      return;
    } catch {
      // Fall back below.
    }

    if (stat.isDirectory()) {
      cpSync(realPath, shadowPath, { recursive: true, dereference: false });
    } else {
      copyFileSync(realPath, shadowPath);
    }
  } catch {
    // Shadowing is best-effort. Missing optional user config should not fail a run.
  }
}

function createClaudeShadowHome(options: { stripAuth: boolean; baseEnv?: NodeJS.ProcessEnv }): ClaudeShadowHome {
  const realHome = options.baseEnv?.HOME || homedir();
  if (!options.stripAuth) {
    return {
      home: realHome,
      isShadow: false,
      cleanup: () => undefined
    };
  }

  const realClaudeDir = join(realHome, '.claude');
  const settings = readJsonObject(join(realClaudeDir, 'settings.json')) ?? readJsonObject(join(realClaudeDir, 'claude.json'));
  const rootClaudeJson = readJsonObject(join(realHome, '.claude.json'));

  const shadowRoot = mkdtempSync(join(tmpdir(), 'funplay-shadow-claude-'));
  const shadowClaudeDir = join(shadowRoot, '.claude');
  try {
    mkdirSync(shadowClaudeDir, { recursive: true });
    if (existsSync(realClaudeDir)) {
      for (const name of readdirSync(realClaudeDir)) {
        if (isClaudeAuthHomeEntry(name)) {
          continue;
        }
        mirrorClaudeHomeEntry(join(realClaudeDir, name), join(shadowClaudeDir, name));
      }
    }

    writeFileSync(
      join(shadowClaudeDir, 'settings.json'),
      JSON.stringify(settings ? stripClaudeAuthEnv(settings) : {}, null, 2)
    );
    if (rootClaudeJson) {
      writeFileSync(join(shadowRoot, '.claude.json'), JSON.stringify(stripClaudeAuthEnv(rootClaudeJson), null, 2));
    }
  } catch {
    try {
      rmSync(shadowRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
    return {
      home: realHome,
      isShadow: false,
      cleanup: () => undefined
    };
  }

  let cleanedUp = false;
  return {
    home: shadowRoot,
    isShadow: true,
    cleanup: () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      try {
        rmSync(shadowRoot, { recursive: true, force: true });
      } catch {
        // The OS temp cleaner can reclaim it later.
      }
    }
  };
}

export function buildClaudeCodeSdkEnv(provider: AiProvider | undefined, baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const clean = sanitizeEnvRecord(toClaudeCodeEnv(baseEnv, resolveProviderForClaudeCode(provider)));
  const expandedPath = buildExpandedPath(baseEnv);
  if (expandedPath) {
    clean.PATH = sanitizeEnvValue(expandedPath);
  }
  if (process.platform === 'win32' && !clean.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashPath = findGitBashPath(baseEnv);
    if (gitBashPath) {
      clean.CLAUDE_CODE_GIT_BASH_PATH = sanitizeEnvValue(gitBashPath);
    }
  }
  delete clean.CLAUDECODE;
  clean.CLAUDE_AGENT_SDK_CLIENT_APP = clean.CLAUDE_AGENT_SDK_CLIENT_APP ?? 'funplay/0.1.0';
  return clean;
}

export function prepareClaudeCodeSdkSubprocessEnv(
  provider: AiProvider | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env
): ClaudeSdkSubprocessEnv {
  const resolved = resolveClaudeCodeProvider(provider);
  const env = buildClaudeCodeSdkEnv(provider, baseEnv);
  const shadow = createClaudeShadowHome({
    stripAuth: resolved.useShadowHome,
    baseEnv
  });
  env.HOME = sanitizeEnvValue(shadow.home);
  env.USERPROFILE = sanitizeEnvValue(shadow.home);
  return {
    env,
    shadow
  };
}

function shouldForceLegacyClaudeCli(): boolean {
  return process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI === '1';
}

export function resolveClaudeAgentSdkExecutablePath(baseEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveClaudeCodeExecutable(baseEnv).sdkExecutablePath;
}

function resolveClaudeSdkPermissionMode(params: GenericAgentRuntimeParams, allowWriteTools: boolean): ClaudeAgentPermissionMode {
  if (params.permission.mode === 'full-access') {
    return 'bypassPermissions';
  }
  return allowWriteTools ? 'acceptEdits' : 'dontAsk';
}

function resolveClaudeSdkSettingSources(provider?: AiProvider): Array<'user' | 'project' | 'local'> {
  return resolveClaudeCodeProvider(provider).settingSources;
}

function safeMcpServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || `server-${makeId('mcp')}`;
}

function normalizeMcpServerConfig(value: unknown): ClaudeAgentMcpServerConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.command === 'string' && value.command.trim()) {
    return {
      type: 'stdio',
      command: value.command.trim(),
      args: Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === 'string') : undefined,
      env: isRecord(value.env)
        ? Object.fromEntries(Object.entries(value.env).filter(([, envValue]) => typeof envValue === 'string')) as Record<string, string>
        : undefined
    } as ClaudeAgentMcpServerConfig;
  }

  if (typeof value.url === 'string' && value.url.trim()) {
    const transport = value.type === 'sse' ? 'sse' : 'http';
    return {
      type: transport,
      url: value.url.trim(),
      headers: isRecord(value.headers)
        ? Object.fromEntries(Object.entries(value.headers).filter(([, headerValue]) => typeof headerValue === 'string')) as Record<string, string>
        : undefined
    } as ClaudeAgentMcpServerConfig;
  }

  return undefined;
}

function resolveMcpConfigEnvPlaceholders(value: string): string {
  return value.replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_, key: string) => process.env[key] ?? '');
}

function resolveMcpServerEnvPlaceholders(config: ClaudeAgentMcpServerConfig): ClaudeAgentMcpServerConfig {
  const next = { ...config } as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'string') {
      next[key] = resolveMcpConfigEnvPlaceholders(value);
      continue;
    }
    if (Array.isArray(value)) {
      next[key] = value.map((item) => (typeof item === 'string' ? resolveMcpConfigEnvPlaceholders(item) : item));
      continue;
    }
    if (isRecord(value)) {
      next[key] = Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          typeof entryValue === 'string' ? resolveMcpConfigEnvPlaceholders(entryValue) : entryValue
        ])
      );
    }
  }
  return next as unknown as ClaudeAgentMcpServerConfig;
}

function loadProjectMcpServers(cwd: string): Record<string, ClaudeAgentMcpServerConfig> {
  const configPath = join(cwd, '.mcp.json');
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    const source = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
    if (!isRecord(source)) {
      return {};
    }

    const servers: Record<string, ClaudeAgentMcpServerConfig> = {};
    for (const [name, config] of Object.entries(source)) {
      const normalized = normalizeMcpServerConfig(config);
      if (normalized) {
        servers[safeMcpServerName(name)] = resolveMcpServerEnvPlaceholders(normalized);
      }
    }
    return servers;
  } catch {
    return {};
  }
}

function buildFunplayMcpServers(params: GenericAgentRuntimeParams, cwd: string, profile: ClaudeMcpProfile): Record<string, ClaudeAgentMcpServerConfig> {
  const servers: Record<string, ClaudeAgentMcpServerConfig> = {};
  for (const plugin of params.plugins.filter((item) => item.enabled && item.baseUrl.trim())) {
    servers[safeMcpServerName(`funplay-${plugin.kind}-${plugin.id}`)] = {
      type: 'http',
      url: plugin.baseUrl.trim()
    } as ClaudeAgentMcpServerConfig;
  }
  return {
    ...loadProjectMcpServers(cwd),
    ...servers,
    ...buildBuiltinAgentMcpServers(cwd, {
      includeWeb: profile.includeWeb,
      includeMemory: profile.includeMemory,
      includeMedia: profile.includeMedia,
      includeImageGeneration: profile.includeImageGeneration,
      includeNotifications: profile.includeNotifications,
      includeWorkspaceWrite: profile.includeWorkspaceWrite,
      project: params.project,
      checkpointSnapshotId: params.checkpointSnapshotId
    })
  };
}

export {
  getAllowedTools,
  resolveClaudeCliModel,
  resolveClaudeEffort,
  resolveClaudeCodeResumeSession,
  shouldForceLegacyClaudeCli,
  resolveClaudeSdkPermissionMode,
  resolveClaudeSdkSettingSources,
  isRecord,
  buildFunplayMcpServers
};
