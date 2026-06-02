import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { toOpenAiCompatibleToolParameters } from '../../electron/main/agent-platform/native/tool-pool.ts';
import type { NativeRuntimeToolDefinition } from '../../electron/main/agent-platform/native/tool-adapter.ts';

// toOpenAiCompatibleToolParameters only reads inputJsonSchema / inputSchema, so a
// minimal definition is enough to exercise it.
function makeDef(overrides: Partial<NativeRuntimeToolDefinition>): NativeRuntimeToolDefinition {
  return {
    name: 'test_tool',
    title: 'Test',
    description: 'test',
    inputSchema: z.object({}),
    ...overrides
  } as unknown as NativeRuntimeToolDefinition;
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('no-argument tool still yields a valid object schema (MiniMax 2013 fix)', () => {
  const params = toOpenAiCompatibleToolParameters(makeDef({ inputSchema: z.object({}) }));
  assert.equal(params.type, 'object');
  assert.ok(isObject(params.properties), 'properties must be an object');
});

test('empty inputJsonSchema is upgraded to a proper object schema', () => {
  const params = toOpenAiCompatibleToolParameters(makeDef({ inputJsonSchema: {} }));
  assert.equal(params.type, 'object');
  assert.ok(isObject(params.properties));
});

test('non-object inputJsonSchema is coerced to type:object', () => {
  const params = toOpenAiCompatibleToolParameters(makeDef({ inputJsonSchema: { type: 'string' } }));
  assert.equal(params.type, 'object');
  assert.ok(isObject(params.properties));
});

test('a real tool schema keeps its properties intact', () => {
  const params = toOpenAiCompatibleToolParameters(
    makeDef({ inputSchema: z.object({ path: z.string(), recursive: z.boolean().optional() }) })
  );
  assert.equal(params.type, 'object');
  const props = params.properties as Record<string, unknown>;
  assert.ok('path' in props, 'declared property should survive');
});

test('$schema is stripped from the emitted parameters', () => {
  const params = toOpenAiCompatibleToolParameters(
    makeDef({ inputJsonSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { a: { type: 'string' } } } })
  );
  assert.equal(params.$schema, undefined);
  assert.equal(params.type, 'object');
});
