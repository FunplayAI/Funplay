import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateOpenAiCompatibleStreamingToolStep,
  generateOpenAiCompatibleText
} from '../../electron/main/openai-compatible-client.ts';
import type { AiProvider } from '../../shared/types.ts';

function buildProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'provider_test',
    name: 'Test Provider',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    hasStoredApiKey: true,
    model: 'gpt-test',
    enabled: true,
    isDefault: true,
    notes: '',
    createdAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:00:00.000Z',
    ...overrides
  };
}

async function withMockFetch<T>(
  handler: (url: string, init: RequestInit) => unknown,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    return new Response(JSON.stringify(handler(String(url), init ?? {})), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createFetchResetError(): Error {
  const error = new TypeError('fetch failed') as Error & { cause?: unknown };
  error.cause = {
    code: 'ECONNRESET',
    message: 'Client network socket disconnected before secure TLS connection was established'
  };
  return error;
}

function streamChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

function idleStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      return undefined;
    }
  });
}

test('openai-compatible chat adapter streams chat completions text requests', async () => {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};

  const result = await withMockFetch(
    (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'chatcmpl_test',
        model: 'gpt-test',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'chat ok'
            }
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12
        }
      };
    },
    () =>
      generateOpenAiCompatibleText({
        provider: buildProvider({ apiMode: 'chat' }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      })
  );

  assert.equal(capturedUrl, 'https://example.test/v1/chat/completions');
  assert.equal(capturedBody.model, 'gpt-test');
  assert.equal(capturedBody.stream, true);
  assert.equal(capturedBody.max_tokens, 64);
  assert.deepEqual(capturedBody.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'user prompt' }
  ]);
  assert.equal(result.text, 'chat ok');
});

test('openai-compatible provider request timeout is provider configurable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      generateOpenAiCompatibleText({
        provider: buildProvider({ apiMode: 'chat', requestTimeoutMs: 20 }),
        system: 'system prompt',
        prompt: 'user prompt'
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'PROVIDER_REQUEST_TIMEOUT');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible SSE chunk timeout aborts stalled streams', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(idleStream(), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream'
    }
  })) as typeof fetch;

  try {
    await assert.rejects(
      generateOpenAiCompatibleText({
        provider: buildProvider({ apiMode: 'chat', requestTimeoutMs: false, chunkTimeoutMs: 20 }),
        system: 'system prompt',
        prompt: 'user prompt'
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'PROVIDER_CHUNK_TIMEOUT');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible chat text generation streams when delta handler is provided', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};
  const deltas: Array<{ delta: string; accumulated: string }> = [];
  const reasoningDeltas: Array<{ delta: string; accumulated: string }> = [];
  globalThis.fetch = (async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response([
      'data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{"reasoning_content":"想"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{"content":"你"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream'
      }
    });
  }) as typeof fetch;

  try {
    const result = await generateOpenAiCompatibleText({
      provider: buildProvider({ apiMode: 'chat' }),
      system: 'system prompt',
      prompt: 'user prompt',
      maxOutputTokens: 64,
      onDelta: (delta, accumulated) => {
        deltas.push({ delta, accumulated });
      },
      onReasoningDelta: (delta, accumulated) => {
        reasoningDeltas.push({ delta, accumulated });
      }
    });

    assert.equal(capturedBody.stream, true);
    assert.equal(result.text, '你好');
    assert.deepEqual(deltas, [
      { delta: '你', accumulated: '你' },
      { delta: '好', accumulated: '你好' }
    ]);
    assert.deepEqual(reasoningDeltas, [
      { delta: '想', accumulated: '想' }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible chat text generation retries transient fetch resets', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      throw createFetchResetError();
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl_retry',
      model: 'gpt-test',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'retry ok'
          }
        }
      ]
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }) as typeof fetch;

  try {
    const result = await generateOpenAiCompatibleText({
      provider: buildProvider({ apiMode: 'chat' }),
      system: 'system prompt',
      prompt: 'user prompt',
      maxOutputTokens: 64
    });

    assert.equal(calls, 2);
    assert.equal(result.text, 'retry ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible chat adapter uses max_completion_tokens for Xiaomi MiMo models', async () => {
  let capturedBody: Record<string, unknown> = {};

  await withMockFetch(
    (_url, init) => {
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'chatcmpl_mimo',
        model: 'mimo-v2.5-pro',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'mimo ok'
            }
          }
        ]
      };
    },
    () =>
      generateOpenAiCompatibleText({
        provider: buildProvider({
          name: 'Xiaomi MiMo',
          apiMode: 'chat',
          baseUrl: 'https://api.xiaomimimo.com/v1',
          model: 'mimo-v2.5-pro'
        }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      })
  );

  assert.equal(capturedBody.max_completion_tokens, 64);
  assert.equal('max_tokens' in capturedBody, false);
});

test('openai-compatible chat adapter uses Xiaomi MiMo provider token profile for deployment aliases', async () => {
  let capturedBody: Record<string, unknown> = {};

  await withMockFetch(
    (_url, init) => {
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'chatcmpl_mimo_alias',
        model: 'deployment-alias',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'mimo alias ok'
            }
          }
        ]
      };
    },
    () =>
      generateOpenAiCompatibleText({
        provider: buildProvider({
          name: 'Xiaomi MiMo',
          apiMode: 'chat',
          baseUrl: 'https://api.xiaomimimo.com/v1',
          model: 'deployment-alias'
        }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      })
  );

  assert.equal(capturedBody.max_completion_tokens, 64);
  assert.equal('max_tokens' in capturedBody, false);
});

test('openai-compatible chat adapter normalizes Xiaomi MiMo tool schemas and keeps empty parameter lists', async () => {
  let capturedBody: Record<string, unknown> = {};

  await withMockFetch(
    (_url, init) => {
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'chatcmpl_mimo_tools',
        model: 'mimo-v2.5-pro',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'mimo tools ok'
            }
          }
        ]
      };
    },
    () =>
      generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({
          name: 'Xiaomi MiMo',
          apiMode: 'chat',
          baseUrl: 'https://api.xiaomimimo.com/v1',
          model: 'mimo-v2.5-pro'
        }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'scan project'
          }
        ],
        tools: [
          {
            name: 'scan_file_tree',
            description: 'Scan project tree.',
            parameters: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'subagent_status',
            description: 'Read subagent status.',
            parameters: {
              type: 'object',
              properties: {
                options: {
                  type: 'object',
                  properties: {
                    includeCompleted: {
                      type: 'boolean'
                    }
                  }
                }
              }
            }
          }
        ],
        maxOutputTokens: 64
      })
  );

  assert.equal(capturedBody.max_completion_tokens, 64);
  assert.equal('tool_choice' in capturedBody, false);
  const tools = capturedBody.tools as Array<{ function?: { parameters?: Record<string, unknown> } }>;
  assert.deepEqual(tools[0]?.function?.parameters, {
    type: 'object',
    properties: {},
    required: []
  });
  assert.deepEqual(tools[1]?.function?.parameters, {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          includeCompleted: {
            type: 'boolean'
          }
        },
        required: []
      }
    },
    required: []
  });
});

test('openai-compatible chat adapter applies Moonshot schema transforms for Kimi tools', async () => {
  let capturedBody: Record<string, unknown> = {};

  await withMockFetch(
    (_url, init) => {
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'chatcmpl_kimi_tools',
        model: 'kimi-k2.6',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'kimi schema ok'
            }
          }
        ]
      };
    },
    () =>
      generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({
          name: 'Kimi',
          apiMode: 'chat',
          baseUrl: 'https://api.moonshot.cn/v1',
          model: 'kimi-k2.6'
        }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'use schema'
          }
        ],
        tools: [
          {
            name: 'choose_asset',
            description: 'Choose an asset.',
            parameters: {
              type: 'object',
              properties: {
                asset: {
                  $ref: '#/$defs/Asset',
                  description: 'Asset reference'
                },
                tags: {
                  type: 'array',
                  items: [
                    { type: 'string' },
                    { type: 'number' }
                  ]
                }
              },
              required: ['asset', 'tags'],
              $defs: {
                Asset: {
                  type: 'string',
                  enum: ['image', 'audio']
                }
              }
            }
          }
        ],
        maxOutputTokens: 64
      })
  );

  const parameters = (capturedBody.tools as Array<{ function?: { parameters?: Record<string, unknown> } }>)[0]?.function?.parameters;
  assert.deepEqual((parameters?.properties as Record<string, unknown>).asset, {
    $ref: '#/$defs/Asset'
  });
  assert.deepEqual((parameters?.properties as Record<string, Record<string, unknown>>).tags.items, {
    type: 'string'
  });
});

test('openai-compatible aggregate endpoints infer Moonshot schema transforms from upstream model ids', async () => {
  let capturedBody: Record<string, unknown> = {};

  await withMockFetch(
    (_url, init) => {
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'chatcmpl_aggregate_kimi_tools',
        model: 'moonshotai/Kimi-K2-Instruct',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'aggregate kimi schema ok'
            }
          }
        ]
      };
    },
    () =>
      generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({
          name: 'SiliconFlow',
          apiMode: 'chat',
          baseUrl: 'https://api.siliconflow.cn/v1',
          model: 'moonshotai/Kimi-K2-Instruct'
        }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'use schema'
          }
        ],
        tools: [
          {
            name: 'choose_asset',
            description: 'Choose an asset.',
            parameters: {
              type: 'object',
              properties: {
                asset: {
                  $ref: '#/$defs/Asset',
                  description: 'Asset reference'
                }
              },
              required: ['asset'],
              $defs: {
                Asset: {
                  type: 'string'
                }
              }
            }
          }
        ],
        maxOutputTokens: 64
      })
  );

  const parameters = (capturedBody.tools as Array<{ function?: { parameters?: Record<string, unknown> } }>)[0]?.function?.parameters;
  assert.deepEqual((parameters?.properties as Record<string, unknown>).asset, {
    $ref: '#/$defs/Asset'
  });
});

test('openai-compatible chat adapter applies Gemini-style schema transforms for compatible endpoints', async () => {
  let capturedBody: Record<string, unknown> = {};

  await withMockFetch(
    (_url, init) => {
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'chatcmpl_gemini_tools',
        model: 'gemini-2.5-pro',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'gemini schema ok'
            }
          }
        ]
      };
    },
    () =>
      generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({
          name: 'Custom OpenAI-Compatible',
          apiMode: 'chat',
          baseUrl: 'https://example-gemini-compatible.test/v1',
          model: 'gemini-2.5-pro'
        }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'use schema'
          }
        ],
        tools: [
          {
            name: 'rank_asset',
            description: 'Rank an asset.',
            parameters: {
              type: 'object',
              properties: {
                score: {
                  type: 'integer',
                  enum: [1, 2],
                  properties: {
                    ignored: {
                      type: 'string'
                    }
                  },
                  required: ['ignored']
                },
                tags: {
                  type: 'array'
                },
                nested: {
                  type: 'object',
                  properties: {
                    ok: {
                      type: 'string'
                    }
                  },
                  required: ['ok', 'missing']
                }
              },
              required: ['score', 'missingTop']
            }
          }
        ],
        maxOutputTokens: 64
      })
  );

  const parameters = (capturedBody.tools as Array<{ function?: { parameters?: Record<string, unknown> } }>)[0]?.function?.parameters;
  const properties = parameters?.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.score, {
    type: 'string',
    enum: ['1', '2']
  });
  assert.deepEqual(properties.tags.items, {
    type: 'string'
  });
  assert.deepEqual(properties.nested.required, ['ok']);
  assert.deepEqual(parameters?.required, ['score']);
});

test('openai-compatible chat adapter adds domestic reasoning request switches from provider profile', async () => {
  const capturedBodies: Record<string, unknown>[] = [];

  await withMockFetch(
    (_url, init) => {
      capturedBodies.push(JSON.parse(String(init.body)));
      return {
        id: 'chatcmpl_reasoning_profile',
        model: capturedBodies.length === 1 ? 'qwen3-max' : 'glm-4.6',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'reasoning profile ok'
            }
          }
        ]
      };
    },
    async () => {
      await generateOpenAiCompatibleText({
        provider: buildProvider({
          name: 'Alibaba Qwen',
          apiMode: 'chat',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen3-max'
        }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      });
      await generateOpenAiCompatibleText({
        provider: buildProvider({
          name: 'Zhipu GLM',
          apiMode: 'chat',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          model: 'glm-4.6'
        }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      });
    }
  );

  assert.equal(capturedBodies[0].enable_thinking, true);
  assert.deepEqual(capturedBodies[1].thinking, {
    type: 'enabled',
    clear_thinking: false
  });
});

test('openai-compatible aggregate endpoints do not infer vendor-only thinking body switches', async () => {
  let capturedBody: Record<string, unknown> = {};

  await withMockFetch(
    (_url, init) => {
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'chatcmpl_openrouter_qwen',
        model: 'qwen/qwen3-max',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'openrouter qwen ok'
            }
          }
        ]
      };
    },
    () =>
      generateOpenAiCompatibleText({
        provider: buildProvider({
          name: 'OpenRouter',
          apiMode: 'chat',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'qwen/qwen3-max'
        }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      })
  );

  assert.equal('enable_thinking' in capturedBody, false);
  assert.equal('thinking' in capturedBody, false);
});

test('openai-compatible client rejects unsupported Responses mode for Xiaomi MiMo', async () => {
  await assert.rejects(
    generateOpenAiCompatibleText({
      provider: buildProvider({
        name: 'Xiaomi MiMo',
        apiMode: 'responses',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.5-pro'
      }),
      system: 'system prompt',
      prompt: 'user prompt',
      maxOutputTokens: 64
    }),
    /does not support the OpenAI-compatible Responses API/
  );
});

test('openai-compatible responses adapter streams responses text requests', async () => {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};

  const result = await withMockFetch(
    (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'resp_test',
        model: 'gpt-test',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'responses ok'
              }
            ]
          }
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12
        }
      };
    },
    () =>
      generateOpenAiCompatibleText({
        provider: buildProvider({ apiMode: 'responses' }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      })
  );

  assert.equal(capturedUrl, 'https://example.test/v1/responses');
  assert.equal(capturedBody.model, 'gpt-test');
  assert.equal(capturedBody.stream, true);
  assert.equal(capturedBody.max_output_tokens, 64);
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.instructions, 'system prompt');
  assert.deepEqual(capturedBody.input, [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'user prompt'
        }
      ]
    }
  ]);
  assert.equal(result.text, 'responses ok');
  assert.equal(result.finishReason, 'stop');
});

test('openai-compatible chat adapter posts and parses tool calls directly', async () => {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};

  const result = await withMockFetch(
    (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'chatcmpl_tool',
        model: 'gpt-test',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_read',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: '{"path":"src/App.tsx"}'
                  }
                }
              ]
            }
          }
        ]
      };
    },
    () =>
      generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({ apiMode: 'chat' }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'read app'
          },
          {
            role: 'assistant',
            toolCalls: [
              {
                id: 'call_old',
                name: 'scan_file_tree',
                arguments: {}
              }
            ]
          },
          {
            role: 'tool',
            toolCallId: 'call_old',
            content: '{"ok":true,"summary":"tree"}'
          }
        ],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string'
                }
              },
              required: ['path']
            }
          }
        ],
        maxOutputTokens: 128
      })
  );

  assert.equal(capturedUrl, 'https://example.test/v1/chat/completions');
  assert.equal(capturedBody.tool_choice, 'auto');
  assert.equal(capturedBody.stream, true);
  assert.deepEqual(capturedBody.tools, [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string'
            }
          },
          required: ['path']
        }
      }
    }
  ]);
  assert.deepEqual((capturedBody.messages as unknown[]).slice(-2), [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_old',
          type: 'function',
          function: {
            name: 'scan_file_tree',
            arguments: '{}'
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_old',
      content: '{"ok":true,"summary":"tree"}'
    }
  ]);
  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_read',
      name: 'read_file',
      arguments: {
        path: 'src/App.tsx'
      },
      rawArguments: '{"path":"src/App.tsx"}'
    }
  ]);
});

test('openai-compatible streaming chat parser tolerates SSE events split across network chunks', async () => {
  const originalFetch = globalThis.fetch;
  const eventText = [
    `data: ${JSON.stringify({
      id: 'chatcmpl_split_tool',
      model: 'gpt-test',
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_split_read',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"src/'
                }
              }
            ]
          }
        }
      ]
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl_split_tool',
      model: 'gpt-test',
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: 'App.tsx"}'
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    })}\n\n`,
    'data: [DONE]\n\n'
  ].join('');

  globalThis.fetch = (async () =>
    new Response(streamChunks([
      eventText.slice(0, 17),
      eventText.slice(17, 103),
      eventText.slice(103, 211),
      eventText.slice(211)
    ]), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream'
      }
    })) as typeof fetch;

  try {
    const result = await generateOpenAiCompatibleStreamingToolStep({
      provider: buildProvider({ apiMode: 'chat' }),
      system: 'system prompt',
      messages: [
        {
          role: 'user',
          content: 'read app'
        }
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string'
              }
            },
            required: ['path']
          }
        }
      ],
      maxOutputTokens: 128
    });

    assert.deepEqual(result.toolCalls, [
      {
        id: 'call_split_read',
        name: 'read_file',
        arguments: {
          path: 'src/App.tsx'
        },
        rawArguments: '{"path":"src/App.tsx"}'
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible streaming chat parser preserves malformed tool arguments as recoverable tool errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response([
      `data: ${JSON.stringify({
        id: 'chatcmpl_bad_args',
        model: 'gpt-test',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_bad_args',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: '{"path":'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream'
      }
    })) as typeof fetch;

  try {
    const result = await generateOpenAiCompatibleStreamingToolStep({
      provider: buildProvider({ apiMode: 'chat' }),
      system: 'system prompt',
      messages: [
        {
          role: 'user',
          content: 'write file'
        }
      ],
      tools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string'
              },
              content: {
                type: 'string'
              }
            },
            required: ['path', 'content']
          }
        }
      ],
      maxOutputTokens: 128
    });

    assert.deepEqual(result.toolCalls, [
      {
        id: 'call_bad_args',
        name: 'write_file',
        arguments: {},
        rawArguments: '{"path":',
        argumentsParseError: 'Tool arguments are not valid JSON.'
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible streaming chat tool step preserves DeepSeek reasoning content for the next request', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  const sse = (...items: Array<Record<string, unknown> | '[DONE]'>) =>
    items.map((item) => `data: ${item === '[DONE]' ? item : JSON.stringify(item)}\n\n`).join('');

  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) {
      return new Response(sse(
        {
          id: 'chatcmpl_deepseek_tool',
          model: 'deepseek-chat',
          choices: [
            {
              delta: {
                role: 'assistant',
                reasoning_content: 'Need to inspect the file.'
              }
            }
          ]
        },
        {
          id: 'chatcmpl_deepseek_tool',
          model: 'deepseek-chat',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool_jzay6hhq',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"'
                    }
                  }
                ]
              }
            }
          ]
        },
        {
          id: 'chatcmpl_deepseek_tool',
          model: 'deepseek-chat',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: 'notes.md"}'
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        },
        '[DONE]'
      ), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream'
        }
      });
    }

    return new Response(sse(
      {
        id: 'chatcmpl_deepseek_final',
        model: 'deepseek-chat',
        choices: [
          {
            delta: {
              role: 'assistant',
              content: 'done'
            },
            finish_reason: 'stop'
          }
        ]
      },
      '[DONE]'
    ), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream'
      }
    });
  }) as typeof fetch;

  try {
    const firstStep = await generateOpenAiCompatibleStreamingToolStep({
      provider: buildProvider({ apiMode: 'chat', name: 'DeepSeek', model: 'deepseek-chat' }),
      system: 'system prompt',
      messages: [
        {
          role: 'user',
          content: 'read notes'
        }
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string'
              }
            },
            required: ['path']
          }
        }
      ],
      maxOutputTokens: 128
    });

    assert.equal(firstStep.reasoningContent, 'Need to inspect the file.');
    assert.deepEqual(firstStep.toolCalls, [
      {
        id: 'tool_jzay6hhq',
        name: 'read_file',
        arguments: {
          path: 'notes.md'
        },
        rawArguments: '{"path":"notes.md"}'
      }
    ]);
    assert.equal(requests[0].stream, true);

    const secondStep = await generateOpenAiCompatibleStreamingToolStep({
      provider: buildProvider({ apiMode: 'chat', name: 'DeepSeek', model: 'deepseek-chat' }),
      system: 'system prompt',
      messages: [
        {
          role: 'user',
          content: 'read notes'
        },
        {
          role: 'assistant',
          reasoningContent: firstStep.reasoningContent,
          toolCalls: firstStep.toolCalls
        },
        {
          role: 'tool',
          toolCallId: 'tool_jzay6hhq',
          content: '{"ok":true,"summary":"file"}'
        }
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string'
              }
            },
            required: ['path']
          }
        }
      ],
      maxOutputTokens: 128
    });

    assert.equal(secondStep.text, 'done');
    assert.deepEqual((requests[1].messages as unknown[]).slice(-2), [
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'Need to inspect the file.',
        tool_calls: [
          {
            id: 'tool_jzay6hhq',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"notes.md"}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'tool_jzay6hhq',
        content: '{"ok":true,"summary":"file"}'
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible chat tool step replays empty MiMo reasoning content for assistant tool messages', async () => {
  const requests: Record<string, unknown>[] = [];

  await withMockFetch(
    (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return {
        id: 'chatcmpl_mimo_final',
        model: 'mimo-v2.5-pro',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'done'
            }
          }
        ]
      };
    },
    async () => {
      await generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({
          name: 'Xiaomi MiMo',
          apiMode: 'chat',
          baseUrl: 'https://api.xiaomimimo.com/v1',
          model: 'mimo-v2.5-pro'
        }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'write files'
          },
          {
            role: 'assistant',
            toolCalls: [
              {
                id: 'call_write',
                name: 'write_file',
                arguments: {
                  path: 'index.html',
                  content: '<!doctype html>'
                }
              }
            ]
          },
          {
            role: 'tool',
            toolCallId: 'call_write',
            content: '{"ok":true}'
          }
        ],
        tools: [
          {
            name: 'write_file',
            description: 'Write a file.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string'
                },
                content: {
                  type: 'string'
                }
              },
              required: ['path', 'content']
            }
          }
        ],
        maxOutputTokens: 128
      });
    }
  );

  assert.deepEqual((requests[0].messages as unknown[]).slice(-2), [
    {
      role: 'assistant',
      content: null,
      reasoning_content: '',
      tool_calls: [
        {
          id: 'call_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: '{"path":"index.html","content":"<!doctype html>"}'
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_write',
      content: '{"ok":true}'
    }
  ]);
});

test('openai-compatible aggregate endpoints infer reasoning_content replay from upstream model ids', async () => {
  const requests: Record<string, unknown>[] = [];

  await withMockFetch(
    (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length === 1) {
        return {
          id: 'chatcmpl_openrouter_deepseek_tool',
          model: 'deepseek/deepseek-chat',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                reasoning_content: 'Need to inspect aggregate routed file.',
                tool_calls: [
                  {
                    id: 'call_read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"notes.md"}'
                    }
                  }
                ]
              }
            }
          ]
        };
      }
      return {
        id: 'chatcmpl_openrouter_deepseek_final',
        model: 'deepseek/deepseek-chat',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'done'
            }
          }
        ]
      };
    },
    async () => {
      const provider = buildProvider({
        name: 'OpenRouter',
        apiMode: 'chat',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'deepseek/deepseek-chat'
      });
      const firstStep = await generateOpenAiCompatibleStreamingToolStep({
        provider,
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'read notes'
          }
        ],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string'
                }
              },
              required: ['path']
            }
          }
        ],
        maxOutputTokens: 128
      });

      assert.equal(firstStep.reasoningContent, 'Need to inspect aggregate routed file.');
      await generateOpenAiCompatibleStreamingToolStep({
        provider,
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'read notes'
          },
          {
            role: 'assistant',
            reasoningContent: firstStep.reasoningContent,
            toolCalls: firstStep.toolCalls
          },
          {
            role: 'tool',
            toolCallId: 'call_read',
            content: '{"ok":true,"summary":"file"}'
          }
        ],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string'
                }
              },
              required: ['path']
            }
          }
        ],
        maxOutputTokens: 128
      });
    }
  );

  assert.deepEqual((requests[1].messages as unknown[]).slice(-2), [
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'Need to inspect aggregate routed file.',
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"notes.md"}'
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_read',
      content: '{"ok":true,"summary":"file"}'
    }
  ]);
});

test('openai-compatible streaming tool step repairs tool call names by case-insensitive match', async () => {
  const result = await withMockFetch(
    () => ({
      id: 'chatcmpl_tool_repair',
      model: 'gpt-test',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_read',
                type: 'function',
                function: {
                  name: 'READ_FILE',
                  arguments: '{"path":"README.md"}'
                }
              }
            ]
          }
        }
      ]
    }),
    () =>
      generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({ apiMode: 'chat' }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'read readme'
          }
        ],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string'
                }
              },
              required: ['path']
            }
          }
        ],
        maxOutputTokens: 128
      })
  );

  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_read',
      name: 'read_file',
      arguments: {
        path: 'README.md'
      },
      rawArguments: '{"path":"README.md"}'
    }
  ]);
});

test('openai-compatible adapter normalizes textual tool markers into structured tool calls', async () => {
  const result = await withMockFetch(
    () => ({
      id: 'chatcmpl_text_tool',
      model: 'gpt-test',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: [
              '我会写入文件。',
              '[Tool] write_file { "path": "index.html", "content": "<!doctype html>\\n<title>Rogue</title>" }'
            ].join('\n')
          }
        }
      ]
    }),
    () =>
      generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({ apiMode: 'chat' }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'write index'
          }
        ],
        tools: [
          {
            name: 'write_file',
            description: 'Write a file.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string'
                },
                content: {
                  type: 'string'
                }
              },
              required: ['path', 'content']
            }
          }
        ],
        maxOutputTokens: 128
      })
  );

  assert.equal(result.text, '我会写入文件。');
  assert.deepEqual(result.toolCalls, [
    {
      id: result.toolCalls[0]?.id,
      name: 'write_file',
      arguments: {
        path: 'index.html',
        content: '<!doctype html>\n<title>Rogue</title>'
      },
      rawArguments: '{ "path": "index.html", "content": "<!doctype html>\\n<title>Rogue</title>" }'
    }
  ]);
  assert.deepEqual(result.toolCallRepair, {
    type: 'textual_tool_marker',
    toolNames: ['write_file']
  });
});

test('openai-compatible responses adapter posts and parses tool calls directly', async () => {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};

  const result = await withMockFetch(
    (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'resp_tool',
        model: 'gpt-test',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_search',
            name: 'search_project_content',
            arguments: '{"query":"NativeToolLoop"}'
          }
        ]
      };
    },
    () =>
      generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({ apiMode: 'responses' }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'search project'
          },
          {
            role: 'assistant',
            toolCalls: [
              {
                id: 'call_old',
                name: 'scan_file_tree',
                arguments: {}
              }
            ]
          },
          {
            role: 'tool',
            toolCallId: 'call_old',
            content: '{"ok":true,"summary":"tree"}'
          }
        ],
        tools: [
          {
            name: 'search_project_content',
            description: 'Search project content.',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string'
                }
              },
              required: ['query']
            }
          }
        ],
        maxOutputTokens: 128
      })
  );

  assert.equal(capturedUrl, 'https://example.test/v1/responses');
  assert.equal(capturedBody.instructions, 'system prompt');
  assert.equal(capturedBody.tool_choice, 'auto');
  assert.equal(capturedBody.stream, true);
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.parallel_tool_calls, false);
  assert.deepEqual(capturedBody.tools, [
    {
      type: 'function',
      name: 'search_project_content',
      description: 'Search project content.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string'
          }
        },
        required: ['query']
      }
    }
  ]);
  assert.deepEqual((capturedBody.input as unknown[]).slice(-2), [
    {
      type: 'function_call',
      call_id: 'call_old',
      name: 'scan_file_tree',
      arguments: '{}'
    },
    {
      type: 'function_call_output',
      call_id: 'call_old',
      output: '{"ok":true,"summary":"tree"}'
    }
  ]);
  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_search',
      name: 'search_project_content',
      arguments: {
        query: 'NativeToolLoop'
      },
      rawArguments: '{"query":"NativeToolLoop"}'
    }
  ]);
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.responseOutputItems, [
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_search',
      name: 'search_project_content',
      arguments: '{"query":"NativeToolLoop"}'
    }
  ]);
});

test('openai-compatible responses streaming tool step parses function call argument events', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_stream_tool","status":"in_progress","model":"gpt-test","output":[]}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_search","name":"search_project_content","arguments":""}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\\"query\\":"}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"\\"NativeToolLoop\\"}"}',
      '',
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","arguments":"{\\"query\\":\\"NativeToolLoop\\"}"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_search","name":"search_project_content","arguments":"{\\"query\\":\\"NativeToolLoop\\"}","status":"completed"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_stream_tool","status":"completed","model":"gpt-test","output":[]}}',
      '',
      ''
    ].join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream'
      }
    });
  }) as typeof fetch;

  try {
    const result = await generateOpenAiCompatibleStreamingToolStep({
      provider: buildProvider({ apiMode: 'responses' }),
      system: 'system prompt',
      messages: [
        {
          role: 'user',
          content: 'search project'
        }
      ],
      tools: [
        {
          name: 'search_project_content',
          description: 'Search project content.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string'
              }
            },
            required: ['query']
          }
        }
      ],
      maxOutputTokens: 128
    });

    assert.equal(capturedBody.stream, true);
    assert.deepEqual(result.toolCalls, [
      {
        id: 'call_search',
        name: 'search_project_content',
        arguments: {
          query: 'NativeToolLoop'
        },
        rawArguments: '{"query":"NativeToolLoop"}'
      }
    ]);
    assert.deepEqual(result.responseOutputItems, [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_search',
        name: 'search_project_content',
        arguments: '{"query":"NativeToolLoop"}',
        status: 'completed'
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible responses adapter preserves raw previous response output items', async () => {
  let capturedBody: Record<string, unknown> = {};

  await withMockFetch(
    (_url, init) => {
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'resp_final',
        output_text: 'done'
      };
    },
    () =>
      generateOpenAiCompatibleStreamingToolStep({
        provider: buildProvider({ apiMode: 'responses' }),
        system: 'system prompt',
        messages: [
          {
            role: 'user',
            content: 'search project'
          },
          {
            role: 'responses_output',
            items: [
              {
                type: 'reasoning',
                id: 'rs_1',
                summary: []
              },
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_search',
                name: 'search_project_content',
                arguments: '{"query":"NativeToolLoop"}',
                status: 'completed'
              }
            ]
          },
          {
            role: 'tool',
            toolCallId: 'call_search',
            content: 'result'
          }
        ],
        tools: [],
        maxOutputTokens: 128
      })
  );

  assert.equal(capturedBody.stream, true);
  assert.deepEqual((capturedBody.input as unknown[]).slice(-3), [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: []
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_search',
      name: 'search_project_content',
      arguments: '{"query":"NativeToolLoop"}',
      status: 'completed'
    },
    {
      type: 'function_call_output',
      call_id: 'call_search',
      output: 'result'
    }
  ]);
});

test('openai-compatible client infers responses mode for legacy Packy providers', async () => {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};

  await withMockFetch(
    (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body));
      return {
        id: 'resp_packy',
        output_text: 'packy ok'
      };
    },
    () =>
      generateOpenAiCompatibleText({
        provider: buildProvider({
          name: 'Packy',
          baseUrl: 'https://www.packyapi.com/v1',
          apiMode: undefined
        }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      })
  );

  assert.equal(capturedUrl, 'https://www.packyapi.com/v1/responses');
  assert.equal(capturedBody.stream, true);
});

test('openai-compatible client normalizes bare Packy base URL to v1 responses endpoint', async () => {
  let capturedUrl = '';

  await withMockFetch(
    (url) => {
      capturedUrl = url;
      return {
        id: 'resp_packy_bare',
        output_text: 'packy bare ok'
      };
    },
    () =>
      generateOpenAiCompatibleText({
        provider: buildProvider({
          name: 'Packy',
          baseUrl: 'https://www.packyapi.com',
          apiMode: 'responses',
          model: 'gpt-5.1-codex'
        }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      })
  );

  assert.equal(capturedUrl, 'https://www.packyapi.com/v1/responses');
});

test('openai-compatible Packy responses reads text from SSE output_text deltas', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};
  const deltas: Array<{ delta: string; accumulated: string }> = [];
  globalThis.fetch = (async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_stream","status":"in_progress","model":"gpt-5.4","output":[]}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","output_index":0,"content_index":0}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"您好"}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"！"}',
      '',
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"您好！"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","model":"gpt-5.4","output":[],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
      '',
      ''
    ].join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream'
      }
    });
  }) as typeof fetch;

  try {
    const result = await generateOpenAiCompatibleText({
      provider: buildProvider({
        name: 'Packy',
        baseUrl: 'https://www.packyapi.com/v1',
        apiMode: 'responses',
        model: 'gpt-5.4'
      }),
      system: 'system prompt',
      prompt: 'user prompt',
      maxOutputTokens: 64,
      onDelta: (delta, accumulated) => {
        deltas.push({ delta, accumulated });
      }
    });

    assert.equal(capturedBody.stream, true);
    assert.equal(result.text, '您好！');
    assert.equal((result.responseBody as { output_text?: string }).output_text, '您好！');
    assert.deepEqual(deltas, [
      { delta: '您好', accumulated: '您好' },
      { delta: '！', accumulated: '您好！' }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible responses retries retryable Cloudflare gateway errors', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return new Response(JSON.stringify({
        type: 'https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/',
        title: 'Error 502: Bad gateway',
        status: 502,
        detail: 'The origin web server returned an invalid or incomplete response to Cloudflare.',
        error_code: 502,
        error_name: 'origin_bad_gateway',
        cloudflare_error: true,
        retryable: true,
        retry_after: 0
      }), {
        status: 502,
        headers: {
          'Content-Type': 'application/problem+json'
        }
      });
    }
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(JSON.stringify({
      id: 'resp_packy_retry_ok',
      output_text: 'retry ok'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }) as typeof fetch;

  try {
    const result = await generateOpenAiCompatibleText({
      provider: buildProvider({
        name: 'Packy',
        baseUrl: 'https://www.packyapi.com/v1',
        apiMode: 'responses',
        model: 'gpt-5.5'
      }),
      system: 'system prompt',
      prompt: 'user prompt',
      maxOutputTokens: 64
    });

    assert.deepEqual(urls, [
      'https://www.packyapi.com/v1/responses',
      'https://www.packyapi.com/v1/responses'
    ]);
    assert.equal(result.text, 'retry ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible responses does not fall back to non-streaming json when a streamed request returns empty json', async () => {
  const capturedBodies: Record<string, unknown>[] = [];

  await assert.rejects(
    withMockFetch(
      (_url, init) => {
        capturedBodies.push(JSON.parse(String(init.body)));
        return {
          id: 'resp_empty',
          status: 'completed',
          output: [],
          instructions: 'provider injected instructions'
        };
      },
      () =>
        generateOpenAiCompatibleText({
          provider: buildProvider({
            name: 'Packy',
            baseUrl: 'https://www.packyapi.com/v1',
            apiMode: 'responses'
          }),
          system: 'system prompt',
          prompt: 'user prompt',
          maxOutputTokens: 64
        })
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'MODEL_EMPTY_RESPONSE');
      assert.match(String((error as { requestUrl?: string }).requestUrl), /\/responses$/);
      assert.match(String((error as { responseBody?: string }).responseBody), /resp_empty/);
      return true;
    }
  );

  assert.equal(capturedBodies.length, 1);
  assert.equal(capturedBodies[0].stream, true);
});

test('openai-compatible responses does not fall back to chat completions when a streamed response has no text', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url, init) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)));
    return new Response([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_empty_stream","status":"in_progress","model":"gpt-5.4","output":[]}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_empty_stream","status":"completed","model":"gpt-5.4","output":[]}}',
      '',
      ''
    ].join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream'
      }
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      generateOpenAiCompatibleText({
        provider: buildProvider({
          name: 'Packy',
          baseUrl: 'https://www.packyapi.com/v1',
          apiMode: 'responses'
        }),
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: 64
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'MODEL_EMPTY_RESPONSE');
        assert.match(String((error as { requestUrl?: string }).requestUrl), /\/responses$/);
        assert.match(String((error as { responseBody?: string }).responseBody), /resp_empty_stream/);
        return true;
      }
    );
    assert.deepEqual(urls, [
      'https://www.packyapi.com/v1/responses'
    ]);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].stream, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible empty response errors include raw request and response bodies', async () => {
  await assert.rejects(
    withMockFetch(
      () => ({
        id: 'chatcmpl_empty',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: null
            }
          }
        ]
      }),
      () =>
        generateOpenAiCompatibleText({
          provider: buildProvider({ apiMode: 'chat', model: 'gpt-5.4' }),
          system: 'system prompt',
          prompt: 'user prompt',
          maxOutputTokens: 64
        })
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'MODEL_EMPTY_RESPONSE');
      assert.match(String((error as { requestUrl?: string }).requestUrl), /chat\/completions$/);
      assert.match(String((error as { requestBody?: string }).requestBody), /max_completion_tokens/);
      assert.match(String((error as { responseBody?: string }).responseBody), /chatcmpl_empty/);
      return true;
    }
  );
});
