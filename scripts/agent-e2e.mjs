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
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
    throw new Error(`Task ${task.id} must include at least one acceptance command.`);
  }
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
      commandResults.push(await runCommand(task.agentCommand.command, {
        cwd: task.agentCommand.cwd ? join(workspaceRoot, task.agentCommand.cwd) : workspaceRoot,
        timeoutMs: task.agentCommand.timeoutMs ?? task.timeoutMs
      }));
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
    status,
    startedAt,
    finishedAt: nowIso(),
    workspaceKept: task.keepWorkspace === true ? workspaceRoot : undefined,
    commands: commandResults
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
    ''
  ];

  for (const result of report.results) {
    lines.push(`## ${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id}`);
    lines.push('');
    lines.push(result.description ?? result.title);
    lines.push('');
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

  const report = {
    id: `agent-e2e-${Date.now()}`,
    status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    finishedAt: nowIso(),
    taskDir,
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
