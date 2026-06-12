// Agent eval runner (skeleton).
//
// Measures real-model agentic completion quality for the `native` runtime.
// It reuses the agent-e2e harness model (prepare workspace -> run agent ->
// deterministic acceptance) and adds per-runtime + per-dimension aggregation.
//
// This is a SKELETON: the actual runtime driver (running a real provider
// through a chosen runtime) is not implemented yet. Until
// scripts/agent-eval-driver.mjs exists and provider credentials are present,
// every (task, runtime) pair is reported as `skipped` with a reason, so this
// runner is runnable today and produces the report scaffold without pretending
// to evaluate. See docs/agent-eval-framework.md.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultTaskDir = join(repoRoot, 'tests/eval/tasks');
const reportDir = join(repoRoot, 'out/agent-eval');
const driverPath = join(repoRoot, 'scripts/agent-eval-driver.mjs');
const defaultTimeoutMs = 180_000;

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = { runtime: undefined, taskDir: defaultTaskDir };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--runtime' && argv[index + 1]) {
      args.runtime = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--tasks' && argv[index + 1]) {
      args.taskDir = resolve(process.cwd(), argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function truncateOutput(value, maxLength = 6000) {
  const normalized = value.replace(/\[[0-9;]*m/g, '');
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n[truncated]` : normalized;
}

function runCommand(command, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const startedTime = Date.now();
  return new Promise((resolveResult) => {
    let settled = false;
    let output = '';
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, FUNPLAY_REPO_ROOT: repoRoot, FUNPLAY_WORKSPACE_ROOT: cwd, ...options.env },
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
      resolveResult({ command, status: 'failed', exitCode: -1, durationMs: Date.now() - startedTime, outputPreview: truncateOutput(output), errorMessage: error.message });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timedOut = signal === 'SIGTERM' && output.includes('Command timed out');
      resolveResult({ command, status: exitCode === 0 && !timedOut ? 'passed' : 'failed', exitCode: exitCode ?? -1, durationMs: Date.now() - startedTime, outputPreview: truncateOutput(output) });
    });
  });
}

async function prepareWorkspace(task) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `funplay-agent-eval-${task.id}-`));
  for (const file of task.workspace?.files ?? []) {
    const target = join(workspaceRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  return workspaceRoot;
}

function hasProviderCredentials(task, runtime) {
  const envKey = task.provider?.[runtime]?.envKey;
  return Boolean(envKey && process.env[`${envKey}_API_KEY`]);
}

async function listTaskFiles(taskDir) {
  const entries = await readdir(taskDir);
  return entries.filter((entry) => entry.endsWith('.json')).sort().map((entry) => join(taskDir, entry));
}

async function runTaskOnRuntime(task, runtime) {
  if (!existsSync(driverPath)) {
    return { runtime, status: 'skipped', reason: 'eval driver not implemented (scripts/agent-eval-driver.mjs)' };
  }
  if (!hasProviderCredentials(task, runtime)) {
    return { runtime, status: 'skipped', reason: `missing provider credentials for runtime "${runtime}"` };
  }
  const workspaceRoot = await prepareWorkspace(task);
  try {
    // The driver imports .ts modules, so it runs from repoRoot with the TS loader.
    const tsLoader = join(repoRoot, 'tests/register-ts-loader.mjs');
    const agent = await runCommand(`node --experimental-strip-types --import "${tsLoader}" "${driverPath}" --runtime "${runtime}" --workspace "${workspaceRoot}" --task "${task.id}"`, {
      cwd: repoRoot,
      timeoutMs: task.budget?.timeoutMs,
      env: {
        FUNPLAY_EVAL_RUNTIME: runtime,
        FUNPLAY_EVAL_PROMPT: task.prompt ?? '',
        FUNPLAY_EVAL_MAX_STEPS: String(task.budget?.maxSteps ?? ''),
        FUNPLAY_EVAL_PROVIDER_ENV_KEY: task.provider?.[runtime]?.envKey ?? ''
      }
    });
    if (agent.status !== 'passed') {
      return { runtime, status: 'failed', reason: 'agent run failed', agent };
    }
    const checks = [];
    for (const check of task.acceptance ?? []) {
      const result = await runCommand(check.command, {
        cwd: check.cwd ? join(workspaceRoot, check.cwd) : workspaceRoot,
        timeoutMs: check.timeoutMs ?? task.budget?.timeoutMs
      });
      checks.push({ id: check.id, required: check.required !== false, ...result });
      if (check.required !== false && result.status !== 'passed') break;
    }
    const status = checks.filter((check) => check.required).every((check) => check.status === 'passed') ? 'passed' : 'failed';
    return { runtime, status, checks, agent };
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function completionRate(perRuntime, runtime) {
  const runs = perRuntime.filter((run) => run.runtime === runtime && run.status !== 'skipped');
  if (runs.length === 0) return null;
  return runs.filter((run) => run.status === 'passed').length / runs.length;
}

function aggregate(results) {
  const allRuns = results.flatMap((result) => result.runs.map((run) => ({ ...run, dimensions: result.task.dimensions ?? [] })));
  const runtimes = [...new Set(allRuns.map((run) => run.runtime))];
  const byRuntime = Object.fromEntries(runtimes.map((runtime) => [runtime, completionRate(allRuns, runtime)]));

  const dimensions = [...new Set(allRuns.flatMap((run) => run.dimensions))].sort();
  const perDimension = Object.fromEntries(dimensions.map((dimension) => {
    const runs = allRuns.filter((run) => run.dimensions.includes(dimension));
    return [dimension, {
      native: completionRate(runs, 'native')
    }];
  }));

  const evaluated = allRuns.filter((run) => run.status !== 'skipped').length;
  return { byRuntime, perDimension, evaluated, skipped: allRuns.length - evaluated, runtimes };
}

function renderMarkdown(report) {
  const m = report.metrics;
  const fmt = (value) => (value == null ? 'n/a' : `${Math.round(value * 100)}%`);
  const lines = [
    '# Agent Eval Report',
    '',
    `- Started: ${report.startedAt}`,
    `- Evaluated runs: ${m.evaluated} (skipped: ${m.skipped})`,
    `- native completion: ${fmt(m.byRuntime.native)}`,
    ''
  ];
  if (m.skipped > 0 && m.evaluated === 0) {
    lines.push('> All runs skipped. Implement scripts/agent-eval-driver.mjs and set provider credentials to evaluate.', '');
  }
  lines.push('## Per-dimension completion (native)', '');
  for (const [dimension, rates] of Object.entries(m.perDimension)) {
    lines.push(`- ${dimension}: ${fmt(rates.native)}`);
  }
  lines.push('');
  for (const result of report.results) {
    lines.push(`## ${result.task.id}`, '');
    for (const run of result.runs) {
      lines.push(`- ${run.runtime}: ${run.status}${run.reason ? ` (${run.reason})` : ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = nowIso();
  const taskFiles = await listTaskFiles(args.taskDir);
  const results = [];

  for (const taskFile of taskFiles) {
    const task = await readJson(taskFile);
    const runtimes = (task.runtimes ?? ['native']).filter((runtime) => !args.runtime || runtime === args.runtime);
    const runs = [];
    for (const runtime of runtimes) {
      runs.push(await runTaskOnRuntime(task, runtime));
    }
    results.push({ task, runs });
  }

  const metrics = aggregate(results);
  const report = { id: `agent-eval-${Date.now()}`, startedAt, finishedAt: nowIso(), taskDir: args.taskDir, metrics, results };

  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportDir, 'latest-report.md'), renderMarkdown(report), 'utf8');
  console.log(`Agent eval: evaluated ${metrics.evaluated}, skipped ${metrics.skipped}. Report: ${join(reportDir, 'latest-report.md')}`);
}

await main();
