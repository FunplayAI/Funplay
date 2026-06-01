import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultTaskDir = join(repoRoot, 'tests/e2e/agent/tasks');
const reportDir = join(repoRoot, 'out/agent-e2e');
const defaultTimeoutMs = 120_000;
const requiredAgentCapabilities = [
  {
    id: 'native_runtime_execution',
    title: 'Native runtime executes a scripted OpenAI-compatible provider through the real event stream'
  },
  {
    id: 'workspace_write_tool',
    title: 'Workspace file writes go through native write tools'
  },
  {
    id: 'active_verification_gate',
    title: 'Workspace side effects trigger blocking active verification'
  },
  {
    id: 'read_only_write_boundary',
    title: 'Read-only runtime mode prevents workspace writes'
  },
  {
    id: 'read_only_rogue_write_rejection',
    title: 'Read-only runtime rejects provider-emitted rogue write tool calls without side effects'
  },
  {
    id: 'invalid_write_rejection',
    title: 'Invalid write tool calls are rejected before side effects'
  },
  {
    id: 'edit_failure_recovery',
    title: 'Failed file edit tools inject recovery context and recover through a later successful edit'
  },
  {
    id: 'no_verification_for_rejected_write',
    title: 'Rejected writes do not trigger active verification'
  },
  {
    id: 'command_side_effect_verification',
    title: 'Shell command workspace side effects trigger active verification'
  },
  {
    id: 'terminal_side_effect_verification',
    title: 'Persistent terminal workspace side effects trigger active verification'
  },
  {
    id: 'verification_repair_pass',
    title: 'Failed verification can enter one controlled repair pass and then pass'
  },
  {
    id: 'checkpoint_rollback_recovery',
    title: 'Failed verification can recover by rolling back checkpointed workspace changes'
  },
  {
    id: 'quality_script_verification',
    title: 'Project quality scripts are selected as active verification when no narrower test or build script exists'
  },
  {
    id: 'verification_operation_log_audit',
    title: 'Host verification stages and command results remain auditable in the final operation log'
  },
  {
    id: 'verification_replan_after_repair',
    title: 'Verification replans after repair edits expand the changed-file set'
  },
  {
    id: 'failed_repair_handoff',
    title: 'Failed repair produces a non-completed handoff with diagnosis and change context'
  }
];
const requiredAgentCapabilityIds = requiredAgentCapabilities.map((capability) => capability.id);
const requiredAgentCapabilityIdSet = new Set(requiredAgentCapabilityIds);

function nowIso() {
  return new Date().toISOString();
}

function truncateOutput(value, maxLength = 6000) {
  const normalized = value.replace(/\u001b\[[0-9;]*m/g, '');
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n[truncated]` : normalized;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeWorkspaceFile(root, file) {
  const target = join(root, file.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.content, 'utf8');
}

async function copyFixture(root, fixture) {
  const source = resolve(repoRoot, fixture.from);
  const target = join(root, fixture.to);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

function runCommand(command, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const startedAt = nowIso();
  const startedTime = Date.now();

  return new Promise((resolveResult) => {
    let settled = false;
    let output = '';
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        FUNPLAY_REPO_ROOT: repoRoot,
        FUNPLAY_WORKSPACE_ROOT: cwd,
        ...options.env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      if (settled) return;
      output += `\nCommand timed out after ${timeoutMs}ms.`;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        command,
        cwd,
        status: 'failed',
        exitCode: -1,
        startedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - startedTime,
        outputPreview: truncateOutput(output),
        errorMessage: error.message
      });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timedOut = signal === 'SIGTERM' && output.includes('Command timed out');
      resolveResult({
        command,
        cwd,
        status: exitCode === 0 && !timedOut ? 'passed' : 'failed',
        exitCode: exitCode ?? -1,
        signal,
        startedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - startedTime,
        outputPreview: truncateOutput(output),
        errorMessage: exitCode === 0 && !timedOut ? undefined : `Command failed: ${command}`
      });
    });
  });
}

async function listTaskFiles(taskDir) {
  const indexPath = join(taskDir, 'index.json');
  if (existsSync(indexPath)) {
    const index = await readJson(indexPath);
    return index.tasks.map((taskPath) => join(taskDir, taskPath));
  }

  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(taskDir);
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => join(taskDir, entry));
}

function validateTask(task, path) {
  if (!task || typeof task !== 'object') {
    throw new Error(`Invalid task definition: ${path}`);
  }
  if (!task.id || !task.title) {
    throw new Error(`Task ${path} must include id and title.`);
  }
  if (task.mode !== undefined && !['agent', 'verification-only'].includes(task.mode)) {
    throw new Error(`Task ${task.id} has unsupported mode: ${task.mode}.`);
  }
  if (task.mode !== 'verification-only' && !task.agentCommand) {
    throw new Error(`Task ${task.id} must include agentCommand or set mode to verification-only.`);
  }
  if (task.mode === 'verification-only' && task.agentCommand) {
    throw new Error(`Task ${task.id} cannot be verification-only while also defining agentCommand.`);
  }
  if (task.capabilities !== undefined && (!Array.isArray(task.capabilities) || task.capabilities.some((item) => typeof item !== 'string' || !item.trim()))) {
    throw new Error(`Task ${task.id} capabilities must be a non-empty string array when provided.`);
  }
  const unknownCapabilities = normalizeCapabilities(task.capabilities).filter((capability) => !requiredAgentCapabilityIdSet.has(capability));
  if (unknownCapabilities.length > 0) {
    throw new Error(`Task ${task.id} declares unknown agent capabilities: ${unknownCapabilities.join(', ')}.`);
  }
  if (task.agentCommand && (!Array.isArray(task.capabilities) || task.capabilities.length === 0)) {
    throw new Error(`Agent task ${task.id} must declare the capabilities it proves.`);
  }
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
    throw new Error(`Task ${task.id} must include at least one acceptance command.`);
  }
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean))).sort();
}

async function prepareWorkspace(task) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `funplay-agent-e2e-${task.id}-`));
  for (const file of task.workspace?.files ?? []) {
    await writeWorkspaceFile(workspaceRoot, file);
  }
  for (const fixture of task.workspace?.fixtures ?? []) {
    await copyFixture(workspaceRoot, fixture);
  }
  return workspaceRoot;
}

async function runTask(taskPath) {
  const task = await readJson(taskPath);
  validateTask(task, taskPath);
  const startedAt = nowIso();
  const workspaceRoot = await prepareWorkspace(task);
  const commandResults = [];
  const mode = task.mode ?? (task.agentCommand ? 'agent' : 'verification-only');
  const capabilities = normalizeCapabilities(task.capabilities);

  try {
    for (const command of task.setup ?? []) {
      commandResults.push(await runCommand(command.command, {
        cwd: command.cwd ? join(workspaceRoot, command.cwd) : workspaceRoot,
        timeoutMs: command.timeoutMs ?? task.timeoutMs
      }));
      if (commandResults.at(-1)?.status !== 'passed') {
        break;
      }
    }

    if (commandResults.every((result) => result.status === 'passed') && task.agentCommand) {
      commandResults.push({
        id: 'agent-command',
        kind: 'agent',
        required: true,
        ...(await runCommand(task.agentCommand.command, {
          cwd: task.agentCommand.cwd ? join(workspaceRoot, task.agentCommand.cwd) : workspaceRoot,
          timeoutMs: task.agentCommand.timeoutMs ?? task.timeoutMs
        }))
      });
    }

    if (commandResults.every((result) => result.status === 'passed')) {
      for (const check of task.acceptance) {
        commandResults.push({
          id: check.id,
          kind: check.kind ?? 'command',
          required: check.required !== false,
          ...(await runCommand(check.command, {
            cwd: check.cwd ? join(workspaceRoot, check.cwd) : workspaceRoot,
            timeoutMs: check.timeoutMs ?? task.timeoutMs
          }))
        });
        if (check.required !== false && commandResults.at(-1)?.status !== 'passed') {
          break;
        }
      }
    }
  } finally {
    if (task.keepWorkspace !== true) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }

  const requiredResults = commandResults.filter((result) => result.required !== false);
  const status = requiredResults.every((result) => result.status === 'passed') ? 'passed' : 'failed';
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    mode,
    status,
    agentExecuted: Boolean(task.agentCommand),
    capabilities,
    startedAt,
    finishedAt: nowIso(),
    workspaceKept: task.keepWorkspace === true ? workspaceRoot : undefined,
    commands: commandResults
  };
}

function computeMetrics(results) {
  const passedTasks = results.filter((result) => result.status === 'passed');
  const agentTasks = results.filter((result) => result.agentExecuted);
  const passedAgentTasks = agentTasks.filter((result) => result.status === 'passed');
  const coveredCapabilities = Array.from(new Set(
    passedAgentTasks.flatMap((result) => result.capabilities ?? [])
  )).sort();
  const coveredRequiredCapabilities = requiredAgentCapabilityIds.filter((id) => coveredCapabilities.includes(id));
  const missingRequiredCapabilities = requiredAgentCapabilityIds.filter((id) => !coveredCapabilities.includes(id));
  const unknownAgentCapabilities = coveredCapabilities.filter((id) => !requiredAgentCapabilityIdSet.has(id));
  const capabilityEvidence = Object.fromEntries(requiredAgentCapabilityIds.map((capability) => [
    capability,
    passedAgentTasks
      .filter((result) => result.capabilities?.includes(capability))
      .map((result) => result.id)
      .sort()
  ]));
  return {
    taskCount: results.length,
    passedTaskCount: passedTasks.length,
    agentTaskCount: agentTasks.length,
    passedAgentTaskCount: passedAgentTasks.length,
    verificationOnlyTaskCount: results.filter((result) => result.mode === 'verification-only').length,
    requiredAgentCapabilities: requiredAgentCapabilityIds,
    coveredRequiredCapabilities,
    coveredAgentCapabilities: coveredCapabilities,
    missingRequiredCapabilities,
    unknownAgentCapabilities,
    capabilityEvidence,
    capabilityCoverageRate: requiredAgentCapabilityIds.length > 0
      ? coveredRequiredCapabilities.length / requiredAgentCapabilityIds.length
      : 1
  };
}

function renderMarkdown(report) {
  const lines = [
    `# Agent E2E Report`,
    '',
    `- Status: ${report.status}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Tasks: ${report.results.filter((result) => result.status === 'passed').length}/${report.results.length} passed`,
    `- Agent tasks: ${report.metrics.passedAgentTaskCount}/${report.metrics.agentTaskCount} passed`,
    `- Required capability coverage: ${report.metrics.coveredRequiredCapabilities.length}/${report.metrics.requiredAgentCapabilities.length}`,
    `- Missing required capabilities: ${report.metrics.missingRequiredCapabilities.length ? report.metrics.missingRequiredCapabilities.join(', ') : 'none'}`,
    `- Unknown capabilities: ${report.metrics.unknownAgentCapabilities.length ? report.metrics.unknownAgentCapabilities.join(', ') : 'none'}`,
    ''
  ];

  lines.push('## Required Capabilities');
  lines.push('');
  for (const capability of requiredAgentCapabilities) {
    const evidence = report.metrics.capabilityEvidence[capability.id] ?? [];
    lines.push(`- ${evidence.length ? 'covered' : 'missing'}: ${capability.id} - ${capability.title}${evidence.length ? ` (tasks: ${evidence.join(', ')})` : ''}`);
  }
  lines.push('');

  for (const result of report.results) {
    lines.push(`## ${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id}`);
    lines.push('');
    lines.push(result.description ?? result.title);
    lines.push('');
    lines.push(`Mode: ${result.mode}`);
    lines.push('');
    lines.push(`Agent executed: ${result.agentExecuted ? 'yes' : 'no'}`);
    lines.push('');
    if (result.capabilities?.length) {
      lines.push(`Capabilities: ${result.capabilities.join(', ')}`);
      lines.push('');
    }
    for (const command of result.commands) {
      lines.push(`- ${command.status}: \`${command.command}\` (${command.durationMs}ms)`);
      if (command.errorMessage) {
        lines.push(`  - ${command.errorMessage}`);
      }
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const taskDir = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : defaultTaskDir;
  const startedAt = nowIso();
  const taskFiles = await listTaskFiles(taskDir);
  const results = [];

  for (const taskFile of taskFiles) {
    results.push(await runTask(taskFile));
  }
  const metrics = computeMetrics(results);
  const allTasksPassed = results.every((result) => result.status === 'passed');
  const hasRequiredAgentCoverage =
    metrics.agentTaskCount > 0 &&
    metrics.passedAgentTaskCount === metrics.agentTaskCount &&
    metrics.missingRequiredCapabilities.length === 0 &&
    metrics.unknownAgentCapabilities.length === 0;

  const report = {
    id: `agent-e2e-${Date.now()}`,
    status: allTasksPassed && hasRequiredAgentCoverage ? 'passed' : 'failed',
    startedAt,
    finishedAt: nowIso(),
    taskDir,
    requiredAgentCapabilities,
    metrics,
    results
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportDir, 'latest-report.md'), renderMarkdown(report), 'utf8');

  console.log(`Agent E2E ${report.status}: ${join(reportDir, 'latest-report.md')}`);
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

await main();
