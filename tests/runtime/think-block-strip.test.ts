import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripLeadingThinkBlock,
  extractTextFromChatChoices,
  extractReasoningFromChatChoices
} from '../../electron/main/openai-compatible-transport.ts';

test('stripLeadingThinkBlock splits a leading think block from the reply', () => {
  const { text, reasoning } = stripLeadingThinkBlock('<think>The user said hi.</think>你好！👋');
  assert.equal(text, '你好！👋');
  assert.equal(reasoning, 'The user said hi.');
});

test('stripLeadingThinkBlock tolerates leading whitespace and trailing newlines', () => {
  const { text, reasoning } = stripLeadingThinkBlock('  \n<think>plan</think>\n\nanswer');
  assert.equal(text, 'answer');
  assert.equal(reasoning, 'plan');
});

test('stripLeadingThinkBlock leaves plain content untouched', () => {
  const { text, reasoning } = stripLeadingThinkBlock('just a normal reply');
  assert.equal(text, 'just a normal reply');
  assert.equal(reasoning, '');
});

test('stripLeadingThinkBlock keeps multi-line reasoning', () => {
  const { text, reasoning } = stripLeadingThinkBlock('<think>line1\nline2</think>done');
  assert.equal(text, 'done');
  assert.equal(reasoning, 'line1\nline2');
});

test('extractTextFromChatChoices strips an inline think block (MiniMax-M3)', () => {
  const body = { choices: [{ message: { content: '<think>greet back</think>你好！' } }] };
  assert.equal(extractTextFromChatChoices(body), '你好！');
});

test('extractReasoningFromChatChoices falls back to the inline think block', () => {
  const body = { choices: [{ message: { content: '<think>greet back</think>你好！' } }] };
  assert.equal(extractReasoningFromChatChoices(body), 'greet back');
});

test('extractReasoningFromChatChoices still prefers a reasoning_content field', () => {
  const body = { choices: [{ message: { content: 'reply', reasoning_content: 'field reasoning' } }] };
  assert.equal(extractReasoningFromChatChoices(body), 'field reasoning');
});

test('content without think is returned verbatim', () => {
  const body = { choices: [{ message: { content: '普通回复' } }] };
  assert.equal(extractTextFromChatChoices(body), '普通回复');
  assert.equal(extractReasoningFromChatChoices(body), '');
});
