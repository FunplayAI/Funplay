import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSessionMessagePreview, resolveOnboardingProjectName } from '../../src/lib/app-helpers.ts';
import type { ChatMessage } from '../../shared/types.ts';

test('session message preview strips internal token usage projection', () => {
  const message: ChatMessage = {
    id: 'msg_usage_preview',
    role: 'assistant',
    content: '完成。\n\nUsage: 13',
    createdAt: '2026-05-21T00:00:00.000Z'
  };

  assert.equal(extractSessionMessagePreview(message), '完成。');
});

test('session message preview hides usage-only legacy content', () => {
  const message: ChatMessage = {
    id: 'msg_usage_only',
    role: 'assistant',
    content: 'Usage: 63733 Usage: 579',
    createdAt: '2026-05-21T00:00:00.000Z'
  };

  assert.equal(extractSessionMessagePreview(message), '');
});

test('imported projects prefer the folder name over stale create-form names', () => {
  assert.equal(resolveOnboardingProjectName({
    mode: 'import',
    projectPath: '/Users/demo/Games/Bird',
    projectName: 'Old Form Name',
    fallback: 'Untitled Project'
  }), 'Bird');
});

test('created projects still prefer the explicit form name', () => {
  assert.equal(resolveOnboardingProjectName({
    mode: 'create',
    projectPath: '/Users/demo/Games/Bird',
    projectName: 'New Game',
    fallback: 'Untitled Project'
  }), 'New Game');
});
