import { tmpdir } from 'node:os';
import type {
  Options as ClaudeAgentSdkOptions,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { AiProvider } from '../../../../shared/types';
import {
  prepareClaudeCodeSdkSubprocessEnv,
  resolveClaudeCliModel
} from './env-builder';
import {
  resolveClaudeCodeExecutable
} from './executable-resolver';
import {
  classifyClaudeRuntimeError,
  sdkResultToClaudeResultEvent
} from './stream-events';
import type {
  ClaudeSdkProviderProbeResult,
  ClaudeSdkSubprocessEnv
} from './types';
import { resolveClaudeCodeProvider } from './runtime-provider';

export async function testClaudeCodeSdkProviderRuntime(
  provider: AiProvider,
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<ClaudeSdkProviderProbeResult> {
  const resolved = resolveClaudeCodeProvider(provider);
  if (!resolved.canUseClaudeCode) {
    throw new Error(`claude_provider_invalid: 当前 provider 不能直接作为 Claude Code SDK runtime 使用。protocol=${provider.protocol}`);
  }

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  timeout.unref?.();

  let stderrBuffer = '';
  let sdkEnvSetup: ClaudeSdkSubprocessEnv | undefined;
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    sdkEnvSetup = prepareClaudeCodeSdkSubprocessEnv(provider);
    const executable = resolveClaudeCodeExecutable();
    const sdkOptions: ClaudeAgentSdkOptions = {
      cwd: options.cwd ?? tmpdir(),
      abortController,
      includePartialMessages: false,
      permissionMode: 'dontAsk',
      env: sdkEnvSetup.env,
      settingSources: resolved.settingSources,
      stderr: (data) => {
        stderrBuffer = [stderrBuffer, data].filter(Boolean).join('\n').slice(-1200);
      }
    };

    const executablePath = executable.sdkExecutablePath;
    if (executablePath) {
      sdkOptions.pathToClaudeCodeExecutable = executablePath;
    }
    const model = resolveClaudeCliModel(provider);
    if (model) {
      sdkOptions.model = model;
    }

    let responsePreview = '';
    for await (const message of query({
      prompt: 'Reply with exactly: OK',
      options: sdkOptions
    }) as AsyncIterable<SDKMessage>) {
      if (message.type === 'result') {
        const result = sdkResultToClaudeResultEvent(message as SDKResultMessage);
        if (result.is_error) {
          throw new Error(result.result || result.subtype || 'claude_sdk_probe_failed');
        }
        responsePreview = result.result?.trim() || responsePreview;
        break;
      }
      if (message.type === 'assistant') {
        const assistant = message as SDKAssistantMessage;
        const content = assistant.message?.content;
        if (Array.isArray(content)) {
          responsePreview = content
            .map((block) => (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim()
            .slice(0, 120);
        }
      }
    }

    if (!responsePreview) {
      throw new Error('empty_response');
    }

    return {
      ok: true,
      runtimeId: 'claude-code-sdk',
      providerId: resolved.providerId,
      providerProtocol: resolved.protocol,
      baseUrl: resolved.baseUrl,
      model,
      executablePath: executable.command,
      executableSource: executable.source,
      responsePreview: responsePreview.slice(0, 120),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    const diagnostic = classifyClaudeRuntimeError({
      error,
      stderr: stderrBuffer,
      provider
    });
    throw new Error(`${diagnostic.code}: ${diagnostic.summary}\n建议：${diagnostic.suggestedAction}`);
  } finally {
    clearTimeout(timeout);
    abortController.abort();
    sdkEnvSetup?.shadow.cleanup();
  }
}
