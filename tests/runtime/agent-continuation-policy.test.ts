import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAgentLengthLimitedFinishReason,
  looksLikeAgentTodoContinuationReply,
  looksLikeUnfinishedAgentWriteReply
} from '../../shared/agent-continuation-policy.ts';

test('agent continuation policy recognizes unfinished write replies with file evidence', () => {
  assert.equal(looksLikeUnfinishedAgentWriteReply('Next I will write src/App.tsx.'), true);
  assert.equal(looksLikeUnfinishedAgentWriteReply('接下来我会创建 Assets/Scripts/Player.cs。'), true);
  assert.equal(looksLikeUnfinishedAgentWriteReply('Next I will continue.'), false);
  assert.equal(looksLikeUnfinishedAgentWriteReply('src/App.tsx 已经更新完成。'), false);
});

test('agent continuation policy recognizes todo and provider length continuation signals', () => {
  assert.equal(looksLikeAgentTodoContinuationReply('pending items remain'), true);
  assert.equal(looksLikeAgentTodoContinuationReply('全部完成'), false);
  assert.equal(isAgentLengthLimitedFinishReason('length'), true);
  assert.equal(isAgentLengthLimitedFinishReason('max_output_tokens'), true);
  assert.equal(isAgentLengthLimitedFinishReason('stop'), false);
});
