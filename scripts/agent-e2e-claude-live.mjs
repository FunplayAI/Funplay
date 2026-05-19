import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = join(repoRoot, 'out/agent-e2e');
const required = process.env.FUNPLAY_E2E_CLAUDE_REQUIRED === 'true';
const hasCredentials = Boolean(
  process.env.FUNPLAY_E2E_CLAUDE_API_KEY?.trim() &&
  process.env.FUNPLAY_E2E_CLAUDE_MODEL?.trim()
);
const scenarios = [
  'sdk-env-live-probe',
  'permission-denied-write',
  'host-controlled-write-and-rollback',
  'image-attachment-vision-block'
];

function nowIso() {
  return new Date().toISOString();
}

function truncateOutput(value, maxLength = 8000) {
  const normalized = value.replace(/\u001b\[[0-9;]*m/g, '');
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n[truncated]` : normalized;
}

function renderMarkdown(report) {
  return [
    '# Live Claude Agent E2E Report',
    '',
    `- Status: ${report.status}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    report.reason ? `- Reason: ${report.reason}` : '',
    report.command ? `- Command: \`${report.command}\`` : '',
    report.durationMs !== undefined ? `- Duration: ${report.durationMs}ms` : '',
    report.errorMessage ? `- Error: ${report.errorMessage}` : '',
    '',
    '## Scenarios',
    ...(report.scenarios ?? scenarios).map((scenario) => `- ${scenario}`),
    '',
    report.outputPreview ? '## Output' : '',
    report.outputPreview ? '```text' : '',
    report.outputPreview ?? '',
    report.outputPreview ? '```' : '',
    ''
  ].filter(Boolean).join('\n');
}

async function writeReport(report) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'claude-live-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportDir, 'claude-live-report.md'), `${renderMarkdown(report)}\n`, 'utf8');
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
      env: {
        ...process.env,
        FUNPLAY_CLAUDE_CODE_FORCE_CLI: '0'
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
        errorMessage: exitCode === 0 && !timedOut ? undefined : `Live Claude E2E failed: ${command}`
      });
    });
  });
}

async function main() {
  const startedAt = nowIso();
  if (!hasCredentials) {
    const report = {
      id: `claude-live-${Date.now()}`,
      status: required ? 'failed' : 'skipped',
      startedAt,
      finishedAt: nowIso(),
      reason: 'FUNPLAY_E2E_CLAUDE_API_KEY and FUNPLAY_E2E_CLAUDE_MODEL are required for live Claude SDK E2E.',
      scenarios
    };
    await writeReport(report);
    console.log(`Live Claude E2E ${report.status}: ${join(reportDir, 'claude-live-report.md')}`);
    if (required) {
      process.exitCode = 1;
    }
    return;
  }

  const command = 'node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/e2e/claude-live.test.ts';
  const result = await runCommand(command, 900_000);
  const report = {
    id: `claude-live-${Date.now()}`,
    ...result,
    scenarios,
    startedAt,
    finishedAt: nowIso()
  };
  await writeReport(report);
  console.log(`Live Claude E2E ${report.status}: ${join(reportDir, 'claude-live-report.md')}`);
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

await main();
