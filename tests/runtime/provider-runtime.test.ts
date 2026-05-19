import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProject, buildState } from './test-helpers.ts';
import { DEFAULT_AGENT_SETTINGS, type AppState } from '../../shared/types.ts';
import {
  createMcpPlugin,
  deleteMcpPlugin,
  resolveProjectPluginByKind,
  resolveProjectPlugins,
  setActiveMcpPlugin,
  updateProjectMcpServers
} from '../../electron/main/mcp-plugin-service.ts';
import { nativeRuntime } from '../../electron/main/agent-platform/native/runtime.ts';
import { claudeCodeSdkRuntime } from '../../electron/main/agent-platform/claude/runtime.ts';
import { executionPlanRuntime } from '../../electron/main/agent-platform/execution-plan-runtime.ts';
import { listAgentRuntimeCapabilities } from '../../electron/main/agent-runtime-capability-service.ts';
import { registerGenericAgentRuntime, resolveGenericAgentRuntime } from '../../electron/main/agent-platform/runtime-registry.ts';

test('MCP resolution is project-bound and does not use global defaults', () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const state = buildState(project) as AppState;
  const plugin = createMcpPlugin(state, {
    name: 'Asset MCP',
    kind: 'asset',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:9999',
    enabled: true
  });

  setActiveMcpPlugin(state, plugin.id);
  assert.equal(resolveProjectPluginByKind(state, project.mcpBindings, 'asset'), undefined);
  assert.equal(resolveProjectPluginByKind(state, { asset: plugin.id }, 'asset')?.id, plugin.id);
});

test('project MCP servers combine global and project-scoped entries', () => {
  const project = buildProject('/tmp/funplay-runtime-test');
  const otherProject = {
    ...buildProject('/tmp/funplay-runtime-test-other'),
    id: 'project_other'
  };
  const state = buildState(project) as AppState;
  state.projects = [project, otherProject];
  const globalPlugin = createMcpPlugin(state, {
    name: 'Global Docs MCP',
    kind: 'custom',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:9001',
    enabled: true
  });
  const localPlugin = createMcpPlugin(state, {
    projectId: project.id,
    name: 'Project Unity MCP',
    kind: 'engine',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:9002',
    enabled: true
  });
  const foreignPlugin = createMcpPlugin(state, {
    projectId: 'project_other',
    name: 'Foreign MCP',
    kind: 'custom',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:9003',
    enabled: true
  });

  const updated = updateProjectMcpServers(state, project.id, [globalPlugin.id, localPlugin.id, foreignPlugin.id]);

  assert.deepEqual(updated.mcpBindings.servers, [globalPlugin.id, localPlugin.id]);
  assert.equal(updated.mcpBindings.engine, localPlugin.id);
  assert.deepEqual(resolveProjectPlugins(state, updated).map((plugin) => plugin.id), [globalPlugin.id, localPlugin.id]);

  deleteMcpPlugin(state, localPlugin.id);
  assert.equal(state.projects[0].mcpBindings.servers?.includes(localPlugin.id), false);
});

test('default agent settings use native runtime and build permissions', () => {
  assert.equal(DEFAULT_AGENT_SETTINGS.runtimeStrategy, 'native');
  assert.equal(DEFAULT_AGENT_SETTINGS.permissionMode, 'full-access');
});

test('runtime capabilities expose native, Claude, and execute-plan boundaries', () => {
  assert.equal(nativeRuntime.capabilities.nativeToolCalling, true);
  assert.equal(nativeRuntime.capabilities.legacyJsonLoop, false);
  assert.equal(nativeRuntime.capabilities.hostControlledWrites, true);
  assert.equal(nativeRuntime.capabilities.toolCheckpoint, true);
  assert.equal(nativeRuntime.capabilities.resume, true);
  assert.equal(nativeRuntime.capabilities.toolResume, true);

  assert.equal(claudeCodeSdkRuntime.capabilities.externalProcess, true);
  assert.equal(claudeCodeSdkRuntime.capabilities.hostControlledWrites, false);
  assert.equal(claudeCodeSdkRuntime.capabilities.mcpTools, true);
  assert.equal(claudeCodeSdkRuntime.capabilities.toolCheckpoint, false);
  assert.equal(claudeCodeSdkRuntime.capabilities.resume, true);
  assert.equal(claudeCodeSdkRuntime.capabilities.contextHandoff, true);
  assert.equal(claudeCodeSdkRuntime.capabilities.externalWriteAudit, true);
  assert.equal(claudeCodeSdkRuntime.capabilities.externalWriteRollback, true);
  assert.equal(claudeCodeSdkRuntime.capabilities.intentBoundMcp, true);
  assert.equal(claudeCodeSdkRuntime.capabilities.exactlyOnceStream, true);
  assert.equal(claudeCodeSdkRuntime.capabilities.liveE2EGated, true);

  assert.equal(executionPlanRuntime.capabilities.executePlan, true);
  assert.equal(executionPlanRuntime.capabilities.toolCheckpoint, true);
  assert.equal(executionPlanRuntime.capabilities.resume, true);
  assert.equal(executionPlanRuntime.capabilities.toolResume, true);
  assert.equal(executionPlanRuntime.capabilities.hostControlledWrites, true);

  const reports = listAgentRuntimeCapabilities();
  assert.deepEqual(
    reports.map((report) => report.id).sort(),
    ['claude-code-sdk', 'execute-plan', 'native']
  );
  assert.equal(reports.find((report) => report.id === 'native')?.capabilities.hostControlledWrites, true);
  assert.equal(reports.find((report) => report.id === 'claude-code-sdk')?.capabilities.externalProcess, true);
});

test('runtime resolver honors override, strategy, and Claude-compatible auto selection', () => {
  const previousForceCli = process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
  try {
    delete process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
    const anthropicProvider = {
      id: 'provider_anthropic',
      name: 'Anthropic',
      protocol: 'anthropic' as const,
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'secret',
      model: 'claude-sonnet-4-6',
      enabled: true,
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const openAiProvider = {
      ...anthropicProvider,
      id: 'provider_openai',
      name: 'OpenAI Compat',
      protocol: 'openai-compatible' as const,
      baseUrl: 'https://example.com/v1',
      model: 'gpt-test'
    };
    const mappedAnthropicProvider = {
      ...anthropicProvider,
      id: 'provider_mapped',
      model: 'gpt-5.4-xhigh',
      claudeCodeCompatible: true
    };

    assert.equal(resolveGenericAgentRuntime({ runtimeId: 'native', provider: anthropicProvider, runtimeStrategy: 'claude-code-sdk' }).id, 'native');
    assert.equal(resolveGenericAgentRuntime({ provider: anthropicProvider, runtimeStrategy: 'native' }).id, 'native');
    assert.equal(resolveGenericAgentRuntime({ provider: openAiProvider, runtimeStrategy: 'auto' }).id, 'native');
    assert.equal(resolveGenericAgentRuntime({ provider: anthropicProvider, runtimeStrategy: 'auto' }).id, 'claude-code-sdk');
    assert.equal(resolveGenericAgentRuntime({ provider: mappedAnthropicProvider, runtimeStrategy: 'auto' }).id, 'claude-code-sdk');
    assert.equal(resolveGenericAgentRuntime({ provider: openAiProvider, runtimeStrategy: 'claude-code-sdk' }).id, 'claude-code-sdk');
  } finally {
    if (previousForceCli === undefined) {
      delete process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI;
    } else {
      process.env.FUNPLAY_CLAUDE_CODE_FORCE_CLI = previousForceCli;
    }
  }
});

test('runtime resolver fails explicit unavailable runtime but keeps strategy fallback', () => {
  resolveGenericAgentRuntime('native');
  registerGenericAgentRuntime({
    ...claudeCodeSdkRuntime,
    isAvailable: () => false
  });

  try {
    assert.throws(
      () => resolveGenericAgentRuntime({ runtimeId: 'claude-code-sdk' }),
      /not available/
    );
    assert.equal(resolveGenericAgentRuntime({ runtimeStrategy: 'claude-code-sdk' }).id, 'native');
  } finally {
    registerGenericAgentRuntime(claudeCodeSdkRuntime);
  }
});
