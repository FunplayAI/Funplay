import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectFromInput } from '../../shared/planner.ts';
import { buildGenericWorkspaceContext } from '../../electron/main/agent-platform/context.ts';
import {
  createProject,
  createProjectSession,
  deleteProjectSession,
  renameProjectSession,
  resolveProjectChatContext
} from '../../electron/main/project-service.ts';
import type { AppState, CreateProjectInput } from '../../shared/types.ts';
import { buildProject, buildState } from './test-helpers.ts';

function text(value: unknown): string {
  return JSON.stringify(value);
}

function createUnityProjectInput(name = 'bird'): CreateProjectInput {
  return {
    name,
    templateId: 'engine-game-prototype',
    artStyle: '像素风格',
    pitch: '由 AI 与引擎控制器共同制作的 Unity 2D 游戏原型',
    engine: {
      platform: 'unity',
      setupMode: 'create',
      projectPath: `/tmp/${name}`,
      dimension: '2d'
    }
  };
}

test('engine project onboarding uses a neutral prototype template', () => {
  const project = createProjectFromInput(createUnityProjectInput());

  assert.equal(project.templateId, 'engine-game-prototype');
  assert.doesNotMatch(text(project.blueprint), /roguelike|进入房间|战斗清场/i);
  assert.doesNotMatch(project.chat[0]?.content ?? '', /roguelike|进入房间|战斗清场/i);

  const context = buildGenericWorkspaceContext(project, [], project.activeSessionId);
  assert.doesNotMatch(text({
    projectBrief: context.projectBrief,
    recentTurns: context.recentTurns
  }), /roguelike|进入房间|战斗清场/i);
});

test('project creation starts with an empty chat transcript', () => {
  const project = createProjectFromInput(createUnityProjectInput('quiet-onboarding'));

  assert.deepEqual(project.chat, []);
  assert.deepEqual(project.sessions[0]?.chat, []);
});

test('unity project creation registers and binds the built-in Unity MCP plugin', async () => {
  const state = buildState(buildProject()) as AppState;
  state.mcpPlugins = [];

  const project = await createProject(state, createUnityProjectInput('unity-auto-mcp'));
  const enginePluginId = project.mcpBindings.engine;
  const plugin = state.mcpPlugins.find((item) => item.id === enginePluginId);

  assert.ok(enginePluginId);
  assert.equal(plugin?.name, 'Unity MCP');
  assert.equal(plugin?.kind, 'engine');
  assert.equal(plugin?.enabled, true);
  assert.equal(plugin?.baseUrl, state.settings.baseUrl);
});

test('legacy unity project without an engine MCP binding is not mutated before agent context', () => {
  const project = createProjectFromInput(createUnityProjectInput('legacy-unity-mcp'));
  project.mcpPluginId = undefined;
  project.mcpBindings = {};
  const state = buildState(project) as AppState;
  state.mcpPlugins = [];

  const resolved = resolveProjectChatContext(state, project.id);

  assert.equal(resolved.current.mcpBindings.engine, undefined);
  assert.equal(resolved.enginePlugin, undefined);
  assert.deepEqual(state.projects[0].mcpBindings, {});
  assert.deepEqual(state.mcpPlugins, []);
});

test('session management does not append chat transcript announcements', () => {
  const project = buildProject();
  const state = buildState(project) as AppState;
  const originalSessionId = project.activeSessionId!;

  const withNewSession = createProjectSession(state, project.id, 'Planning');
  const newSessionId = withNewSession.activeSessionId!;
  assert.deepEqual(withNewSession.chat, []);
  assert.deepEqual(withNewSession.sessions.find((session) => session.id === newSessionId)?.chat, []);

  const renamed = renameProjectSession(state, project.id, newSessionId, 'Production');
  assert.deepEqual(renamed.chat, []);
  assert.deepEqual(renamed.sessions.find((session) => session.id === newSessionId)?.chat, []);

  const deleted = deleteProjectSession(state, project.id, newSessionId);
  assert.equal(deleted.activeSessionId, originalSessionId);
  assert.deepEqual(deleted.chat, []);
  assert.deepEqual(deleted.sessions.find((session) => session.id === originalSessionId)?.chat, []);
});
