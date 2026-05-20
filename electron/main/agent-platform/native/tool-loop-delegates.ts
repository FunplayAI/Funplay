import type { GenericAgentRuntimeParams } from '../types';
import type { WorkspaceToolAction, WorkspaceToolActionResult } from '../workspace-tools';
import {
  readNativeBackgroundSubagentStatus,
  runNativeParallelSubagents,
  runNativeSubagent,
  startNativeBackgroundSubagent
} from './subagent-runner';
import type { NativeToolPoolDelegates } from './tool-pool';

async function requestUserInputFromTool(
  params: GenericAgentRuntimeParams,
  action: Extract<WorkspaceToolAction, { type: 'ask_user' }>
): Promise<WorkspaceToolActionResult> {
  if (!params.requestUserInput) {
    return {
      ok: false,
      isError: true,
      summary: '当前运行环境不支持向用户提问。'
    };
  }

  const response = await params.requestUserInput({
    title: action.title,
    question: action.question,
    detail: action.detail,
    options: action.options?.map((option, index) => ({
      id: option.id || `option_${index + 1}`,
      label: option.label,
      description: option.description
    })),
    multiSelect: action.multiSelect,
    allowFreeText: action.allowFreeText ?? true,
    placeholder: action.placeholder,
    toolName: 'ask_user'
  });

  if (response.cancelled) {
    return {
      ok: false,
      isError: true,
      summary: '用户没有回答这个问题，当前请求已取消或超时。'
    };
  }

  return {
    ok: true,
    summary: [
      'User answered the question.',
      response.optionIds?.length ? `Selected options: ${response.optionIds.join(', ')}` : '',
      response.optionId ? `Selected option: ${response.optionId}` : '',
      `Answer: ${response.answer}`
    ].filter(Boolean).join('\n')
  };
}

export function createNativeToolLoopDelegates(params: GenericAgentRuntimeParams): NativeToolPoolDelegates {
  return {
    requestUserInput: (action) => requestUserInputFromTool(params, action),
    requestMcpUserInput: params.requestUserInput,
    runSubagent: (action) => runNativeSubagent(params, action),
    runSubagents: (action) => runNativeParallelSubagents(params, action),
    startSubagent: (action) => startNativeBackgroundSubagent(params, action),
    readSubagentStatus: (action) => readNativeBackgroundSubagentStatus(params, action)
  };
}
