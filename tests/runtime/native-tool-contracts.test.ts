import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAgentToolDefinition,
  listAgentToolDefinitions
} from '../../electron/main/agent-platform/tool-registry.ts';
import {
  listNativeWorkspaceToolDefinitions,
  resolveNativeRuntimeToolName
} from '../../electron/main/agent-platform/native/tool-adapter.ts';

const fakeProject = {
  id: 'project_1',
  name: 'Project',
  path: '/tmp/project',
  createdAt: 'now',
  updatedAt: 'now'
} as any;

test('native static tools expose complete contract hooks', () => {
  const definitions = listAgentToolDefinitions();
  assert.ok(definitions.length >= 63);

  for (const definition of definitions) {
    assert.ok(definition.toolLanguage, `${definition.name} missing toolLanguage`);
    assert.ok(definition.toolLanguage.family, `${definition.name} missing toolLanguage.family`);
    assert.equal(typeof definition.userFacingName, 'function', `${definition.name} missing userFacingName`);
    assert.equal(typeof definition.getActivityDescription, 'function', `${definition.name} missing getActivityDescription`);
    assert.equal(typeof definition.getToolUseSummary, 'function', `${definition.name} missing getToolUseSummary`);
    assert.equal(typeof definition.toAutoClassifierInput, 'function', `${definition.name} missing toAutoClassifierInput`);
    assert.equal(typeof definition.classifySideEffect, 'function', `${definition.name} missing classifySideEffect`);
    assert.equal(typeof definition.getPermissionDetail, 'function', `${definition.name} missing getPermissionDetail`);
    assert.equal(typeof definition.mapToolResultToProtocolResult, 'function', `${definition.name} missing mapToolResultToProtocolResult`);
    assert.equal(typeof definition.extractSearchText, 'function', `${definition.name} missing extractSearchText`);
    assert.equal(typeof definition.isConcurrencySafe, 'function', `${definition.name} missing isConcurrencySafe`);
  }
});

test('native tool language exposes Claude-like aliases and permission detail', () => {
  const read = getAgentToolDefinition('read_file');
  const grep = getAgentToolDefinition('search_project_content');
  const bash = getAgentToolDefinition('run_command');
  const patch = getAgentToolDefinition('patch_file');
  assert.ok(read);
  assert.ok(grep);
  assert.ok(bash);
  assert.ok(patch);

  assert.equal(read.toolLanguage?.canonicalName, 'Read');
  assert.ok(read.aliases?.includes('Read'));
  assert.equal(grep.toolLanguage?.canonicalName, 'Grep');
  assert.ok(bash.aliases?.includes('Bash'));
  assert.ok(patch.aliases?.includes('ApplyPatch'));

  const definitions = listNativeWorkspaceToolDefinitions({
    project: fakeProject,
    includeWriteTools: true,
    includeMcpToolCalls: true,
    includeCommandTools: true
  } as any);
  assert.equal(resolveNativeRuntimeToolName('Read', definitions), 'read_file');
  assert.equal(resolveNativeRuntimeToolName('grep', definitions), 'search_project_content');
  assert.equal(resolveNativeRuntimeToolName('Bash', definitions), 'run_command');
  assert.equal(resolveNativeRuntimeToolName('apply-patch', definitions), 'patch_file');

  const detail = bash.getPermissionDetail?.({
    command: 'sudo rm -rf build',
    cwd: '.'
  }, {
    project: fakeProject,
    toolName: 'run_command',
    readOnly: false,
    risk: 'high',
    permissionPolicy: 'ask'
  });
  assert.match(detail ?? '', /工具：Run command/);
  assert.match(detail ?? '', /recursive_force_delete/);
});

test('native command contract classifies safety and compresses command output', () => {
  const definition = getAgentToolDefinition('run_command');
  assert.ok(definition);

  assert.equal(definition.isConcurrencySafe?.({ command: 'git status' }), true);
  assert.equal(definition.isConcurrencySafe?.({ command: 'npm install' }), false);

  const highRisk = definition.toAutoClassifierInput?.({
    command: 'sudo rm -rf build',
    cwd: '.'
  }) as {
    safety?: {
      risk?: string;
      reasons?: string[];
    };
    workspaceMutation?: {
      mutatesWorkspace?: boolean;
      reasons?: string[];
    };
  };
  assert.equal(highRisk.safety?.risk, 'high');
  assert.ok(highRisk.safety?.reasons?.includes('recursive_force_delete'));
  assert.equal(highRisk.workspaceMutation?.mutatesWorkspace, true);
  assert.ok(highRisk.workspaceMutation?.reasons?.includes('filesystem_command'));

  const protocol = definition.mapToolResultToProtocolResult?.({
    ok: true,
    summary: 'large command result',
    command: {
      command: 'npm test',
      cwd: '.',
      exitCode: 0,
      stdout: 'a'.repeat(12_000),
      stderr: 'b'.repeat(6_000),
      outputTruncated: true
    }
  }, {
    project: fakeProject,
    toolName: 'run_command',
    readOnly: false,
    input: {
      command: 'npm test'
    }
  });

  assert.ok(protocol);
  assert.match(protocol.content, /Command: npm test/);
  assert.match(protocol.content, /truncated by Funplay/);
  assert.ok(protocol.content.length <= 8_000);
});

test('native tool contracts classify side effects for verification gates', () => {
  const writeFile = getAgentToolDefinition('write_file');
  const runCommand = getAgentToolDefinition('run_command');
  const terminalStart = getAgentToolDefinition('terminal_start');
  const terminalWrite = getAgentToolDefinition('terminal_write');
  const openEngineProject = getAgentToolDefinition('open_engine_project');
  assert.ok(writeFile);
  assert.ok(runCommand);
  assert.ok(terminalStart);
  assert.ok(terminalWrite);
  assert.ok(openEngineProject);

  assert.deepEqual(writeFile.classifySideEffect?.({
    path: 'src/app.ts'
  }), {
    kind: 'workspace_write',
    confidence: 'high',
    verificationTrigger: 'active_write',
    evidence: ['tool:write_file', 'target:src/app.ts']
  });

  assert.equal(runCommand.classifySideEffect?.({
    command: 'npm test'
  })?.kind, 'none');

  const commandWrite = runCommand.classifySideEffect?.({
    command: "node -e \"require('fs').writeFileSync('src/out.txt', 'ok')\""
  });
  assert.equal(commandWrite?.kind, 'workspace_write');
  assert.equal(commandWrite?.verificationTrigger, 'active_write');
  assert.ok(commandWrite?.evidence.includes('command:node_file_write'));

  const terminalStartWrite = terminalStart.classifySideEffect?.({
    command: "printf ok > src/out.txt"
  });
  assert.equal(terminalStartWrite?.kind, 'workspace_write');
  assert.equal(terminalStartWrite?.verificationTrigger, 'active_write');
  assert.ok(terminalStartWrite?.evidence.includes('command:stdout_redirection'));

  const terminalStdinWrite = terminalWrite.classifySideEffect?.({
    sessionId: 'term_123',
    input: "python -c \"open('src/out.txt', 'w').write('ok')\""
  });
  assert.equal(terminalStdinWrite?.kind, 'workspace_write');
  assert.equal(terminalStdinWrite?.verificationTrigger, 'active_write');
  assert.ok(terminalStdinWrite?.evidence.includes('command:python_file_write'));

  const terminalDevServer = terminalStart.classifySideEffect?.({
    command: 'npm run dev'
  });
  assert.equal(terminalDevServer?.kind, 'external');
  assert.equal(terminalDevServer?.verificationTrigger, undefined);

  assert.equal(openEngineProject.classifySideEffect?.({
    platform: 'unity',
    projectPath: '/tmp/game'
  })?.verificationTrigger, 'active_engine');
});

test('native edit and mcp contracts expose focused classifier inputs', () => {
  const patch = getAgentToolDefinition('patch_file');
  const mcp = getAgentToolDefinition('call_mcp_tool');
  assert.ok(patch);
  assert.ok(mcp);

  const patchInput = patch.toAutoClassifierInput?.({
    path: 'src/App.tsx',
    patch: [
      '@@ -1,2 +1,3 @@',
      '-old',
      '+new',
      '+another'
    ].join('\n')
  }) as {
    patch?: {
      hunkCount?: number;
      addedLines?: number;
      removedLines?: number;
    };
  };

  assert.equal(patchInput.patch?.hunkCount, 1);
  assert.equal(patchInput.patch?.addedLines, 2);
  assert.equal(patchInput.patch?.removedLines, 1);

  assert.equal(mcp.isConcurrencySafe?.({ toolName: 'get_hierarchy' }), true);
  assert.equal(mcp.isConcurrencySafe?.({ toolName: 'simulate_key_press' }), false);

  const mcpInput = mcp.toAutoClassifierInput?.({
    pluginKind: 'engine',
    toolName: 'execute_code',
    args: {
      code: 'Debug.Log("hello");'
    }
  }) as {
    inferredReadOnly?: boolean;
    argsSize?: number;
  };

  assert.equal(mcpInput.inferredReadOnly, false);
  assert.ok((mcpInput.argsSize ?? 0) > 0);
});
