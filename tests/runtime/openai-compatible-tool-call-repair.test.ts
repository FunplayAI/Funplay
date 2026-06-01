import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCallArguments, repairOpenAiCompatibleToolCalls } from '../../electron/main/openai-compatible-profile-transforms.ts';

// These guard the third-level lenient repair that lets weaker, non-frontier
// providers' malformed tool-call arguments still parse — closing part of the
// cross-provider gap with Claude (维度⑥).

test('parseToolCallArguments parses clean JSON', () => {
  assert.deepEqual(parseToolCallArguments('{"path":"a.js","content":"x"}'), { path: 'a.js', content: 'x' });
});

test('parseToolCallArguments strips markdown code fences', () => {
  assert.deepEqual(parseToolCallArguments('```json\n{"path":"a.js"}\n```'), { path: 'a.js' });
  assert.deepEqual(parseToolCallArguments('```\n{"a":1}\n```'), { a: 1 });
});

test('parseToolCallArguments tolerates JSON5-style trailing commas', () => {
  assert.deepEqual(parseToolCallArguments('{"a":1,"b":2,}'), { a: 1, b: 2 });
  assert.deepEqual(parseToolCallArguments('{"items":[1,2,3,]}'), { items: [1, 2, 3] });
});

test('parseToolCallArguments strips trailing commas without touching string contents', () => {
  // The "a,}" substring lives inside a string and must survive; only the
  // structural trailing comma before the closing brace is removed.
  assert.deepEqual(parseToolCallArguments('{"text":"a,}","x":1,}'), { text: 'a,}', x: 1 });
});

test('parseToolCallArguments handles a fenced object with trailing comma together', () => {
  assert.deepEqual(parseToolCallArguments('```json\n{"a":1,}\n```'), { a: 1 });
});

test('parseToolCallArguments coerces Python-style literals from local models', () => {
  assert.deepEqual(parseToolCallArguments('{"ok":True,"err":False,"val":None}'), { ok: true, err: false, val: null });
});

test('parseToolCallArguments keeps Python-like words inside strings intact', () => {
  assert.deepEqual(parseToolCallArguments('{"note":"None of this","flag":True}'), { note: 'None of this', flag: true });
});

test('parseToolCallArguments returns undefined for non-JSON', () => {
  assert.equal(parseToolCallArguments('not json at all'), undefined);
  assert.equal(parseToolCallArguments(''), undefined);
});

const toolDefs = [
  { name: 'write_file', description: '', parameters: {} },
  { name: 'read_file', description: '', parameters: {} }
] as Parameters<typeof repairOpenAiCompatibleToolCalls>[1];

test('repairOpenAiCompatibleToolCalls fixes case mismatches', () => {
  const calls = [{ name: 'Write_File' }];
  repairOpenAiCompatibleToolCalls(calls, toolDefs);
  assert.equal(calls[0].name, 'write_file');
});

test('repairOpenAiCompatibleToolCalls strips namespace prefixes', () => {
  const calls = [{ name: 'functions.write_file' }, { name: 'tools/read_file' }];
  repairOpenAiCompatibleToolCalls(calls, toolDefs);
  assert.equal(calls[0].name, 'write_file');
  assert.equal(calls[1].name, 'read_file');
});

test('repairOpenAiCompatibleToolCalls matches hyphen/underscore variants', () => {
  const calls = [{ name: 'write-file' }];
  repairOpenAiCompatibleToolCalls(calls, toolDefs);
  assert.equal(calls[0].name, 'write_file');
});

test('repairOpenAiCompatibleToolCalls leaves unknown tools unchanged', () => {
  const calls = [{ name: 'totally_unknown' }];
  repairOpenAiCompatibleToolCalls(calls, toolDefs);
  assert.equal(calls[0].name, 'totally_unknown');
});
