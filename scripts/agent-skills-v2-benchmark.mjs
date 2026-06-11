import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = join(repoRoot, 'out/agent-skills-v2-benchmark');
const skipNativeAbiWrap = process.env.FUNPLAY_SKIP_NATIVE_ABI_WRAP === '1';

const checks = [
  {
    id: 'skills-registry-context-tools',
    title: 'Skills v2 registry, context activation, and tools',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "agent skill registry|filesystem skill metadata|slash-invoked filesystem skill|auto-activates model-invocable|native skill tools" tests/runtime/agent-runtime.test.ts',
    timeoutMs: 45_000
  },
  {
    id: 'skills-tool-registry-boundaries',
    title: 'Skills tools remain read-only and permission-safe',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "read-only workspace tools|tool registry includes write|native tool adapter exposes write" tests/runtime/agent-runtime.test.ts',
    timeoutMs: 45_000
  },
  {
    id: 'skills-observability',
    title: 'Skills activation events, replay, and transcript visibility',
    command: 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "skill activation|active filesystem skill as an Agent Core part|completed assistant transcript renders ordered Agent Core parts|skills page renders filesystem registry" tests/runtime/agent-core-v2.test.ts tests/runtime/agent-run-artifacts.test.ts tests/runtime/stream-manager-persistence.test.ts tests/runtime/agent-ui-render.test.ts tests/runtime/agent-runtime.test.ts',
    timeoutMs: 60_000
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
    '# Agent Skills v2 Benchmark Report',
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

  const report = {
    id: `agent-skills-v2-benchmark-${Date.now()}`,
    status: results.length > 0 && results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedTime,
    results
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportDir, 'latest-report.md'), renderMarkdown(report), 'utf8');

  console.log(`Agent Skills v2 benchmark ${report.status}: ${join(reportDir, 'latest-report.md')}`);
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

await main();
