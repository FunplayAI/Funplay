import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePermissionRules,
  matchesPermissionPathGlob,
  resolveAgentToolPermission
} from '../../electron/main/agent-platform/permission-broker.ts';
import {
  deriveCommandPrefix,
  derivePathGlobForPaths,
  deriveScopedSessionPermissionRules,
  grantSessionWritePermission,
  listSessionPermissionRules,
  restoreSessionWritePermissionGrant,
  revokeSessionWritePermission
} from '../../electron/main/agent-platform/permission-session-store.ts';
import type { AgentPermissionImpact, AgentPermissionRule } from '../../shared/types/index.ts';
import type { AgentToolPermissionRequest } from '../../electron/main/agent-platform/permission-broker.ts';

function rule(overrides: Partial<AgentPermissionRule> & Pick<AgentPermissionRule, 'toolName' | 'action'>): AgentPermissionRule {
  return {
    id: `rule_${Math.random().toString(36).slice(2)}`,
    scope: 'session',
    createdAt: new Date().toISOString(),
    source: 'user_decision',
    ...overrides
  };
}

function impact(partial: Partial<AgentPermissionImpact>): AgentPermissionImpact {
  return {
    toolName: partial.toolName ?? 'run_command',
    toolTitle: partial.toolTitle ?? 'Run command',
    permissionPolicy: 'ask',
    checkpointPolicy: 'none',
    readOnly: false,
    ...partial
  };
}

test('path glob matching: ** crosses directories, * stays in one segment', () => {
  assert.equal(matchesPermissionPathGlob('src/app/main.ts', 'src/**'), true);
  assert.equal(matchesPermissionPathGlob('src/main.ts', 'src/**'), true);
  assert.equal(matchesPermissionPathGlob('lib/main.ts', 'src/**'), false);
  assert.equal(matchesPermissionPathGlob('main.ts', '*'), true);
  assert.equal(matchesPermissionPathGlob('src/main.ts', '*'), false);
  assert.equal(matchesPermissionPathGlob('src/a.test.ts', 'src/*.test.ts'), true);
  assert.equal(matchesPermissionPathGlob('src/deep/a.test.ts', 'src/*.test.ts'), false);
});

test('command prefix matches on token boundaries only', () => {
  const rules = [rule({ toolName: 'run_command', commandPrefix: 'npm run', action: 'allow' })];
  assert.equal(
    evaluatePermissionRules(rules, 'run_command', impact({ commands: ['npm   run test:runtime'] })),
    'allow'
  );
  assert.equal(
    evaluatePermissionRules(rules, 'run_command', impact({ commands: ['npm run'] })),
    'allow'
  );
  assert.equal(
    evaluatePermissionRules(rules, 'run_command', impact({ commands: ['npm runner'] })),
    undefined
  );
  assert.equal(evaluatePermissionRules(rules, 'run_command', impact({ commands: [] })), undefined);
});

test('deny wins over allow regardless of rule order', () => {
  const rules = [
    rule({ toolName: 'run_command', commandPrefix: 'npm', action: 'allow' }),
    rule({ toolName: 'run_command', commandPrefix: 'npm run', action: 'deny' })
  ];
  assert.equal(
    evaluatePermissionRules(rules, 'run_command', impact({ commands: ['npm run dist'] })),
    'deny'
  );
  assert.equal(
    evaluatePermissionRules(rules, 'run_command', impact({ commands: ['npm install'] })),
    'allow'
  );
});

test('wildcard tool rules match any tool; path rules require all paths to match', () => {
  const rules = [rule({ toolName: '*', pathGlob: 'Assets/**', action: 'allow' })];
  assert.equal(
    evaluatePermissionRules(rules, 'write_file', impact({ toolName: 'write_file', paths: ['Assets/a.png', 'Assets/sub/b.txt'] })),
    'allow'
  );
  assert.equal(
    evaluatePermissionRules(rules, 'write_file', impact({ toolName: 'write_file', paths: ['Assets/a.png', 'src/b.ts'] })),
    undefined
  );
});

test('path rules normalize absolute paths against the project root', () => {
  const rules = [rule({ toolName: 'write_file', pathGlob: 'src/**', action: 'allow' })];
  assert.equal(
    evaluatePermissionRules(
      rules,
      'write_file',
      impact({ toolName: 'write_file', paths: ['/work/proj/src/main.ts'] }),
      '/work/proj'
    ),
    'allow'
  );
});

test('deriveCommandPrefix takes the first two normalized tokens', () => {
  assert.equal(deriveCommandPrefix('  npm   run   test:runtime  '), 'npm run');
  assert.equal(deriveCommandPrefix('ls'), 'ls');
});

test('derivePathGlobForPaths produces common-directory globs', () => {
  assert.equal(derivePathGlobForPaths(['src/a.ts', 'src/sub/b.ts'], undefined), 'src/**');
  assert.equal(derivePathGlobForPaths(['a.ts', 'b.ts'], undefined), '*');
  assert.equal(derivePathGlobForPaths(['src/a.ts', 'lib/b.ts'], undefined), undefined);
  assert.equal(derivePathGlobForPaths(['/p/Assets/x/a.png'], '/p'), 'Assets/x/**');
});

test('deriveScopedSessionPermissionRules maps run_command to a two-token prefix rule', () => {
  const rules = deriveScopedSessionPermissionRules({
    toolName: 'run_command',
    impact: impact({ commands: ['npm run test:runtime'] })
  });
  assert.equal(rules?.length, 1);
  assert.equal(rules?.[0].commandPrefix, 'npm run');
  assert.equal(rules?.[0].action, 'allow');
  assert.equal(rules?.[0].scope, 'session');
});

test('deriveScopedSessionPermissionRules maps write tools to directory globs', () => {
  const rules = deriveScopedSessionPermissionRules({
    toolName: 'write_file',
    impact: impact({ toolName: 'write_file', paths: ['/p/src/game/a.ts'] }),
    projectPath: '/p'
  });
  assert.equal(rules?.[0].pathGlob, 'src/game/**');
});

test('session grant stores scoped rules and a matching call auto-allows while others ask', async () => {
  const sessionId = 'session_rule_grant';
  try {
    grantSessionWritePermission(sessionId, {
      tools: [],
      rules: deriveScopedSessionPermissionRules({
        toolName: 'run_command',
        impact: impact({ commands: ['npm run lint'] })
      })
    });
    const rules = listSessionPermissionRules(sessionId);
    assert.equal(rules.length, 1);

    let prompted = 0;
    const context = {
      permission: {
        mode: 'default' as const,
        allowWriteTools: false,
        allowSessionWriteTools: false,
        allowedWriteTools: [],
        rules
      },
      requestPermission: async () => {
        prompted += 1;
        return 'deny' as const;
      }
    };
    const request = (command: string): AgentToolPermissionRequest => ({
      tool: {
        name: 'run_command',
        title: 'Run command',
        risk: 'high',
        readOnly: false,
        permissionPolicy: 'ask',
        checkpointPolicy: 'none'
      },
      input: { command }
    });

    assert.equal(await resolveAgentToolPermission(context, request('npm run lint --fix')), 'allow');
    assert.equal(prompted, 0);
    assert.equal(await resolveAgentToolPermission(context, request('rm -rf /')), 'deny');
    assert.equal(prompted, 1);
  } finally {
    revokeSessionWritePermission(sessionId);
  }
});

test('deny rules override blanket full-access pre-approval', async () => {
  const context = {
    permission: {
      mode: 'default' as const,
      allowWriteTools: true,
      allowSessionWriteTools: false,
      allowedWriteTools: ['*'],
      rules: [rule({ toolName: 'run_command', commandPrefix: 'git push', action: 'deny' })]
    },
    requestPermission: async () => 'allow' as const
  };
  const decision = await resolveAgentToolPermission(context, {
    tool: {
      name: 'run_command',
      title: 'Run command',
      risk: 'high',
      readOnly: false,
      permissionPolicy: 'ask',
      checkpointPolicy: 'none'
    },
    input: { command: 'git push origin main' }
  });
  assert.equal(decision, 'deny');
});

test('legacy grants without rules restore cleanly', () => {
  const sessionId = 'session_legacy_grant';
  try {
    restoreSessionWritePermissionGrant(sessionId, {
      tools: ['write_file'],
      grantedAt: Date.now(),
      expiresAt: Date.now() + 60_000
    });
    assert.deepEqual(listSessionPermissionRules(sessionId), []);
  } finally {
    revokeSessionWritePermission(sessionId);
  }
});
