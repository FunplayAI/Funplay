import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  EnvironmentTask,
  EnvironmentTaskStage,
  EnvironmentTaskStatus,
  InstalledUnityEditorOption,
  PlatformChoice,
  ProjectRuntimeState,
  ProjectSetupMode,
  UnityReleaseChannel
} from '../../shared/types';
import { checkUnityHealth } from './unity-bridge';
import { listUnityResources, readUnityResource } from './unity-mcp-client';
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
  hasPendingBridgeLinkedTask,
  getPendingBridgeLinkedTaskProjectPath,
  bindTaskProjectPath,
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

const execFileAsync = promisify(execFile);
const shell = electron.shell;

export interface UnityVersionRecommendation {
  version: string;
  strategyLabel: string;
}

function getUnityHubCandidates(): string[] {
  return ['/Applications/Unity Hub.app', join(process.env.HOME ?? '', 'Applications/Unity Hub.app')];
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

function funplayMcpSettingsPath(projectPath: string): string {
  return join(normalizeProjectPath(projectPath), 'UserSettings', 'FunplayMcpSettings.json');
}

export function resolveTargetProjectPath(input: { mode: ProjectSetupMode; projectPath: string; projectName?: string }): string {
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

export function readFunplayMcpSettingsFile(projectPath: string): { enabled: boolean; port: number; toolExportProfile: string; url: string } | null {
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

export async function configureUnityMcpPort(projectPath: string, preferredPort: number): Promise<{ port: number; url: string } | null> {
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

export function isUnityHubInstalled(): boolean {
  return getUnityHubCandidates().some((path) => existsSync(path));
}

function isUnityHubRunning(): boolean {
  try {
    execFileSync('pgrep', ['-x', 'Unity Hub'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getUnityHubBinary(): string | null {
  const candidates = getUnityHubCandidates();
  const installedPath = candidates.find((path) => existsSync(path));
  return installedPath ? join(installedPath, 'Contents', 'MacOS', 'Unity Hub') : null;
}

export const listEnvironmentTasks = listEnvironmentTasksInternal;

export async function listEnvironmentTasksForState(state: AppState): Promise<EnvironmentTask[]> {
  if (hasPendingBridgeLinkedTask()) {
    const pendingProjectPath = getPendingBridgeLinkedTaskProjectPath();
    const health = await checkUnityHealth(
      state.settings.baseUrl || 'http://127.0.0.1:8765/',
      pendingProjectPath ? { expectedProjectPath: pendingProjectPath } : {}
    ).catch(() => undefined);
    if (health?.status === 'online') {
      syncDiscoveredUnityMcpEndpoint(state, health.url);
      reconcileBridgeConnectedTasks(undefined, pendingProjectPath);
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
  }
): Promise<ProjectRuntimeState> {
  const checkedAt = nowIso();
  const platform = input.platform ?? 'web';
  const projectPath = input.projectPath?.trim();

  if (!projectPath || platform !== 'unity') {
    return {
      checkedAt,
      projectExists: !!projectPath && existsSync(normalizeProjectPath(projectPath)),
      unityProjectValid: false,
      projectOpen: false,
      bridgeInstalled: false
    };
  }

  const normalizedProjectPath = normalizeProjectPath(projectPath);
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
        ['unity://selection/current', (value: string) => void (currentSelectionSummary = trimMultilineText(value, 10, 1200))],
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
  const availableUnityEditors = input.platform === 'unity' && input.mode === 'create' ? buildInstalledUnityEditorOptions(detectedDimension) : [];
  const selectedUnityEditorOption = input.unityEditorVersion
    ? availableUnityEditors.find((editor) => editor.version === input.unityEditorVersion)
    : availableUnityEditors.find((editor) => editor.recommended)
      ?? availableUnityEditors[0];
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
    checks.push({
      id: 'cocos-entry',
      title: 'Cocos Creator',
      description: '当前版本已增加 Cocos 引擎入口，但仅开放 2D 项目模式。',
      status: 'warning',
      detail:
        input.mode === 'create'
          ? `当前已选择创建 Cocos 2D 项目：${input.projectName || '未命名项目'}`
          : `当前已选择导入 Cocos 项目目录：${input.projectPath}`,
      actions: []
    });

    return {
      platform: input.platform,
      mode: input.mode,
      dimension: '2d',
      checkedAt,
      projectPath: input.projectPath,
      enginePluginId: input.enginePluginId,
      selectedUnityVersion: selectedUnityEditorOption?.version,
      availableUnityEditors,
      checks,
      ready: false
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

  const unityHubInstalled = isUnityHubInstalled();
  const unityHubRunning = unityHubInstalled && isUnityHubRunning();
  checks.push({
    id: 'unity-hub',
    title: 'Unity Hub',
    description: '用于安装和管理 Unity Editor 版本。',
    status: unityHubInstalled ? 'passed' : 'failed',
    detail: unityHubInstalled
      ? unityHubRunning
        ? '已检测到 Unity Hub，且当前已打开。'
        : '已检测到 Unity Hub。'
      : '未检测到 Unity Hub，无法继续一键安装 Editor。',
    actions: unityHubInstalled
      ? unityHubRunning
        ? []
        : [{ id: 'open_unity_hub', label: '打开 Unity Hub', description: '打开 Unity Hub 检查登录和安装状态。' }]
      : [
          {
            id: 'install_unity_hub',
            label: '一键安装 Unity Hub',
            description: '打开 Unity Hub 官方下载页。',
            primary: true
          }
        ]
  });

  const projectPathExists = existsSync(normalizedProjectPath);
  const targetProjectPathExists = existsSync(targetProjectPath);
  const hasProjectName = input.mode === 'import' ? true : !!input.projectName?.trim();
  const validUnityProject = isValidUnityProject(targetProjectPath);
  const editor = findUnityEditorInstall();
  const projectUnityVersion = input.mode === 'import' && validUnityProject ? readUnityProjectVersion(targetProjectPath)?.version : undefined;
  const projectVersionEditor = projectUnityVersion ? selectUnityEditorForProject(targetProjectPath, projectUnityVersion).editor : undefined;
  const compatibleImportEditorInstalled = input.mode === 'import' ? (projectUnityVersion ? !!projectVersionEditor : editor.installed) : false;
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
    actions:
      (input.mode === 'create' ? compatibleEditorInstalled : compatibleImportEditorInstalled)
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
  const bridgeHealth = healthBaseUrl ? await checkUnityHealth(healthBaseUrl, { expectedProjectPath: targetProjectPath }) : undefined;
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
        ? [
            {
              id: 'open_unity_project',
              label: '打开 Unity 项目',
              description: '直接启动 Unity 打开该项目。',
              primary: true
            }
          ] satisfies EnvironmentAction[]
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
        ? [
            {
              id: 'install_project_bridge',
              label: '自动安装 Bridge',
              description: '写入项目 manifest 并触发 Unity 导入 MCP Package。',
              primary: true
            }
          ] satisfies EnvironmentAction[]
        : []
  });

  if (validUnityProject && bridgeInstalled && bridgeHealth) {
    checks.push({
      id: 'bridge-connected',
      title: 'Bridge / MCP 连通性',
      description: 'Bridge 安装完成后，检测当前项目是否已和 Funplay 成功连通。',
      status: bridgeConnected ? 'passed' : 'warning',
      detail:
        bridgeConnected
          ? `连接成功：${bridgeHealth.message}`
          : projectEffectivelyOpen
            ? '项目已打开，但还不能连通 Bridge / MCP。可能还在导入依赖或尚未启动 MCP Server。'
            : '还不能连通当前项目。请先打开项目，等待 Bridge 安装完成并启动 MCP Server。',
      actions:
        bridgeConnected
          ? []
          : [
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
            ] as EnvironmentAction[]
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
    projectName?: string;
    projectPath: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  }
): Promise<EnvironmentActionResult> {
  if (input.platform !== 'unity') {
    return {
      actionId: input.actionId,
      status: 'failed',
      message: `${formatPlatformLabel(input.platform)} 引擎 adapter 尚未实现自动打开或 Bridge 安装。`
    };
  }

  const targetProjectPath = resolveTargetProjectPath(input);
  switch (input.actionId) {
    case 'install_unity_hub': {
      const task = await startInstallUnityHubTask();
      return {
        actionId: input.actionId,
        status: 'opened',
        message: '已创建 Unity Hub 安装任务。',
        taskId: task.id
      };
    }
    case 'open_unity_hub': {
      const candidates = getUnityHubCandidates();
      const installedPath = candidates.find((path) => existsSync(path));
      if (!installedPath) {
        return {
          actionId: input.actionId,
          status: 'failed',
          message: '未检测到 Unity Hub。'
        };
      }
      await shell.openPath(installedPath);
      return {
        actionId: input.actionId,
        status: 'opened',
        message: '已尝试打开 Unity Hub。'
      };
    }
    case 'install_unity_editor': {
      const task = await startInstallUnityEditorTask({
        mode: input.mode,
        dimension: input.dimension,
        unityEditorVersion: input.mode === 'import' ? readProjectUnityEditorVersion(targetProjectPath) ?? input.unityEditorVersion : input.unityEditorVersion
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
        message: valid ? '项目路径校验通过，是有效的 Unity 项目。' : exists ? '目标目录存在，但还不是有效的 Unity 项目。' : '目标项目路径不存在，请检查后重试。'
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
