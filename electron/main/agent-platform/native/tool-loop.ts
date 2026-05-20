import type { GenericAgentRuntimeParams } from '../types';
import { runNativeAiSdkToolLoop } from './ai-sdk-runner';
import { runOpenAiCompatibleNativeToolLoop } from './openai-compatible-runner';
import type { NativeToolLoopCallbacks } from './tool-loop-controller';
import type { NativeToolLoopRunResult } from './tool-loop-state';

export {
  runOpenAiCompatibleNativeToolLoop
} from './openai-compatible-runner';

export {
  NATIVE_MAIN_PROVIDER_STEP_TIMEOUT_MS,
  NATIVE_SUBAGENT_PROVIDER_STEP_TIMEOUT_MS
} from './provider-step';

export {
  NATIVE_MAIN_TOOL_LOOP_MAX_OUTPUT_TOKENS
} from './tool-loop-options';

export {
  createNativeToolLoopPermissionInstructions
} from './tool-loop-prompt';

export type {
  NativeToolLoopRunResult
} from './tool-loop-state';

export async function runNativeReadOnlyToolLoop(
  params: GenericAgentRuntimeParams,
  callbacks?: NativeToolLoopCallbacks
): Promise<NativeToolLoopRunResult> {
  if (!params.provider) {
    throw new Error('Native tool loop requires a provider.');
  }
  if (params.provider.protocol === 'openai-compatible') {
    return runOpenAiCompatibleNativeToolLoop(params, callbacks);
  }

  return runNativeAiSdkToolLoop(params, callbacks);
}
