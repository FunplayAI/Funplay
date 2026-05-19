import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = join(repoRoot, 'out/agent-core-v2-benchmark');
const skipNativeAbiWrap = process.env.FUNPLAY_SKIP_NATIVE_ABI_WRAP === '1';

const checks = [
  {
    id: 'core-state-and-parts',
    title: 'Agent Core state machine and part converters',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-core-v2.test.ts',
    timeoutMs: 30_000
  },
  {
    id: 'core-replay-builders',
    title: 'Agent Core replay builders',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-core-replay.test.ts',
    timeoutMs: 30_000
  },
  {
    id: 'core-runtime-persistence',
    title: 'Agent Core runtime persistence',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "Agent Core state|context summaries|todo-list tool" tests/runtime/stream-manager-persistence.test.ts',
    timeoutMs: 45_000
  },
  {
    id: 'core-debugger-export',
    title: 'Agent Core debugger replay export',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-run-artifacts.test.ts',
    timeoutMs: 30_000
  },
  {
    id: 'core-transcript-render',
    title: 'Agent Core transcript rendering',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "ordered Agent Core parts" tests/runtime/agent-ui-render.test.ts',
    timeoutMs: 30_000
  },
  {
    id: 'core-default-runtime-path',
    title: 'Default runtime completion emits Agent Core parts',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "default Agent Core parts" tests/runtime/agent-runtime.test.ts',
    timeoutMs: 45_000
  }
];

function nowIso() {
  return new Date().toISOString();
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function truncateOutput(value, maxLength = 6000) {
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

function renderMarkdown(report) {
  const passed = report.results.filter((result) => result.status === 'passed').length;
  return `${[
    '# Agent Core v2 Benchmark Report',
    '',
    `- Status: ${report.status}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Checks: ${passed}/${report.results.length} passed`,
    `- Duration: ${report.durationMs}ms`,
    '',
    ...report.results.flatMap((result) => [
      `## ${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id}`,
      '',
      `- Title: ${result.title}`,
      `- Duration: ${result.durationMs}ms`,
      `- Command: \`${result.command}\``,
      result.errorMessage ? `- Error: ${result.errorMessage}` : '',
      ''
    ].filter(Boolean))
  ].join('\n')}\n`;
}

async function main() {
  const startedAt = nowIso();
  const startedTime = Date.now();
  const results = [];

  try {
    if (!skipNativeAbiWrap) {
      results.push({
        id: 'setup-node-abi',
        title: 'Prepare Node native ABI',
        ...(await runCommand('npm rebuild better-sqlite3', 120_000))
      });
    }
    if (results.every((result) => result.status === 'passed')) {
      for (const check of checks) {
        results.push({
          id: check.id,
          title: check.title,
          ...(await runCommand(check.command, check.timeoutMs))
        });
      }
    }
  } finally {
    if (!skipNativeAbiWrap) {
      results.push({
        id: 'restore-electron-abi',
        title: 'Restore Electron native ABI',
        ...(await runCommand('npm run rebuild:native:force', 120_000))
      });
    }
  }

  const required = results.filter((result) => result.id !== 'restore-electron-abi');
  const report = {
    id: `agent-core-v2-benchmark-${Date.now()}`,
    status: required.length > 0 && required.every((result) => result.status === 'passed') && results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedTime,
    results
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportDir, 'latest-report.md'), renderMarkdown(report), 'utf8');

  console.log(`Agent Core v2 benchmark ${report.status}: ${join(reportDir, 'latest-report.md')}`);
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

await main();
