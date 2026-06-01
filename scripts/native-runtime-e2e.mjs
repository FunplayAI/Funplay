import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectFromInput } from '../shared/planner.ts';
import { ensureProjectSessions, getActiveProjectSession } from '../shared/project-sessions.ts';
import { buildGenericWorkspaceContext } from '../electron/main/agent-platform/context.ts';
import { nativeRuntime } from '../electron/main/agent-platform/native/runtime.ts';
import { disposePersistentTerminals } from '../electron/main/agent-platform/persistent-terminal-store.ts';

function sse(...items) {
  return items.map((item) => `data: ${item === '[DONE]' ? item : JSON.stringify(item)}\n\n`).join('');
}

function streamResponse(...items) {
  return new Response(sse(...items, '[DONE]'), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream'
    }
  });
}

function buildProject(projectPath) {
  return ensureProjectSessions(createProjectFromInput({
    name: 'Native Runtime E2E',
    templateId: 'generic-workspace',
    artStyle: 'test',
    pitch: 'native runtime e2e',
    engine: {
      platform: 'web',
      setupMode: 'import',
      projectPath,
      dimension: 'unknown'
    }
  }));
}

function buildProvider() {
  const timestamp = new Date().toISOString();
  return {
    id: 'provider_native_e2e',
    name: 'Native E2E Mock',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    baseUrl: 'https://native-e2e.example/v1',
    apiKey: 'test-key',
    hasStoredApiKey: true,
    model: 'native-e2e-mock',
    enabled: true,
    isDefault: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function runRuntime(params, observers = {}) {
  for await (const event of nativeRuntime.executeEventStream(params)) {
    if (event.type === 'stage') {
      observers.onStage?.(event.stage);
    } else if (event.type === 'tool_result') {
      observers.onToolResult?.(event.result);
    }
    if (event.type === 'result') {
      return event.result;
    }
  }
  throw new Error('nativeRuntime completed without a result event.');
}

async function withMockFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function waitForPath(path, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function extractTerminalSessionIdFromRequestBody(body) {
  const match = String(body ?? '').match(/term_[a-z0-9]+/i);
  assert.ok(match, 'Expected previous terminal_start result to include a terminal session id.');
  return match[0];
}

function extractModelTextFromRequestBody(body) {
  try {
    const parsed = JSON.parse(String(body ?? '{}'));
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return messages.map((message) => {
      if (typeof message.content === 'string') {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        return message.content.map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
          return '';
        }).join('\n');
      }
      return '';
    }).join('\n\n');
  } catch {
    return String(body ?? '');
  }
}

function extractToolMessageTextFromRequestBody(body) {
  try {
    const parsed = JSON.parse(String(body ?? '{}'));
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return messages
      .filter((message) => message.role === 'tool')
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .join('\n\n');
  } catch {
    return String(body ?? '');
  }
}

async function runWriteVerify(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  const result = await withMockFetch(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_write_output',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/agent-output.json',
                  content: `${JSON.stringify({
                    ready: true,
                    marker: 'FUNPLAY_NATIVE_E2E_OK'
                  }, null, 2)}\n`,
                  reason: 'native runtime e2e write'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    return streamResponse({
      id: 'chatcmpl_native_e2e_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'Created src/agent-output.json.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Create src/agent-output.json with marker FUNPLAY_NATIVE_E2E_OK.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Create src/agent-output.json with marker FUNPLAY_NATIVE_E2E_OK.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  assert.equal(result.status, 'completed');
  assert.equal(JSON.parse(await readFile(join(projectPath, 'src/agent-output.json'), 'utf8')).marker, 'FUNPLAY_NATIVE_E2E_OK');
  assert.equal(requestCount >= 2, true);
  assert.match(result.steps.map((step) => step.title).join('\n'), /执行主动验证/);
}

async function runQualityScriptVerify(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  const stages = [];
  const toolResults = [];
  const result = await withMockFetch(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_quality_script',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_quality_script_write',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/quality-output.json',
                  content: `${JSON.stringify({
                    ready: true,
                    marker: 'FUNPLAY_NATIVE_QUALITY_OK'
                  }, null, 2)}\n`,
                  reason: 'native runtime e2e quality script write'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    return streamResponse({
      id: 'chatcmpl_native_e2e_quality_script_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'Created src/quality-output.json.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Create src/quality-output.json with marker FUNPLAY_NATIVE_QUALITY_OK.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Create src/quality-output.json with marker FUNPLAY_NATIVE_QUALITY_OK.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }, {
    onStage: (stage) => stages.push(stage),
    onToolResult: (toolResult) => toolResults.push(toolResult)
  }));

  assert.equal(result.status, 'completed');
  assert.equal(JSON.parse(await readFile(join(projectPath, 'src/quality-output.json'), 'utf8')).marker, 'FUNPLAY_NATIVE_QUALITY_OK');
  assert.equal(requestCount >= 2, true);
  const stageText = JSON.stringify(stages);
  const toolResultText = JSON.stringify(toolResults);
  const operationLogText = JSON.stringify(result.operationLog ?? []);
  assert.match(stageText, /active_verify_quality/);
  assert.match(stageText, /npm run check/);
  assert.match(toolResultText, /native-quality-script acceptance passed/);
  assert.doesNotMatch(stageText, /git diff --check/);
  assert.match(operationLogText, /native_active_verification/);
  assert.match(operationLogText, /npm run check/);
  assert.match(operationLogText, /native-quality-script acceptance passed/);
  assert.doesNotMatch(operationLogText, /git diff --check/);
  assert.match(result.steps.map((step) => step.title).join('\n'), /执行主动验证/);
}

async function runCommandWriteVerify(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  const result = await withMockFetch(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_command_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_command_write_output',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({
                  command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/agent-output.json', JSON.stringify({ready:true, marker:'FUNPLAY_NATIVE_COMMAND_OK'}, null, 2)+'\\n')\"",
                  timeoutMs: 5000,
                  reason: 'write project output through shell command'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    return streamResponse({
      id: 'chatcmpl_native_e2e_command_write_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'Created src/agent-output.json using a shell command.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Use a shell command to create src/agent-output.json with marker FUNPLAY_NATIVE_COMMAND_OK.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Use a shell command to create src/agent-output.json with marker FUNPLAY_NATIVE_COMMAND_OK.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  assert.equal(result.status, 'completed');
  assert.equal(JSON.parse(await readFile(join(projectPath, 'src/agent-output.json'), 'utf8')).marker, 'FUNPLAY_NATIVE_COMMAND_OK');
  assert.equal(requestCount >= 2, true);
  assert.match(result.steps.map((step) => step.title).join('\n'), /执行主动验证/);
}

async function runTerminalStartWriteVerify(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  const result = await withMockFetch(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_terminal_start_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_terminal_start_write_output',
              type: 'function',
              function: {
                name: 'terminal_start',
                arguments: JSON.stringify({
                  name: 'terminal write verify',
                  command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/agent-output.json', JSON.stringify({ready:true, marker:'FUNPLAY_NATIVE_TERMINAL_OK'}, null, 2)+'\\n')\"",
                  cwd: '.',
                  reason: 'write project output through persistent terminal'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    return streamResponse({
      id: 'chatcmpl_native_e2e_terminal_start_write_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'Created src/agent-output.json using a persistent terminal.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Use a persistent terminal to create src/agent-output.json with marker FUNPLAY_NATIVE_TERMINAL_OK.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Use a persistent terminal to create src/agent-output.json with marker FUNPLAY_NATIVE_TERMINAL_OK.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  try {
    assert.equal(result.status, 'completed');
    assert.equal(JSON.parse(await readFile(join(projectPath, 'src/agent-output.json'), 'utf8')).marker, 'FUNPLAY_NATIVE_TERMINAL_OK');
    assert.equal(requestCount >= 2, true);
    assert.match(result.steps.map((step) => step.title).join('\n'), /执行主动验证/);
  } finally {
    disposePersistentTerminals();
  }
}

async function runTerminalWriteVerify(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  const result = await withMockFetch(async (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_terminal_write_start',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_terminal_write_start',
              type: 'function',
              function: {
                name: 'terminal_start',
                arguments: JSON.stringify({
                  name: 'terminal write verify shell',
                  cwd: '.',
                  reason: 'start a persistent shell before writing project output'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    if (requestCount === 2) {
      const sessionId = extractTerminalSessionIdFromRequestBody(init?.body);
      return streamResponse({
        id: 'chatcmpl_native_e2e_terminal_write_input',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_terminal_write_output',
              type: 'function',
              function: {
                name: 'terminal_write',
                arguments: JSON.stringify({
                  sessionId,
                  input: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/agent-output.json', JSON.stringify({ready:true, marker:'FUNPLAY_NATIVE_TERMINAL_WRITE_OK'}, null, 2)+'\\n')\"",
                  appendNewline: true,
                  reason: 'write project output through terminal stdin'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    await waitForPath(join(projectPath, 'src/agent-output.json'));
    return streamResponse({
      id: 'chatcmpl_native_e2e_terminal_write_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'Created src/agent-output.json by writing into a persistent terminal.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Use terminal_write to create src/agent-output.json with marker FUNPLAY_NATIVE_TERMINAL_WRITE_OK.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Use terminal_write to create src/agent-output.json with marker FUNPLAY_NATIVE_TERMINAL_WRITE_OK.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  try {
    assert.equal(result.status, 'completed');
    assert.equal(JSON.parse(await readFile(join(projectPath, 'src/agent-output.json'), 'utf8')).marker, 'FUNPLAY_NATIVE_TERMINAL_WRITE_OK');
    assert.equal(requestCount >= 3, true);
    assert.match(result.steps.map((step) => step.title).join('\n'), /执行主动验证/);
  } finally {
    disposePersistentTerminals();
  }
}

async function runInvalidWriteNoVerify(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  const result = await withMockFetch(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_invalid_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_invalid_empty_multi_edit',
              type: 'function',
              function: {
                name: 'multi_edit',
                arguments: JSON.stringify({
                  path: 'alpha.js',
                  edits: [],
                  reason: 'invalid write request that must not execute'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    return streamResponse({
      id: 'chatcmpl_native_e2e_invalid_write_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'The invalid multi_edit was rejected before changing files.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Try to update alpha.js with an invalid empty multi_edit.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Try to update alpha.js with an invalid empty multi_edit.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  assert.equal(result.status, 'completed');
  assert.equal(requestCount, 2);
  assert.equal(await readFile(join(projectPath, 'alpha.js'), 'utf8'), 'const value = "current";\n');
  assert.doesNotMatch(result.steps.map((step) => step.title).join('\n'), /执行主动验证/);
  assert.doesNotMatch(JSON.stringify(result.operationLog ?? []), /native_active_verification/);
}

async function runEditRecovery(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  let failedEditToolText = '';
  let readResultToolText = '';
  const result = await withMockFetch(async (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_bad_edit',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_bad_edit',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  path: 'src/service.js',
                  oldText: "export const marker = 'missing-before-recovery';\n",
                  newText: "export const marker = 'after-recovery';\n",
                  reason: 'intentionally stale edit to prove recovery'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    if (requestCount === 2) {
      failedEditToolText = extractToolMessageTextFromRequestBody(init?.body);
      return streamResponse({
        id: 'chatcmpl_native_e2e_recovery_read',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_recovery_read',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({
                  path: 'src/service.js'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    if (requestCount === 3) {
      readResultToolText = extractToolMessageTextFromRequestBody(init?.body);
      return streamResponse({
        id: 'chatcmpl_native_e2e_recovery_edit',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_recovery_edit',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  path: 'src/service.js',
                  oldText: "export const marker = 'before-recovery';\n",
                  newText: "export const marker = 'after-recovery';\n",
                  reason: 'recover after reading the current file content'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    return streamResponse({
      id: 'chatcmpl_native_e2e_recovery_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'Recovered from the failed edit and updated src/service.js.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Update src/service.js marker to after-recovery. If the first edit fails, recover by reading the file and applying the correct edit.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Update src/service.js marker to after-recovery. If the first edit fails, recover by reading the file and applying the correct edit.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  assert.equal(result.status, 'completed');
  assert.equal(await readFile(join(projectPath, 'src/service.js'), 'utf8'), "export const marker = 'after-recovery';\n");
  assert.equal(requestCount >= 4, true);
  assert.match(failedEditToolText, /src\/service\.js/);
  assert.match(failedEditToolText, /Failure kind: missing_match/);
  assert.match(failedEditToolText, /Recovery hint: 读取目标片段后使用更精确 oldText/);
  assert.match(readResultToolText, /before-recovery/);
  assert.match(result.steps.map((step) => step.title).join('\n'), /执行主动验证/);
}

async function runRepairVerify(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  let repairRequestBody = '';
  const result = await withMockFetch(async (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_initial_bad_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_write_bad_output',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/agent-output.json',
                  content: `${JSON.stringify({
                    ready: true,
                    marker: 'BROKEN_MARKER'
                  }, null, 2)}\n`,
                  reason: 'native runtime e2e intentionally failing write'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    if (requestCount === 2) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_initial_final',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            role: 'assistant',
            content: 'Created src/agent-output.json.'
          },
          finish_reason: 'stop'
        }]
      });
    }
    if (requestCount === 3) {
      repairRequestBody = String(init?.body ?? '');
      return streamResponse({
        id: 'chatcmpl_native_e2e_repair_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_repair_output',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/agent-output.json',
                  content: `${JSON.stringify({
                    ready: true,
                    marker: 'FUNPLAY_NATIVE_REPAIR_OK'
                  }, null, 2)}\n`,
                  reason: 'repair active verification failure'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    return streamResponse({
      id: 'chatcmpl_native_e2e_repair_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'Repaired src/agent-output.json so the acceptance check passes.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Create src/agent-output.json with marker FUNPLAY_NATIVE_REPAIR_OK.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Create src/agent-output.json with marker FUNPLAY_NATIVE_REPAIR_OK.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  assert.equal(result.status, 'completed');
  assert.equal(JSON.parse(await readFile(join(projectPath, 'src/agent-output.json'), 'utf8')).marker, 'FUNPLAY_NATIVE_REPAIR_OK');
  assert.equal(requestCount >= 4, true);
  assert.match(repairRequestBody, /Failure diagnosis/);
  assert.match(repairRequestBody, /Changes to inspect/);
  assert.match(repairRequestBody, /Verification checks from failed run/);
  assert.match(repairRequestBody, /Command: npm test/);
  assert.match(repairRequestBody, /Relevant files from failed verification/);
  assert.match(repairRequestBody, /BROKEN_MARKER/);
}

async function runCheckpointRollbackRecovery(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  const checkpointSnapshotId = 'snapshot_native_e2e_checkpoint_rollback';
  let requestCount = 0;
  let repairRequestText = '';
  const result = await withMockFetch(async (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_checkpoint_bad_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_checkpoint_bad_write',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/state.json',
                  content: `${JSON.stringify({
                    ready: true,
                    marker: 'BROKEN_ROLLBACK'
                  }, null, 2)}\n`,
                  reason: 'intentionally write a bad state to prove checkpoint rollback'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    if (requestCount === 2) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_checkpoint_initial_final',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            role: 'assistant',
            content: 'Updated src/state.json.'
          },
          finish_reason: 'stop'
        }]
      });
    }
    if (requestCount === 3) {
      repairRequestText = extractModelTextFromRequestBody(init?.body);
      return streamResponse({
        id: 'chatcmpl_native_e2e_checkpoint_rollback',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_checkpoint_rollback',
              type: 'function',
              function: {
                name: 'checkpoint_rollback',
                arguments: JSON.stringify({
                  reason: 'rollback failed verification to the recorded safe baseline'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    return streamResponse({
      id: 'chatcmpl_native_e2e_checkpoint_rollback_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'Rolled back the failed change to the checkpointed safe baseline.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Update src/state.json. If verification shows the change is wrong, roll back to the checkpointed safe baseline.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Update src/state.json. If verification shows the change is wrong, roll back to the checkpointed safe baseline.'),
    checkpointSnapshotId,
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  const restored = JSON.parse(await readFile(join(projectPath, 'src/state.json'), 'utf8'));
  assert.equal(result.status, 'completed');
  assert.equal(restored.marker, 'SAFE_BASELINE');
  assert.equal(requestCount >= 4, true);
  assert.match(repairRequestText, /Failure diagnosis/);
  assert.match(repairRequestText, /Changes to inspect/);
  assert.match(repairRequestText, /BROKEN_ROLLBACK/);
  assert.match(repairRequestText, /checkpoint_rollback/);
  assert.match(JSON.stringify(result.operationLog ?? []), /checkpoint_rollback/);
  assert.match(JSON.stringify(result.operationLog ?? []), /Restored files: src\/state\.json/);
  assert.match(result.steps.map((step) => step.title).join('\n'), /主动验证修复通过/);
}

async function runRepairFailHandoff(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  let repairRequestBody = '';
  const result = await withMockFetch(async (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_handoff_initial_bad_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_write_still_bad_output',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/agent-output.json',
                  content: `${JSON.stringify({
                    ready: true,
                    marker: 'BROKEN_MARKER'
                  }, null, 2)}\n`,
                  reason: 'native runtime e2e intentionally failing write'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    if (requestCount === 2) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_handoff_initial_final',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            role: 'assistant',
            content: 'Created src/agent-output.json.'
          },
          finish_reason: 'stop'
        }]
      });
    }
    if (requestCount === 3) {
      repairRequestBody = String(init?.body ?? '');
      return streamResponse({
        id: 'chatcmpl_native_e2e_handoff_repair_final',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            role: 'assistant',
            content: 'I inspected the failure but cannot safely repair it in one pass.'
          },
          finish_reason: 'stop'
        }]
      });
    }
    throw new Error(`Unexpected repair-fail-handoff request ${requestCount}.`);
  }, () => runRuntime({
    project,
    message: 'Create src/agent-output.json with marker FUNPLAY_NATIVE_REPAIR_OK.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Create src/agent-output.json with marker FUNPLAY_NATIVE_REPAIR_OK.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  assert.equal(result.status, 'failed');
  assert.match(result.assistantMessage, /自动验证未通过/);
  assert.match(result.assistantMessage, /已执行一次受控修复/);
  assert.match(result.assistantMessage, /变更摘要/);
  assert.match(repairRequestBody, /Failure diagnosis/);
  assert.match(repairRequestBody, /Changes to inspect/);
  assert.match(repairRequestBody, /Verification checks from failed run/);
  assert.match(repairRequestBody, /Command: npm test/);
  assert.match(repairRequestBody, /BROKEN_MARKER/);
  assert.equal(requestCount >= 3, true);
}

async function runRepairReplan(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  let repairRequestBody = '';
  const result = await withMockFetch(async (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_replan_initial_bad_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_write_bad_app',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/app.mjs',
                  content: "export const marker = 'BROKEN_APP';\n",
                  reason: 'native runtime e2e intentionally failing app write'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    if (requestCount === 2) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_replan_initial_final',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            role: 'assistant',
            content: 'Created src/app.mjs.'
          },
          finish_reason: 'stop'
        }]
      });
    }
    if (requestCount === 3) {
      repairRequestBody = String(init?.body ?? '');
      return streamResponse({
        id: 'chatcmpl_native_e2e_replan_repair_app',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_repair_app',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/app.mjs',
                  content: "export const marker = 'APP_OK';\n",
                  reason: 'repair app verification failure'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    if (requestCount === 4) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_replan_write_extra',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_write_broken_extra',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/extra.mjs',
                  content: "export const extra = 'BROKEN_EXTRA';\n",
                  reason: 'introduce a second repaired file that must be verified'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    if (requestCount === 5) {
      return streamResponse({
        id: 'chatcmpl_native_e2e_replan_repair_final',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            role: 'assistant',
            content: 'Repaired app.mjs and added extra.mjs.'
          },
          finish_reason: 'stop'
        }]
      });
    }
    throw new Error(`Unexpected repair-replan request ${requestCount}.`);
  }, () => runRuntime({
    project,
    message: 'Create src/app.mjs with marker APP_OK.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Create src/app.mjs with marker APP_OK.'),
    permission: {
      mode: 'full-access',
      allowWriteTools: true,
      allowSessionWriteTools: true,
      allowedWriteTools: ['*']
    }
  }));

  assert.equal(result.status, 'failed');
  assert.match(result.assistantMessage, /自动验证未通过/);
  assert.match(result.assistantMessage, /npm test -- src\/app\.test\.mjs src\/extra\.test\.mjs/);
  assert.match(repairRequestBody, /Failure diagnosis/);
  assert.match(repairRequestBody, /Verification checks from failed run/);
  assert.match(repairRequestBody, /Command: npm test -- src\/app\.test\.mjs/);
  assert.match(repairRequestBody, /BROKEN_APP/);
  const operationLogText = JSON.stringify(result.operationLog ?? []);
  assert.match(operationLogText, /BROKEN_EXTRA/);
  assert.equal(requestCount >= 5, true);
}

async function runReadonlyDeny(projectPath) {
  const project = buildProject(projectPath);
  const activeSession = getActiveProjectSession(project);
  let requestCount = 0;
  let firstRequestBody = '';
  let secondRequestBody = '';
  const result = await withMockFetch(async (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      firstRequestBody = String(init?.body ?? '');
      return streamResponse({
        id: 'chatcmpl_native_e2e_readonly_rogue_write',
        model: 'native-e2e-mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_readonly_rogue_write',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'blocked.txt',
                  content: 'blocked\n',
                  reason: 'rogue provider write despite read-only mode'
                })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      });
    }
    secondRequestBody = String(init?.body ?? '');
    return streamResponse({
      id: 'chatcmpl_native_e2e_readonly_final',
      model: 'native-e2e-mock',
      choices: [{
        delta: {
          role: 'assistant',
          content: 'The rogue write_file call was rejected by read-only mode.'
        },
        finish_reason: 'stop'
      }]
    });
  }, () => runRuntime({
    project,
    message: 'Create blocked.txt with content blocked.',
    provider: buildProvider(),
    plugins: [],
    context: buildGenericWorkspaceContext(project, [], activeSession.id, 'Create blocked.txt with content blocked.'),
    permission: {
      mode: 'read-only',
      allowWriteTools: false,
      allowSessionWriteTools: false
    }
  }));

  assert.equal(result.status, 'completed');
  assert.equal(existsSync(join(projectPath, 'blocked.txt')), false);
  assert.equal(requestCount >= 2, true);
  assert.doesNotMatch(firstRequestBody, /"name"\s*:\s*"write_file"/);
  assert.match(secondRequestBody, /write_file/);
  assert.match(secondRequestBody, /未知工具|unknown tool|not available|not exposed|未开放|未获得执行权限/i);
  const operationLogText = JSON.stringify(result.operationLog ?? []);
  assert.match(operationLogText, /write_file/);
  assert.match(operationLogText, /failed|失败|未知工具|未开放|未获得执行权限/i);
  assert.doesNotMatch(operationLogText, /native_active_verification/);
}

const scenario = process.argv[2];
const projectPath = process.argv[3] ?? process.env.FUNPLAY_WORKSPACE_ROOT ?? process.cwd();

if (scenario === 'write-verify') {
  await runWriteVerify(projectPath);
} else if (scenario === 'quality-script-verify') {
  await runQualityScriptVerify(projectPath);
} else if (scenario === 'command-write-verify') {
  await runCommandWriteVerify(projectPath);
} else if (scenario === 'terminal-start-write-verify') {
  await runTerminalStartWriteVerify(projectPath);
} else if (scenario === 'terminal-write-verify') {
  await runTerminalWriteVerify(projectPath);
} else if (scenario === 'invalid-write-no-verify') {
  await runInvalidWriteNoVerify(projectPath);
} else if (scenario === 'edit-recovery') {
  await runEditRecovery(projectPath);
} else if (scenario === 'repair-fail-handoff') {
  await runRepairFailHandoff(projectPath);
} else if (scenario === 'checkpoint-rollback-recovery') {
  await runCheckpointRollbackRecovery(projectPath);
} else if (scenario === 'repair-replan') {
  await runRepairReplan(projectPath);
} else if (scenario === 'repair-verify') {
  await runRepairVerify(projectPath);
} else if (scenario === 'readonly-deny') {
  await runReadonlyDeny(projectPath);
} else {
  throw new Error(`Unknown native runtime e2e scenario: ${scenario}`);
}

console.log(`native-runtime-e2e ${scenario} passed`);
