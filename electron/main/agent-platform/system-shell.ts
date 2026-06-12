import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Cross-platform shell resolution for spawning commands.
 *
 * The old code hardcoded `process.env.SHELL || '/bin/sh'` together with Unix
 * flags (`-lc` / `-i`). On Windows `$SHELL` is normally unset, so it fell back
 * to `/bin/sh` — which does not exist there — producing `spawn /bin/sh ENOENT`.
 * Resolve the platform-native shell instead: cmd.exe on Windows (via %ComSpec%),
 * the login/interactive shell on Unix.
 */

/**
 * One-shot command execution for `run_command`:
 * `cmd /d /s /c <command>` on Windows, `sh -lc <command>` on Unix.
 */
export function resolveRunCommandShell(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { shell: process.env.SHELL || '/bin/sh', args: ['-lc', command] };
}

/**
 * Interactive persistent terminal: bare `cmd.exe` on Windows (it reads commands
 * from stdin by default), `sh -i` on Unix.
 */
export function resolveInteractiveShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'cmd.exe', args: [] };
  }
  return { shell: process.env.SHELL || '/bin/sh', args: ['-i'] };
}

/**
 * OS-level sandboxing for `run_command`.
 *
 * - macOS: wrap the spawn in `sandbox-exec` with a generated Seatbelt profile
 *   (read everywhere, write only to the project / tmp / Funplay user-data dirs,
 *   network on by default with a no-network variant).
 * - Linux: best-effort `bwrap` when present (`--ro-bind / /`, project rw,
 *   optional `--unshare-net`); otherwise the run is recorded as downgraded.
 * - Windows: no sandbox backend — commands run unsandboxed and the downgrade
 *   is recorded so callers can surface it.
 */

export type CommandSandboxKind = 'seatbelt' | 'bwrap' | 'none';

export interface CommandSandboxPolicy {
  /** Project root that stays writable inside the sandbox. */
  projectPath: string;
  /** Whether outbound/inbound network access is allowed. */
  allowNetwork: boolean;
  /** Additional writable roots (os tmpdir, Funplay user-data dirs, ...). */
  extraWritePaths?: string[];
}

export interface CommandSandboxCapability {
  kind: CommandSandboxKind;
  available: boolean;
  /** Human-readable availability note (binary path or unavailability reason). */
  detail: string;
  /** Absolute path of the sandbox binary when available. */
  binaryPath?: string;
}

export interface ResolvedSandboxedCommandShell {
  shell: string;
  args: string[];
  sandbox: {
    kind: CommandSandboxKind;
    /** True when the spawn is actually wrapped by a sandbox backend. */
    applied: boolean;
    networkAllowed: boolean;
    /** True when sandboxing was requested but no backend is available on this host. */
    downgraded: boolean;
    detail: string;
  };
}

const MACOS_SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** Device nodes shells and common CLIs write to even for read-only work. */
const SEATBELT_WRITABLE_DEVICE_LITERALS = [
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/dtracehelper'
];

function escapeSeatbeltString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeSandboxWritePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

/**
 * On macOS `/tmp`, `/var` and `/etc` are symlinks into `/private`; Seatbelt
 * matches resolved paths, so emit the `/private`-prefixed twin as well.
 */
function expandMacosPrivateAliases(paths: string[]): string[] {
  const expanded: string[] = [];
  for (const path of paths) {
    expanded.push(path);
    if (/^\/(?:tmp|var|etc)(?:\/|$)/.test(path)) {
      expanded.push(`/private${path}`);
    }
  }
  return expanded;
}

function uniqueNonEmpty(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.map((path) => normalizeSandboxWritePath(path ?? '')).filter(Boolean))];
}

/**
 * Pure Seatbelt profile generator for `sandbox-exec -p`.
 * Later rules win in Seatbelt, so the profile allows everything, denies all
 * file writes, then re-allows the device literals and the writable roots; the
 * optional trailing `(deny network*)` implements the no-network variant.
 */
export function buildSandboxProfile(policy: CommandSandboxPolicy): string {
  const writeRoots = expandMacosPrivateAliases(uniqueNonEmpty([policy.projectPath, ...(policy.extraWritePaths ?? [])]));
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...SEATBELT_WRITABLE_DEVICE_LITERALS.map((device) => `  (literal "${escapeSeatbeltString(device)}")`),
    ...writeRoots.map((root) => `  (subpath "${escapeSeatbeltString(root)}")`)
  ];
  lines[lines.length - 1] += ')';
  if (!policy.allowNetwork) {
    lines.push('(deny network*)');
  }
  return lines.join('\n');
}

/** Best-effort bwrap argument list mirroring the Seatbelt policy. */
export function buildBwrapArgs(policy: CommandSandboxPolicy, shell: string, shellArgs: string[]): string[] {
  const writeRoots = uniqueNonEmpty([policy.projectPath, ...(policy.extraWritePaths ?? [])]);
  return [
    '--ro-bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    ...writeRoots.flatMap((root) => ['--bind', root, root]),
    ...(policy.allowNetwork ? [] : ['--unshare-net']),
    '--die-with-parent',
    '--',
    shell,
    ...shellArgs
  ];
}

function findExecutableOnPath(binary: string): string | undefined {
  for (const segment of (process.env.PATH ?? '').split(delimiter)) {
    if (!segment) {
      continue;
    }
    const candidate = join(segment, binary);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function probeCommandSandboxCapability(): CommandSandboxCapability {
  if (process.platform === 'darwin') {
    if (existsSync(MACOS_SANDBOX_EXEC_PATH)) {
      return { kind: 'seatbelt', available: true, detail: MACOS_SANDBOX_EXEC_PATH, binaryPath: MACOS_SANDBOX_EXEC_PATH };
    }
    return { kind: 'none', available: false, detail: '未找到 sandbox-exec' };
  }
  if (process.platform === 'linux') {
    const bwrapPath = findExecutableOnPath('bwrap');
    if (bwrapPath) {
      return { kind: 'bwrap', available: true, detail: bwrapPath, binaryPath: bwrapPath };
    }
    return { kind: 'none', available: false, detail: '未找到 bwrap' };
  }
  return { kind: 'none', available: false, detail: `平台 ${process.platform} 不支持命令沙箱` };
}

let cachedCommandSandboxCapability: CommandSandboxCapability | undefined;

/** Detects the host sandbox backend once and caches the result for the process lifetime. */
export function detectCommandSandboxCapability(): CommandSandboxCapability {
  if (!cachedCommandSandboxCapability) {
    cachedCommandSandboxCapability = probeCommandSandboxCapability();
  }
  return cachedCommandSandboxCapability;
}

/** Test seam: override the cached capability, or pass undefined to re-probe lazily. */
export function setCommandSandboxCapabilityForTests(capability: CommandSandboxCapability | undefined): void {
  cachedCommandSandboxCapability = capability;
}

/**
 * Resolves the `run_command` spawn wrapped in the host sandbox backend.
 * Falls back to the plain shell spawn (recorded as `downgraded`) when no
 * backend is available, so callers can surface the downgrade to the user.
 */
export function resolveSandboxedRunCommandShell(
  command: string,
  policy: CommandSandboxPolicy
): ResolvedSandboxedCommandShell {
  const base = resolveRunCommandShell(command);
  const capability = detectCommandSandboxCapability();
  if (capability.kind === 'seatbelt' && capability.binaryPath) {
    return {
      shell: capability.binaryPath,
      args: ['-p', buildSandboxProfile(policy), base.shell, ...base.args],
      sandbox: {
        kind: 'seatbelt',
        applied: true,
        networkAllowed: policy.allowNetwork,
        downgraded: false,
        detail: capability.detail
      }
    };
  }
  if (capability.kind === 'bwrap' && capability.binaryPath) {
    return {
      shell: capability.binaryPath,
      args: buildBwrapArgs(policy, base.shell, base.args),
      sandbox: {
        kind: 'bwrap',
        applied: true,
        networkAllowed: policy.allowNetwork,
        downgraded: false,
        detail: capability.detail
      }
    };
  }
  return {
    shell: base.shell,
    args: base.args,
    sandbox: {
      kind: 'none',
      applied: false,
      networkAllowed: true,
      downgraded: true,
      detail: capability.detail
    }
  };
}

/** Permission-prompt status line for run_command (derived from input.unsandboxed + host availability). */
export function describeRunCommandSandboxStatus(unsandboxedRequested: boolean): string {
  if (unsandboxedRequested) {
    return '已禁用（显式请求）';
  }
  const capability = detectCommandSandboxCapability();
  return capability.available ? 'workspace-write' : `不可用（${capability.detail}，将以非沙箱方式执行）`;
}
