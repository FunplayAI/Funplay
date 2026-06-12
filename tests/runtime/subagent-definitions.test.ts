import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findSubagentDefinition,
  listSubagentDefinitions,
  parseSubagentDefinitionContent,
  resetSubagentDefinitionCache,
  resolveNativeSubagentModel,
  resolveNativeSubagentToolPoolMode
} from '../../electron/main/agent-platform/native/subagent-definitions.ts';

async function writeDefinition(
  root: string,
  dir: '.claude' | '.funplay',
  fileName: string,
  content: string
): Promise<string> {
  const directory = join(root, dir, 'agents');
  await mkdir(directory, { recursive: true });
  const path = join(directory, fileName);
  await writeFile(path, content, 'utf8');
  return path;
}

test('parseSubagentDefinitionContent reads frontmatter name, description, tools, model and body', () => {
  const definition = parseSubagentDefinitionContent({
    content: [
      '---',
      'name: code-reviewer',
      'description: 审查代码改动',
      'tools: [read, write, command]',
      'model: gpt-sub',
      '---',
      '',
      '你专注于代码审查。',
      '先看 diff，再给结论。'
    ].join('\n'),
    sourcePath: '/tmp/agents/code-reviewer.md',
    source: 'claude'
  });

  assert.ok(definition);
  assert.equal(definition.name, 'code-reviewer');
  assert.equal(definition.description, '审查代码改动');
  assert.deepEqual(definition.tools, ['read', 'write', 'command']);
  assert.equal(definition.model, 'gpt-sub');
  assert.equal(definition.systemPrompt, '你专注于代码审查。\n先看 diff，再给结论。');
  assert.equal(definition.source, 'claude');
});

test('parseSubagentDefinitionContent supports yaml list tools, comma strings, and filters unknown families', () => {
  const yamlList = parseSubagentDefinitionContent({
    content: ['---', 'name: yaml-agent', 'tools:', '  - read', '  - web', '  - terminal', '---', 'body'].join('\n'),
    sourcePath: '/tmp/agents/yaml-agent.md',
    source: 'funplay'
  });
  assert.deepEqual(yamlList?.tools, ['read', 'web']);

  const commaString = parseSubagentDefinitionContent({
    content: ['---', 'name: comma-agent', 'tools: read, mcp, bogus', '---', 'body'].join('\n'),
    sourcePath: '/tmp/agents/comma-agent.md',
    source: 'funplay'
  });
  assert.deepEqual(commaString?.tools, ['read', 'mcp']);
});

test('parseSubagentDefinitionContent falls back to the file basename without frontmatter', () => {
  const definition = parseSubagentDefinitionContent({
    content: '只有正文，没有 frontmatter。',
    sourcePath: '/tmp/agents/plain-investigator.md',
    source: 'claude'
  });
  assert.equal(definition?.name, 'plain-investigator');
  assert.deepEqual(definition?.tools, []);
  assert.equal(definition?.model, undefined);
  assert.equal(definition?.systemPrompt, '只有正文，没有 frontmatter。');
});

test('listSubagentDefinitions loads both directories and .funplay wins name conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-subagent-defs-'));
  try {
    resetSubagentDefinitionCache();
    await writeDefinition(
      root,
      '.claude',
      'reviewer.md',
      ['---', 'name: reviewer', 'model: claude-model', '---', 'claude body'].join('\n')
    );
    await writeDefinition(root, '.claude', 'scout.md', ['---', 'name: scout', '---', 'scout body'].join('\n'));
    await writeDefinition(
      root,
      '.funplay',
      'reviewer.md',
      ['---', 'name: Reviewer', 'model: funplay-model', '---', 'funplay body'].join('\n')
    );

    const definitions = listSubagentDefinitions(root);
    assert.deepEqual(definitions.map((definition) => definition.name).sort(), ['Reviewer', 'scout']);
    const reviewer = findSubagentDefinition(root, 'reviewer');
    assert.equal(reviewer?.source, 'funplay');
    assert.equal(reviewer?.model, 'funplay-model');
    assert.equal(reviewer?.systemPrompt, 'funplay body');

    // Case-insensitive lookup.
    assert.equal(findSubagentDefinition(root, 'REVIEWER')?.name, 'Reviewer');
    assert.equal(findSubagentDefinition(root, 'missing'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listSubagentDefinitions caches by mtime signature and invalidates on file changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-subagent-cache-'));
  try {
    resetSubagentDefinitionCache();
    const path = await writeDefinition(root, '.claude', 'cached.md', ['---', 'name: cached', '---', 'v1'].join('\n'));

    const first = listSubagentDefinitions(root);
    const second = listSubagentDefinitions(root);
    assert.equal(second, first, 'unchanged files must return the cached definitions array');

    // Rewrite the file and force a different mtime so the signature changes even
    // on coarse-grained filesystems.
    await writeFile(path, ['---', 'name: cached', '---', 'v2'].join('\n'), 'utf8');
    const bumped = new Date(Date.now() + 5_000);
    await utimes(path, bumped, bumped);
    const third = listSubagentDefinitions(root);
    assert.notEqual(third, first);
    assert.equal(third[0]?.systemPrompt, 'v2');

    // Adding a file changes the file set signature.
    await writeDefinition(root, '.funplay', 'extra.md', ['---', 'name: extra', '---', 'extra body'].join('\n'));
    const fourth = listSubagentDefinitions(root);
    assert.deepEqual(fourth.map((definition) => definition.name).sort(), ['cached', 'extra']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listSubagentDefinitions returns empty without a project root or agent directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-subagent-empty-'));
  try {
    resetSubagentDefinitionCache();
    assert.deepEqual(listSubagentDefinitions(undefined), []);
    assert.deepEqual(listSubagentDefinitions(''), []);
    assert.deepEqual(listSubagentDefinitions(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveNativeSubagentModel resolves against the provider model list', () => {
  const provider = {
    model: 'parent-model',
    upstreamModel: 'parent-upstream',
    availableModels: [{ modelId: 'sub-model', upstreamModelId: 'sub-upstream' }, { modelId: 'Other-Model' }]
  };

  const parent = resolveNativeSubagentModel(provider, undefined);
  assert.equal(parent.source, 'parent');
  assert.equal(parent.model, 'parent-model');
  assert.equal(parent.upstreamModel, 'parent-upstream');

  const same = resolveNativeSubagentModel(provider, 'parent-model');
  assert.equal(same.source, 'requested');
  assert.equal(same.model, 'parent-model');

  const matched = resolveNativeSubagentModel(provider, 'sub-model');
  assert.equal(matched.source, 'requested');
  assert.equal(matched.model, 'sub-model');
  assert.equal(matched.upstreamModel, 'sub-upstream');

  const byUpstream = resolveNativeSubagentModel(provider, 'sub-upstream');
  assert.equal(byUpstream.model, 'sub-model');

  const caseInsensitive = resolveNativeSubagentModel(provider, 'other-model');
  assert.equal(caseInsensitive.source, 'requested');
  assert.equal(caseInsensitive.model, 'Other-Model');
});

test('resolveNativeSubagentModel falls back to the parent model for unknown models with a zh note', () => {
  const fallback = resolveNativeSubagentModel(
    {
      model: 'parent-model',
      availableModels: [{ modelId: 'known-model' }]
    },
    'unknown-model'
  );
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.model, 'parent-model');
  assert.equal(fallback.requestedModel, 'unknown-model');
  assert.match(fallback.fallbackNote ?? '', /unknown-model/);
  assert.match(fallback.fallbackNote ?? '', /回退到父模型/);

  // No model list at all: cannot verify, also falls back.
  const noList = resolveNativeSubagentModel({ model: 'parent-model' }, 'anything');
  assert.equal(noList.source, 'fallback');
  assert.equal(noList.model, 'parent-model');
});

test('resolveNativeSubagentToolPoolMode keeps investigator read-only and forbids nested subagents', () => {
  const investigator = resolveNativeSubagentToolPoolMode({ mode: 'investigator' });
  assert.equal(investigator.includeWriteTools, false);
  assert.equal(investigator.includeCommandTools, false);
  assert.equal(investigator.includeMcpToolCalls, false);
  for (const excluded of ['ask_user', 'run_subagent', 'run_subagents', 'subagent_start', 'subagent_status']) {
    assert.ok(investigator.excludeTools?.includes(excluded as never), `expected ${excluded} excluded`);
  }

  // Investigator stays read-only even when a definition declares write/command.
  const restrictedInvestigator = resolveNativeSubagentToolPoolMode({
    mode: 'investigator',
    definition: {
      name: 'writer',
      tools: ['read', 'write', 'command'],
      systemPrompt: '',
      sourcePath: '/tmp/agents/writer.md',
      source: 'claude'
    }
  });
  assert.equal(restrictedInvestigator.includeWriteTools, false);
  assert.equal(restrictedInvestigator.includeCommandTools, false);
});

test('resolveNativeSubagentToolPoolMode enables worker buckets per definition tool families', () => {
  const workerDefault = resolveNativeSubagentToolPoolMode({ mode: 'worker' });
  assert.equal(workerDefault.includeWriteTools, true);
  assert.equal(workerDefault.includeCommandTools, true);
  assert.equal(workerDefault.includeMcpToolCalls, false);
  assert.ok(workerDefault.excludeTools?.includes('checkpoint_rollback' as never));
  assert.ok(workerDefault.excludeTools?.includes('run_subagent' as never));
  assert.equal(workerDefault.excludeTools?.includes('web_search' as never), false);

  const writeOnly = resolveNativeSubagentToolPoolMode({
    mode: 'worker',
    definition: {
      name: 'writer',
      tools: ['read', 'write'],
      systemPrompt: '',
      sourcePath: '/tmp/agents/writer.md',
      source: 'funplay'
    }
  });
  assert.equal(writeOnly.includeWriteTools, true);
  assert.equal(writeOnly.includeCommandTools, false);
  assert.equal(writeOnly.includeMcpToolCalls, false);
  // Definition lists tool families without web: web tools drop out.
  assert.ok(writeOnly.excludeTools?.includes('web_search' as never));
  assert.ok(writeOnly.excludeTools?.includes('web_fetch' as never));

  const mcpWorker = resolveNativeSubagentToolPoolMode({
    mode: 'worker',
    definition: {
      name: 'mcp-worker',
      tools: ['read', 'mcp', 'web'],
      systemPrompt: '',
      sourcePath: '/tmp/agents/mcp-worker.md',
      source: 'funplay'
    }
  });
  assert.equal(mcpWorker.includeWriteTools, false);
  assert.equal(mcpWorker.includeMcpToolCalls, true);
  assert.equal(mcpWorker.excludeTools?.includes('web_search' as never), false);
});
