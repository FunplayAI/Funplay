import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentActions } from '../../src/actions/environmentActions.ts';
import { useProjectStore } from '../../src/stores/projectStore.ts';
import type { Project } from '../../shared/types.ts';

/**
 * Integration test for the engine-environment actions extracted from App.tsx.
 * window.funplay is mocked; the post-action runtime refresh is asserted by
 * overriding the projectStore action it fires (a Zustand setState override).
 */

function makeProject(overrides: Record<string, unknown> = {}): Project {
  return {
    id: 'p1',
    name: 'p1',
    engine: {
      platform: 'unity',
      projectPath: '/projects/p1',
      dimension: '2d',
      unityEditorVersion: '2022.3'
    },
    mcpBindings: { engine: 'engine-plugin' },
    mcpPluginId: 'fallback-plugin',
    runtimeState: { detectedDimension: '3d' },
    ...overrides
  } as unknown as Project;
}

interface FunplayCalls {
  diagnose: unknown[];
  run: unknown[];
}

function installFunplay(): FunplayCalls {
  const calls: FunplayCalls = { diagnose: [], run: [] };
  (globalThis as { window?: unknown }).window = {
    funplay: {
      diagnoseEnvironment: async (input: unknown) => {
        calls.diagnose.push(input);
        return { ok: true };
      },
      runEnvironmentAction: async (input: unknown) => {
        calls.run.push(input);
        return { applied: true };
      }
    }
  };
  return calls;
}

test('diagnoseSelectedProjectEnvironment forwards the built engine input', async () => {
  const calls = installFunplay();
  const actions = createEnvironmentActions({ getSelectedProject: () => makeProject(), language: 'en-US' });
  const result = await actions.diagnoseSelectedProjectEnvironment();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.diagnose, [
    {
      platform: 'unity',
      mode: 'import',
      dimension: '2d',
      projectPath: '/projects/p1',
      enginePluginId: 'engine-plugin',
      unityEditorVersion: '2022.3'
    }
  ]);
});

test('buildEnvironmentInput falls back to mcpPluginId and detectedDimension', async () => {
  const calls = installFunplay();
  const project = makeProject({
    engine: { platform: 'unity', projectPath: '/p', unityEditorVersion: undefined },
    mcpBindings: { engine: '' }
  });
  const actions = createEnvironmentActions({ getSelectedProject: () => project, language: 'en-US' });
  await actions.diagnoseSelectedProjectEnvironment();

  assert.equal((calls.diagnose[0] as { dimension: string }).dimension, '3d'); // runtimeState.detectedDimension
  assert.equal((calls.diagnose[0] as { enginePluginId: string }).enginePluginId, 'fallback-plugin');
});

test('diagnoseSelectedProjectEnvironment throws a localized error without a selected project', async () => {
  installFunplay();
  const actions = createEnvironmentActions({ getSelectedProject: () => null, language: 'en-US' });
  await assert.rejects(() => actions.diagnoseSelectedProjectEnvironment(), /Select a project first\./);
});

test('environment actions reject a project that has no openable engine path', async () => {
  installFunplay();
  const webProject = makeProject({ engine: { platform: 'web', projectPath: '/p' } });
  const actions = createEnvironmentActions({ getSelectedProject: () => webProject, language: 'en-US' });
  await assert.rejects(() => actions.diagnoseSelectedProjectEnvironment(), /no engine path to open\./);
});

test('runSelectedProjectEnvironmentAction forwards input + actionId and kicks off a runtime refresh', async () => {
  const calls = installFunplay();
  const retryCalls: Array<unknown[]> = [];
  // Override the fire-and-forget refresh so we can observe it without polling.
  useProjectStore.setState({
    retryRefreshProjectRuntimeState: async (...args: unknown[]) => {
      retryCalls.push(args);
    }
  });

  const actions = createEnvironmentActions({ getSelectedProject: () => makeProject(), language: 'en-US' });
  const result = await actions.runSelectedProjectEnvironmentAction('open' as never);

  assert.deepEqual(result, { applied: true });
  assert.equal((calls.run[0] as { actionId: string }).actionId, 'open');
  assert.equal((calls.run[0] as { projectPath: string }).projectPath, '/projects/p1');
  assert.deepEqual(retryCalls, [['p1', 6, 1200]]);
});

test('runSelectedProjectEnvironmentAction throws a localized error without a selected project', async () => {
  installFunplay();
  const actions = createEnvironmentActions({ getSelectedProject: () => null, language: 'en-US' });
  await assert.rejects(() => actions.runSelectedProjectEnvironmentAction('open' as never), /Select a project first\./);
});
