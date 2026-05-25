import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = join(repoRoot, 'out/agent-benchmark');
const defaultTimeoutMs = 180_000;

const benchmarks = [
  {
    id: 'stateful-core',
    title: 'Stateful runtime core',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "structured event log|coalesce bounded text|runtime run persistence stores timeline|active runtime runs persist accumulated usage|v3 migration|command lifecycle hook|execute-plan stream projects tool work|execute-plan stream projects denied write permission|execute-plan cancellation clears pending permission" tests/runtime/stream-manager-persistence.test.ts tests/runtime/stream-session-manager.test.ts tests/runtime/store-migrations.test.ts',
    timeoutMs: 60_000
  },
  {
    id: 'replay-artifacts',
    title: 'Replay artifacts',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-run-artifacts.test.ts',
    timeoutMs: 30_000
  },
  {
    id: 'provider-conformance',
    title: 'Provider conformance and protocol fixtures',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/provider-conformance.test.ts tests/runtime/openai-compatible-client.test.ts',
    timeoutMs: 60_000
  },
  {
    id: 'tool-reliability',
    title: 'Tool reliability and edit metrics',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "write tool|edit tools|multi_edit|patch tools" tests/runtime/workspace-tools.test.ts',
    timeoutMs: 60_000
  },
  {
    id: 'mcp-compatibility-matrix',
    title: 'MCP compatibility matrix',
    command: 'npm run agent:mcp-compatibility',
    timeoutMs: 90_000
  },
  {
    id: 'ui-render',
    title: 'Structured UI render',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts',
    timeoutMs: 30_000
  },
  {
    id: 'agent-core-v2',
    title: 'Agent Core v2 maturity slice',
    command: 'FUNPLAY_SKIP_NATIVE_ABI_WRAP=1 npm run agent:core-v2-benchmark',
    timeoutMs: 90_000
  },
  {
    id: 'skills-v2',
    title: 'Skills v2 platform slice',
    command: 'FUNPLAY_SKIP_NATIVE_ABI_WRAP=1 npm run agent:skills-v2-benchmark',
    timeoutMs: 90_000
  },
  {
    id: 'agent-platform-v3',
    title: 'Agent Platform v3 host-loop slice',
    command: 'FUNPLAY_SKIP_NATIVE_ABI_WRAP=1 npm run agent:platform-v3-benchmark',
    timeoutMs: 120_000
  },
  {
    id: 'claude-code-platform-hooks',
    title: 'Claude Code style lifecycle hooks slice',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-hooks.test.ts tests/runtime/claude-sdk-options.test.ts && node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "Claude Code runtime compacts long resume|Claude Code runtime retries stale resume|Claude Code runtime runs UserPromptSubmit and Stop|native runtime runs SessionStart|native notification tools emit Notification|native subagent tools emit SubagentStop" tests/runtime/agent-runtime.test.ts',
    timeoutMs: 45_000
  },
  {
    id: 'agent-e2e-dry',
    title: 'Agent dry E2E',
    command: 'npm run agent:e2e',
    timeoutMs: 120_000
  }
];

function nowIso() {
  return new Date().toISOString();
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function truncateOutput(value, maxLength = 8000) {
  const clean = stripAnsi(value);
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}\n[truncated]` : clean;
}

function runCommand(command, options = {}) {
  const startedAt = nowIso();
  const startedTime = Date.now();
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  return new Promise((resolveResult) => {
    let settled = false;
    let output = '';
    const child = spawn(command, {
      cwd: repoRoot,
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

async function runBenchmark(benchmark) {
  const result = await runCommand(benchmark.command, {
    timeoutMs: benchmark.timeoutMs
  });
  return {
    id: benchmark.id,
    title: benchmark.title,
    ...result
  };
}

function renderMarkdown(report) {
  const passed = report.results.filter((result) => result.status === 'passed').length;
  const lines = [
    '# Agent Benchmark Report',
    '',
    `- Status: ${report.status}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Benchmarks: ${passed}/${report.results.length} passed`,
    `- Duration: ${report.durationMs}ms`,
    `- Completion rate: ${(report.metrics.completionRate * 100).toFixed(1)}%`,
    `- Required duration: ${report.metrics.requiredDurationMs}ms`,
    `- Maturity tier: ${report.metrics.maturityTier}`,
    `- Manual intervention required: ${report.metrics.manualInterventionRequired ? 'yes' : 'no'}`,
    `- Patch-first edit metrics: ${report.metrics.patchFirstEditMetricsAvailable ? 'available' : 'missing'}`,
    ''
  ];

  for (const result of report.results) {
    lines.push(`## ${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id}`);
    lines.push('');
    lines.push(`- Title: ${result.title}`);
    lines.push(`- Duration: ${result.durationMs}ms`);
    lines.push(`- Command: \`${result.command}\``);
    if (result.errorMessage) {
      lines.push(`- Error: ${result.errorMessage}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function computeMetrics(results) {
  const requiredResults = results.filter((result) => result.id !== 'restore-electron-abi');
  const passedResults = requiredResults.filter((result) => result.status === 'passed');
  const failedResults = requiredResults.filter((result) => result.status !== 'passed');
  const slowest = requiredResults
    .slice()
    .sort((left, right) => right.durationMs - left.durationMs)[0];
  return {
    benchmarkCount: requiredResults.length,
    passedCount: passedResults.length,
    failedCount: failedResults.length,
    completionRate: requiredResults.length > 0 ? passedResults.length / requiredResults.length : 0,
    failedBenchmarkIds: failedResults.map((result) => result.id),
    requiredDurationMs: requiredResults.reduce((total, result) => total + result.durationMs, 0),
    slowestBenchmarkId: slowest?.id,
    slowestBenchmarkDurationMs: slowest?.durationMs,
    manualInterventionRequired: failedResults.length > 0,
    liveProviderRequired: false,
    patchFirstEditMetricsAvailable: requiredResults.some((result) => result.id === 'tool-reliability' && result.status === 'passed'),
    maturityTier: failedResults.length === 0 ? 'dry-pass' : 'dry-fail'
  };
}

async function main() {
  const startedAt = nowIso();
  const startedTime = Date.now();
  const setup = await runCommand('npm rebuild better-sqlite3', {
    timeoutMs: 120_000
  });
  const results = [];

  try {
    if (setup.status !== 'passed') {
      results.push({
        id: 'setup-node-abi',
        title: 'Prepare Node native ABI',
        ...setup
      });
    } else {
      for (const benchmark of benchmarks) {
        results.push(await runBenchmark(benchmark));
      }
    }
  } finally {
    const restore = await runCommand('npm run rebuild:native:force', {
      timeoutMs: 120_000
    });
    results.push({
      id: 'restore-electron-abi',
      title: 'Restore Electron native ABI',
      ...restore
    });
  }

  const requiredResults = results.filter((result) => result.id !== 'restore-electron-abi');
  const report = {
    id: `agent-benchmark-${Date.now()}`,
    status: requiredResults.length > 0 && requiredResults.every((result) => result.status === 'passed') && results.at(-1)?.status === 'passed' ? 'passed' : 'failed',
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedTime,
    results,
    metrics: computeMetrics(results)
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportDir, 'latest-report.md'), renderMarkdown(report), 'utf8');

  console.log(`Agent benchmark ${report.status}: ${join(reportDir, 'latest-report.md')}`);
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

await main();
