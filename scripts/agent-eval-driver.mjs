// Agent eval driver.
//
// Drives ONE real-provider agent run through a chosen runtime (native or
// claude-code-sdk) inside a prepared workspace, then exits. The agent mutates
// the workspace through its real tools; agent-eval.mjs runs the deterministic
// acceptance checks afterward. This is the real-provider counterpart to the
// scripted scripts/native-runtime-e2e.mjs.
//
// Must run from the repo root with the TS loader, e.g.:
//   node --experimental-strip-types --import ./tests/register-ts-loader.mjs \
//     scripts/agent-eval-driver.mjs --runtime native --workspace <dir>
//
// Provider credentials are read from env, keyed by FUNPLAY_EVAL_PROVIDER_ENV_KEY
// (e.g. prefix FUNPLAY_EVAL_NATIVE -> FUNPLAY_EVAL_NATIVE_API_KEY / _BASE_URL /
// _MODEL / _PROTOCOL). Without credentials the driver exits non-zero; agent-eval
// skips the run before reaching here. See docs/agent-eval-framework.md.

import { resolve } from 'node:path';
import { createProjectFromInput } from '../shared/planner.ts';
import { ensureProjectSessions, getActiveProjectSession } from '../shared/project-sessions.ts';
import { buildGenericWorkspaceContext } from '../electron/main/agent-platform/context.ts';
import { resolveGenericAgentRuntime } from '../electron/main/agent-platform/runtime-registry.ts';
import { disposePersistentTerminals } from '../electron/main/agent-platform/persistent-terminal-store.ts';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1];
    if (argv[index] === '--workspace' && next) {
      args.workspace = next;
      index += 1;
    } else if (argv[index] === '--runtime' && next) {
      args.runtime = next;
      index += 1;
    } else if (argv[index] === '--task' && next) {
      args.task = next;
      index += 1;
    }
  }
  return args;
}

function buildProvider(runtimeId) {
  const prefix = process.env.FUNPLAY_EVAL_PROVIDER_ENV_KEY;
  if (!prefix) {
    throw new Error('FUNPLAY_EVAL_PROVIDER_ENV_KEY is required to resolve provider credentials.');
  }
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (!apiKey) {
    throw new Error(`${prefix}_API_KEY is required for eval runtime "${runtimeId}".`);
  }
  const protocol = process.env[`${prefix}_PROTOCOL`] || (runtimeId === 'claude-code-sdk' ? 'anthropic' : 'openai-compatible');
  const timestamp = new Date().toISOString();
  return {
    id: `provider_eval_${runtimeId}`,
    name: `Eval ${runtimeId}`,
    protocol,
    apiMode: 'chat',
    baseUrl: process.env[`${prefix}_BASE_URL`] || (protocol === 'anthropic' ? 'https://api.anthropic.com' : ''),
    apiKey,
    hasStoredApiKey: true,
    model: process.env[`${prefix}_MODEL`] || '',
    enabled: true,
    isDefault: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function buildProject(projectPath) {
  return ensureProjectSessions(createProjectFromInput({
    name: 'Funplay Agent Eval',
    templateId: 'generic-workspace',
    artStyle: 'eval',
    pitch: 'agent eval run',
    engine: {
      platform: 'web',
      setupMode: 'import',
      projectPath,
      dimension: 'unknown'
    }
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = resolve(args.workspace ?? process.env.FUNPLAY_WORKSPACE_ROOT ?? process.cwd());
  const runtimeId = args.runtime ?? process.env.FUNPLAY_EVAL_RUNTIME ?? 'native';
  const prompt = process.env.FUNPLAY_EVAL_PROMPT ?? '';
  const maxSteps = process.env.FUNPLAY_EVAL_MAX_STEPS;

  // Honor the task step budget for the native main tool loop.
  if (maxSteps && runtimeId === 'native') {
    process.env.FUNPLAY_NATIVE_MAIN_TOOL_LOOP_MAX_STEPS = maxSteps;
  }

  const project = buildProject(workspace);
  const session = getActiveProjectSession(project);
  const provider = buildProvider(runtimeId);
  const runtime = resolveGenericAgentRuntime({ runtimeId });

  let result;
  try {
    for await (const event of runtime.executeEventStream({
      project,
      message: prompt,
      provider,
      plugins: [],
      context: buildGenericWorkspaceContext(project, [], session.id, prompt),
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      }
    })) {
      if (event.type === 'result') {
        result = event.result;
        break;
      }
    }
  } finally {
    disposePersistentTerminals();
  }

  if (!result) {
    console.error(`agent-eval-driver: runtime "${runtimeId}" produced no result event.`);
    process.exitCode = 1;
    return;
  }

  // Machine-readable line for agent-eval.mjs to capture run metrics.
  console.log(JSON.stringify({
    runtime: runtimeId,
    status: result.status,
    stepCount: result.steps?.length ?? 0,
    assistantPreview: (result.assistantMessage ?? '').slice(0, 200)
  }));
  process.exitCode = result.status === 'completed' ? 0 : 1;
}

await main();
