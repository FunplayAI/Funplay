import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = join(repoRoot, 'out/agent-platform-v3-benchmark');
const skipNativeAbiWrap = process.env.FUNPLAY_SKIP_NATIVE_ABI_WRAP === '1';

const checks = [
  {
    id: 'run-loop-long-tasks',
    title: 'Host-driven long task loop and continuation decisions',
    coverage: ['long_tasks', 'tool_calls_continue', 'stop_only_finishes', 'execute_plan_projection'],
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "continues when provider stop contains tool calls|keeps recording state until all parallel tool results arrive|supports host-forced continuation|completes only on no-tool stop|execute-plan stream projects tool work|long task stream renders partial reply|task graph persists stage progress across a long agent run" tests/runtime/agent-run-controller.test.ts tests/runtime/stream-manager-persistence.test.ts tests/runtime/agent-ui-render.test.ts tests/runtime/agent-run-artifacts.test.ts',
    timeoutMs: 60_000
  },
  {
    id: 'failed-edit-recovery',
    title: 'Failed edit classification and recovery hints',
    coverage: ['failed_edits', 'tool_error_parts', 'patch_first_metrics'],
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "failed write-like tool summaries keep the real error|projects completed and failed results to Agent Core parts|workspace multi_edit prevalidates all edits before writing|workspace patch tools preview and apply unified diffs with checkpoint|native tool executor records precomputed and unknown tool errors" tests/runtime/agent-ui-render.test.ts tests/runtime/tool-executor.test.ts tests/runtime/workspace-tools.test.ts tests/runtime/native-tool-executor.test.ts',
    timeoutMs: 90_000
  },
  {
    id: 'permission-denial',
    title: 'Host permission denial replay',
    coverage: ['permission_denial', 'host_permissions', 'structured_pause', 'execute_plan_permission'],
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "represents permission waits as structured pause parts|records permission denial as tool error for continuation|records permission approval as a structured tool result|execute-plan stream projects denied write permission|permission prompts render structured impact|native command tool is high-risk and permission-gated|native create directory tool is permission-gated" tests/runtime/agent-run-controller.test.ts tests/runtime/stream-manager-persistence.test.ts tests/runtime/agent-ui-render.test.ts tests/runtime/workspace-tools.test.ts',
    timeoutMs: 90_000
  },
  {
    id: 'restart-resume',
    title: 'Restart-safe resume cursor and exactly-once tool results',
    coverage: ['restart_resume', 'stable_cursor', 'exactly_once_tools'],
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "finalizes pending tools as errors on resumable interruption|finalizes pending permission waits on resumable interruption|execute-plan cancellation clears pending permission|ignores duplicate completed tool result ids exactly once|resumes from the last completed tool boundary|tool-boundary resume context|resume transaction summary|project Agent runs settings render recovery" tests/runtime/agent-run-controller.test.ts tests/runtime/stream-manager-persistence.test.ts tests/runtime/agent-core-replay.test.ts tests/runtime/agent-runtime.test.ts tests/runtime/agent-ui-render.test.ts',
    timeoutMs: 60_000
  },
  {
    id: 'context-compression',
    title: 'Structured context compression and replay',
    coverage: ['context_compression', 'structured_summary', 'provider_replay'],
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "owns context compression trigger and summary recording|formats structured context summaries without breaking tool pairing|context summaries" tests/runtime/agent-run-controller.test.ts tests/runtime/agent-core-replay.test.ts tests/runtime/stream-manager-persistence.test.ts',
    timeoutMs: 60_000
  },
  {
    id: 'mcp-platform',
    title: 'MCP transport, tool elicitation, and tool transaction coverage',
    coverage: ['mcp', 'tool_elicitation', 'tool_metadata'],
    command: 'npm run agent:mcp-compatibility',
    timeoutMs: 120_000
  },
  {
    id: 'observable-ui',
    title: 'Structured Agent Core UI rendering',
    coverage: ['ui_rendering', 'message_parts', 'pseudo_text_suppression'],
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "streaming transcript can render directly from Agent Core parts|completed assistant transcript renders ordered Agent Core parts|assistant Agent Core parts do not fall back to pseudo tool message content|historical orphan tool results render a compact summary until expanded" tests/runtime/agent-ui-render.test.ts',
    timeoutMs: 60_000
  },
  {
    id: 'debugger-export',
    title: 'Replay debugger and redacted export',
    coverage: ['audit_trail', 'debugger_export', 'redaction'],
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-run-artifacts.test.ts',
    timeoutMs: 45_000
  }
];

function nowIso() {
  return new Date().toISOString();
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function truncateOutput(value, maxLength = 7000) {
  const clean = stripAnsi(value);
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}\n[truncated]` : clean;
}

function runCommand(command, timeoutMs) {
  const startedAt = nowIso();
  const startedTime = Date.now();

  return new Promise((resolveResult) => {
    let settled = false;
    let output = '';
    const child = spawn(command, {
      cwd: repoRoot,
      shell: true,
      env: process.env,
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

async function runCheck(check) {
  return {
    id: check.id,
    title: check.title,
    coverage: check.coverage,
    ...(await runCommand(check.command, check.timeoutMs))
  };
}

function computeMetrics(results) {
  const requiredResults = results.filter((result) => result.id !== 'restore-electron-abi' && result.id !== 'setup-node-abi');
  const passedResults = requiredResults.filter((result) => result.status === 'passed');
  const failedResults = requiredResults.filter((result) => result.status !== 'passed');
  const coverage = [...new Set(requiredResults.flatMap((result) => result.coverage ?? []))].sort();
  const failedCoverage = [...new Set(failedResults.flatMap((result) => result.coverage ?? []))].sort();
  const slowest = requiredResults
    .slice()
    .sort((left, right) => right.durationMs - left.durationMs)[0];

  return {
    checkCount: requiredResults.length,
    passedCount: passedResults.length,
    failedCount: failedResults.length,
    completionRate: requiredResults.length > 0 ? passedResults.length / requiredResults.length : 0,
    failedCheckIds: failedResults.map((result) => result.id),
    coverage,
    failedCoverage,
    requiredDurationMs: requiredResults.reduce((total, result) => total + result.durationMs, 0),
    slowestCheckId: slowest?.id,
    slowestCheckDurationMs: slowest?.durationMs,
    liveProviderRequired: false,
    maturityTier: failedResults.length === 0 ? 'platform-v3-dry-pass' : 'platform-v3-dry-fail'
  };
}

function renderMarkdown(report) {
  const lines = [
    '# Agent Platform v3 Benchmark Report',
    '',
    `- Status: ${report.status}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Checks: ${report.metrics.passedCount}/${report.metrics.checkCount} passed`,
    `- Duration: ${report.durationMs}ms`,
    `- Completion rate: ${(report.metrics.completionRate * 100).toFixed(1)}%`,
    `- Maturity tier: ${report.metrics.maturityTier}`,
    `- Live provider required: ${report.metrics.liveProviderRequired ? 'yes' : 'no'}`,
    `- Coverage: ${report.metrics.coverage.join(', ')}`,
    '',
    '| Check | Status | Duration | Coverage |',
    '| --- | --- | --- | --- |'
  ];

  for (const result of report.results) {
    lines.push(`| ${result.id} | ${result.status} | ${result.durationMs}ms | ${(result.coverage ?? []).join(', ')} |`);
  }

  for (const result of report.results) {
    if (result.status === 'passed') {
      continue;
    }
    lines.push('');
    lines.push(`## FAIL ${result.id}`);
    lines.push('');
    lines.push(`- Title: ${result.title}`);
    lines.push(`- Command: \`${result.command}\``);
    if (result.errorMessage) {
      lines.push(`- Error: ${result.errorMessage}`);
    }
    if (result.outputPreview) {
      lines.push('');
      lines.push('```text');
      lines.push(result.outputPreview);
      lines.push('```');
    }
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const startedAt = nowIso();
  const startedTime = Date.now();
  const results = [];

  try {
    if (!skipNativeAbiWrap) {
      const setup = await runCommand('npm rebuild better-sqlite3', 120_000);
      results.push({
        id: 'setup-node-abi',
        title: 'Prepare Node native ABI',
        coverage: [],
        ...setup
      });
    }

    if (results.every((result) => result.status === 'passed')) {
      for (const check of checks) {
        results.push(await runCheck(check));
      }
    }
  } finally {
    if (!skipNativeAbiWrap) {
      results.push({
        id: 'restore-electron-abi',
        title: 'Restore Electron native ABI',
        coverage: [],
        ...(await runCommand('npm run rebuild:native:force', 120_000))
      });
    }
  }

  const requiredResults = results.filter((result) => result.id !== 'restore-electron-abi' && result.id !== 'setup-node-abi');
  const report = {
    id: `agent-platform-v3-benchmark-${Date.now()}`,
    status: requiredResults.length > 0 && requiredResults.every((result) => result.status === 'passed') && results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedTime,
    results,
    metrics: computeMetrics(results)
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportDir, 'latest-report.md'), renderMarkdown(report), 'utf8');

  console.log(`Agent Platform v3 benchmark ${report.status}: ${join(reportDir, 'latest-report.md')}`);
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

await main();
