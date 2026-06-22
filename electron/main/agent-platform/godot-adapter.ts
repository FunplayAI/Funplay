import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { Project } from '../../../shared/types';
import type { WorkspaceToolActionResult } from './workspace-tools-types';

// Godot mirrors the Cocos-creator3 adapter shape: a GUI editor we detect/launch,
// plus an external MCP bridge that ships as a Godot editor plugin (addon) cloned
// from FunplayAI/funplay-godot-mcp into the project's res://addons/funplay_mcp.

export interface GodotInstallation {
  executablePath: string;
  source: string;
  version?: string;
}

export interface GodotProjectInspection {
  projectPath: string;
  exists: boolean;
  valid: boolean;
  indicators: string[];
  missing: string[];
}

export interface GodotTemplateProjectResult extends WorkspaceToolActionResult {
  projectPath?: string;
}

const GODOT_ENV_KEYS = ['GODOT4_BIN', 'GODOT_BIN', 'GODOT_EXECUTABLE', 'GODOT_PATH', 'GODOT'];

const FUNPLAY_GODOT_MCP_REPO = 'https://github.com/FunplayAI/funplay-godot-mcp.git';
// Pin installs to a published release tag for reproducibility — a bare clone of
// the default branch could drift mid-development. Bump this when the bridge ships
// a new release.
const FUNPLAY_GODOT_MCP_PINNED_REF = 'v0.9.2';
// The bridge lives as a Godot editor plugin under the project's addons/ folder.
const FUNPLAY_GODOT_MCP_ADDON_DIR = 'funplay_mcp';
export const DEFAULT_GODOT_MCP_BASE_URL = 'http://127.0.0.1:8765/';

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

export function isGodotProjectCurrentlyOpen(projectPath: string): boolean {
  const variants = normalizeProjectPathVariants(projectPath);
  if (!variants.length) {
    return false;
  }
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
    return output
      .split('\n')
      .some((line) => /godot/i.test(line) && variants.some((variant) => line.includes(variant)));
  } catch {
    return false;
  }
}

function safeProjectName(value: string): string {
  return value.trim().replace(/["\n\r]+/g, ' ').trim().slice(0, 80) || 'Godot Project';
}

// Godot ships as a single portable binary (no installer); on macOS it's wrapped in
// a .app whose Mach-O is at Contents/MacOS/Godot.
function godotBinaryFromCandidate(path: string): string {
  if (process.platform === 'darwin' && path.endsWith('.app')) {
    return join(path, 'Contents', 'MacOS', 'Godot');
  }
  return path;
}

function godotVersionFromPath(path: string): string | undefined {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(path)?.[1];
}

function pushInstallation(installations: GodotInstallation[], executablePath: string, source: string): void {
  const resolved = godotBinaryFromCandidate(resolveHomePath(executablePath));
  if (!existsSync(resolved)) {
    return;
  }
  installations.push({ executablePath: resolved, source, version: godotVersionFromPath(resolved) });
}

function scanForGodotApps(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => /^godot.*\.app$/i.test(entry.name))
      .map((entry) => join(root, entry.name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function scanForGodotExecutables(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^godot.*\.exe$/i.test(entry.name) && !/console/i.test(entry.name))
      .map((entry) => join(root, entry.name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function godotFromPath(): string | undefined {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['godot4', 'godot']) {
    try {
      const found = execFileSync(locator, [name], { encoding: 'utf8' }).split('\n')[0]?.trim();
      if (found && existsSync(found)) {
        return found;
      }
    } catch {
      // not on PATH
    }
  }
  return undefined;
}

export function detectGodotInstallations(env: NodeJS.ProcessEnv = process.env): GodotInstallation[] {
  const installations: GodotInstallation[] = [];
  for (const key of GODOT_ENV_KEYS) {
    const value = normalizePath(env[key]);
    if (value) {
      pushInstallation(installations, value, `env:${key}`);
    }
  }

  if (process.platform === 'darwin') {
    for (const root of ['/Applications', join(homedir(), 'Applications')]) {
      for (const app of scanForGodotApps(root)) {
        pushInstallation(installations, app, 'macos:applications');
      }
    }
  } else if (process.platform === 'win32') {
    for (const root of uniqueValues([
      env.ProgramFiles ? join(env.ProgramFiles, 'Godot') : '',
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Godot') : '',
      env.USERPROFILE ? join(env.USERPROFILE, 'scoop', 'apps', 'godot', 'current') : ''
    ])) {
      for (const exe of scanForGodotExecutables(root)) {
        pushInstallation(installations, exe, 'windows:program-files');
      }
    }
  } else {
    for (const candidate of ['/usr/bin/godot', '/usr/local/bin/godot', '/opt/godot/godot', join(homedir(), '.local/bin/godot')]) {
      pushInstallation(installations, candidate, 'linux:default-path');
    }
  }

  const onPath = godotFromPath();
  if (onPath) {
    pushInstallation(installations, onPath, 'path');
  }

  return uniqueValues(installations.map((installation) => installation.executablePath))
    .map((path) => installations.find((installation) => installation.executablePath === path)!)
    .sort((a, b) => {
      // An explicit env override always wins (its version is unknown -> '' and
      // would otherwise sort last and be silently discarded).
      const aEnv = a.source.startsWith('env:');
      const bEnv = b.source.startsWith('env:');
      if (aEnv !== bEnv) {
        return aEnv ? -1 : 1;
      }
      return (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true });
    });
}

export function findGodotInstallation(env?: NodeJS.ProcessEnv): GodotInstallation | undefined {
  return detectGodotInstallations(env)[0];
}

export function inspectGodotProject(projectPath: string): GodotProjectInspection {
  const resolved = resolve(resolveHomePath(projectPath));
  const exists = existsSync(resolved);
  const hasProjectGodot = existsSync(join(resolved, 'project.godot'));
  return {
    projectPath: resolved,
    exists,
    valid: exists && hasProjectGodot,
    indicators: [hasProjectGodot ? 'project.godot' : ''].filter(Boolean),
    missing: [exists ? '' : 'project directory', hasProjectGodot ? '' : 'project.godot'].filter(Boolean)
  };
}

export function createGodotProjectFromTemplate(input: {
  targetProjectPath: string;
  projectName: string;
  dimension: '2d' | '3d' | 'unknown';
}): GodotTemplateProjectResult {
  const projectName = safeProjectName(input.projectName);
  const targetProjectPath = resolve(resolveHomePath(input.targetProjectPath));
  const parentPath = join(targetProjectPath, '..');
  if (!existsSync(parentPath)) {
    return { ok: false, isError: true, summary: `Godot project parent directory does not exist: ${parentPath}` };
  }

  const existing = inspectGodotProject(targetProjectPath);
  if (existing.valid) {
    return { ok: true, projectPath: existing.projectPath, summary: `Godot project already exists: ${existing.projectPath}` };
  }
  if (existing.exists) {
    try {
      if (readdirSync(targetProjectPath).length > 0) {
        return {
          ok: false,
          isError: true,
          summary: `Target path already exists and is not an empty Godot project directory: ${targetProjectPath}`
        };
      }
    } catch (error) {
      return {
        ok: false,
        isError: true,
        summary: `Failed to inspect target Godot project directory: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  // Godot has no clean headless "create project" CLI, so bootstrap a minimal valid
  // project (project.godot + a default main scene). The editor fills in res://.godot
  // on first open. The root node type follows the requested 2D/3D dimension.
  const rootNodeType = input.dimension === '3d' ? 'Node3D' : 'Node2D';
  const projectGodot = [
    '; Engine configuration file.',
    '; Generated by Funplay.',
    '',
    'config_version=5',
    '',
    '[application]',
    '',
    `config/name="${projectName}"`,
    'run/main_scene="res://main.tscn"',
    'config/features=PackedStringArray("4.2")',
    ''
  ].join('\n');
  const mainScene = [
    '[gd_scene format=3]',
    '',
    `[node name="Main" type="${rootNodeType}"]`,
    ''
  ].join('\n');

  try {
    mkdirSync(targetProjectPath, { recursive: true });
    writeFileSync(join(targetProjectPath, 'project.godot'), projectGodot, 'utf8');
    writeFileSync(join(targetProjectPath, 'main.tscn'), mainScene, 'utf8');
  } catch (error) {
    return {
      ok: false,
      isError: true,
      summary: `Failed to create Godot project: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  return {
    ok: true,
    projectPath: targetProjectPath,
    summary: [
      'Engine platform: godot',
      'Capability: createProject',
      `Project path: ${targetProjectPath}`,
      `Main scene root: ${rootNodeType} (${input.dimension})`,
      'Next action: open_engine_project to launch the Godot editor, then install_engine_bridge.'
    ].join('\n')
  };
}

export function getGodotBridgePath(projectPath: string): string {
  return join(resolve(resolveHomePath(projectPath)), 'addons', FUNPLAY_GODOT_MCP_ADDON_DIR);
}

export function isGodotBridgeInstalled(projectPath: string): boolean {
  const bridgePath = getGodotBridgePath(projectPath);
  return existsSync(join(bridgePath, 'plugin.cfg')) && existsSync(join(bridgePath, 'plugin.gd'));
}

export function diagnoseGodotEnvironment(input: { project: Project; projectPath: string }): WorkspaceToolActionResult {
  const installation = findGodotInstallation();
  const project = inspectGodotProject(input.projectPath);
  return {
    ok: true,
    summary: [
      'Engine platform: godot',
      'Engine adapter: Godot Adapter',
      'Capability: diagnose',
      'Supported: yes',
      installation ? `Godot executable: ${installation.executablePath}` : 'Godot executable: not found',
      installation?.version ? `Detected Godot version: ${installation.version}` : '',
      installation?.source ? `Install source: ${installation.source}` : '',
      `Project path: ${project.projectPath}`,
      `Project path exists: ${project.exists ? 'yes' : 'no'}`,
      `Godot project valid: ${project.valid ? 'yes' : 'no'}`,
      project.indicators.length ? `Project indicators: ${project.indicators.join(', ')}` : '',
      project.missing.length ? `Missing project indicators: ${project.missing.join(', ')}` : '',
      `Funplay Godot MCP installed: ${project.valid && isGodotBridgeInstalled(project.projectPath) ? 'yes' : 'no'}`,
      `Default MCP endpoint: ${DEFAULT_GODOT_MCP_BASE_URL}`,
      'Godot requirement: Godot 4.2+ (GDScript; .NET projects expose C# where applicable).',
      'Bridge/MCP support: install_engine_bridge clones FunplayAI/funplay-godot-mcp into addons/funplay_mcp; then enable "Funplay MCP for Godot" in Project Settings > Plugins.'
    ]
      .filter(Boolean)
      .join('\n')
  };
}

function spawnDetached(command: string, args: string[]): WorkspaceToolActionResult {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, summary: `Started ${command} ${args.join(' ')}` };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      summary: `Failed to start ${command}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// openHub for Godot = the project manager (Godot launched with no project). If no
// editor is installed, point the user at the download page.
export function openGodotProjectManager(
  options: { resolveGodot?: () => GodotInstallation | undefined; launch?: (command: string, args: string[]) => WorkspaceToolActionResult } = {}
): WorkspaceToolActionResult {
  const resolveGodot = options.resolveGodot ?? (() => findGodotInstallation());
  const launch = options.launch ?? spawnDetached;
  const installation = resolveGodot();
  if (!installation) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: godot',
        'Engine adapter: Godot Adapter',
        'Capability: openHub',
        'Godot executable: not found',
        'Next action: install Godot 4.2+ from https://godotengine.org/download or set GODOT_BIN.'
      ].join('\n')
    };
  }
  const result = launch(installation.executablePath, ['--project-manager']);
  return {
    ...result,
    summary: [
      'Engine platform: godot',
      'Engine adapter: Godot Adapter',
      'Capability: openHub',
      `Godot executable: ${installation.executablePath}`,
      result.summary
    ].join('\n')
  };
}

interface GodotLaunchOutcome {
  started: boolean;
  reason?: string;
}

// Spawn the Godot editor and observe a brief window for an early crash instead of
// reporting success the instant spawn() is issued. Exit code 0 or surviving the
// window both count as a launch; a spawn error or a non-zero early exit means the
// editor died on launch. observeMs is injectable so tests resolve fast.
async function launchGodotEditor(command: string, args: string[], observeMs = 800): Promise<GodotLaunchOutcome> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, { detached: true, stdio: 'ignore' });
  } catch (error) {
    return { started: false, reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return await new Promise<GodotLaunchOutcome>((resolveOutcome) => {
    let settled = false;
    const settle = (outcome: GodotLaunchOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolveOutcome(outcome);
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
          reason: signal ? `Godot was terminated by ${signal} on launch` : `Godot exited immediately with code ${code}`
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

export async function openGodotProject(input: { projectPath: string; observeMs?: number }): Promise<WorkspaceToolActionResult> {
  const installation = findGodotInstallation();
  const project = inspectGodotProject(input.projectPath);
  if (!installation) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: godot',
        'Engine adapter: Godot Adapter',
        'Capability: openProject',
        'Godot executable: not found',
        'Next action: install Godot 4.2+ from https://godotengine.org/download or set GODOT_BIN.'
      ].join('\n')
    };
  }
  if (!project.valid) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: godot',
        'Engine adapter: Godot Adapter',
        'Capability: openProject',
        `Project path: ${project.projectPath}`,
        `Godot project valid: ${project.valid ? 'yes' : 'no'}`,
        project.missing.length ? `Missing project indicators: ${project.missing.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    };
  }
  if (isGodotProjectCurrentlyOpen(project.projectPath)) {
    return {
      ok: true,
      summary: [
        'Engine platform: godot',
        'Engine adapter: Godot Adapter',
        'Capability: openProject',
        `Godot executable: ${installation.executablePath}`,
        `Project path: ${project.projectPath}`,
        'Project already open: yes',
        'Skipped launch: Godot already has this project open.'
      ].join('\n')
    };
  }
  const launch = await launchGodotEditor(
    installation.executablePath,
    ['--editor', '--path', project.projectPath],
    input.observeMs
  );
  if (!launch.started) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: godot',
        'Engine adapter: Godot Adapter',
        'Capability: openProject',
        `Godot executable: ${installation.executablePath}`,
        `Project path: ${project.projectPath}`,
        `Launch failed: ${launch.reason ?? 'Godot did not stay open.'}`,
        'Next action: open the project manually in Godot and enable the Funplay MCP plugin.'
      ].join('\n')
    };
  }
  return {
    ok: true,
    summary: [
      'Engine platform: godot',
      'Engine adapter: Godot Adapter',
      'Capability: openProject',
      `Godot executable: ${installation.executablePath}`,
      `Project path: ${project.projectPath}`,
      'Project launch: started (survived the early-exit watch).',
      'Bridge connectivity: the Funplay Godot MCP bridge stays offline until you enable the plugin in Project Settings > Plugins.'
    ].join('\n')
  };
}

// After a copy/clone, confirm the addon files actually landed instead of inferring
// success from a zero exit status alone.
function verifyGodotBridgeLanded(projectPath: string, bridgePath: string): WorkspaceToolActionResult | null {
  if (isGodotBridgeInstalled(projectPath)) {
    return null;
  }
  return {
    ok: false,
    isError: true,
    summary: [
      'Engine platform: godot',
      'Engine adapter: Godot Adapter',
      'Capability: installBridge',
      `Install incomplete: ${bridgePath} is missing required Funplay Godot MCP files (plugin.cfg / plugin.gd).`,
      'Next action: remove that folder and retry install_engine_bridge.'
    ].join('\n')
  };
}

// The bridge is the addons/funplay_mcp SUBFOLDER of the repo, so we clone to a temp
// dir and copy that addon into the project (rather than cloning the repo root in).
function copyGodotAddonFromSource(addonSource: string, bridgePath: string): void {
  mkdirSync(join(bridgePath, '..'), { recursive: true });
  cpSync(addonSource, bridgePath, { recursive: true });
}

function resolveLocalAddonSource(localSource: string): string | undefined {
  const nested = join(localSource, 'addons', FUNPLAY_GODOT_MCP_ADDON_DIR);
  if (existsSync(join(nested, 'plugin.cfg'))) {
    return nested;
  }
  if (existsSync(join(localSource, 'plugin.cfg'))) {
    return localSource;
  }
  return undefined;
}

export function installGodotBridge(input: { projectPath: string }): WorkspaceToolActionResult {
  const project = inspectGodotProject(input.projectPath);
  if (!project.valid) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: godot',
        'Engine adapter: Godot Adapter',
        'Capability: installBridge',
        `Project path: ${project.projectPath}`,
        `Godot project valid: ${project.valid ? 'yes' : 'no'}`,
        project.missing.length ? `Missing project indicators: ${project.missing.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    };
  }

  const bridgePath = getGodotBridgePath(project.projectPath);
  if (isGodotBridgeInstalled(project.projectPath)) {
    return {
      ok: true,
      summary: [
        'Engine platform: godot',
        'Engine adapter: Godot Adapter',
        'Capability: installBridge',
        `Funplay Godot MCP already installed: ${bridgePath}`,
        `Default MCP endpoint: ${DEFAULT_GODOT_MCP_BASE_URL}`,
        'Next action: enable "Funplay MCP for Godot" in Project Settings > Plugins.'
      ].join('\n')
    };
  }
  if (existsSync(bridgePath)) {
    return {
      ok: false,
      isError: true,
      summary: [
        'Engine platform: godot',
        'Engine adapter: Godot Adapter',
        'Capability: installBridge',
        `Target path already exists but does not look like Funplay Godot MCP: ${bridgePath}`,
        'Next action: remove or inspect that folder, then retry install_engine_bridge.'
      ].join('\n')
    };
  }

  // Offline source override: copy a local bridge checkout instead of cloning. Lets
  // tests (and air-gapped installs) bring the bridge without hitting the network.
  const localSource = normalizePath(process.env.FUNPLAY_GODOT_MCP_LOCAL_SOURCE);
  if (localSource && existsSync(localSource)) {
    const addonSource = resolveLocalAddonSource(localSource);
    if (!addonSource) {
      return {
        ok: false,
        isError: true,
        summary: `FUNPLAY_GODOT_MCP_LOCAL_SOURCE does not contain a Funplay Godot MCP addon (addons/${FUNPLAY_GODOT_MCP_ADDON_DIR}/plugin.cfg): ${localSource}`
      };
    }
    try {
      copyGodotAddonFromSource(addonSource, bridgePath);
      const incomplete = verifyGodotBridgeLanded(project.projectPath, bridgePath);
      if (incomplete) {
        return incomplete;
      }
      return {
        ok: true,
        summary: [
          'Engine platform: godot',
          'Engine adapter: Godot Adapter',
          'Capability: installBridge',
          `Funplay Godot MCP installed from local source: ${bridgePath}`,
          `Default MCP endpoint: ${DEFAULT_GODOT_MCP_BASE_URL}`,
          'Next action: enable "Funplay MCP for Godot" in Project Settings > Plugins.'
        ].join('\n')
      };
    } catch (error) {
      return {
        ok: false,
        isError: true,
        summary: `Failed to copy Godot bridge from ${localSource}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  const tempClone = mkdtempSync(join(tmpdir(), 'funplay-godot-mcp-'));
  try {
    const cloned = spawnSync(
      'git',
      ['clone', '--depth', '1', '--branch', FUNPLAY_GODOT_MCP_PINNED_REF, FUNPLAY_GODOT_MCP_REPO, tempClone],
      { encoding: 'utf8', timeout: 120_000 }
    );
    if (cloned.status !== 0) {
      return {
        ok: false,
        isError: true,
        summary: [
          'Engine platform: godot',
          'Engine adapter: Godot Adapter',
          'Capability: installBridge',
          `Failed to clone ${FUNPLAY_GODOT_MCP_REPO}`,
          cloned.error ? `Error: ${cloned.error.message}` : '',
          cloned.stderr ? `stderr: ${cloned.stderr.slice(0, 2000)}` : '',
          'Next action: check git/network access or install the GitHub release zip manually into addons/funplay_mcp.'
        ]
          .filter(Boolean)
          .join('\n')
      };
    }

    const addonSource = join(tempClone, 'addons', FUNPLAY_GODOT_MCP_ADDON_DIR);
    if (!existsSync(join(addonSource, 'plugin.cfg'))) {
      return {
        ok: false,
        isError: true,
        summary: `Cloned ${FUNPLAY_GODOT_MCP_REPO} but addons/${FUNPLAY_GODOT_MCP_ADDON_DIR}/plugin.cfg was not found — the bridge layout may have changed.`
      };
    }
    copyGodotAddonFromSource(addonSource, bridgePath);
  } catch (error) {
    return {
      ok: false,
      isError: true,
      summary: `Failed to install Godot bridge: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    rmSync(tempClone, { recursive: true, force: true });
  }

  const incomplete = verifyGodotBridgeLanded(project.projectPath, bridgePath);
  if (incomplete) {
    return incomplete;
  }

  return {
    ok: true,
    summary: [
      'Engine platform: godot',
      'Engine adapter: Godot Adapter',
      'Capability: installBridge',
      `Installed Funplay Godot MCP: ${bridgePath}`,
      `Repository: ${FUNPLAY_GODOT_MCP_REPO} @ ${FUNPLAY_GODOT_MCP_PINNED_REF}`,
      `Default MCP endpoint: ${DEFAULT_GODOT_MCP_BASE_URL}`,
      'Next action: enable "Funplay MCP for Godot" in Project Settings > Plugins.'
    ].join('\n')
  };
}
