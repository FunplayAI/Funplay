import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { Project } from '../../../shared/types';
import type { WorkspaceToolActionResult } from './workspace-tools-types';

export interface CocosCreatorInstallation {
  executablePath: string;
  source: string;
  version?: string;
}

export interface CocosProjectInspection {
  projectPath: string;
  exists: boolean;
  valid: boolean;
  indicators: string[];
  missing: string[];
  packageName?: string;
}

export interface CocosCliBuildCommand {
  command: string;
  cwd: string;
  target: string;
  executablePath: string;
  buildPath: string;
  logPath: string;
}

export interface CocosTemplateProjectResult extends WorkspaceToolActionResult {
  projectPath?: string;
  templatePath?: string;
}

const COCOS_CREATOR_ENV_KEYS = ['COCOS_CREATOR_EXECUTABLE', 'COCOS_CREATOR_PATH', 'COCOS_CREATOR'];

const COCOS_DASHBOARD_ENV_KEYS = ['COCOS_DASHBOARD_EXECUTABLE', 'COCOS_DASHBOARD_PATH'];

const FUNPLAY_COCOS_MCP_REPO = 'https://github.com/FunplayAI/funplay-cocos-mcp.git';
// Pin installs to a published release tag for reproducibility — a bare clone of
// the default branch could drift mid-development. Bump this when the bridge ships
// a new release.
const FUNPLAY_COCOS_MCP_PINNED_REF = 'v0.4.0';
const FUNPLAY_COCOS_MCP_EXTENSION_DIR = 'funplay-cocos-mcp';
export const DEFAULT_COCOS_MCP_BASE_URL = 'http://127.0.0.1:8765/';

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function resolveHomePath(value: string): string {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function normalizePath(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return resolve(resolveHomePath(value.trim()));
}

function normalizeProjectPathVariants(projectPath: string): string[] {
  const trimmed = projectPath.trim();
  if (!trimmed) {
    return [];
  }
  const expanded = resolveHomePath(trimmed);
  const resolved = resolve(expanded);
  const variants = new Set([expanded, resolved]);
  try {
    if (existsSync(resolved)) {
      variants.add(realpathSync(resolved));
    }
  } catch {
    // Best-effort process detection; the resolved path is still useful.
  }
  return Array.from(variants)
    .map((variant) => variant.replace(/[\\/]+$/g, ''))
    .filter(Boolean);
}

export function isCocosProjectCurrentlyOpen(projectPath: string): boolean {
  const variants = normalizeProjectPathVariants(projectPath);
  if (!variants.length) {
    return false;
  }
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
    return output
      .split('\n')
      .some(
        (line) =>
          /CocosCreator/i.test(line) && line.includes('--project') && variants.some((variant) => line.includes(variant))
      );
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function versionFromPath(path: string): string | undefined {
  return /(?:^|[\\/])(\d+\.\d+\.\d+)(?:[\\/]|$)/.exec(path)?.[1];
}

function safeProjectPackageName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'cocos-project'
  );
}

function creatorBinaryFromCandidate(path: string): string {
  if (process.platform === 'darwin' && path.endsWith('.app')) {
    return join(path, 'Contents', 'MacOS', 'CocosCreator');
  }
  return path;
}

function pushInstallation(installations: CocosCreatorInstallation[], executablePath: string, source: string): void {
  const resolved = creatorBinaryFromCandidate(resolveHomePath(executablePath));
  if (!existsSync(resolved)) {
    return;
  }
  installations.push({
    executablePath: resolved,
    source,
    version: versionFromPath(resolved)
  });
}

function readVersionedCreatorInstallations(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name))
      .map((entry) => join(root, entry.name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

export function detectCocosCreatorInstallations(env: NodeJS.ProcessEnv = process.env): CocosCreatorInstallation[] {
  const installations: CocosCreatorInstallation[] = [];
  for (const key of COCOS_CREATOR_ENV_KEYS) {
    const value = normalizePath(env[key]);
    if (value) {
      pushInstallation(installations, value, `env:${key}`);
    }
  }

  if (process.platform === 'darwin') {
    for (const root of [
      '/Applications/Cocos/Creator',
      '/Applications/CocosCreator/Creator',
      join(homedir(), 'Applications/Cocos/Creator')
    ]) {
      for (const versionRoot of readVersionedCreatorInstallations(root)) {
        pushInstallation(installations, join(versionRoot, 'CocosCreator.app'), 'macos:cocos-dashboard');
      }
    }
    pushInstallation(installations, '/Applications/CocosCreator.app', 'macos:legacy-app');
  } else if (process.platform === 'win32') {
    for (const root of uniqueValues([
      env.ProgramData ? join(env.ProgramData, 'cocos/editors/Creator') : '',
      env.ProgramFiles ? join(env.ProgramFiles, 'Cocos/Creator') : '',
      env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'Cocos/Creator') : '',
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'CocosCreator') : ''
    ])) {
      for (const versionRoot of readVersionedCreatorInstallations(root)) {
        pushInstallation(installations, join(versionRoot, 'CocosCreator.exe'), 'windows:cocos-dashboard');
      }
    }
  } else {
    for (const candidate of [
      '/opt/CocosCreator/CocosCreator',
      '/opt/cocos/creator/CocosCreator',
      join(homedir(), 'CocosCreator/CocosCreator')
    ]) {
      pushInstallation(installations, candidate, 'linux:default-path');
    }
  }

  return uniqueValues(installations.map((installation) => installation.executablePath))
    .map((path) => installations.find((installation) => installation.executablePath === path)!)
    .sort((a, b) => {
      // An explicit COCOS_CREATOR_EXECUTABLE override always wins, even over a
      // higher-versioned dashboard install (its version is unknown -> '', so it
      // would otherwise sort last and be silently discarded).
      const aEnv = a.source.startsWith('env:');
      const bEnv = b.source.startsWith('env:');
      if (aEnv !== bEnv) {
        return aEnv ? -1 : 1;
      }
      return (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true });
    });
}

export function findCocosCreatorInstallation(env?: NodeJS.ProcessEnv): CocosCreatorInstallation | undefined {
  return detectCocosCreatorInstallations(env)[0];
}

function getCocosTemplateRoot(installation: CocosCreatorInstallation): string | undefined {
  const executablePath = installation.executablePath;
  const candidates = uniqueValues([
    join(dirname(dirname(executablePath)), 'Resources', 'templates'),
    join(dirname(executablePath), 'Resources', 'templates'),
    join(dirname(executablePath), 'resources', 'templates'),
    join(dirname(dirname(executablePath)), 'resources', 'templates')
  ]);
  return candidates.find(
    (candidate) => existsSync(join(candidate, 'list.json')) || existsSync(join(candidate, 'empty'))
  );
}

export function getCocosTemplatePath(input: {
  dimension: '2d' | '3d' | 'unknown';
  env?: NodeJS.ProcessEnv;
}): { installation: CocosCreatorInstallation; templatePath: string; templateName: string } | undefined {
  const installation = findCocosCreatorInstallation(input.env);
  if (!installation) {
    return undefined;
  }
  const templateRoot = getCocosTemplateRoot(installation);
  if (!templateRoot) {
    return undefined;
  }
  const templateName = input.dimension === '2d' ? 'empty-2d' : 'empty';
  const templatePath = join(templateRoot, templateName);
  return existsSync(templatePath)
    ? {
        installation,
        templatePath,
        templateName
      }
    : undefined;
}

function dashboardBinaryFromCandidate(path: string): string {
  if (process.platform === 'darwin' && path.endsWith('.app')) {
    return join(path, 'Contents', 'MacOS', 'CocosDashboard');
  }
  return path;
}

export function findCocosDashboardExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of COCOS_DASHBOARD_ENV_KEYS) {
    const value = normalizePath(env[key]);
    const candidate = value ? dashboardBinaryFromCandidate(value) : undefined;
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/CocosDashboard.app',
          '/Applications/Cocos/CocosDashboard.app',
          join(homedir(), 'Applications/CocosDashboard.app')
        ].map(dashboardBinaryFromCandidate)
      : process.platform === 'win32'
        ? uniqueValues([
            env.ProgramData ? join(env.ProgramData, 'cocos/CocosDashboard/CocosDashboard.exe') : '',
            env.ProgramFiles ? join(env.ProgramFiles, 'CocosDashboard/CocosDashboard.exe') : '',
            env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'CocosDashboard/CocosDashboard.exe') : ''
          ])
        : ['/opt/CocosDashboard/CocosDashboard', join(homedir(), 'CocosDashboard/CocosDashboard')];
  return candidates.find((candidate) => existsSync(candidate));
}

export function inspectCocosProject(projectPath: string): CocosProjectInspection {
  const resolved = resolve(resolveHomePath(projectPath));
  const exists = existsSync(resolved);
  const packageJsonPath = join(resolved, 'package.json');
  const legacyProjectJsonPath = join(resolved, 'project.json');
  const assetsPath = join(resolved, 'assets');
  const hasPackageJson = existsSync(packageJsonPath);
  const hasLegacyProjectJson = existsSync(legacyProjectJsonPath);
  const hasAssets = existsSync(assetsPath);
  const packageName = hasPackageJson
    ? (() => {
        try {
          const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
          return typeof parsed.name === 'string' ? parsed.name : undefined;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  return {
    projectPath: resolved,
    exists,
    valid: exists && hasAssets && (hasPackageJson || hasLegacyProjectJson),
    indicators: [
      hasAssets ? 'assets/' : '',
      hasPackageJson ? 'package.json' : '',
      hasLegacyProjectJson ? 'project.json' : ''
    ].filter(Boolean),
    missing: [
      exists ? '' : 'project directory',
      hasAssets ? '' : 'assets/',
      hasPackageJson || hasLegacyProjectJson ? '' : 'package.json or project.json'
    ].filter(Boolean),
    packageName
  };
}

export function createCocosProjectFromTemplate(input: {
  targetProjectPath: string;
  projectName: string;
  dimension: '2d' | '3d' | 'unknown';
  env?: NodeJS.ProcessEnv;
}): CocosTemplateProjectResult {
  const projectName = safeProjectPackageName(input.projectName);
  const targetProjectPath = resolve(resolveHomePath(input.targetProjectPath));
  const parentPath = dirname(targetProjectPath);
  if (!existsSync(parentPath)) {
    return {
      ok: false,
      isError: true,
      summary: `Cocos project parent directory does not exist: ${parentPath}`
    };
  }

  const existing = inspectCocosProject(targetProjectPath);
  if (existing.valid) {
    return {
      ok: true,
      projectPath: existing.projectPath,
      summary: `Cocos project already exists: ${existing.projectPath}`
    };
  }
  if (existing.exists) {
    try {
      if (readdirSync(targetProjectPath).length > 0) {
        return {
          ok: false,
          isError: true,
          summary: `Target path already exists and is not an empty Cocos project directory: ${targetProjectPath}`
        };
      }
    } catch (error) {
      return {
        ok: false,
        isError: true,
        summary: `Failed to inspect target Cocos project directory: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  const template = getCocosTemplatePath({
    dimension: input.dimension,
    env: input.env
  });
  if (!template) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Cocos Creator template not found.',
        'Next action: install Cocos Creator 3.8+ via Cocos Dashboard or set COCOS_CREATOR_EXECUTABLE.'
      ].join('\n')
    };
  }

  try {
    mkdirSync(targetProjectPath, { recursive: true });
    cpSync(template.templatePath, targetProjectPath, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
    mkdirSync(join(targetProjectPath, 'assets'), { recursive: true });
    const packageJsonPath = join(targetProjectPath, 'package.json');
    if (existsSync(packageJsonPath)) {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
      parsed.name = projectName;
      writeFileSync(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    } else {
      writeFileSync(packageJsonPath, `${JSON.stringify({ name: projectName }, null, 2)}\n`, 'utf8');
    }
  } catch (error) {
    return {
      ok: false,
      isError: true,
      summary: `Failed to create Cocos project from template: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  return {
    ok: true,
    projectPath: targetProjectPath,
    templatePath: template.templatePath,
    summary: [
      'Engine platform: cocos',
      'Capability: createProject',
      `Cocos Creator executable: ${template.installation.executablePath}`,
      `Template: ${template.templateName}`,
      `Project path: ${targetProjectPath}`
    ].join('\n')
  };
}

export function createCocosCliBuildCommand(input: {
  projectPath?: string;
  projectId?: string;
  env?: NodeJS.ProcessEnv;
}): CocosCliBuildCommand | undefined {
  const projectPath = normalizePath(input.projectPath);
  if (!projectPath) {
    return undefined;
  }
  const project = inspectCocosProject(projectPath);
  const installation = findCocosCreatorInstallation(input.env);
  if (!project.valid || !installation) {
    return undefined;
  }
  const segment =
    (input.projectId ?? project.packageName ?? 'project').replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 80) || 'project';
  const buildRoot = join(tmpdir(), 'funplay-cocos-build', segment);
  const buildPath = join(buildRoot, 'web-desktop');
  const logPath = join(buildRoot, 'cocos-build.log');
  const buildArgs = `platform=web-desktop;debug=true;buildPath=${buildPath};logDest=${logPath}`;
  return {
    command: `${shellQuote(installation.executablePath)} --project ${shellQuote(project.projectPath)} --build ${shellQuote(buildArgs)}`,
    cwd: '.',
    target: `web-desktop -> ${buildPath}`,
    executablePath: installation.executablePath,
    buildPath,
    logPath
  };
}

export function getCocosBridgePath(projectPath: string): string {
  return join(resolve(resolveHomePath(projectPath)), 'extensions', FUNPLAY_COCOS_MCP_EXTENSION_DIR);
}

export function isCocosBridgeInstalled(projectPath: string): boolean {
  const bridgePath = getCocosBridgePath(projectPath);
  return (
    existsSync(join(bridgePath, 'package.json')) &&
    existsSync(join(bridgePath, 'browser.js')) &&
    existsSync(join(bridgePath, 'server.json'))
  );
}

export function diagnoseCocosEnvironment(input: { project: Project; projectPath: string }): WorkspaceToolActionResult {
  const installation = findCocosCreatorInstallation();
  const project = inspectCocosProject(input.projectPath);
  const buildCommand = createCocosCliBuildCommand({
    projectPath: project.projectPath,
    projectId: input.project.id
  });
  return {
    ok: true,
    summary: [
      'Engine platform: cocos',
      'Engine adapter: Cocos Creator Adapter',
      'Capability: diagnose',
      'Supported: yes',
      installation ? `Cocos Creator executable: ${installation.executablePath}` : 'Cocos Creator executable: not found',
      installation?.version ? `Detected Creator version: ${installation.version}` : '',
      installation?.source ? `Install source: ${installation.source}` : '',
      `Project path: ${project.projectPath}`,
      `Project path exists: ${project.exists ? 'yes' : 'no'}`,
      `Cocos project valid: ${project.valid ? 'yes' : 'no'}`,
      project.indicators.length ? `Project indicators: ${project.indicators.join(', ')}` : '',
      project.missing.length ? `Missing project indicators: ${project.missing.join(', ')}` : '',
      `Funplay Cocos MCP installed: ${project.valid && isCocosBridgeInstalled(project.projectPath) ? 'yes' : 'no'}`,
      `Default MCP endpoint: ${DEFAULT_COCOS_MCP_BASE_URL}`,
      'CLI build support: command-line publishing is available through CocosCreator --project ... --build ...',
      'Headless caveat: Cocos Creator 3.8 command-line builds still require a GUI/window server according to official docs.',
      buildCommand ? `Suggested verification command: ${buildCommand.command}` : '',
      'Bridge/MCP support: install_engine_bridge clones FunplayAI/funplay-cocos-mcp into extensions/funplay-cocos-mcp; then open Funplay > MCP Server in Cocos Creator.'
    ]
      .filter(Boolean)
      .join('\n')
  };
}

function spawnDetached(command: string, args: string[]): WorkspaceToolActionResult {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return {
      ok: true,
      summary: `Started ${command} ${args.join(' ')}`
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      summary: `Failed to start ${command}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function openCocosDashboard(): WorkspaceToolActionResult {
  const dashboard = findCocosDashboardExecutable();
  if (!dashboard) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: cocos',
        'Engine adapter: Cocos Creator Adapter',
        'Capability: openHub',
        'Cocos Dashboard executable: not found',
        'Next action: install Cocos Dashboard or set COCOS_DASHBOARD_EXECUTABLE.'
      ].join('\n')
    };
  }
  const result = spawnDetached(dashboard, []);
  return {
    ...result,
    summary: [
      'Engine platform: cocos',
      'Engine adapter: Cocos Creator Adapter',
      'Capability: openHub',
      `Cocos Dashboard executable: ${dashboard}`,
      result.summary
    ].join('\n')
  };
}

interface CocosLaunchOutcome {
  started: boolean;
  reason?: string;
}

// Spawn the Cocos Creator editor and observe a brief window for an early crash,
// instead of reporting success the instant spawn() is issued. Exit code 0 (a
// launcher that handed off cleanly) or surviving the window both count as a
// successful launch; a spawn error (e.g. ENOENT) or a NON-ZERO early exit means
// the editor died on launch. observeMs is injectable so tests resolve fast.
async function launchCocosEditor(command: string, args: string[], observeMs = 800): Promise<CocosLaunchOutcome> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, { detached: true, stdio: 'ignore' });
  } catch (error) {
    return { started: false, reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return await new Promise<CocosLaunchOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: CocosLaunchOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };
    child.once('error', (error) =>
      settle({ started: false, reason: `launch error: ${error instanceof Error ? error.message : String(error)}` })
    );
    child.once('exit', (code, signal) => {
      if (code === 0) {
        settle({ started: true });
      } else {
        settle({
          started: false,
          reason: signal
            ? `Cocos Creator was terminated by ${signal} on launch`
            : `Cocos Creator exited immediately with code ${code}`
        });
      }
    });
    const timer = setTimeout(() => {
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      child.unref();
      settle({ started: true });
    }, observeMs);
    timer.unref?.();
  });
}

export async function openCocosProject(input: {
  projectPath: string;
  observeMs?: number;
}): Promise<WorkspaceToolActionResult> {
  const installation = findCocosCreatorInstallation();
  const project = inspectCocosProject(input.projectPath);
  if (!installation) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: cocos',
        'Engine adapter: Cocos Creator Adapter',
        'Capability: openProject',
        'Cocos Creator executable: not found',
        'Next action: install Cocos Creator via Cocos Dashboard or set COCOS_CREATOR_EXECUTABLE.'
      ].join('\n')
    };
  }
  if (!project.valid) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: cocos',
        'Engine adapter: Cocos Creator Adapter',
        'Capability: openProject',
        `Project path: ${project.projectPath}`,
        `Cocos project valid: ${project.valid ? 'yes' : 'no'}`,
        project.missing.length ? `Missing project indicators: ${project.missing.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    };
  }
  if (isCocosProjectCurrentlyOpen(project.projectPath)) {
    return {
      ok: true,
      summary: [
        'Engine platform: cocos',
        'Engine adapter: Cocos Creator Adapter',
        'Capability: openProject',
        `Cocos Creator executable: ${installation.executablePath}`,
        `Project path: ${project.projectPath}`,
        'Project already open: yes',
        'Skipped launch: Cocos Creator already has this project open.'
      ].join('\n')
    };
  }
  const launch = await launchCocosEditor(installation.executablePath, ['--project', project.projectPath], input.observeMs);
  if (!launch.started) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: cocos',
        'Engine adapter: Cocos Creator Adapter',
        'Capability: openProject',
        `Cocos Creator executable: ${installation.executablePath}`,
        `Project path: ${project.projectPath}`,
        `Launch failed: ${launch.reason ?? 'Cocos Creator did not stay open.'}`,
        'Next action: open the project manually in Cocos Creator and start Funplay > MCP Server.'
      ].join('\n')
    };
  }
  return {
    ok: true,
    summary: [
      'Engine platform: cocos',
      'Engine adapter: Cocos Creator Adapter',
      'Capability: openProject',
      `Cocos Creator executable: ${installation.executablePath}`,
      `Project path: ${project.projectPath}`,
      'Project launch: started (survived the early-exit watch).',
      'Bridge connectivity: the Funplay Cocos MCP bridge stays offline until you open Funplay > MCP Server inside Cocos Creator.'
    ].join('\n')
  };
}

// After a copy/clone, confirm the bridge files actually landed instead of
// inferring success from a zero exit status alone — a partial/corrupt clone or a
// copy from an incomplete source would otherwise be reported as installed.
function verifyCocosBridgeLanded(projectPath: string, bridgePath: string): WorkspaceToolActionResult | null {
  if (isCocosBridgeInstalled(projectPath)) {
    return null;
  }
  return {
    ok: false,
    isError: true,
    summary: [
      'Engine platform: cocos',
      'Engine adapter: Cocos Creator Adapter',
      'Capability: installBridge',
      `Install incomplete: ${bridgePath} is missing required Funplay Cocos MCP files (package.json / browser.js / server.json).`,
      'Next action: remove that folder and retry install_engine_bridge.'
    ].join('\n')
  };
}

export function installCocosBridge(input: { projectPath: string }): WorkspaceToolActionResult {
  const project = inspectCocosProject(input.projectPath);
  if (!project.valid) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: cocos',
        'Engine adapter: Cocos Creator Adapter',
        'Capability: installBridge',
        `Project path: ${project.projectPath}`,
        `Cocos project valid: ${project.valid ? 'yes' : 'no'}`,
        project.missing.length ? `Missing project indicators: ${project.missing.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    };
  }

  const extensionsPath = join(project.projectPath, 'extensions');
  const bridgePath = getCocosBridgePath(project.projectPath);
  if (isCocosBridgeInstalled(project.projectPath)) {
    return {
      ok: true,
      summary: [
        'Engine platform: cocos',
        'Engine adapter: Cocos Creator Adapter',
        'Capability: installBridge',
        `Funplay Cocos MCP already installed: ${bridgePath}`,
        `Default MCP endpoint: ${DEFAULT_COCOS_MCP_BASE_URL}`,
        'Next action: restart Cocos Creator or reload extensions, then open Funplay > MCP Server.'
      ].join('\n')
    };
  }
  if (existsSync(bridgePath)) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: cocos',
        'Engine adapter: Cocos Creator Adapter',
        'Capability: installBridge',
        `Target path already exists but does not look like Funplay Cocos MCP: ${bridgePath}`,
        'Next action: remove or inspect that folder, then retry install_engine_bridge.'
      ].join('\n')
    };
  }

  try {
    mkdirSync(extensionsPath, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      isError: true,
      summary: `Failed to create Cocos extensions directory ${extensionsPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  // Offline source override: copy a local bridge checkout instead of cloning.
  // Lets tests (and air-gapped installs) bring the bridge without hitting the
  // network — the live git clone is the default only when this is unset.
  const localSource = normalizePath(process.env.FUNPLAY_COCOS_MCP_LOCAL_SOURCE);
  if (localSource && existsSync(localSource)) {
    try {
      cpSync(localSource, bridgePath, { recursive: true });
      const incomplete = verifyCocosBridgeLanded(project.projectPath, bridgePath);
      if (incomplete) {
        return incomplete;
      }
      return {
        ok: true,
        summary: [
          'Engine platform: cocos',
          'Engine adapter: Cocos Creator Adapter',
          'Capability: installBridge',
          `Funplay Cocos MCP installed from local source: ${bridgePath}`,
          `Default MCP endpoint: ${DEFAULT_COCOS_MCP_BASE_URL}`,
          'Next action: restart Cocos Creator or reload extensions, then open Funplay > MCP Server.'
        ].join('\n')
      };
    } catch (error) {
      return {
        ok: false,
        isError: true,
        summary: `Failed to copy Cocos bridge from ${localSource}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  const cloned = spawnSync(
    'git',
    ['clone', '--depth', '1', '--branch', FUNPLAY_COCOS_MCP_PINNED_REF, FUNPLAY_COCOS_MCP_REPO, bridgePath],
    {
      encoding: 'utf8',
      timeout: 120_000
    }
  );
  if (cloned.status !== 0) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: cocos',
        'Engine adapter: Cocos Creator Adapter',
        'Capability: installBridge',
        `Failed to clone ${FUNPLAY_COCOS_MCP_REPO}`,
        cloned.error ? `Error: ${cloned.error.message}` : '',
        cloned.stderr ? `stderr: ${cloned.stderr.slice(0, 2000)}` : '',
        cloned.stdout ? `stdout: ${cloned.stdout.slice(0, 1000)}` : '',
        'Next action: check git/network access or install the GitHub release zip manually into extensions/funplay-cocos-mcp.'
      ]
        .filter(Boolean)
        .join('\n')
    };
  }

  const incomplete = verifyCocosBridgeLanded(project.projectPath, bridgePath);
  if (incomplete) {
    return incomplete;
  }

  return {
    ok: true,
    summary: [
      'Engine platform: cocos',
      'Engine adapter: Cocos Creator Adapter',
      'Capability: installBridge',
      `Installed Funplay Cocos MCP: ${bridgePath}`,
      `Repository: ${FUNPLAY_COCOS_MCP_REPO} @ ${FUNPLAY_COCOS_MCP_PINNED_REF}`,
      `Default MCP endpoint: ${DEFAULT_COCOS_MCP_BASE_URL}`,
      'Next action: restart Cocos Creator or reload extensions, then open Funplay > MCP Server.'
    ].join('\n')
  };
}
