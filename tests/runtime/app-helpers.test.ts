import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSessionMessagePreview,
  formatQueuedPromptWithAttachments,
  getPlatformCards,
  resolveOnboardingProjectName
} from '../../src/lib/app-helpers.ts';
import type { ChatMessage, PromptAttachment } from '../../shared/types.ts';

test('session message preview strips internal token usage projection', () => {
  const message: ChatMessage = {
    id: 'msg_usage_preview',
    role: 'assistant',
    content: '完成。\n\nUsage: 13',
    createdAt: '2026-05-21T00:00:00.000Z'
  };

  assert.equal(extractSessionMessagePreview(message), '完成。');
});

test('formatQueuedPromptWithAttachments returns the prompt unchanged when there are no attachments', () => {
  assert.equal(formatQueuedPromptWithAttachments('做个跳跃游戏', [], 'zh-CN'), '做个跳跃游戏');
});

test('formatQueuedPromptWithAttachments lists attachment paths, preferring relativePath over path', () => {
  const attachments = [
    { id: 'att_1', name: 'hero.png', path: '/abs/hero.png', relativePath: 'art/hero.png' },
    { id: 'att_2', name: 'sfx.wav', path: '/abs/sfx.wav' }
  ] as PromptAttachment[];
  const result = formatQueuedPromptWithAttachments('use these', attachments, 'en-US');
  assert.match(result, /Attachment paths kept/);
  assert.match(result, /1\. hero\.png -> art\/hero\.png/);
  assert.match(result, /2\. sfx\.wav -> \/abs\/sfx\.wav/);
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

test('platform cards advertise engine 2D and 3D support', () => {
  const zhUnity = getPlatformCards('zh-CN').find((card) => card.id === 'unity');
  const zhCocos = getPlatformCards('zh-CN').find((card) => card.id === 'cocos');
  const enUnity = getPlatformCards('en-US').find((card) => card.id === 'unity');
  const enCocos = getPlatformCards('en-US').find((card) => card.id === 'cocos');

  assert.equal(zhUnity?.description, '支持 2D / 3D');
  assert.equal(zhCocos?.description, '支持 2D / 3D');
  assert.equal(enUnity?.description, 'Supports 2D / 3D');
  assert.equal(enCocos?.description, 'Supports 2D / 3D');
});
