import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createThinkStreamSplitState,
  pushThroughThinkStream,
  flushThinkStream
} from '../../electron/main/openai-compatible-transport.ts';

/** Feed `deltas` through a fresh splitter and return the accumulated text + reasoning. */
function runStream(deltas: string[]): { text: string; reasoning: string } {
  const split = createThinkStreamSplitState();
  let text = '';
  let reasoning = '';
  for (const delta of deltas) {
    const part = pushThroughThinkStream(split, delta);
    text += part.text;
    reasoning += part.reasoning;
  }
  const tail = flushThinkStream(split);
  return { text: text + tail.text, reasoning: reasoning + tail.reasoning };
}

test('plain content streams straight through as visible text', () => {
  assert.deepEqual(runStream(['你好', '世界']), { text: '你好世界', reasoning: '' });
});

test('a complete think block in one delta is split out', () => {
  assert.deepEqual(runStream(['<think>plan</think>answer']), { text: 'answer', reasoning: 'plan' });
});

test('leading whitespace before <think> is dropped, not shown', () => {
  assert.deepEqual(runStream(['  \n<think>x</think>y']), { text: 'y', reasoning: 'x' });
});

test('an open tag split across chunks is still recognized', () => {
  assert.deepEqual(runStream(['<thi', 'nk>plan</think>done']), { text: 'done', reasoning: 'plan' });
});

test('a close tag split across chunks is still recognized', () => {
  assert.deepEqual(runStream(['<think>abc</thi', 'nk>def']), { text: 'def', reasoning: 'abc' });
});

test('reasoning spanning many chunks accumulates correctly', () => {
  assert.deepEqual(runStream(['<think>a', 'b', 'c</think>d']), { text: 'd', reasoning: 'abc' });
});

test('think text containing a stray "<" is not mistaken for the close tag', () => {
  assert.deepEqual(runStream(['<think>a < ', 'b</think>c']), { text: 'c', reasoning: 'a < b' });
});

test('a "<" that does turn into </think> closes the block', () => {
  assert.deepEqual(runStream(['<think>a<', '/think>b']), { text: 'b', reasoning: 'a' });
});

test('content that merely starts with "<" is not held hostage as a think tag', () => {
  assert.deepEqual(runStream(['<div>hi']), { text: '<div>hi', reasoning: '' });
});

test('a "<t" decoy split across chunks flushes as visible text', () => {
  assert.deepEqual(runStream(['<t', 'able>cell']), { text: '<table>cell', reasoning: '' });
});

test('whitespace right after </think> is swallowed like the non-streaming pattern', () => {
  assert.deepEqual(runStream(['<think>x</think>\n\nhello']), { text: 'hello', reasoning: 'x' });
});

test('an unterminated think block (truncated stream) flushes as reasoning', () => {
  assert.deepEqual(runStream(['<think>partial thought']), { text: '', reasoning: 'partial thought' });
});

test('a partial open tag left at end of stream flushes as visible text', () => {
  assert.deepEqual(runStream(['<thi']), { text: '<thi', reasoning: '' });
});

test('the visible text stream never flashes think markup, chunk by chunk', () => {
  const split = createThinkStreamSplitState();
  const deltas = ['<thi', 'nk>secret rea', 'soning</thi', 'nk>Visible ', 'answer'];
  let text = '';
  for (const delta of deltas) {
    const part = pushThroughThinkStream(split, delta);
    assert.ok(!part.text.includes('<think>'), `text delta leaked open tag: "${part.text}"`);
    assert.ok(!part.text.includes('think>'), `text delta leaked a tag fragment: "${part.text}"`);
    assert.ok(!part.text.includes('secret'), `text delta leaked reasoning: "${part.text}"`);
    text += part.text;
  }
  text += flushThinkStream(split).text;
  assert.equal(text, 'Visible answer');
});
