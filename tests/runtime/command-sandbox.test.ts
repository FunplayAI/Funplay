import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBwrapArgs,
  buildSandboxProfile,
  describeRunCommandSandboxStatus,
  detectCommandSandboxCapability,
  resolveSandboxedRunCommandShell,
  setCommandSandboxCapabilityForTests
} from '../../electron/main/agent-platform/system-shell.ts';
import { getAgentToolDefinition } from '../../electron/main/agent-platform/tool-registry.ts';
import { resolveNativeToolPermission } from '../../electron/main/agent-platform/native/tool-permission.ts';
import { createNativeWorkspaceTools } from '../../electron/main/agent-platform/native/tool-adapter.ts';
import {
  executeAgentToolAction,
  executeWorkspaceToolAction
} from '../../electron/main/agent-platform/workspace-tools.ts';
import {
  consumePendingBackgroundCommandNotices,
  drainBackgroundCommandNoticeMessage,
  disposePersistentTerminals,
  readPersistentTerminal,
  readPersistentTerminalMetadata,
  startBackgroundCommandJob
} from '../../electron/main/agent-platform/persistent-terminal-store.ts';
import { buildProject, executeNativeWorkspaceTool } from './test-helpers.ts';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('buildSandboxProfile snapshots the workspace-write policy with network allowed', () => {
  const profile = buildSandboxProfile({
    projectPath: '/work/proj/',
    allowNetwork: true,
    extraWritePaths: ['/tmp/funplay-tmp', '/Users/dev/Library/Application Support/Funplay']
  });
  assert.equal(
    profile,
    [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write*',
      '  (literal "/dev/null")',
      '  (literal "/dev/stdout")',
      '  (literal "/dev/stderr")',
      '  (literal "/dev/tty")',
      '  (literal "/dev/dtracehelper")',
      '  (subpath "/work/proj")',
      '  (subpath "/tmp/funplay-tmp")',
      '  (subpath "/private/tmp/funplay-tmp")',
      '  (subpath "/Users/dev/Library/Application Support/Funplay"))'
    ].join('\n')
  );
});

test('buildSandboxProfile no-network variant appends a network deny rule', () => {
  const profile = buildSandboxProfile({
    projectPath: '/work/proj',
    allowNetwork: false
  });
  assert.equal(
    profile,
    [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write*',
      '  (literal "/dev/null")',
      '  (literal "/dev/stdout")',
      '  (literal "/dev/stderr")',
      '  (literal "/dev/tty")',
      '  (literal "/dev/dtracehelper")',
      '  (subpath "/work/proj"))',
      '(deny network*)'
    ].join('\n')
  );
});

test('buildSandboxProfile escapes quotes and backslashes and dedupes write roots', () => {
  const profile = buildSandboxProfile({
    projectPath: '/work/we"ird\\proj',
    allowNetwork: true,
    extraWritePaths: ['/work/we"ird\\proj', '/var/folders/abc']
  });
  assert.match(profile, /\(subpath "\/work\/we\\"ird\\\\proj"\)/);
  assert.equal(profile.match(/we\\"ird/g)?.length, 1);
  assert.match(profile, /\(subpath "\/var\/folders\/abc"\)/);
  assert.match(profile, /\(subpath "\/private\/var\/folders\/abc"\)/);
});

test('buildBwrapArgs binds the project rw over a read-only root and can unshare the network', () => {
  const policy = {
    projectPath: '/work/proj',
    allowNetwork: false,
    extraWritePaths: ['/tmp/scratch']
  };
  const args = buildBwrapArgs(policy, '/bin/sh', ['-lc', 'echo hi']);
  assert.deepEqual(args.slice(0, 3), ['--ro-bind', '/', '/']);
  assert.ok(args.join(' ').includes('--bind /work/proj /work/proj'));
  assert.ok(args.join(' ').includes('--bind /tmp/scratch /tmp/scratch'));
  assert.ok(args.includes('--unshare-net'));
  assert.deepEqual(args.slice(-3), ['/bin/sh', '-lc', 'echo hi']);

  const networked = buildBwrapArgs({ ...policy, allowNetwork: true }, '/bin/sh', ['-lc', 'echo hi']);
  assert.equal(networked.includes('--unshare-net'), false);
});

test('sandbox capability detection downgrades cleanly when no backend is available', () => {
  try {
    setCommandSandboxCapabilityForTests({ kind: 'none', available: false, detail: '测试模拟不可用' });
    const resolved = resolveSandboxedRunCommandShell('echo hi', {
      projectPath: '/work/proj',
      allowNetwork: true
    });
    assert.equal(resolved.sandbox.applied, false);
    assert.equal(resolved.sandbox.downgraded, true);
    assert.equal(resolved.sandbox.kind, 'none');
    assert.match(resolved.sandbox.detail, /测试模拟不可用/);
    if (process.platform !== 'win32') {
      assert.deepEqual(resolved.args, ['-lc', 'echo hi']);
    }
    assert.match(describeRunCommandSandboxStatus(false), /不可用（测试模拟不可用/);
  } finally {
    setCommandSandboxCapabilityForTests(undefined);
  }
});

test('describeRunCommandSandboxStatus reports the explicit unsandboxed request', () => {
  assert.equal(describeRunCommandSandboxStatus(true), '已禁用（显式请求）');
});

test('run_command schema enforces the raised 600000ms timeout bound and new flags', () => {
  const definition = getAgentToolDefinition('run_command');
  assert.ok(definition);

  assert.equal(definition.inputSchema.safeParse({ command: 'npm test', timeoutMs: 600_000 }).success, true);
  assert.equal(definition.inputSchema.safeParse({ command: 'npm test', timeoutMs: 600_001 }).success, false);
  assert.equal(definition.inputSchema.safeParse({ command: 'npm test', timeoutMs: 999 }).success, false);
  assert.equal(definition.inputSchema.safeParse({ command: 'npm test' }).success, true);
  assert.equal(
    definition.inputSchema.safeParse({ command: 'npm test', background: true, unsandboxed: true }).success,
    true
  );

  const action = definition.toAction({
    command: 'npm test',
    background: true,
    unsandboxed: true
  });
  assert.deepEqual(action, {
    type: 'run_command',
    command: 'npm test',
    cwd: undefined,
    timeoutMs: undefined,
    background: true,
    unsandboxed: true,
    reason: undefined
  });
});

test('run_command validateInput rejects unsandboxed outside full-access mode', async () => {
  const definition = getAgentToolDefinition('run_command');
  assert.ok(definition);
  const project = buildProject();

  const denied = await definition.validateInput?.(
    { command: 'ls', unsandboxed: true },
    {
      project,
      permissionMode: 'ask',
      toolName: 'run_command',
      readOnly: false
    }
  );
  assert.equal(denied?.ok, false);
  assert.match(denied?.summary ?? '', /full-access/);
  assert.match(denied?.recoveryHint ?? '', /unsandboxed/);

  const allowed = await definition.validateInput?.(
    { command: 'ls', unsandboxed: true },
    {
      project,
      permissionMode: 'full-access',
      toolName: 'run_command',
      readOnly: false
    }
  );
  assert.equal(allowed, undefined);

  const withoutFlag = await definition.validateInput?.(
    { command: 'ls' },
    {
      project,
      permissionMode: 'ask',
      toolName: 'run_command',
      readOnly: false
    }
  );
  assert.equal(withoutFlag, undefined);
});

test('unsandboxed run_command forces a user prompt even with blanket pre-approvals', async () => {
  const definition = getAgentToolDefinition('run_command');
  assert.ok(definition);
  assert.equal(definition.requiresExplicitApproval?.({ unsandboxed: true }), true);
  assert.equal(definition.requiresExplicitApproval?.({ command: 'ls' }), false);

  let prompted = 0;
  const context = {
    permission: {
      mode: 'full-access' as const,
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    },
    requestPermission: async () => {
      prompted += 1;
      return 'allow' as const;
    }
  };

  const preApproved = await resolveNativeToolPermission(context, {
    toolName: 'run_command',
    input: { command: 'ls' },
    isWrite: true
  });
  assert.equal(preApproved, 'allow');
  assert.equal(prompted, 0);

  const escape = await resolveNativeToolPermission(context, {
    toolName: 'run_command',
    input: { command: 'ls', unsandboxed: true },
    isWrite: true
  });
  assert.equal(escape, 'allow');
  assert.equal(prompted, 1);

  const denyingContext = {
    permission: context.permission,
    requestPermission: async () => 'deny' as const
  };
  const deniedEscape = await resolveNativeToolPermission(denyingContext, {
    toolName: 'run_command',
    input: { command: 'ls', unsandboxed: true },
    isWrite: true
  });
  assert.equal(deniedEscape, 'deny');
});

test('run_command rejects shell background control operator & and points at background:true', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-bg-reject-'));
  try {
    const project = buildProject(projectPath);
    const trailing = await executeWorkspaceToolAction(project, {
      type: 'run_command',
      command: 'node -e "setInterval(() => {}, 1000)" &'
    });
    assert.equal(trailing.ok, false);
    assert.equal(trailing.isError, true);
    assert.match(trailing.summary, /background:true/);
    assert.match(trailing.summary, /terminal_start/);

    const embedded = await executeWorkspaceToolAction(project, {
      type: 'run_command',
      command: 'sleep 5 & echo done'
    });
    assert.equal(embedded.ok, false);
    assert.equal(embedded.isError, true);
    assert.match(embedded.summary, /background:true/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('background command job lifecycle queues a completion notice exactly once', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-bg-job-'));
  try {
    const project = buildProject(projectPath);
    const job = startBackgroundCommandJob(project, {
      command: 'echo bg-done',
      spawn: {
        shell: process.execPath,
        args: ['-e', "process.stdout.write('bg-done\\n')"]
      },
      sandboxStatus: '沙箱：workspace-write'
    });
    assert.match(job.jobId, /^job_/);
    assert.equal(job.terminal.status, 'running');
    assert.match(job.summary, /terminal_read/);

    const notices: string[] = [];
    await waitFor(() => {
      notices.push(...consumePendingBackgroundCommandNotices(project.id));
      return notices.length > 0;
    });
    assert.equal(notices.length, 1);
    assert.match(notices[0], new RegExp(`\\[后台命令完成\\] ${job.jobId}`));
    assert.match(notices[0], /命令：echo bg-done/);
    assert.match(notices[0], /退出码：0/);
    assert.match(notices[0], /沙箱：workspace-write/);
    assert.match(notices[0], /bg-done/);
    assert.deepEqual(consumePendingBackgroundCommandNotices(project.id), []);

    const metadata = readPersistentTerminalMetadata(job.jobId);
    assert.equal(metadata.status, 'exited');
    assert.equal(metadata.exitCode, 0);
    const read = readPersistentTerminal({ sessionId: job.jobId });
    assert.match(read, /type=background-command/);
    assert.match(read, /bg-done/);
  } finally {
    disposePersistentTerminals();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('drainBackgroundCommandNoticeMessage wraps pending notices into one user turn then clears them', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-bg-drain-'));
  try {
    const project = buildProject(projectPath);
    assert.equal(drainBackgroundCommandNoticeMessage(project.id), undefined);
    startBackgroundCommandJob(project, {
      command: 'echo drain-me',
      spawn: { shell: process.execPath, args: ['-e', "process.stdout.write('drain-me\\n')"] }
    });
    await waitFor(() => {
      const message = drainBackgroundCommandNoticeMessage(project.id);
      if (!message) {
        return false;
      }
      assert.match(message, /后台命令已完成/);
      assert.match(message, /drain-me/);
      return true;
    });
    // Drained exactly once — a second drain finds nothing.
    assert.equal(drainBackgroundCommandNoticeMessage(project.id), undefined);
  } finally {
    disposePersistentTerminals();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('run_command background:true returns a job id and injects the notice into the next tool output', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-bg-flow-'));
  try {
    const project = buildProject(projectPath);
    const started = await executeAgentToolAction(project, {
      type: 'run_command',
      command: 'node -e "console.log(\'bg-flow-done\')"',
      background: true
    });
    assert.equal(started.ok, true);
    const jobId = started.summary.match(/Job ID: (job_[a-z0-9]+)/)?.[1];
    assert.ok(jobId);
    assert.equal(started.terminal?.sessionId, jobId);
    assert.equal(started.terminal?.status, 'running');
    assert.match(started.summary, /terminal_read/);

    await waitFor(() => readPersistentTerminalMetadata(jobId).status !== 'running');

    const tools = createNativeWorkspaceTools({ project });
    const listed = await executeNativeWorkspaceTool(tools, 'terminal_list', {});
    assert.match(String(listed.summary), /\[Lifecycle hook additional context\]/);
    assert.match(String(listed.summary), new RegExp(`\\[后台命令完成\\] ${jobId}`));
    assert.match(String(listed.summary), /bg-flow-done/);

    const listedAgain = await executeNativeWorkspaceTool(tools, 'terminal_list', {});
    assert.doesNotMatch(String(listedAgain.summary), /后台命令完成/);
  } finally {
    disposePersistentTerminals();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('darwin smoke: /bin/echo runs under sandbox-exec with a generated profile', async (t) => {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC_PATH)) {
    t.skip('requires macOS sandbox-exec');
    return;
  }
  assert.equal(detectCommandSandboxCapability().kind, 'seatbelt');
  const profile = buildSandboxProfile({
    projectPath: tmpdir(),
    allowNetwork: true,
    extraWritePaths: [tmpdir()]
  });
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(SANDBOX_EXEC_PATH, ['-p', profile, '/bin/echo', 'sandbox-smoke-ok'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (data: Buffer) => stdout.push(data));
    child.stderr.on('data', (data: Buffer) => stderr.push(data));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    );
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /sandbox-smoke-ok/);
});

test('darwin smoke: run_command enforces workspace-write sandbox per permission mode', async (t) => {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC_PATH)) {
    t.skip('requires macOS sandbox-exec');
    return;
  }
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-sandbox-mode-'));
  const deniedPath = join(homedir(), `funplay-sandbox-denied-${Date.now()}`);
  try {
    const project = buildProject(projectPath);
    const inside = await executeAgentToolAction(
      project,
      {
        type: 'run_command',
        command: 'printf sandboxed-ok && touch inside.txt',
        timeoutMs: 15_000
      },
      {
        permissionMode: 'ask'
      }
    );
    assert.equal(inside.ok, true, inside.summary);
    assert.match(inside.summary, /沙箱：workspace-write/);
    assert.match(inside.summary, /sandboxed-ok/);
    assert.equal(existsSync(join(projectPath, 'inside.txt')), true);

    const denied = await executeAgentToolAction(
      project,
      {
        type: 'run_command',
        command: `touch '${deniedPath}'`,
        timeoutMs: 15_000
      },
      {
        permissionMode: 'ask'
      }
    );
    assert.equal(denied.ok, false);
    assert.equal(existsSync(deniedPath), false);
    assert.match(denied.summary, /unsandboxed:true/);

    const readOnly = await executeAgentToolAction(
      project,
      {
        type: 'run_command',
        command: 'printf plan-ok',
        timeoutMs: 15_000
      },
      {
        permissionMode: 'read-only'
      }
    );
    assert.equal(readOnly.ok, true, readOnly.summary);
    assert.match(readOnly.summary, /沙箱：workspace-write（已禁用网络）/);
  } finally {
    await rm(deniedPath, { force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
});
