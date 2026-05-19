import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectFromInput } from '../../shared/planner.ts';
import { ensureProjectSessions, getActiveProjectSession } from '../../shared/project-sessions.ts';
import type { AiProvider, Project } from '../../shared/types.ts';
import { buildGenericWorkspaceContext } from '../../electron/main/agent-platform/context.ts';
import {
  claudeCodeSdkRuntime,
  testClaudeCodeSdkProviderRuntime
} from '../../electron/main/agent-platform/claude/runtime.ts';
import { executeAgentToolAction } from '../../electron/main/agent-platform/workspace-tools.ts';

const hasCredentials = Boolean(
  process.env.FUNPLAY_E2E_CLAUDE_API_KEY?.trim() &&
  process.env.FUNPLAY_E2E_CLAUDE_MODEL?.trim()
);

function buildProject(projectPath: string): Project {
  return ensureProjectSessions(
    createProjectFromInput({
      name: 'Claude Live E2E',
      templateId: 'generic-workspace',
      artStyle: 'test',
      pitch: 'live claude sdk e2e',
      engine: {
        platform: 'web',
        setupMode: 'import',
        projectPath,
        dimension: 'unknown'
      }
    })
  );
}

function buildProvider(): AiProvider {
  const timestamp = new Date().toISOString();
  return {
    id: 'provider_live_claude',
    name: 'Live Claude E2E',
    protocol: 'anthropic',
    baseUrl: process.env.FUNPLAY_E2E_CLAUDE_BASE_URL?.trim() || 'https://api.anthropic.com',
    apiKey: process.env.FUNPLAY_E2E_CLAUDE_API_KEY?.trim() ?? '',
    model: process.env.FUNPLAY_E2E_CLAUDE_MODEL?.trim() ?? 'claude-sonnet-4-6',
    enabled: true,
    isDefault: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

test('live Claude SDK provider probe uses runtime subprocess env', {
  skip: hasCredentials ? false : 'missing FUNPLAY_E2E_CLAUDE_* env',
  timeout: 180_000
}, async () => {
  const probe = await testClaudeCodeSdkProviderRuntime(buildProvider(), {
    timeoutMs: 120_000
  });

  assert.equal(probe.ok, true);
  assert.equal(probe.runtimeId, 'claude-code-sdk');
  assert.equal(Boolean(probe.model), true);
});

test('live Claude runtime denies writes before contacting SDK when permission is read-only', {
  skip: hasCredentials ? false : 'missing FUNPLAY_E2E_CLAUDE_* env'
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-deny-'));
  try {
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '创建 blocked.txt');
    const result = await claudeCodeSdkRuntime.executeTurn?.({
      project,
      message: '创建 blocked.txt，内容为 blocked',
      provider: buildProvider(),
      plugins: [],
      context,
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      }
    });

    assert.equal(result?.assistantIntent, 'fallback');
    assert.match(result?.assistantMessage ?? '', /未获得写入权限|没有拿到写入权限|只读/);
    assert.equal(existsSync(join(projectPath, 'blocked.txt')), false);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live Claude SDK accepts image attachment vision blocks', {
  skip: hasCredentials ? false : 'missing FUNPLAY_E2E_CLAUDE_* env',
  timeout: 300_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-vision-'));
  const redPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axl3iUAAAAASUVORK5CYII=';
  try {
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(
      project,
      [],
      getActiveProjectSession(project).id,
      'Look at the attached image and reply with FUNPLAY_VISION_OK.'
    );
    const stages: Array<{ stageId: string; input?: Record<string, unknown> }> = [];
    const result = await claudeCodeSdkRuntime.executeTurn?.({
      project,
      message: 'Look at the attached image and reply with exactly FUNPLAY_VISION_OK.',
      attachments: [
        {
          id: 'live-red-pixel',
          name: 'red-pixel.png',
          path: join(projectPath, 'missing-red-pixel.png'),
          relativePath: 'red-pixel.png',
          mimeType: 'image/png',
          kind: 'image',
          size: Buffer.from(redPngBase64, 'base64').byteLength,
          previewDataUrl: `data:image/png;base64,${redPngBase64}`
        }
      ],
      provider: buildProvider(),
      plugins: [],
      context,
      permission: {
        mode: 'read-only',
        allowWriteTools: false,
        allowSessionWriteTools: false
      },
      onStage: (stage) => stages.push({
        stageId: stage.stageId,
        input: stage.input
      })
    });

    const visionStage = stages.find((stage) => stage.stageId === 'stage:claude_attachment_vision');
    assert.equal(visionStage?.input?.imageCount, 1);
    assert.equal(visionStage?.input?.degradedCount, 0);
    assert.equal(visionStage?.input?.droppedImageCount, 0);
    if (result?.status === 'completed') {
      assert.match(result.assistantMessage, /FUNPLAY_VISION_OK/i);
    } else {
      assert.match(result?.fallbackDetail ?? result?.assistantMessage ?? '', /claude_|provider|API Error|上游|Upstream/i);
    }
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('live Claude SDK uses host-controlled workspace write and checkpoint rollback', {
  skip: hasCredentials ? false : 'missing FUNPLAY_E2E_CLAUDE_* env',
  timeout: 600_000
}, async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-live-write-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(
      project,
      [],
      getActiveProjectSession(project).id,
      'Create src/live-output.txt with exact content FUNPLAY_LIVE_OK.'
    );
    const stages: string[] = [];
    const result = await claudeCodeSdkRuntime.executeTurn?.({
      project,
      message: [
        'Use the available Funplay host-controlled workspace write tool.',
        'Create the project-relative file src/live-output.txt with exactly this content:',
        'FUNPLAY_LIVE_OK',
        'Do not create or modify any other files. Reply with a short confirmation.'
      ].join('\n'),
      provider: buildProvider(),
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      },
      checkpointSnapshotId: 'live_claude_checkpoint',
      onStage: (stage) => stages.push(stage.stageId)
    });

    assert.equal(result?.status, 'completed');
    assert.equal((await readFile(join(projectPath, 'src/live-output.txt'), 'utf8')).trim(), 'FUNPLAY_LIVE_OK');
    assert.equal(stages.includes('stage:external_write_audit'), true);

    const rollback = await executeAgentToolAction(
      project,
      {
        type: 'checkpoint_rollback',
        reason: 'live claude e2e rollback'
      },
      {
        checkpointSnapshotId: 'live_claude_checkpoint'
      }
    );
    assert.equal(rollback.ok, true);
    assert.equal(existsSync(join(projectPath, 'src/live-output.txt')), false);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
