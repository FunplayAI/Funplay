import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = join(repoRoot, 'out/release-gate');

const gates = [
  {
    id: 'release-audit',
    title: 'Open-source release configuration audit',
    command: 'npm run release:audit',
    timeoutMs: 30_000
  },
  {
    id: 'ui-smoke',
    title: 'Static desktop UI release smoke',
    command: 'npm run ui:smoke',
    timeoutMs: 120_000
  },
  {
    id: 'ui-electron-smoke',
    title: 'Real Electron desktop UI release smoke',
    command: 'npm run ui:electron-smoke',
    timeoutMs: 300_000
  },
  {
    id: 'ui-maturity',
    title: 'Desktop UI maturity gate',
    command: 'npm run ui:maturity-gate',
    timeoutMs: 120_000
  },
  {
    id: 'runtime-maturity',
    title: 'Runtime dry maturity gate',
    command: 'npm run runtime:maturity-gate',
    timeoutMs: 900_000
  }
];

function nowIso() {
  return new Date().toISOString();
}

function truncateOutput(value, maxLength = 8000) {
  const normalized = value.replace(/\u001b\[[0-9;]*m/g, '');
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n[truncated]` : normalized;
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
        errorMessage: exitCode === 0 && !timedOut ? undefined : `Gate command failed: ${command}`
      });
    });
  });
}

function renderMarkdown(report) {
  const lines = [
    '# Release Gate Report',
    '',
    `- Status: ${report.status}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Gates: ${report.gates.filter((gate) => gate.status === 'passed').length}/${report.gates.length} passed`,
    ''
  ];

  for (const gate of report.gates) {
    lines.push(`## ${gate.status.toUpperCase()} ${gate.id}`);
    lines.push('');
    lines.push(gate.title);
    lines.push('');
    lines.push(`- Command: \`${gate.command}\``);
    if (gate.durationMs !== undefined) {
      lines.push(`- Duration: ${gate.durationMs}ms`);
    }
    if (gate.errorMessage) {
      lines.push(`- Error: ${gate.errorMessage}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const startedAt = nowIso();
  const results = [];
  let blocked = false;

  for (const gate of gates) {
    if (blocked) {
      results.push({
        ...gate,
        status: 'skipped',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        errorMessage: 'Skipped because an earlier release gate failed.'
      });
      continue;
    }

    const result = await runCommand(gate.command, gate.timeoutMs);
    results.push({
      ...gate,
      ...result
    });
    if (result.status !== 'passed') {
      blocked = true;
    }
  }

  const report = {
    id: `release-gate-${Date.now()}`,
    status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    finishedAt: nowIso(),
    gates: results
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportDir, 'latest-report.md'), renderMarkdown(report), 'utf8');

  console.log(`Release gate ${report.status}: ${join(reportDir, 'latest-report.md')}`);
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

await main();
