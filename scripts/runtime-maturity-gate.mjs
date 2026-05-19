import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = join(repoRoot, 'out/maturity-gate');
const args = new Set(process.argv.slice(2));
const requireLive = args.has('--require-live') || process.env.FUNPLAY_MATURITY_REQUIRE_LIVE === 'true';
const failOnSkipped = args.has('--fail-on-skipped') || process.env.FUNPLAY_MATURITY_FAIL_ON_SKIPPED === 'true';
const requiredDryMaturityTier = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--required-tier='))
  ?.split('=')
  .slice(1)
  .join('=') ||
  process.env.FUNPLAY_MATURITY_REQUIRED_TIER ||
  'dry-pass';
const hasClaudeLiveCredentials = Boolean(
  process.env.FUNPLAY_E2E_CLAUDE_API_KEY?.trim() &&
  process.env.FUNPLAY_E2E_CLAUDE_MODEL?.trim()
);

const gates = [
  {
    id: 'build',
    title: 'Production TypeScript and Electron build',
    command: 'npm run build',
    timeoutMs: 600_000,
    required: true
  },
  {
    id: 'runtime-tests',
    title: 'Runtime regression tests',
    command: 'npm run test:runtime',
    timeoutMs: 600_000,
    required: true
  },
  {
    id: 'agent-e2e-dry',
    title: 'Deterministic agent E2E harness',
    command: 'npm run agent:e2e',
    timeoutMs: 300_000,
    required: true
  },
  {
    id: 'agent-benchmark',
    title: 'Deterministic Agent maturity benchmark tier',
    command: 'npm run agent:benchmark',
    timeoutMs: 600_000,
    required: true,
    nestedReportPath: join(repoRoot, 'out/agent-benchmark/latest-report.json'),
    requiredMaturityTier: requiredDryMaturityTier
  },
  {
    id: 'claude-live-e2e',
    title: 'Live Claude SDK runtime E2E',
    command: 'npm run agent:e2e:claude-live',
    timeoutMs: 1_000_000,
    required: requireLive,
    env: {
      FUNPLAY_E2E_CLAUDE_REQUIRED: requireLive ? 'true' : 'false'
    },
    nestedReportPath: join(repoRoot, 'out/agent-e2e/claude-live-report.json')
  }
];

function nowIso() {
  return new Date().toISOString();
}

function redactSecrets(value) {
  let output = value;
  for (const secret of [
    process.env.FUNPLAY_E2E_CLAUDE_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN
  ]) {
    const cleaned = secret?.trim();
    if (cleaned && cleaned.length >= 6) {
      output = output.split(cleaned).join('[redacted]');
    }
  }
  return output;
}

function truncateOutput(value, maxLength = 9000) {
  const normalized = redactSecrets(value.replace(/\u001b\[[0-9;]*m/g, ''));
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n[truncated]` : normalized;
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function runCommand(gate) {
  const startedAt = nowIso();
  const startedTime = Date.now();

  return new Promise((resolveResult) => {
    let settled = false;
    let output = '';
    const child = spawn(gate.command, {
      cwd: repoRoot,
      shell: true,
      env: {
        ...process.env,
        ...(gate.env ?? {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      if (settled) return;
      output += `\nCommand timed out after ${gate.timeoutMs}ms.`;
      child.kill('SIGTERM');
    }, gate.timeoutMs);

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
        status: exitCode === 0 && !timedOut ? 'passed' : 'failed',
        exitCode: exitCode ?? -1,
        signal,
        startedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - startedTime,
        outputPreview: truncateOutput(output),
        errorMessage: exitCode === 0 && !timedOut ? undefined : `Gate command failed: ${gate.command}`
      });
    });
  });
}

async function normalizeGateResult(gate, result) {
  const nestedReport = gate.nestedReportPath ? await readJsonIfExists(gate.nestedReportPath) : undefined;
  if (nestedReport?.status === 'skipped') {
    return {
      ...result,
      status: gate.required ? 'failed' : 'skipped',
      nestedReport,
      errorMessage: gate.required
        ? nestedReport.reason ?? 'Required live gate was skipped.'
        : nestedReport.reason
    };
  }
  if (nestedReport?.status === 'passed' && result.status === 'passed') {
    return {
      ...result,
      status: 'passed',
      nestedReport
    };
  }
  if (nestedReport?.status === 'failed') {
    return {
      ...result,
      status: 'failed',
      nestedReport,
      errorMessage: nestedReport.errorMessage ?? result.errorMessage
    };
  }
  return {
    ...result,
    nestedReport
  };
}

function computeOverallStatus(results) {
  if (results.some((result) => result.status === 'failed')) {
    return 'failed';
  }
  if (results.some((result) => result.status === 'skipped')) {
    return 'partial';
  }
  return 'passed';
}

function maturityTierRank(tier) {
  if (tier === 'live-pass') return 3;
  if (tier === 'dry-pass') return 2;
  if (tier === 'partial') return 1;
  return 0;
}

function meetsRequiredMaturityTier(actual, required) {
  return maturityTierRank(actual) >= maturityTierRank(required);
}

function renderMarkdown(report) {
  const lines = [
    '# Runtime Maturity Gate Report',
    '',
    `- Status: ${report.status}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Require live Claude: ${report.requireLive ? 'yes' : 'no'}`,
    `- Required dry maturity tier: ${report.requiredDryMaturityTier}`,
    `- Claude live credentials present: ${report.environment.hasClaudeLiveCredentials ? 'yes' : 'no'}`,
    `- Platform: ${report.environment.platform}/${report.environment.arch}`,
    `- Node: ${report.environment.node}`,
    '',
    '| Gate | Required | Status | Duration |',
    '| --- | --- | --- | --- |'
  ];

  for (const gate of report.gates) {
    lines.push(`| ${gate.id} | ${gate.required ? 'yes' : 'no'} | ${gate.status} | ${gate.durationMs ?? 0}ms |`);
  }

  for (const gate of report.gates) {
    if (gate.status === 'passed' && !gate.errorMessage) {
      continue;
    }
    lines.push('');
    lines.push(`## ${gate.status.toUpperCase()} ${gate.id}`);
    lines.push('');
    lines.push(gate.title);
    lines.push('');
    lines.push(`- Command: \`${gate.command}\``);
    if (gate.errorMessage) {
      lines.push(`- Reason: ${gate.errorMessage}`);
    }
    if (gate.nestedReport?.reason) {
      lines.push(`- Nested reason: ${gate.nestedReport.reason}`);
    }
    if (gate.nestedReport?.metrics) {
      lines.push(`- Nested maturity tier: ${gate.nestedReport.metrics.maturityTier ?? '-'}`);
      lines.push(`- Nested completion rate: ${typeof gate.nestedReport.metrics.completionRate === 'number' ? `${(gate.nestedReport.metrics.completionRate * 100).toFixed(1)}%` : '-'}`);
      if (Array.isArray(gate.nestedReport.metrics.failedBenchmarkIds) && gate.nestedReport.metrics.failedBenchmarkIds.length > 0) {
        lines.push(`- Failed benchmark IDs: ${gate.nestedReport.metrics.failedBenchmarkIds.join(', ')}`);
      }
    }
    if (gate.outputPreview) {
      lines.push('');
      lines.push('```text');
      lines.push(gate.outputPreview);
      lines.push('```');
    }
  }

  return `${lines.join('\n')}\n`;
}

async function writeReport(report) {
  await mkdir(reportDir, { recursive: true });
  const markdown = renderMarkdown(report);
  await writeFile(join(reportDir, 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportDir, 'latest-report.md'), markdown, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
  }
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
        durationMs: 0,
        errorMessage: 'Skipped because an earlier required maturity gate failed.'
      });
      continue;
    }

    const rawResult = await runCommand(gate);
    let result = await normalizeGateResult(gate, rawResult);
    if (gate.requiredMaturityTier) {
      const actualTier = result.nestedReport?.metrics?.maturityTier;
      if (!actualTier || !meetsRequiredMaturityTier(actualTier, gate.requiredMaturityTier)) {
        result = {
          ...result,
          status: 'failed',
          errorMessage: `Required maturity tier ${gate.requiredMaturityTier} was not met. Actual tier: ${actualTier ?? 'missing'}.`
        };
      }
    }
    results.push({
      ...gate,
      ...result
    });
    if (gate.required && result.status === 'failed') {
      blocked = true;
    }
  }

  const report = {
    id: `runtime-maturity-${Date.now()}`,
    status: computeOverallStatus(results),
    startedAt,
    finishedAt: nowIso(),
    requireLive,
    failOnSkipped,
    requiredDryMaturityTier,
    environment: {
      ci: Boolean(process.env.CI),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hasClaudeLiveCredentials
    },
    gates: results
  };

  await writeReport(report);
  console.log(`Runtime maturity gate ${report.status}: ${join(reportDir, 'latest-report.md')}`);
  if (report.status === 'failed' || (failOnSkipped && report.status !== 'passed')) {
    process.exitCode = 1;
  }
}

await main();
