import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentToolPolicy } from '../../electron/main/agent-platform/tool-policy.ts';

test('tool policy detects workspace write intent with structured evidence', () => {
  const policy = resolveAgentToolPolicy({
    message: '请修改 src/App.tsx 并添加一个测试',
    currentGoal: '实现新的设置页面'
  });

  assert.equal(policy.requiresWorkspaceWritePermission, true);
  assert.equal(policy.workspaceWrite.detected, true);
  assert.equal(policy.workspaceWrite.confidence, 'high');
  assert.equal(policy.exposesHighRiskTools, true);
  assert.ok(policy.evidence.some((item) => item.startsWith('workspace_write:')));
});

test('tool policy detects project directory creation as workspace write intent', () => {
  const policy = resolveAgentToolPolicy({
    message: '在项目中新建一个文件夹用来放资源文件'
  });

  assert.equal(policy.requiresWorkspaceWritePermission, true);
  assert.equal(policy.workspaceWrite.detected, true);
  assert.equal(policy.workspaceWrite.confidence, 'high');
  assert.equal(policy.exposesHighRiskTools, true);
  assert.ok(policy.evidence.includes('workspace_write:explicit-directory-create'));
});

test('tool policy separates writing prose from workspace writes', () => {
  const policy = resolveAgentToolPolicy({
    message: 'write a short summary of the previous discussion'
  });

  assert.equal(policy.requiresWorkspaceWritePermission, false);
  assert.equal(policy.workspaceWrite.detected, false);
  assert.equal(policy.exposesHighRiskTools, false);
});

test('tool policy carries unfinished workspace write intent across continuation requests', () => {
  const policy = resolveAgentToolPolicy({
    message: '继续完成',
    recentMessages: [
      {
        role: 'assistant',
        content: [
          '[Tool] update_todo_list',
          '{"todos":[{"id":"5","status":"in_progress","content":"重写 renderer.js（掉落物/怪物/血条/光照/合成UI/死亡画面）"},{"id":"6","status":"pending","content":"更新 index.html（引入新脚本）"}]}'
        ].join('\n')
      }
    ]
  });

  assert.equal(policy.requiresWorkspaceWritePermission, true);
  assert.equal(policy.workspaceWrite.detected, true);
  assert.equal(policy.workspaceWrite.confidence, 'high');
  assert.ok(policy.evidence.includes('workspace_write:continuation-context'));
});

test('tool policy detects command and durable side-effect intents', () => {
  const policy = resolveAgentToolPolicy({
    message: '运行 npm test，然后记住这个决定并提醒我明天复查'
  });

  assert.equal(policy.command.detected, true);
  assert.equal(policy.memoryWrite.detected, true);
  assert.equal(policy.notification.detected, true);
  assert.equal(policy.requiresWorkspaceWritePermission, false);
  assert.equal(policy.exposesHighRiskTools, true);
});
