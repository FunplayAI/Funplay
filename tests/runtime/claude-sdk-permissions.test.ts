import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProject, tryRunGit } from './test-helpers.ts';
import { getActiveProjectSession } from '../../shared/project-sessions.ts';
import { buildGenericWorkspaceContext } from '../../electron/main/agent-platform/context.ts';
import { buildClaudeCodeSdkEnv, createClaudeSdkPermissionHandler, sanitizeClaudeToolInput } from '../../electron/main/agent-platform/claude/runtime.ts';

test('Claude Code tool input sanitizer removes empty Read pages', () => {
  assert.deepEqual(
    sanitizeClaudeToolInput('Read', {
      file_path: 'docs/spec.pdf',
      pages: ''
    }),
    {
      file_path: 'docs/spec.pdf'
    }
  );
  assert.deepEqual(
    sanitizeClaudeToolInput('Read', {
      file_path: 'docs/spec.pdf',
      pages: '1-5'
    }),
    {
      file_path: 'docs/spec.pdf',
      pages: '1-5'
    }
  );
  assert.deepEqual(
    sanitizeClaudeToolInput('Write', {
      file_path: 'docs/spec.pdf',
      pages: ''
    }),
    {
      file_path: 'docs/spec.pdf',
      pages: ''
    }
  );
});

test('Claude Agent SDK AskUserQuestion uses host user input bridge', async () => {
  const project = buildProject();
  const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);
  const userInputRequests: Array<{
    title?: string;
    question: string;
    toolName?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
  }> = [];
  const handler = createClaudeSdkPermissionHandler({
    project,
    message: '更新首页',
    provider: {
      id: 'provider_anthropic',
      name: 'Anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'secret',
      model: 'claude-sonnet-4-6',
      enabled: true,
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    plugins: [],
    context,
    permission: {
      mode: 'read-only',
      allowWriteTools: false,
      allowSessionWriteTools: false
    },
    requestUserInput: async (request) => {
      userInputRequests.push(request);
      return {
        answer: 'Home screen',
        optionId: request.options?.[0]?.id
      };
    }
  });

  const result = await handler(
    'AskUserQuestion',
    {
      questions: [
        {
          question: 'Which screen should be updated?',
          header: 'Target',
          options: [
            { label: 'Home', description: 'Update home screen' },
            { label: 'Settings', description: 'Update settings screen' }
          ],
          multiSelect: false
        }
      ]
    },
    {
      signal: new AbortController().signal,
      toolUseID: 'tool_ask_user'
    }
  );

  assert.equal(result.behavior, 'allow');
  if (result.behavior !== 'allow') {
    assert.fail('AskUserQuestion should be allowed after the user answers.');
  }
  assert.deepEqual(result.updatedInput?.answers, {
    'Which screen should be updated?': 'Home screen'
  });
  assert.equal(result.toolUseID, 'tool_ask_user');
  assert.equal(userInputRequests.length, 1);
  assert.equal(userInputRequests[0]?.toolName, 'AskUserQuestion');
  assert.equal(userInputRequests[0]?.question, 'Which screen should be updated?');
  assert.equal(userInputRequests[0]?.multiSelect, false);
  assert.deepEqual(userInputRequests[0]?.options, [
    {
      id: 'q1_option_1',
      label: 'Home',
      description: 'Update home screen'
    },
    {
      id: 'q1_option_2',
      label: 'Settings',
      description: 'Update settings screen'
    }
  ]);
});

test('Claude Agent SDK downgrades Agent worktree isolation outside git repos', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-agent-nongit-'));
  try {
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);
    const stages: Array<{
      stageId: string;
      phase?: string;
      title: string;
      target: string;
      status: string;
      input?: Record<string, unknown>;
      summary?: string;
    }> = [];
    const handler = createClaudeSdkPermissionHandler({
      project,
      message: '检查项目',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'secret',
        model: 'claude-sonnet-4-6',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      },
      onStage: (stage) => {
        stages.push(stage);
      }
    });

    const result = await handler(
      'Agent',
      {
        description: 'Inspect files',
        prompt: 'Inspect the current project.',
        isolation: 'worktree'
      },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool_agent_worktree'
      }
    );

    assert.equal(result.behavior, 'allow');
    if (result.behavior !== 'allow') {
      assert.fail('Agent should be allowed in full-access mode.');
    }
    assert.equal(result.updatedInput?.isolation, undefined);
    assert.equal(result.updatedInput?.description, 'Inspect files');
    assert.equal(stages.length, 1);
    assert.equal(stages[0]?.stageId, 'stage:claude_agent_worktree_downgrade:tool_agent_worktree');
    assert.equal(stages[0]?.target, 'claude_code:Agent');
    assert.equal(stages[0]?.input?.requestedIsolation, 'worktree');
    assert.match(stages[0]?.summary ?? '', /不是 Git 仓库/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('Claude Agent SDK preserves Agent worktree isolation inside git repos', async (t) => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-agent-git-'));
  try {
    if (!tryRunGit(['init'], projectPath)) {
      t.skip('git is unavailable');
      return;
    }

    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id);
    const stages: Array<{ stageId: string }> = [];
    const handler = createClaudeSdkPermissionHandler({
      project,
      message: '检查项目',
      provider: {
        id: 'provider_anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'secret',
        model: 'claude-sonnet-4-6',
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true,
        allowedWriteTools: ['*']
      },
      onStage: (stage) => {
        stages.push(stage);
      }
    });

    const result = await handler(
      'Agent',
      {
        description: 'Inspect files',
        prompt: 'Inspect the current project.',
        isolation: 'worktree'
      },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool_agent_worktree'
      }
    );

    assert.equal(result.behavior, 'allow');
    if (result.behavior !== 'allow') {
      assert.fail('Agent should be allowed in full-access mode.');
    }
    assert.equal(result.updatedInput?.isolation, 'worktree');
    assert.equal(stages.length, 0);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('Claude Agent SDK env sanitizes process env and marks Funplay client app', () => {
  const env = buildClaudeCodeSdkEnv({
    id: 'provider_anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'new\u0001-key',
    model: 'claude-opus-4-1',
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, {
    PATH: '/usr/bin',
    BAD: undefined,
    CLAUDE_AGENT_SDK_CLIENT_APP: ''
  });

  assert.equal(env.ANTHROPIC_API_KEY, 'new-key');
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, '');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'BAD'), false);

  const openAiEnv = buildClaudeCodeSdkEnv({
    id: 'provider_openai',
    name: 'OpenAI Compat',
    protocol: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'openai-key',
    model: 'gpt-test',
    enabled: true,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'old-key',
    ANTHROPIC_AUTH_TOKEN: 'old-token',
    ANTHROPIC_BASE_URL: 'https://old.example/v1',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    CLAUDECODE: '1'
  });
  assert.equal(openAiEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(openAiEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(openAiEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(openAiEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(openAiEnv.CLAUDECODE, undefined);
});
