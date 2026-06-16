import { existsSync, realpathSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import electron from 'electron';
import type {
  AppState,
  EnvironmentAction,
  EnvironmentActionKind,
  EnvironmentActionResult,
  EnvironmentCheck,
  EnvironmentDiagnostics,
  EngineProjectDimension,
  CocosEngineVariant,
  EnvironmentTask,
  EnvironmentTaskStage,
  EnvironmentTaskStatus,
  InstalledUnityEditorOption,
  McpConnectionSnapshot,
  McpPlugin,
  PlatformChoice,
  ProjectRuntimeState,
  ProjectSetupMode,
  UnitySettings,
  UnityHealthResult,
  UnityReleaseChannel
} from '../../shared/types';
import { checkUnityHealth } from './unity-bridge';
import { listUnityResources, readUnityResource } from './unity-mcp-client';
import { logEngineDebug } from './engine-log';
import {
  checkCocosCliPrerequisites,
  findCocosCliInstallation,
  getCocosCliDir,
  installCocosCli
} from './cocos-cli-installer';
import { nowIso } from '../../shared/utils';
import {
  listInstalledUnityEditors,
  compareUnityVersions,
  versionStrategyLabel,
  buildInstalledUnityEditorOptions,
  selectUnityEditorForTemplate,
  readUnityProjectVersion,
  selectUnityEditorForProject
} from './unity-version';
import {
  environmentTasks,
  createTask,
  completeTask,
  taskStageUpdate,
  reconcileBridgeConnectedTasks,
  bindTaskProjectPath,
  getEnvironmentTaskProjectPath,
  listEnvironmentTasks as listEnvironmentTasksInternal
} from './environment-task-manager';
import {
  startInstallUnityHubTask,
  startInstallUnityEditorTask,
  openUnityProjectDirectly,
  startCreateUnityProjectTask,
  syncDiscoveredUnityMcpEndpoint,
  waitForBridgeAfterOpen
} from './unity-install-tasks';
import {
  DEFAULT_COCOS_MCP_BASE_URL,
  createCocosProjectFromTemplate,
  findCocosCreatorInstallation,
  findCocosDashboardExecutable,
  inspectCocosProject,
  installCocosBridge,
  isCocosBridgeInstalled,
  isCocosProjectCurrentlyOpen,
  openCocosDashboard,
  openCocosProject
} from './agent-platform/cocos-adapter';
import {
  getMcpConnectionSnapshot,
  initializeMcpConnection,
  postMcpJsonRpcForConfig,
  type McpConnectionConfig
} from './mcp-connection-manager';

const execFileAsync = promisify(execFile);
const shell = electron.shell;

export interface UnityVersionRecommendation {
  version: string;
  strategyLabel: string;
}

type UnityHubInstallSource = 'standard' | 'custom';

function normalizeLocalPath(localPath: string): string {
  return localPath.trim().replace(/^~/, process.env.HOME ?? '~');
}

function getStandardUnityHubCandidates(): string[] {
  if (process.platform === 'darwin') {
    return ['/Applications/Unity Hub.app', join(process.env.HOME ?? '', 'Applications/Unity Hub.app')];
  }
  if (process.platform === 'win32') {
    return [
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Unity Hub', 'Unity Hub.exe'),
      join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Unity Hub', 'Unity Hub.exe'),
      join(process.env.LocalAppData ?? '', 'Programs', 'Unity Hub', 'Unity Hub.exe')
    ].filter(Boolean);
  }
  return [
    '/opt/unityhub/unityhub',
    '/usr/bin/unityhub',
    '/usr/local/bin/unityhub',
    join(process.env.HOME ?? '', 'Applications', 'UnityHub.AppImage'),
    join(process.env.HOME ?? '', 'Applications', 'Unity Hub.AppImage')
  ];
}

function getUnityHubCandidates(
  settings?: Pick<UnitySettings, 'unityHubPath'>
): Array<{ path: string; source: UnityHubInstallSource }> {
  const candidates: Array<{ path: string; source: UnityHubInstallSource }> = getStandardUnityHubCandidates().map(
    (path) => ({ path, source: 'standard' })
  );
  const customPath = settings?.unityHubPath ? normalizeLocalPath(settings.unityHubPath) : '';
  if (customPath) {
    candidates.push({ path: customPath, source: 'custom' });
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.path || seen.has(candidate.path)) {
      return false;
    }
    seen.add(candidate.path);
    return true;
  });
}

export function resolveUnityHubBinaryPath(hubPath: string): string {
  if (hubPath.endsWith('.app')) {
    return join(hubPath, 'Contents', 'MacOS', 'Unity Hub');
  }
  const windowsBinary = join(hubPath, 'Unity Hub.exe');
  if (existsSync(windowsBinary)) {
    return windowsBinary;
  }
  const linuxBinary = join(hubPath, 'unityhub');
  if (existsSync(linuxBinary)) {
    return linuxBinary;
  }
  return hubPath;
}

export function isLikelyUnityHubPath(localPath: string): boolean {
  const normalized = normalizeLocalPath(localPath);
  if (!normalized || !existsSync(normalized)) {
    return false;
  }
  const name = basename(normalized).toLowerCase();
  if (['unity hub.app', 'unity hub.exe', 'unityhub', 'unityhub.appimage', 'unity hub.appimage'].includes(name)) {
    return true;
  }
  return (
    existsSync(join(normalized, 'Contents', 'MacOS', 'Unity Hub')) ||
    existsSync(join(normalized, 'Unity Hub.exe')) ||
    existsSync(join(normalized, 'unityhub'))
  );
}

function findUnityHubInstall(
  settings?: Pick<UnitySettings, 'unityHubPath'>
): { path: string; source: UnityHubInstallSource } | null {
  return getUnityHubCandidates(settings).find((candidate) => isLikelyUnityHubPath(candidate.path)) ?? null;
}

export function findUnityEditorInstall(): { installed: boolean; versions: string[] } {
  const editors = listInstalledUnityEditors();
  return {
    installed: editors.length > 0,
    versions: editors.map((editor) => editor.version)
  };
}

export function findUnityEditorAppPath(): string | null {
  return listInstalledUnityEditors()[0]?.appPath ?? null;
}

export function readProjectUnityEditorVersion(projectPath: string): string | null {
  return readUnityProjectVersion(projectPath)?.version ?? null;
}

export function isValidUnityProject(projectPath: string): boolean {
  const normalizedPath = projectPath.trim().replace(/^~/, process.env.HOME ?? '~');
  if (!existsSync(normalizedPath)) {
    return false;
  }

  const hasAssets = existsSync(join(normalizedPath, 'Assets'));
  const hasProjectSettings = existsSync(join(normalizedPath, 'ProjectSettings'));
  const hasPackages = existsSync(join(normalizedPath, 'Packages'));
  return hasProjectSettings && (hasAssets || hasPackages);
}

export function normalizeProjectPath(projectPath: string): string {
  return projectPath.trim().replace(/^~/, process.env.HOME ?? '~');
}

function normalizeProjectPathForCompare(projectPath: string): string {
  const normalized = resolve(normalizeProjectPath(projectPath)).replace(/\/+$/g, '');
  try {
    return existsSync(normalized) ? realpathSync(normalized).replace(/\/+$/g, '') : normalized;
  } catch {
    return normalized;
  }
}

function projectPathsMatch(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && normalizeProjectPathForCompare(left) === normalizeProjectPathForCompare(right));
}

function funplayMcpSettingsPath(projectPath: string): string {
  return join(normalizeProjectPath(projectPath), 'UserSettings', 'FunplayMcpSettings.json');
}

export function resolveTargetProjectPath(input: {
  mode: ProjectSetupMode;
  projectPath: string;
  projectName?: string;
}): string {
  const normalizedBase = normalizeProjectPath(input.projectPath);
  if (input.mode === 'create') {
    const name = (input.projectName ?? '').trim();
    return name ? join(normalizedBase, name) : normalizedBase;
  }
  return normalizedBase;
}

function isUnityProjectCurrentlyOpen(projectPath: string): boolean {
  const normalized = normalizeProjectPath(projectPath);
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
    return output
      .split('\n')
      .some((line) => line.includes('/Unity') && line.includes('-projectPath') && line.includes(normalized));
  } catch {
    return false;
  }
}

function formatCocosDimensionLabel(dimension: EngineProjectDimension): string {
  return dimension === '3d' ? '3D' : '2D';
}

// Resolve the app userData dir for the managed cocos-cli install. Guarded so it
// stays safe outside a running Electron app (e.g. the Node test runner), where
// the COCOS_CLI_DIR override carries the path instead.
function resolveCocosCliUserDataPath(): string {
  try {
    return electron.app.getPath('userData');
  } catch {
    return '';
  }
}

function getCocosDashboardDownloadUrl(): string {
  return 'https://www.cocos.com/en/creator-download';
}

function isCocosEngineMcpPlugin(plugin: McpPlugin | undefined): plugin is McpPlugin {
  return Boolean(plugin && plugin.kind === 'engine' && /\bcocos\b/i.test(`${plugin.name} ${plugin.notes ?? ''}`));
}

function resolveCocosMcpPlugin(state: AppState, enginePluginId?: string): McpPlugin | undefined {
  const requestedPlugin = enginePluginId ? state.mcpPlugins.find((item) => item.id === enginePluginId) : undefined;
  if (isCocosEngineMcpPlugin(requestedPlugin)) {
    return requestedPlugin;
  }
  return (
    state.mcpPlugins.find((item) => item.enabled && isCocosEngineMcpPlugin(item)) ??
    state.mcpPlugins.find(isCocosEngineMcpPlugin)
  );
}

function buildCocosMcpConnectionConfig(state: AppState, enginePluginId?: string): McpConnectionConfig {
  const plugin = resolveCocosMcpPlugin(state, enginePluginId);
  return plugin
    ? {
        id: plugin.id,
        name: plugin.name,
        transport: plugin.transport,
        baseUrl: plugin.baseUrl,
        command: plugin.command,
        args: plugin.args,
        cwd: plugin.cwd,
        env: plugin.env
      }
    : {
        name: 'Funplay Cocos MCP',
        transport: 'http',
        baseUrl: DEFAULT_COCOS_MCP_BASE_URL
      };
}

function parseCocosMcpPort(baseUrl: string): number {
  try {
    const parsed = new URL(baseUrl);
    const port = Number(parsed.port);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch {
    // Use the built-in extension default below.
  }
  return 8765;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function extractCocosProjectPathFromText(text: string): string | undefined {
  const patterns = [
    /^\s*-\s*Project Path:\s*(.+?)\s*$/im,
    /^\s*Project Path:\s*(.+?)\s*$/im,
    /["']?projectPath["']?\s*[:=]\s*["']([^"'\n\r]+)["']/i,
    /["']?project_path["']?\s*[:=]\s*["']([^"'\n\r]+)["']/i,
    /\bproject\s+path\b\s*[:=]\s*([^,\n\r}]+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (candidate) {
      return candidate;
    }
  }
  try {
    return extractCocosProjectPath(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function extractCocosProjectPath(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value === 'string') {
    return extractCocosProjectPathFromText(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractCocosProjectPath(item, depth + 1);
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of ['projectPath', 'project_path', 'projectRoot', 'project_root', 'rootPath', 'root_path', 'cwd']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  for (const key of ['project', 'data', 'result', 'structuredContent', 'content', 'contents']) {
    const candidate = extractCocosProjectPath(record[key], depth + 1);
    if (candidate) {
      return candidate;
    }
  }
  for (const item of Object.values(record)) {
    const candidate = extractCocosProjectPath(item, depth + 1);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

async function readCocosMcpProjectPath(
  config: McpConnectionConfig,
  abortSignal: AbortSignal
): Promise<string | undefined> {
  try {
    const projectInfo = await postMcpJsonRpcForConfig<unknown>(
      config,
      'tools/call',
      {
        name: 'get_project_info',
        arguments: {}
      },
      false,
      abortSignal,
      1500
    );
    const projectPath = extractCocosProjectPath(projectInfo);
    if (projectPath) {
      return projectPath;
    }
  } catch {
    // Older or narrowed tool profiles may not expose get_project_info.
  }

  try {
    const projectContext = await postMcpJsonRpcForConfig<unknown>(
      config,
      'resources/read',
      {
        uri: 'cocos://project/context'
      },
      false,
      abortSignal,
      1500
    );
    return extractCocosProjectPath(projectContext);
  } catch {
    return undefined;
  }
}

function buildCocosBridgeHealth(
  snapshot: McpConnectionSnapshot,
  input: {
    expectedProjectPath?: string;
    detectedProjectPath?: string;
  }
): UnityHealthResult {
  const serverLabel = snapshot.serverInfo
    ? `${snapshot.serverInfo.name}${snapshot.serverInfo.version ? ` ${snapshot.serverInfo.version}` : ''}`
    : 'Funplay Cocos MCP';
  if (snapshot.status !== 'online') {
    return {
      status: 'offline',
      checkedAt: snapshot.lastCheckedAt ?? nowIso(),
      url: snapshot.baseUrl,
      projectPath: input.detectedProjectPath,
      message: `Cocos MCP 未连通${snapshot.lastError ? `：${snapshot.lastError}` : '。'}`
    };
  }

  if (input.expectedProjectPath) {
    if (!input.detectedProjectPath) {
      return {
        status: 'offline',
        checkedAt: snapshot.lastCheckedAt ?? nowIso(),
        url: snapshot.baseUrl,
        message:
          'Cocos MCP 已响应，但还不能确认它连接的是当前项目。请在 Cocos Creator 中打开 Funplay > MCP Server，并确认 get_project_info / cocos://project/context 可读取当前项目路径。'
      };
    }
    if (!projectPathsMatch(input.detectedProjectPath, input.expectedProjectPath)) {
      return {
        status: 'offline',
        checkedAt: snapshot.lastCheckedAt ?? nowIso(),
        url: snapshot.baseUrl,
        projectPath: input.detectedProjectPath,
        message: `Cocos MCP 已响应，但当前连接的是 ${input.detectedProjectPath}，不是目标项目 ${input.expectedProjectPath}。请在目标项目中启动 Funplay MCP Server 后重新检测。`
      };
    }
  }

  return {
    status: 'online',
    checkedAt: snapshot.lastCheckedAt ?? nowIso(),
    url: snapshot.baseUrl,
    projectPath: input.detectedProjectPath ?? input.expectedProjectPath,
    message: `Cocos MCP 已连通：${serverLabel}${input.detectedProjectPath ? ` · ${input.detectedProjectPath}` : ''}。`
  };
}

interface CocosHealthCacheEntry {
  snapshot: McpConnectionSnapshot;
  health: UnityHealthResult;
  expiresAt: number;
}
// Short-TTL cache so the 2s onboarding + 5s runtime pollers don't re-initialize
// and re-probe the live Cocos MCP on every tick (Unity already caches this way).
const cocosHealthCache = new Map<string, CocosHealthCacheEntry>();
const COCOS_HEALTH_TTL_ONLINE_MS = 4000;
const COCOS_HEALTH_TTL_OFFLINE_MS = 1500;

// CocosCreator (with the funplay-cocos-mcp extension) listen ports, so a probe
// can recover when the bridge moved off the configured/default port — mirroring
// Unity's discoverUnityListenPorts.
async function discoverCocosListenPorts(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-a', '-c', 'CocosCreator', '-iTCP', '-sTCP:LISTEN'], {
      timeout: 1500,
      maxBuffer: 512 * 1024
    });
    const ports = [...stdout.matchAll(/(?:127\.0\.0\.1|\*|\[::1\]):(\d+)\s+\(LISTEN\)/g)]
      .map((match) => Number(match[1]))
      .filter((port) => Number.isInteger(port) && port > 0);
    return [...new Set(ports)];
  } catch (error) {
    logEngineDebug('cocos', 'lsof port discovery failed', error);
    return [];
  }
}

async function probeCocosMcpConfig(
  config: McpConnectionConfig,
  expectedProjectPath?: string
): Promise<{ snapshot: McpConnectionSnapshot; health: UnityHealthResult }> {
  let detectedProjectPath: string | undefined;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  // Bound the whole probe to the deadline even when initializeMcpConnection awaits
  // a SHARED in-flight init from another caller (whose abort our controller can't
  // cancel) — otherwise a slow/hung server could block this probe up to the 60s
  // default request timeout.
  const deadline = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error('Cocos MCP probe timed out.'));
    }, 3500);
    timeoutHandle.unref?.();
  });
  try {
    await Promise.race([
      (async () => {
        await initializeMcpConnection(config, { abortSignal: controller.signal });
        if (expectedProjectPath) {
          detectedProjectPath = await readCocosMcpProjectPath(config, controller.signal);
        }
      })(),
      deadline
    ]);
  } catch (error) {
    // Snapshot below records the offline status; the underlying reason (timeout
    // vs refused vs tool error) is only otherwise visible under the debug flag.
    logEngineDebug('cocos', `probe failed for ${config.baseUrl ?? config.transport}`, error);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
  const snapshot = getMcpConnectionSnapshot(config);
  return { snapshot, health: buildCocosBridgeHealth(snapshot, { expectedProjectPath, detectedProjectPath }) };
}

async function checkCocosMcpConnection(
  state: AppState,
  enginePluginId?: string,
  expectedProjectPath?: string,
  options: { bypassCache?: boolean } = {}
): Promise<{
  snapshot: McpConnectionSnapshot;
  health: UnityHealthResult;
}> {
  const config = buildCocosMcpConnectionConfig(state, enginePluginId);
  const cacheKey = `${config.baseUrl ?? config.transport}\u0000${expectedProjectPath ?? ''}`;
  if (!options.bypassCache) {
    const cached = cocosHealthCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { snapshot: cached.snapshot, health: cached.health };
    }
  }

  let result = await probeCocosMcpConfig(config, expectedProjectPath);

  // Port rediscovery: if the configured endpoint is offline and this is an
  // HTTP-ish transport, try other CocosCreator listen ports and adopt the first
  // that responds (a port change is otherwise unrecoverable without reconfig).
  if (
    result.health.status !== 'online' &&
    (config.transport === 'http' || config.transport === 'streamable-http' || config.transport === 'sse')
  ) {
    const configuredPort = parseCocosMcpPort(config.baseUrl ?? '');
    const ports = (await discoverCocosListenPorts()).filter((port) => port !== configuredPort);
    for (const port of ports) {
      const candidate: McpConnectionConfig = { ...config, baseUrl: `http://127.0.0.1:${port}/` };
      const candidateResult = await probeCocosMcpConfig(candidate, expectedProjectPath);
      if (candidateResult.health.status === 'online') {
        result = candidateResult;
        break;
      }
    }
  }

  cocosHealthCache.set(cacheKey, {
    snapshot: result.snapshot,
    health: result.health,
    expiresAt: Date.now() + (result.health.status === 'online' ? COCOS_HEALTH_TTL_ONLINE_MS : COCOS_HEALTH_TTL_OFFLINE_MS)
  });
  return result;
}

function bridgePackageSpec(): { packageName: string; url: string } {
  return {
    packageName: 'com.gamebooom.unity.mcp',
    url: 'https://github.com/FunplayAI/funplay-unity-mcp.git'
  };
}

function hasBridgeDependency(projectPath: string): boolean {
  const manifestPath = join(normalizeProjectPath(projectPath), 'Packages', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return false;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
    const spec = bridgePackageSpec();
    return manifest.dependencies?.[spec.packageName]?.includes('github.com/FunplayAI/funplay-unity-mcp') ?? false;
  } catch {
    return false;
  }
}

export function installBridgeDependency(projectPath: string): void {
  const manifestPath = join(normalizeProjectPath(projectPath), 'Packages', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('未找到 Unity 项目的 Packages/manifest.json');
  }

  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as { dependencies?: Record<string, string> };
  const spec = bridgePackageSpec();
  manifest.dependencies = manifest.dependencies ?? {};
  manifest.dependencies[spec.packageName] = spec.url;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function isTcpPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function allocatePreferredMcpPort(preferredPort = 8765): Promise<number> {
  const maxOffset = 50;
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const candidate = preferredPort + offset;
    if (await isTcpPortAvailable(candidate)) {
      return candidate;
    }
  }

  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address?.port ? address.port : preferredPort;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function writeFunplayMcpSettingsFile(
  projectPath: string,
  input: {
    enabled: boolean;
    port: number;
    toolExportProfile?: string;
  }
): { port: number; url: string } {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  const settingsPath = funplayMcpSettingsPath(normalizedProjectPath);
  const settingsDir = join(normalizedProjectPath, 'UserSettings');
  execFileSync('mkdir', ['-p', settingsDir]);
  const payload = {
    enabled: input.enabled,
    port: input.port > 0 ? input.port : 8765,
    toolExportProfile: input.toolExportProfile?.trim() || 'core'
  };
  writeFileSync(settingsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return {
    port: payload.port,
    url: `http://127.0.0.1:${payload.port}/`
  };
}

export function readFunplayMcpSettingsFile(
  projectPath: string
): { enabled: boolean; port: number; toolExportProfile: string; url: string } | null {
  const settingsPath = funplayMcpSettingsPath(projectPath);
  if (!existsSync(settingsPath)) {
    return null;
  }

  try {
    const payload = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      enabled?: boolean;
      port?: number;
      toolExportProfile?: string;
    };
    const port = typeof payload.port === 'number' && payload.port > 0 ? payload.port : 8765;
    return {
      enabled: payload.enabled !== false,
      port,
      toolExportProfile: payload.toolExportProfile?.trim() || 'core',
      url: `http://127.0.0.1:${port}/`
    };
  } catch {
    return null;
  }
}

export async function configureUnityMcpPort(
  projectPath: string,
  preferredPort: number
): Promise<{ port: number; url: string } | null> {
  const assignedPort = await allocatePreferredMcpPort(preferredPort);
  return writeFunplayMcpSettingsFile(projectPath, {
    enabled: true,
    port: assignedPort,
    toolExportProfile: 'core'
  });
}

export function ensureBothInputSystemsEnabled(projectPath: string): void {
  const projectSettingsPath = join(normalizeProjectPath(projectPath), 'ProjectSettings', 'ProjectSettings.asset');
  if (!existsSync(projectSettingsPath)) {
    throw new Error('未找到 Unity 项目的 ProjectSettings/ProjectSettings.asset');
  }

  const raw = readFileSync(projectSettingsPath, 'utf8');
  if (/activeInputHandler:\s*2\b/.test(raw)) {
    return;
  }

  if (/activeInputHandler:\s*\d+\b/.test(raw)) {
    const next = raw.replace(/activeInputHandler:\s*\d+\b/, 'activeInputHandler: 2');
    writeFileSync(projectSettingsPath, next, 'utf8');
    return;
  }

  const next = `${raw.trimEnd()}\n  activeInputHandler: 2\n`;
  writeFileSync(projectSettingsPath, next, 'utf8');
}

function detectUnityProjectDimension(projectPath: string): EngineProjectDimension {
  const projectRoot = normalizeProjectPath(projectPath);
  const candidateFiles = [
    join(projectRoot, 'ProjectSettings', 'EditorSettings.asset'),
    join(projectRoot, 'ProjectSettings', 'ProjectSettings.asset')
  ];

  for (const settingsPath of candidateFiles) {
    if (!existsSync(settingsPath)) {
      continue;
    }

    try {
      const content = readFileSync(settingsPath, 'utf8');
      if (/m_DefaultBehaviorMode:\s*1/.test(content) || /defaultBehaviorMode:\s*1/.test(content)) {
        return '2d';
      }
      if (/m_DefaultBehaviorMode:\s*0/.test(content) || /defaultBehaviorMode:\s*0/.test(content)) {
        return '3d';
      }
    } catch {
      // noop
    }
  }

  const manifestPath = join(projectRoot, 'Packages', 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
      const deps = manifest.dependencies ?? {};
      if (deps['com.unity.2d.sprite'] || deps['com.unity.2d.tilemap']) {
        return '2d';
      }
      if (deps['com.unity.render-pipelines.universal']) {
        return '3d';
      }
    } catch {
      // noop
    }
  }

  return 'unknown';
}

function formatDimensionLabel(dimension: EngineProjectDimension): string {
  if (dimension === '2d') return '2D 项目';
  if (dimension === '3d') return '3D 项目';
  return '未知类型项目';
}

function formatPlatformLabel(platform: PlatformChoice): string {
  switch (platform) {
    case 'unity':
      return 'Unity';
    case 'cocos':
      return 'Cocos Creator';
    case 'godot':
      return 'Godot';
    case 'unreal':
      return 'Unreal Engine';
    case 'web':
    default:
      return 'Web';
  }
}

export function isUnityHubInstalled(settings?: Pick<UnitySettings, 'unityHubPath'>): boolean {
  return Boolean(findUnityHubInstall(settings));
}

function isUnityHubRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Unity Hub.exe'], { encoding: 'utf8' });
      return output.toLowerCase().includes('unity hub.exe');
    }
    if (process.platform === 'darwin') {
      execFileSync('pgrep', ['-x', 'Unity Hub'], { stdio: 'ignore' });
      return true;
    }
    execFileSync('pgrep', ['-f', 'unityhub'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getUnityHubBinary(settings?: Pick<UnitySettings, 'unityHubPath'>): string | null {
  const installed = findUnityHubInstall(settings);
  if (!installed) {
    return null;
  }
  const binary = resolveUnityHubBinaryPath(installed.path);
  return existsSync(binary) ? binary : installed.path;
}

export function getUnityHubLaunchPath(settings?: Pick<UnitySettings, 'unityHubPath'>): string | null {
  return findUnityHubInstall(settings)?.path ?? null;
}

export const listEnvironmentTasks = listEnvironmentTasksInternal;

const COCOS_BRIDGE_LINKED_ACTION_IDS = new Set<EnvironmentActionKind>([
  'create_cocos_project',
  'open_cocos_project',
  'install_cocos_bridge'
]);

const UNITY_BRIDGE_LINKED_ACTION_IDS = new Set<EnvironmentActionKind>([
  'create_unity_project',
  'import_unity_project',
  'open_unity_project',
  'install_project_bridge',
  'verify_project_path'
]);

function isPendingEnvironmentTask(task: EnvironmentTask): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'needs_user';
}

export async function listEnvironmentTasksForState(state: AppState): Promise<EnvironmentTask[]> {
  const pendingTasks = listEnvironmentTasksInternal().filter(isPendingEnvironmentTask);

  // First pass (synchronous): classify eligible bridge-linked tasks. Cocos
  // routine reconciliation shares ONE health probe (no per-project distinction),
  // while Unity is project-scoped, so dedup distinct project paths.
  const cocosTaskPaths: string[] = [];
  const unityProjectPaths = new Set<string>();
  for (const task of pendingTasks) {
    const pendingProjectPath = getEnvironmentTaskProjectPath(task.id);
    if (!pendingProjectPath) {
      // Without a bound project path we can't verify the online bridge belongs to
      // THIS task's project — completing it against any online editor would
      // mis-attribute success. All bridge-linked actions are project-scoped, so
      // this is an anomaly; skip.
      continue;
    }
    if (COCOS_BRIDGE_LINKED_ACTION_IDS.has(task.actionId)) {
      const project = inspectCocosProject(pendingProjectPath);
      if (project.valid && isCocosBridgeInstalled(project.projectPath)) {
        cocosTaskPaths.push(pendingProjectPath);
      }
    } else if (UNITY_BRIDGE_LINKED_ACTION_IDS.has(task.actionId)) {
      unityProjectPaths.add(pendingProjectPath);
    }
  }

  // Second pass: run the (deduped) probes concurrently so wall-clock is bounded
  // by the slowest single probe, not the sum — distinct pending tasks no longer
  // serialize their network round-trips.
  const unityBaseUrl = state.settings.baseUrl || 'http://127.0.0.1:8765/';
  const [cocosProbe, unityProbes] = await Promise.all([
    // Routine reconciliation: connection-health only. Passing no expectedProjectPath
    // skips the get_project_info tool call, so the external Cocos extension is never
    // poked into its blocking "project definition not found" modal (explicit diagnose
    // still does the full project-match check).
    cocosTaskPaths.length > 0
      ? checkCocosMcpConnection(state, undefined, undefined).catch((error) => {
          logEngineDebug('cocos', 'task-reconciliation probe threw', error);
          return undefined;
        })
      : Promise.resolve(undefined),
    Promise.all(
      [...unityProjectPaths].map((projectPath) =>
        checkUnityHealth(unityBaseUrl, { expectedProjectPath: projectPath })
          .catch((error) => {
            logEngineDebug('unity', 'task-reconciliation health probe threw', error);
            return undefined;
          })
          .then((health) => ({ projectPath, health }))
      )
    )
  ]);

  // Third pass: reconcile. Reconcile cocos tasks against the BOUND path, not
  // inspectCocosProject's resolved/realpath'd form — a raw === against the
  // resolved path silently diverges for symlinked (/tmp -> /private/tmp) or
  // trailing-slash paths, so the task would otherwise never auto-complete.
  if (cocosProbe?.health.status === 'online') {
    for (const projectPath of cocosTaskPaths) {
      reconcileBridgeConnectedTasks(cocosProbe.health.message, projectPath);
    }
  }
  for (const { projectPath, health } of unityProbes) {
    if (health?.status === 'online') {
      syncDiscoveredUnityMcpEndpoint(state, health.url);
      reconcileBridgeConnectedTasks(undefined, projectPath);
    }
  }

  return listEnvironmentTasksInternal();
}

export function listAvailableUnityEditors(dimension: EngineProjectDimension = 'unknown'): InstalledUnityEditorOption[] {
  return buildInstalledUnityEditorOptions(dimension);
}

function extractTextContent(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function trimMultilineText(value: string | undefined, maxLines = 8, maxChars = 1200): string | undefined {
  if (!value) {
    return undefined;
  }
  const sliced = value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  const lines = sliced.split('\n');
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n')}\n…` : sliced;
}

export async function getProjectRuntimeState(
  state: AppState,
  input: {
    platform?: PlatformChoice;
    projectPath?: string;
    /**
     * Whether to verify the connected bridge serves THIS project by calling a
     * project-path MCP tool (Cocos: readCocosMcpProjectPath). Defaults to true
     * for explicit diagnostics. The periodic runtime poller passes false: that
     * tool call makes the (external) Cocos extension read the project, which pops
     * a blocking "project definition not found" modal for a broken project — so
     * the routine poll only checks connection health, not project-match.
     */
    verifyBridgeProjectMatch?: boolean;
  }
): Promise<ProjectRuntimeState> {
  const checkedAt = nowIso();
  const platform = input.platform ?? 'web';
  const projectPath = input.projectPath?.trim();

  if (!projectPath) {
    return {
      checkedAt,
      projectExists: false,
      unityProjectValid: false,
      projectOpen: false,
      bridgeInstalled: false
    };
  }

  const normalizedProjectPath = normalizeProjectPath(projectPath);
  if (platform === 'cocos') {
    const cocosProject = inspectCocosProject(normalizedProjectPath);
    const bridgeInstalled = cocosProject.valid && isCocosBridgeInstalled(cocosProject.projectPath);
    // Skip the project-path tool call on routine polls (see verifyBridgeProjectMatch).
    const expectedProjectPath = input.verifyBridgeProjectMatch === false ? undefined : cocosProject.projectPath;
    const bridgeProbe = bridgeInstalled
      ? await checkCocosMcpConnection(state, undefined, expectedProjectPath)
      : undefined;
    const bridgeHealth = bridgeProbe?.health;
    const projectOpen = cocosProject.valid
      ? isCocosProjectCurrentlyOpen(cocosProject.projectPath) || bridgeHealth?.status === 'online'
      : false;
    const mcpUrl =
      bridgeProbe?.snapshot.baseUrl ?? buildCocosMcpConnectionConfig(state).baseUrl ?? DEFAULT_COCOS_MCP_BASE_URL;

    // When the bridge is online, read the cocos:// resource layer into the runtime
    // snapshot (scene/selection/diagnostics/logs) — mirroring the Unity branch so
    // a Cocos refresh carries the same depth of live editor state. cocos://errors/
    // scripts is the Cocos analogue of unity://errors/console. detectedDimension
    // stays 'unknown': Cocos 3.x is a unified 2D/3D engine with no reliable
    // project-file marker to recover the intended dimension post-hoc.
    let availableResourceUris: string[] | undefined;
    let activeSceneSummary: string | undefined;
    let currentSelectionSummary: string | undefined;
    let recentConsoleSummary: string | undefined;
    let recentBridgeLogs: string | undefined;
    if (bridgeHealth?.status === 'online') {
      try {
        const resources = await listUnityResources(mcpUrl);
        availableResourceUris = resources.map((resource) => resource.uri).filter(Boolean);
        const readableResources = [
          ['cocos://scene/active', (value: string) => void (activeSceneSummary = trimMultilineText(value, 10, 1400))],
          [
            'cocos://selection/current',
            (value: string) => void (currentSelectionSummary = trimMultilineText(value, 10, 1200))
          ],
          ['cocos://errors/scripts', (value: string) => void (recentConsoleSummary = trimMultilineText(value, 10, 1400))],
          ['cocos://mcp/interactions', (value: string) => void (recentBridgeLogs = trimMultilineText(value, 12, 1800))]
        ] as const;
        for (const [uri, assign] of readableResources) {
          if (!availableResourceUris.includes(uri)) {
            continue;
          }
          try {
            assign(extractTextContent(await readUnityResource(mcpUrl, uri)));
          } catch {
            // best effort
          }
        }
      } catch {
        availableResourceUris = undefined;
      }
    }

    return {
      checkedAt,
      projectExists: cocosProject.exists,
      unityProjectValid: cocosProject.valid,
      projectOpen,
      bridgeInstalled,
      detectedDimension: 'unknown',
      availableResourceUris,
      activeSceneSummary,
      currentSelectionSummary,
      recentConsoleSummary,
      recentBridgeLogs,
      mcpSettings: bridgeInstalled
        ? {
            enabled: true,
            port: parseCocosMcpPort(mcpUrl),
            toolExportProfile: 'cocos',
            url: mcpUrl
          }
        : undefined,
      bridgeHealth
    };
  }

  if (platform !== 'unity') {
    return {
      checkedAt,
      projectExists: existsSync(normalizedProjectPath),
      unityProjectValid: false,
      projectOpen: false,
      bridgeInstalled: false
    };
  }

  const projectExists = existsSync(normalizedProjectPath);
  const unityProjectValid = isValidUnityProject(normalizedProjectPath);
  const detectedDimension = unityProjectValid ? detectUnityProjectDimension(normalizedProjectPath) : 'unknown';
  const projectOpen = unityProjectValid ? isUnityProjectCurrentlyOpen(normalizedProjectPath) : false;
  const bridgeInstalled = unityProjectValid ? hasBridgeDependency(normalizedProjectPath) : false;
  const mcpSettings = unityProjectValid ? readFunplayMcpSettingsFile(normalizedProjectPath) : null;
  const healthBaseUrl = mcpSettings?.url || state.settings.baseUrl || 'http://127.0.0.1:8765/';
  const bridgeHealth =
    unityProjectValid && bridgeInstalled
      ? await checkUnityHealth(healthBaseUrl, { expectedProjectPath: normalizedProjectPath }).catch(() => undefined)
      : undefined;
  let availableResourceUris: string[] | undefined;
  let activeSceneSummary: string | undefined;
  let currentSelectionSummary: string | undefined;
  let recentConsoleSummary: string | undefined;
  let recentBridgeLogs: string | undefined;

  if (bridgeHealth?.status === 'online') {
    syncDiscoveredUnityMcpEndpoint(state, bridgeHealth.url);
    reconcileBridgeConnectedTasks(undefined, normalizedProjectPath);
    try {
      const resources = await listUnityResources(bridgeHealth.url);
      availableResourceUris = resources.map((resource) => resource.uri).filter(Boolean);
      const readableResources = [
        ['unity://scene/active', (value: string) => void (activeSceneSummary = trimMultilineText(value, 10, 1400))],
        [
          'unity://selection/current',
          (value: string) => void (currentSelectionSummary = trimMultilineText(value, 10, 1200))
        ],
        ['unity://errors/console', (value: string) => void (recentConsoleSummary = trimMultilineText(value, 10, 1400))],
        ['unity://mcp/interactions', (value: string) => void (recentBridgeLogs = trimMultilineText(value, 12, 1800))]
      ] as const;

      for (const [uri, assign] of readableResources) {
        if (!availableResourceUris.includes(uri)) {
          continue;
        }
        try {
          const result = await readUnityResource(bridgeHealth.url, uri);
          assign(extractTextContent(result));
        } catch {
          // best effort
        }
      }
    } catch {
      availableResourceUris = undefined;
    }
  }

  return {
    checkedAt,
    projectExists,
    unityProjectValid,
    projectOpen,
    bridgeInstalled,
    detectedDimension,
    availableResourceUris,
    activeSceneSummary,
    currentSelectionSummary,
    recentConsoleSummary,
    recentBridgeLogs,
    mcpSettings: mcpSettings ?? undefined,
    bridgeHealth
  };
}

export async function diagnoseEnvironment(
  state: AppState,
  input: {
    platform: PlatformChoice;
    mode: ProjectSetupMode;
    dimension: EngineProjectDimension;
    cocosVariant?: CocosEngineVariant;
    projectName?: string;
    projectPath: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  }
): Promise<EnvironmentDiagnostics> {
  const checkedAt = nowIso();
  const checks: EnvironmentCheck[] = [];
  const normalizedProjectPath = normalizeProjectPath(input.projectPath);
  const targetProjectPath = resolveTargetProjectPath(input);
  const detectedDimension = input.mode === 'import' ? detectUnityProjectDimension(input.projectPath) : input.dimension;
  const availableUnityEditors =
    input.platform === 'unity' && input.mode === 'create' ? buildInstalledUnityEditorOptions(detectedDimension) : [];
  const selectedUnityEditorOption = input.unityEditorVersion
    ? availableUnityEditors.find((editor) => editor.version === input.unityEditorVersion)
    : (availableUnityEditors.find((editor) => editor.recommended) ?? availableUnityEditors[0]);
  const unityTemplateSelection =
    input.platform === 'unity' && input.mode === 'create'
      ? selectUnityEditorForTemplate(detectedDimension, input.unityEditorVersion)
      : null;
  const compatibleEditorInstalled = input.mode === 'create' ? !!unityTemplateSelection : false;

  if (input.platform === 'web') {
    checks.push({
      id: 'web-ready',
      title: '通用项目无需引擎安装',
      description: '当前项目将使用通用工作区启动。',
      status: 'passed',
      detail: '无需 Unity / Godot / Unreal 运行环境，可直接进入工作台。',
      actions: []
    });

    return {
      platform: input.platform,
      mode: input.mode,
      dimension: detectedDimension,
      checkedAt,
      projectPath: input.projectPath,
      enginePluginId: input.enginePluginId,
      selectedUnityVersion: selectedUnityEditorOption?.version,
      availableUnityEditors,
      checks,
      ready: true
    };
  }

  if (input.platform === 'cocos') {
    const cocosVariant: CocosEngineVariant = input.cocosVariant ?? 'creator3';

    if (cocosVariant === 'cocos4') {
      // cocos4 is driven headlessly by cocos-cli (no Cocos Creator GUI). The
      // onboarding checks the build prerequisites and whether Funplay's managed
      // cocos-cli is built, offering the heavy download when it isn't.
      const userDataPath = resolveCocosCliUserDataPath();
      const cliInstall = findCocosCliInstallation(userDataPath);
      const prereqs = checkCocosCliPrerequisites();

      checks.push({
        id: 'cocos-cli-prereq',
        title: '构建前置环境',
        description: '下载 cocos4 需要系统 Node.js 22+ 与 git（cocos-cli 的构建依赖）。',
        status: prereqs.ok ? 'passed' : 'failed',
        detail: prereqs.ok
          ? `已满足：Node ${prereqs.nodeVersion}，git 可用。`
          : `缺少：${prereqs.missing.join('、')}。请安装后重试。`,
        actions: []
      });

      checks.push({
        id: 'cocos-cli',
        title: 'Cocos 4 / cocos-cli',
        description: '官方 cocos4 引擎 + cocos-cli（headless MCP，无需打开 Cocos Creator 编辑器）。',
        status: cliInstall ? 'passed' : 'failed',
        detail: cliInstall
          ? `已安装：${cliInstall.cliPath}`
          : `未安装。Funplay 会克隆 cocos-cli 并拉取 cocos4 引擎（约 3.5G）到 ${getCocosCliDir(userDataPath)}。`,
        actions: cliInstall
          ? []
          : prereqs.ok
            ? [
                {
                  id: 'install_cocos_cli',
                  label: '下载 cocos-cli + cocos4',
                  description: '克隆并构建官方 cocos4 工具链（约 3.5G，耗时较长）。',
                  primary: true
                }
              ]
            : []
      });

      return {
        platform: input.platform,
        mode: input.mode,
        dimension: input.dimension,
        cocosVariant,
        checkedAt,
        projectPath: input.projectPath,
        enginePluginId: input.enginePluginId,
        checks,
        ready: checks.every((check) => check.status === 'passed')
      };
    }

    const cocosDimension = formatCocosDimensionLabel(input.dimension);
    const cocosEnginePlugin = resolveCocosMcpPlugin(state, input.enginePluginId);
    const dashboardPath = findCocosDashboardExecutable();
    const creatorInstallation = findCocosCreatorInstallation();
    const creatorInstalled = Boolean(creatorInstallation);
    const dashboardInstalled = Boolean(dashboardPath);
    const projectPathExists = existsSync(normalizedProjectPath);
    const targetProjectPathExists = existsSync(targetProjectPath);
    const hasProjectName = input.mode === 'import' ? true : !!input.projectName?.trim();
    const cocosProject = inspectCocosProject(targetProjectPath);
    const bridgeInstalled = cocosProject.valid && isCocosBridgeInstalled(cocosProject.projectPath);
    const bridgeProbe = bridgeInstalled
      ? await checkCocosMcpConnection(state, cocosEnginePlugin?.id, cocosProject.projectPath, { bypassCache: true })
      : null;
    const bridgeHealth = bridgeProbe?.health;
    const bridgeConnected = bridgeHealth?.status === 'online';
    const projectAlreadyOpen = cocosProject.valid ? isCocosProjectCurrentlyOpen(cocosProject.projectPath) : false;
    const projectEffectivelyOpen = projectAlreadyOpen || bridgeConnected;

    checks.push({
      id: 'cocos-dashboard',
      title: 'Cocos Dashboard / Creator',
      description: '用于管理 Cocos Creator 版本，并提供 2D / 3D 项目模板。',
      status: creatorInstalled ? 'passed' : dashboardInstalled ? 'warning' : 'failed',
      detail: creatorInstalled
        ? [
            `已检测到 Cocos Creator：${creatorInstallation!.executablePath}`,
            creatorInstallation?.version ? `版本：${creatorInstallation.version}` : '',
            dashboardInstalled
              ? `已检测到 Cocos Dashboard：${dashboardPath}`
              : '未检测到 Dashboard，但可以继续使用已安装 Creator。'
          ]
            .filter(Boolean)
            .join('；')
        : dashboardInstalled
          ? `已检测到 Cocos Dashboard：${dashboardPath}。请先在 Dashboard 中安装 Cocos Creator 3.8+。`
          : '未检测到 Cocos Dashboard 或 Cocos Creator。请先安装 Cocos Dashboard / Creator。',
      actions: creatorInstalled
        ? dashboardInstalled
          ? [
              {
                id: 'open_cocos_dashboard',
                label: '打开 Dashboard',
                description: '打开 Dashboard 管理 Creator 版本和项目。'
              }
            ]
          : []
        : dashboardInstalled
          ? [
              {
                id: 'open_cocos_dashboard',
                label: '打开 Dashboard',
                description: '打开 Dashboard 安装 Cocos Creator。',
                primary: true
              }
            ]
          : [
              {
                id: 'install_cocos_dashboard',
                label: '安装 Cocos',
                description: '打开 Cocos Creator 官方下载页。',
                primary: true
              }
            ]
    });

    checks.push({
      id: 'engine-project',
      title: input.mode === 'create' ? 'Cocos 项目创建' : 'Cocos 项目导入',
      description:
        input.mode === 'create'
          ? '使用 Cocos Creator 内置模板创建新的 2D / 3D 项目。'
          : '选择并导入你已经存在的 Cocos Creator 项目目录。',
      status:
        input.mode === 'create'
          ? cocosProject.valid
            ? 'passed'
            : projectPathExists && hasProjectName && creatorInstalled
              ? 'warning'
              : 'pending'
          : cocosProject.valid
            ? 'passed'
            : targetProjectPathExists
              ? 'warning'
              : 'pending',
      detail:
        input.mode === 'create'
          ? !projectPathExists
            ? '请先选择用于创建新项目的目录。'
            : !hasProjectName
              ? '请先填写项目名称。'
              : cocosProject.valid
                ? `已检测到已创建的 Cocos ${cocosDimension} 项目：${cocosProject.projectPath}`
                : targetProjectPathExists
                  ? `目标目录已存在但还不是有效 Cocos 项目：${targetProjectPath}`
                  : creatorInstalled
                    ? `已选择创建目录：${input.projectPath}，项目名称：${input.projectName}，将使用 Cocos Creator 内置 ${cocosDimension} 空模板创建项目。`
                    : '请先安装 Cocos Creator，才能使用内置模板创建项目。'
          : targetProjectPathExists
            ? cocosProject.valid
              ? `已检测到有效 Cocos 项目：${cocosProject.projectPath} · ${cocosDimension}`
              : `已检测到目录：${targetProjectPath}，但缺少 ${cocosProject.missing.join('、') || 'Cocos 项目标识'}。`
            : '还没有检测到现有项目目录，请先选择正确的 Cocos 项目路径。',
      actions:
        input.mode === 'create'
          ? projectPathExists && hasProjectName
            ? cocosProject.valid
              ? [
                  {
                    id: 'verify_project_path',
                    label: '校验创建结果',
                    description: '重新校验目标目录是否是有效 Cocos 项目。',
                    primary: true
                  }
                ]
              : creatorInstalled
                ? [
                    {
                      id: 'create_cocos_project',
                      label: '创建 Cocos 模板项目',
                      description: `使用 Cocos Creator 内置 ${cocosDimension} 空模板创建项目。`,
                      primary: true
                    }
                  ]
                : [
                    {
                      id: dashboardInstalled ? 'open_cocos_dashboard' : 'install_cocos_dashboard',
                      label: dashboardInstalled ? '打开 Dashboard' : '安装 Cocos',
                      description: dashboardInstalled
                        ? '打开 Dashboard 安装 Cocos Creator。'
                        : '打开 Cocos Creator 官方下载页。',
                      primary: true
                    }
                  ]
            : []
          : targetProjectPathExists
            ? [
                {
                  id: 'verify_project_path',
                  label: '校验项目路径',
                  description: '重新校验当前目录是否是有效 Cocos 项目。',
                  primary: true
                }
              ]
            : []
    });

    checks.push({
      id: 'engine-opened',
      title: 'Cocos 项目打开状态',
      description: '如果当前项目已经由 Cocos Creator 打开，Funplay 不会重复触发打开动作。',
      status: projectEffectivelyOpen ? 'passed' : cocosProject.valid ? 'warning' : 'pending',
      detail: projectAlreadyOpen
        ? '已检测到该项目当前就在 Cocos Creator 中打开。'
        : bridgeConnected
          ? '已通过 Cocos MCP 连通确认该项目已经打开。'
          : cocosProject.valid
            ? '该 Cocos 项目还没有检测到打开状态。'
            : '等待先准备好有效的 Cocos 项目。',
      actions:
        cocosProject.valid && !projectEffectivelyOpen
          ? [
              {
                id: 'open_cocos_project',
                label: '打开 Cocos 项目',
                description: '直接启动 Cocos Creator 打开该项目。',
                primary: true
              }
            ]
          : []
    });

    checks.push({
      id: 'bridge-installed',
      title: 'Funplay Cocos MCP',
      description: 'Funplay 会把 funplay-cocos-mcp 扩展安装到当前 Cocos 项目的 extensions 目录。',
      status: bridgeInstalled ? 'passed' : cocosProject.valid ? 'warning' : 'pending',
      detail: bridgeInstalled
        ? '已检测到项目中存在 funplay-cocos-mcp 扩展。'
        : cocosProject.valid
          ? '项目中还没有安装 funplay-cocos-mcp 扩展。'
          : '等待先准备好有效的 Cocos 项目。',
      actions:
        cocosProject.valid && !bridgeInstalled
          ? [
              {
                id: 'install_cocos_bridge',
                label: '安装 Cocos MCP',
                description: '克隆 FunplayAI/funplay-cocos-mcp 到项目 extensions 目录。',
                primary: true
              }
            ]
          : []
    });

    checks.push({
      id: 'bridge-connected',
      title: 'Cocos MCP 连通性',
      description: '扩展安装完成并在 Cocos Creator 中启动 MCP Server 后，Funplay 会检测连通性。',
      status: bridgeConnected ? 'passed' : bridgeInstalled ? 'warning' : 'pending',
      detail: bridgeConnected
        ? bridgeHealth.message
        : bridgeInstalled
          ? (bridgeHealth?.message ??
            `扩展已安装，但尚未连通 ${bridgeProbe?.snapshot.baseUrl ?? DEFAULT_COCOS_MCP_BASE_URL}。请在 Cocos Creator 中打开 Funplay > MCP Server 后重新检测。`)
          : '等待先安装 funplay-cocos-mcp 扩展。',
      actions: bridgeConnected
        ? []
        : cocosProject.valid && !projectEffectivelyOpen
          ? [
              {
                id: 'open_cocos_project',
                label: '打开 Cocos 项目',
                description: '打开项目后，在 Cocos Creator 中启动 Funplay MCP Server。',
                primary: true
              }
            ]
          : []
    });

    return {
      platform: input.platform,
      mode: input.mode,
      dimension: input.dimension,
      cocosVariant,
      checkedAt,
      projectPath: input.projectPath,
      enginePluginId: cocosEnginePlugin?.id,
      selectedUnityVersion: selectedUnityEditorOption?.version,
      availableUnityEditors,
      checks,
      ready: checks.every((check) => check.status === 'passed')
    };
  }

  if (input.platform !== 'unity') {
    const label = formatPlatformLabel(input.platform);
    checks.push({
      id: 'engine-adapter',
      title: `${label} Adapter`,
      description: 'Funplay 引擎控制层已经按通用接口接入，但该引擎还没有启用本机自动化 adapter。',
      status: 'warning',
      detail: `${label} 项目当前可以作为通用文件工作区使用；Hub/项目打开/Bridge/MCP 自动化还没有实现。`,
      actions: []
    });

    return {
      platform: input.platform,
      mode: input.mode,
      dimension: input.dimension,
      checkedAt,
      projectPath: input.projectPath,
      enginePluginId: input.enginePluginId,
      selectedUnityVersion: selectedUnityEditorOption?.version,
      availableUnityEditors,
      checks,
      ready: false
    };
  }

  const unityHubInstall = findUnityHubInstall(state.settings);
  const unityHubInstalled = Boolean(unityHubInstall);
  const unityHubRunning = unityHubInstalled && isUnityHubRunning();
  checks.push({
    id: 'unity-hub',
    title: 'Unity Hub',
    description: '用于安装和管理 Unity Editor 版本。',
    status: unityHubInstalled ? 'passed' : 'failed',
    detail: unityHubInstalled
      ? unityHubRunning
        ? '已检测到 Unity Hub，且当前已打开。'
        : unityHubInstall?.source === 'custom'
          ? `已检测到自定义 Unity Hub：${unityHubInstall.path}`
          : '已检测到 Unity Hub。'
      : '未检测到 Unity Hub。可自动安装或打开当前系统的官方安装器，也可以手动选择已安装的 Unity Hub。',
    actions: unityHubInstalled
      ? unityHubRunning
        ? []
        : [{ id: 'open_unity_hub', label: '打开 Unity Hub', description: '打开 Unity Hub 检查登录和安装状态。' }]
      : [
          {
            id: 'install_unity_hub',
            label: '安装 Unity Hub',
            description: '优先使用包管理器自动安装；不可用时打开官方安装器。',
            primary: true
          },
          {
            id: 'select_unity_hub',
            label: '选择已安装 Hub',
            description: '如果 Unity Hub 装在非标准目录，请手动选择。'
          }
        ]
  });

  const projectPathExists = existsSync(normalizedProjectPath);
  const targetProjectPathExists = existsSync(targetProjectPath);
  const hasProjectName = input.mode === 'import' ? true : !!input.projectName?.trim();
  const validUnityProject = isValidUnityProject(targetProjectPath);
  const editor = findUnityEditorInstall();
  const projectUnityVersion =
    input.mode === 'import' && validUnityProject ? readUnityProjectVersion(targetProjectPath)?.version : undefined;
  const projectVersionEditor = projectUnityVersion
    ? selectUnityEditorForProject(targetProjectPath, projectUnityVersion).editor
    : undefined;
  const compatibleImportEditorInstalled =
    input.mode === 'import' ? (projectUnityVersion ? !!projectVersionEditor : editor.installed) : false;
  checks.push({
    id: 'unity-editor',
    title: 'Unity Editor',
    description:
      input.mode === 'create'
        ? '需要一个能按官方模板创建项目的 Unity Editor 版本。'
        : '至少需要一个可用的 Unity Editor 版本。',
    status:
      input.mode === 'create'
        ? compatibleEditorInstalled
          ? 'passed'
          : unityHubInstalled
            ? 'warning'
            : 'failed'
        : compatibleImportEditorInstalled
          ? 'passed'
          : unityHubInstalled
            ? 'warning'
            : 'failed',
    detail:
      input.mode === 'create'
        ? compatibleEditorInstalled
          ? `已检测到可用于官方模板创建的版本：${unityTemplateSelection!.editor.version} · ${unityTemplateSelection!.template.displayName} · ${versionStrategyLabel(detectedDimension)}`
          : editor.installed
            ? selectedUnityEditorOption && !selectedUnityEditorOption.compatible
              ? `当前选择的 Unity ${selectedUnityEditorOption.version} 不支持官方 ${detectedDimension === '2d' ? '2D URP' : '3D URP'} 模板。${selectedUnityEditorOption.reason}`
              : `已检测到：${editor.versions.join('、')}，但当前没有可用于官方 ${detectedDimension === '2d' ? '2D URP' : '3D URP'} 模板创建的版本。${versionStrategyLabel(detectedDimension)}`
            : `还没有检测到可用于官方模板创建的 Unity Editor。${versionStrategyLabel(detectedDimension)}`
        : editor.installed
          ? projectUnityVersion
            ? projectVersionEditor
              ? `项目保存版本：Unity ${projectUnityVersion}，已检测到匹配 Editor。`
              : `项目保存版本：Unity ${projectUnityVersion}。本机已安装：${editor.versions.join('、')}，但没有精确匹配版本；为避免自动升级项目，Funplay 不会用其他 Unity 版本打开。`
            : `未能读取项目保存的 Unity 版本；已检测到：${editor.versions.join('、')}`
          : projectUnityVersion
            ? `项目保存版本：Unity ${projectUnityVersion}，但本机还没有检测到该版本。`
            : '还没有检测到可用的 Unity Editor 版本。',
    actions: (input.mode === 'create' ? compatibleEditorInstalled : compatibleImportEditorInstalled)
      ? []
      : [
          {
            id: 'install_unity_editor',
            label: '安装推荐 Unity',
            description:
              input.mode === 'create'
                ? `通过 Unity Hub 安装最新可用版本，后续会优先使用本机支持官方模板的最新 Unity。`
                : projectUnityVersion
                  ? `通过 Unity Hub 安装项目保存版本 Unity ${projectUnityVersion}，避免打开时触发项目升级。`
                  : '通过 Unity Hub 安装推荐版本。',
            primary: true
          }
        ]
  });

  const projectAlreadyOpen = validUnityProject ? isUnityProjectCurrentlyOpen(targetProjectPath) : false;
  const bridgeInstalled = validUnityProject ? hasBridgeDependency(targetProjectPath) : false;
  const healthBaseUrl =
    validUnityProject && bridgeInstalled
      ? readFunplayMcpSettingsFile(targetProjectPath)?.url || state.settings.baseUrl || 'http://127.0.0.1:8765/'
      : null;
  const bridgeHealth = healthBaseUrl
    ? await checkUnityHealth(healthBaseUrl, { expectedProjectPath: targetProjectPath })
    : undefined;
  const bridgeConnected = bridgeHealth?.status === 'online';
  if (bridgeConnected) {
    syncDiscoveredUnityMcpEndpoint(state, bridgeHealth.url);
    reconcileBridgeConnectedTasks(undefined, targetProjectPath);
  }
  const projectEffectivelyOpen = projectAlreadyOpen || bridgeConnected;
  checks.push({
    id: 'engine-project',
    title: input.mode === 'create' ? '引擎项目创建' : '引擎项目导入',
    description:
      input.mode === 'create'
        ? '先按 Unity 官方模板创建一个新的 Unity 项目。'
        : '选择并导入你已经存在的 Unity 项目目录。',
    status:
      input.mode === 'create'
        ? validUnityProject
          ? 'passed'
          : projectPathExists && hasProjectName && compatibleEditorInstalled
            ? 'warning'
            : 'pending'
        : validUnityProject
          ? 'passed'
          : editor.installed
            ? 'warning'
            : 'pending',
    detail:
      input.mode === 'create'
        ? !projectPathExists
          ? '请先选择用于创建新项目的目录。'
          : !hasProjectName
            ? '请先填写项目名称。'
            : validUnityProject
              ? `已检测到已创建的 Unity 项目：${targetProjectPath} · ${formatDimensionLabel(detectedDimension)}`
              : targetProjectPathExists
                ? `目标项目目录已出现：${targetProjectPath}，正在等待 Unity 完成项目结构初始化。`
                : compatibleEditorInstalled
                  ? `已选择创建目录：${input.projectPath}，项目名称：${input.projectName}，将使用 ${unityTemplateSelection!.editor.version} / ${unityTemplateSelection!.template.displayName} 创建 ${formatDimensionLabel(detectedDimension)}。`
                  : selectedUnityEditorOption && !selectedUnityEditorOption.compatible
                    ? `已选择创建目录：${input.projectPath}，项目名称：${input.projectName}。当前所选 Unity ${selectedUnityEditorOption.version} 不支持官方模板，请改选其他已安装版本。`
                    : `已选择创建目录：${input.projectPath}，项目名称：${input.projectName}。请先安装支持官方 ${detectedDimension === '2d' ? '2D URP' : '3D URP'} 模板的推荐 Unity 版本。`
        : projectPathExists
          ? validUnityProject
            ? `已检测到有效 Unity 项目：${input.projectPath} · 已识别为 ${formatDimensionLabel(detectedDimension)}`
            : `已检测到目录：${input.projectPath}，但它还不是有效的 Unity 项目目录。`
          : '还没有检测到现有项目目录，请先选择正确的 Unity 项目路径。',
    actions:
      input.mode === 'create'
        ? projectPathExists && hasProjectName
          ? validUnityProject
            ? [
                {
                  id: 'verify_project_path',
                  label: '校验创建结果',
                  description: '重新校验目标项目是否已创建完成。',
                  primary: true
                }
              ]
            : compatibleEditorInstalled
              ? [
                  {
                    id: 'create_unity_project',
                    label: '创建官方模板项目',
                    description: `自动创建新的 ${unityTemplateSelection!.template.displayName} 官方模板项目。`,
                    primary: true
                  }
                ]
              : [
                  {
                    id: 'install_unity_editor',
                    label: '先安装推荐 Unity',
                    description: `当前创建流程需要先安装支持官方模板的 Unity 版本，后续会优先使用本机最新版本。`,
                    primary: true
                  }
                ]
          : []
        : projectPathExists
          ? [
              {
                id: 'verify_project_path',
                label: '校验项目路径',
                description: '重新校验当前目录是否存在。',
                primary: true
              }
            ]
          : [
              {
                id: 'import_unity_project',
                label: '导入已有项目',
                description: '打开 Unity Hub 并导入现有项目。',
                primary: true
              }
            ]
  });

  checks.push({
    id: 'engine-opened',
    title: 'Unity 项目打开状态',
    description: '如果当前项目已经在 Unity 中打开，Funplay 不会重复触发打开动作。',
    status: projectEffectivelyOpen ? 'passed' : validUnityProject ? 'warning' : 'pending',
    detail: projectAlreadyOpen
      ? '已检测到该项目当前就在 Unity Editor 中打开。'
      : bridgeConnected
        ? '已通过 Bridge / MCP 连通确认该 Unity 项目已经打开。'
        : validUnityProject && projectUnityVersion && !projectVersionEditor
          ? `该项目还没有打开；项目保存于 Unity ${projectUnityVersion}，但本机缺少精确匹配版本。请先安装该版本，避免 Unity 自动升级项目。`
          : validUnityProject
            ? '该项目还没有在 Unity 中打开。'
            : '等待先准备好有效的 Unity 项目。',
    actions:
      validUnityProject && !projectEffectivelyOpen && (!projectUnityVersion || !!projectVersionEditor)
        ? ([
            {
              id: 'open_unity_project',
              label: '打开 Unity 项目',
              description: '直接启动 Unity 打开该项目。',
              primary: true
            }
          ] satisfies EnvironmentAction[])
        : []
  });

  checks.push({
    id: 'bridge-installed',
    title: 'Funplay Bridge',
    description: 'Funplay 会把 Unity MCP Package 自动安装到当前项目中。',
    status: bridgeInstalled ? 'passed' : validUnityProject ? 'warning' : 'pending',
    detail: bridgeInstalled
      ? '已检测到项目中存在 Funplay Bridge 依赖。'
      : validUnityProject
        ? '项目中还没有安装 Funplay Bridge。'
        : '等待先准备好有效的 Unity 项目。',
    actions:
      validUnityProject && !bridgeInstalled
        ? ([
            {
              id: 'install_project_bridge',
              label: '自动安装 Bridge',
              description: '写入项目 manifest 并触发 Unity 导入 MCP Package。',
              primary: true
            }
          ] satisfies EnvironmentAction[])
        : []
  });

  if (validUnityProject && bridgeInstalled && bridgeHealth) {
    checks.push({
      id: 'bridge-connected',
      title: 'Bridge / MCP 连通性',
      description: 'Bridge 安装完成后，检测当前项目是否已和 Funplay 成功连通。',
      status: bridgeConnected ? 'passed' : 'warning',
      detail: bridgeConnected
        ? `连接成功：${bridgeHealth.message}`
        : projectEffectivelyOpen
          ? '项目已打开，但还不能连通 Bridge / MCP。可能还在导入依赖或尚未启动 MCP Server。'
          : '还不能连通当前项目。请先打开项目，等待 Bridge 安装完成并启动 MCP Server。',
      actions: bridgeConnected
        ? []
        : ([
            ...(projectEffectivelyOpen
              ? []
              : [
                  {
                    id: 'open_unity_project',
                    label: '打开 Unity 项目',
                    description: '直接启动 Unity 打开该项目。',
                    primary: true
                  }
                ]),
            ...(bridgeInstalled
              ? []
              : [
                  {
                    id: 'install_project_bridge',
                    label: '自动安装 Bridge',
                    description: '自动写入项目依赖。',
                    primary: true
                  }
                ])
          ] as EnvironmentAction[])
    });
  } else {
    checks.push({
      id: 'bridge-connected',
      title: 'Bridge / MCP 连通性',
      description: '需要先准备项目并安装 Bridge，才能继续检测连通性。',
      status: 'pending',
      detail: '等待先准备好 Unity 项目并安装 Bridge。',
      actions: []
    });
  }

  return {
    platform: input.platform,
    mode: input.mode,
    dimension: detectedDimension,
    checkedAt,
    projectPath: input.projectPath,
    enginePluginId: input.enginePluginId,
    selectedUnityVersion: selectedUnityEditorOption?.version,
    availableUnityEditors,
    checks,
    ready: checks.every((check) => check.status === 'passed')
  };
}

export async function runEnvironmentAction(
  state: AppState,
  input: {
    actionId: EnvironmentActionKind;
    platform: PlatformChoice;
    mode: ProjectSetupMode;
    dimension: EngineProjectDimension;
    cocosVariant?: CocosEngineVariant;
    projectName?: string;
    projectPath: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  }
): Promise<EnvironmentActionResult> {
  const targetProjectPath = resolveTargetProjectPath(input);
  if (input.platform === 'cocos') {
    switch (input.actionId) {
      case 'install_cocos_dashboard': {
        await shell.openExternal(getCocosDashboardDownloadUrl());
        return {
          actionId: input.actionId,
          status: 'opened',
          message: '已打开 Cocos Creator 官方下载页。'
        };
      }
      case 'open_cocos_dashboard': {
        const result = openCocosDashboard();
        return {
          actionId: input.actionId,
          status: result.ok ? 'opened' : 'failed',
          message: result.summary
        };
      }
      case 'create_cocos_project': {
        const task = createTask('create_cocos_project', '创建 Cocos 项目', '正在准备自动创建 Cocos 项目…');
        bindTaskProjectPath(task.id, targetProjectPath);
        taskStageUpdate(task.id, {
          stage: 'checking',
          status: 'running',
          progress: 8,
          message: '正在检查 Cocos Creator 模板、项目名称和目标目录…',
          log: `目标项目路径：${targetProjectPath}`
        });
        const projectName = input.projectName?.trim();
        if (!projectName) {
          completeTask(task.id, 'failed', '请先填写项目名称。');
          return {
            actionId: input.actionId,
            status: 'failed',
            message: '请先填写项目名称。',
            taskId: task.id
          };
        }

        taskStageUpdate(task.id, {
          stage: 'installing',
          status: 'running',
          progress: 24,
          message: `正在从 Cocos Creator 内置 ${formatCocosDimensionLabel(input.dimension)} 模板生成项目…`,
          log: `开始创建 Cocos ${formatCocosDimensionLabel(input.dimension)} 项目：${targetProjectPath}`
        });
        const created = createCocosProjectFromTemplate({
          targetProjectPath,
          projectName,
          dimension: input.dimension
        });
        if (!created.ok) {
          completeTask(task.id, 'failed', created.summary);
          return {
            actionId: input.actionId,
            status: 'failed',
            message: created.summary,
            taskId: task.id
          };
        }

        taskStageUpdate(task.id, {
          stage: 'installing',
          status: 'running',
          progress: 64,
          message: 'Cocos 项目已创建，正在安装 funplay-cocos-mcp 扩展…',
          log: created.summary
        });
        const bridge = installCocosBridge({ projectPath: targetProjectPath });
        if (!bridge.ok) {
          completeTask(task.id, 'failed', bridge.summary);
          return {
            actionId: input.actionId,
            status: 'failed',
            message: bridge.summary,
            taskId: task.id
          };
        }

        taskStageUpdate(task.id, {
          stage: 'validating',
          status: 'running',
          progress: 86,
          message: 'Cocos 项目和 MCP 扩展已准备好，正在尝试打开项目…',
          log: bridge.summary
        });
        const opened = await openCocosProject({ projectPath: targetProjectPath });
        completeTask(
          task.id,
          'needs_user',
          opened.ok
            ? 'Cocos 项目已创建，funplay-cocos-mcp 已安装，并已尝试打开项目。请在 Cocos Creator 中打开 Funplay > MCP Server，等连通性检测通过后流程才会完成。'
            : `Cocos 项目已创建，funplay-cocos-mcp 已安装；请手动打开项目并启动 Funplay MCP Server。${opened.summary}`,
          opened.ok ? 92 : 88
        );
        return {
          actionId: input.actionId,
          status: 'opened',
          message: opened.ok
            ? 'Cocos 项目已创建并打开，请在 Cocos Creator 中启动 Funplay MCP Server。'
            : 'Cocos 项目已创建，请手动打开 Cocos Creator 项目并启动 Funplay MCP Server。',
          taskId: task.id
        };
      }
      case 'open_cocos_project': {
        const task = createTask('open_cocos_project', '打开 Cocos 项目', '正在准备打开 Cocos 项目…');
        bindTaskProjectPath(task.id, targetProjectPath);
        taskStageUpdate(task.id, {
          stage: 'checking',
          status: 'running',
          progress: 12,
          message: '正在检查 Cocos 项目结构…',
          log: `项目路径：${targetProjectPath}`
        });
        if (isCocosProjectCurrentlyOpen(targetProjectPath)) {
          completeTask(
            task.id,
            'needs_user',
            '已检测到该 Cocos 项目当前就在 Cocos Creator 中打开，Funplay 不会重复打开同一个项目。请在 Cocos Creator 中打开 Funplay > MCP Server 后重新检测。',
            72
          );
          return {
            actionId: input.actionId,
            status: 'opened',
            message: '该 Cocos 项目已经打开；请在 Cocos Creator 中启动 Funplay MCP Server。',
            taskId: task.id
          };
        }
        const result = await openCocosProject({ projectPath: targetProjectPath });
        completeTask(task.id, result.ok ? 'completed' : 'failed', result.summary);
        return {
          actionId: input.actionId,
          status: result.ok ? 'opened' : 'failed',
          message: result.summary,
          taskId: task.id
        };
      }
      case 'install_cocos_bridge': {
        const task = createTask('install_cocos_bridge', '安装 Funplay Cocos MCP', '正在准备安装 funplay-cocos-mcp…');
        bindTaskProjectPath(task.id, targetProjectPath);
        taskStageUpdate(task.id, {
          stage: 'checking',
          status: 'running',
          progress: 12,
          message: '正在检查 Cocos 项目和 extensions 目录…',
          log: `项目路径：${targetProjectPath}`
        });
        const result = installCocosBridge({ projectPath: targetProjectPath });
        completeTask(task.id, result.ok ? 'completed' : 'failed', result.summary);
        return {
          actionId: input.actionId,
          status: result.ok ? 'completed' : 'failed',
          message: result.summary,
          taskId: task.id
        };
      }
      case 'verify_project_path': {
        const project = inspectCocosProject(targetProjectPath);
        return {
          actionId: input.actionId,
          status: project.valid ? 'completed' : 'failed',
          message: project.valid
            ? '项目路径校验通过，是有效的 Cocos 项目。'
            : project.exists
              ? `目标目录存在，但还不是有效的 Cocos 项目，缺少：${project.missing.join('、') || 'Cocos 项目标识'}。`
              : '目标项目路径不存在，请检查后重试。'
        };
      }
      case 'install_cocos_cli': {
        const task = createTask('install_cocos_cli', '下载 cocos-cli + cocos4', '正在准备下载 cocos-cli…');
        taskStageUpdate(task.id, {
          stage: 'checking',
          status: 'running',
          progress: 5,
          message: '正在检查前置环境（Node.js / git）…'
        });
        const userDataPath = resolveCocosCliUserDataPath();
        // The clone+build is heavy (~5G, several minutes); run it in the
        // background and return the task immediately so the IPC call doesn't block.
        void installCocosCli({
          userDataPath,
          onStage: (stage, progress, message) =>
            taskStageUpdate(task.id, { stage, status: 'running', progress, message })
        })
          .then((installResult) => {
            completeTask(task.id, installResult.ok ? 'completed' : 'failed', installResult.message);
          })
          .catch((error) => {
            completeTask(
              task.id,
              'failed',
              `cocos-cli 安装异常：${error instanceof Error ? error.message : String(error)}`
            );
          });
        return {
          actionId: input.actionId,
          status: 'opened',
          message: 'cocos-cli 下载已开始：将克隆 cocos-cli 并拉取 cocos4 引擎（约 3.5G，耗时较长），可在任务列表查看进度。',
          taskId: task.id
        };
      }
      default:
        return {
          actionId: input.actionId,
          status: 'failed',
          message: '暂不支持该 Cocos 动作。'
        };
    }
  }

  if (input.platform !== 'unity') {
    return {
      actionId: input.actionId,
      status: 'failed',
      message: `${formatPlatformLabel(input.platform)} 引擎 adapter 尚未实现自动打开或 Bridge 安装。`
    };
  }

  switch (input.actionId) {
    case 'install_unity_hub': {
      const task = await startInstallUnityHubTask({
        unityHubPath: state.settings.unityHubPath
      });
      return {
        actionId: input.actionId,
        status: 'opened',
        message: '已创建 Unity Hub 安装任务。',
        taskId: task.id
      };
    }
    case 'open_unity_hub': {
      const installed = findUnityHubInstall(state.settings);
      if (!installed) {
        return {
          actionId: input.actionId,
          status: 'failed',
          message: '未检测到 Unity Hub。'
        };
      }
      await shell.openPath(installed.path);
      return {
        actionId: input.actionId,
        status: 'opened',
        message: '已尝试打开 Unity Hub。'
      };
    }
    case 'select_unity_hub': {
      const result = await electron.dialog.showOpenDialog({
        title: '选择 Unity Hub',
        message: '选择已安装的 Unity Hub 应用或可执行文件。',
        properties: ['openFile', 'openDirectory'],
        buttonLabel: '选择 Unity Hub'
      });
      const selectedPath = result.filePaths[0];
      if (result.canceled || !selectedPath) {
        return {
          actionId: input.actionId,
          status: 'failed',
          message: '已取消选择 Unity Hub。'
        };
      }
      if (!isLikelyUnityHubPath(selectedPath)) {
        return {
          actionId: input.actionId,
          status: 'failed',
          message: '选择的路径不像 Unity Hub，请选择 Unity Hub.app、Unity Hub.exe 或 unityhub 可执行文件。'
        };
      }
      state.settings = {
        ...state.settings,
        unityHubPath: selectedPath
      };
      return {
        actionId: input.actionId,
        status: 'completed',
        message: `已保存 Unity Hub 路径：${selectedPath}`
      };
    }
    case 'install_unity_editor': {
      const task = await startInstallUnityEditorTask({
        mode: input.mode,
        dimension: input.dimension,
        unityEditorVersion:
          input.mode === 'import'
            ? (readProjectUnityEditorVersion(targetProjectPath) ?? input.unityEditorVersion)
            : input.unityEditorVersion,
        unityHubPath: state.settings.unityHubPath
      });
      return {
        actionId: input.actionId,
        status: task.status === 'failed' ? 'failed' : 'opened',
        message: task.message,
        taskId: task.id
      };
    }
    case 'create_unity_project': {
      const task = await startCreateUnityProjectTask(state, input);
      return {
        actionId: input.actionId,
        status: task.status === 'failed' ? 'failed' : 'opened',
        message: task.message,
        taskId: task.id
      };
    }
    case 'import_unity_project': {
      const task = createTask('import_unity_project', '导入已有 Unity 项目', '正在准备导入已有项目…');
      bindTaskProjectPath(task.id, targetProjectPath);
      const projectUnityVersion = readProjectUnityEditorVersion(targetProjectPath);
      const editorSelection = selectUnityEditorForProject(targetProjectPath, projectUnityVersion ?? undefined);
      if (editorSelection.missingExactVersion) {
        taskStageUpdate(task.id, {
          stage: 'waiting_manual',
          status: 'needs_user',
          progress: 34,
          message: `当前项目保存于 Unity ${editorSelection.missingExactVersion}，本机未安装该精确版本。为避免自动升级项目，请先安装该版本。`,
          log: `缺少 Unity Editor ${editorSelection.missingExactVersion}。`
        });
        return {
          actionId: input.actionId,
          status: 'failed',
          message: `缺少 Unity Editor ${editorSelection.missingExactVersion}，已阻止用其他 Unity 版本打开项目以避免自动升级。`,
          taskId: task.id
        };
      }
      if (await openUnityProjectDirectly(targetProjectPath)) {
        taskStageUpdate(task.id, {
          stage: 'validating',
          status: 'running',
          progress: 72,
          message: '已直接启动 Unity 打开该项目，等待 Editor 完成加载…',
          log: `已通过本地 Unity Editor 直接打开已有项目：${targetProjectPath}`
        });
        waitForBridgeAfterOpen(task.id, state, targetProjectPath);
        return {
          actionId: input.actionId,
          status: 'completed',
          message: '已直接启动 Unity 打开该项目，请等待 Editor 启动后重新检测。',
          taskId: task.id
        };
      }
      taskStageUpdate(task.id, {
        stage: 'waiting_manual',
        status: 'needs_user',
        progress: 30,
        message: '未能直接启动项目，已打开 Unity Hub，请导入现有项目并返回重新检测。',
        log: `目标项目路径：${targetProjectPath}`
      });
      await shell.openExternal('unityhub://open');
      return {
        actionId: input.actionId,
        status: 'opened',
        message: '已打开 Unity Hub，请导入项目后返回重新检测。',
        taskId: task.id
      };
    }
    case 'open_unity_project': {
      const task = createTask('open_unity_project', '打开 Unity 项目', '正在准备打开 Unity 项目…');
      bindTaskProjectPath(task.id, targetProjectPath);
      if (isUnityProjectCurrentlyOpen(targetProjectPath)) {
        if (hasBridgeDependency(targetProjectPath)) {
          const preferredPort = state.settings.lastAssignedMcpPort ?? 8765;
          const assignedEndpoint = await configureUnityMcpPort(targetProjectPath, preferredPort);
          if (assignedEndpoint) {
            syncDiscoveredUnityMcpEndpoint(state, assignedEndpoint.url);
          }
          taskStageUpdate(task.id, {
            stage: 'validating',
            status: 'running',
            progress: 78,
            message: '当前项目已经打开，正在校验 Bridge / MCP 连通性…',
            log: '检测到目标项目已经打开，开始校验 Bridge / MCP。'
          });
          waitForBridgeAfterOpen(task.id, state, targetProjectPath);
        } else {
          taskStageUpdate(task.id, {
            stage: 'completed',
            status: 'completed',
            progress: 100,
            message: '当前项目已经在 Unity 中打开，无需重复触发打开。',
            log: '检测到目标项目已经打开。'
          });
        }
        return {
          actionId: input.actionId,
          status: 'completed',
          message: '当前项目已经在 Unity 中打开。',
          taskId: task.id
        };
      }
      const projectUnityVersion = readProjectUnityEditorVersion(targetProjectPath);
      const editorSelection = selectUnityEditorForProject(targetProjectPath, projectUnityVersion ?? undefined);
      if (editorSelection.missingExactVersion) {
        taskStageUpdate(task.id, {
          stage: 'waiting_manual',
          status: 'needs_user',
          progress: 36,
          message: `当前项目保存于 Unity ${editorSelection.missingExactVersion}，本机未安装该精确版本。为避免自动升级项目，请先安装该版本。`,
          log: `缺少 Unity Editor ${editorSelection.missingExactVersion}，拒绝使用其他 Unity 版本打开 ${targetProjectPath}。`
        });
        return {
          actionId: input.actionId,
          status: 'failed',
          message: `缺少 Unity Editor ${editorSelection.missingExactVersion}，已阻止用其他 Unity 版本打开项目以避免自动升级。`,
          taskId: task.id
        };
      }
      if (isValidUnityProject(targetProjectPath) && hasBridgeDependency(targetProjectPath)) {
        const preferredPort = state.settings.lastAssignedMcpPort ?? 8765;
        const assignedEndpoint = await configureUnityMcpPort(targetProjectPath, preferredPort);
        if (assignedEndpoint) {
          syncDiscoveredUnityMcpEndpoint(state, assignedEndpoint.url);
        }
      }
      if (await openUnityProjectDirectly(targetProjectPath)) {
        taskStageUpdate(task.id, {
          stage: 'validating',
          status: 'running',
          progress: 74,
          message: '已直接启动 Unity 打开项目，等待 Editor 完成加载…',
          log: `已通过本地 Unity Editor 打开项目：${targetProjectPath}`
        });
        waitForBridgeAfterOpen(task.id, state, targetProjectPath);
        return {
          actionId: input.actionId,
          status: 'completed',
          message: '已直接启动 Unity 打开项目，请等待 Unity Editor 启动后重新检测。',
          taskId: task.id
        };
      }
      taskStageUpdate(task.id, {
        stage: 'waiting_manual',
        status: 'needs_user',
        progress: 40,
        message: '未能直接启动 Unity，已尝试打开 Unity Hub，请在 Hub 中打开该项目并等待 Editor 启动。',
        log: `项目路径：${targetProjectPath}`
      });
      await shell.openExternal('unityhub://open');
      return {
        actionId: input.actionId,
        status: 'opened',
        message: '已尝试打开 Unity 项目，请等待 Unity Editor 启动后重新检测。',
        taskId: task.id
      };
    }
    case 'install_project_bridge': {
      const task = createTask('install_project_bridge', '安装 Funplay Bridge', '正在准备把 Bridge 安装到当前项目…');
      bindTaskProjectPath(task.id, targetProjectPath);
      try {
        taskStageUpdate(task.id, {
          stage: 'checking',
          status: 'running',
          progress: 10,
          message: '正在检查 Unity 项目结构…',
          log: `项目路径：${targetProjectPath}`
        });
        if (!isValidUnityProject(targetProjectPath)) {
          completeTask(task.id, 'failed', '当前目录不是有效的 Unity 项目，无法安装 Bridge。');
          return {
            actionId: input.actionId,
            status: 'failed',
            message: '当前目录不是有效的 Unity 项目。',
            taskId: task.id
          };
        }

        taskStageUpdate(task.id, {
          stage: 'installing',
          progress: 42,
          message: '正在写入输入系统设置和项目依赖，并触发 Unity 导入 Bridge…',
          log: '开始写入 ProjectSettings/ProjectSettings.asset 与 Packages/manifest.json'
        });
        ensureBothInputSystemsEnabled(targetProjectPath);
        installBridgeDependency(targetProjectPath);

        taskStageUpdate(task.id, {
          stage: 'installing',
          progress: 54,
          message: '正在为 MCP 分配空闲端口并写入启动配置…',
          log: '开始写入 Unity MCP 端口配置。'
        });
        const preferredPort = state.settings.lastAssignedMcpPort ?? 8765;
        const assignedEndpoint = await configureUnityMcpPort(targetProjectPath, preferredPort);
        if (assignedEndpoint) {
          syncDiscoveredUnityMcpEndpoint(state, assignedEndpoint.url);
        }

        if (isUnityProjectCurrentlyOpen(targetProjectPath)) {
          taskStageUpdate(task.id, {
            stage: 'validating',
            progress: 72,
            message: '项目已打开，正在等待 Unity 导入 Bridge 并启动 MCP…',
            log: '检测到项目已打开，开始等待 Bridge / MCP 连通。'
          });
          waitForBridgeAfterOpen(task.id, state, targetProjectPath);
        } else {
          taskStageUpdate(task.id, {
            stage: 'waiting_manual',
            status: 'needs_user',
            progress: 72,
            message: 'Bridge 依赖已写入项目。请打开 Unity 项目，等待 Unity 完成导入后重新检测。',
            log: '等待用户打开项目并完成 Unity 包导入。'
          });
        }
        return {
          actionId: input.actionId,
          status: 'completed',
          message: '已自动把 Bridge 依赖写入当前项目。',
          taskId: task.id
        };
      } catch (error) {
        completeTask(task.id, 'failed', error instanceof Error ? error.message : '自动安装 Bridge 失败。');
        return {
          actionId: input.actionId,
          status: 'failed',
          message: error instanceof Error ? error.message : '自动安装 Bridge 失败。',
          taskId: task.id
        };
      }
    }
    case 'verify_project_path': {
      const exists = existsSync(targetProjectPath);
      const valid = isValidUnityProject(targetProjectPath);
      return {
        actionId: input.actionId,
        status: valid ? 'completed' : 'failed',
        message: valid
          ? '项目路径校验通过，是有效的 Unity 项目。'
          : exists
            ? '目标目录存在，但还不是有效的 Unity 项目。'
            : '目标项目路径不存在，请检查后重试。'
      };
    }
    default:
      return {
        actionId: input.actionId,
        status: 'failed',
        message: '暂不支持该动作。'
      };
  }
}
