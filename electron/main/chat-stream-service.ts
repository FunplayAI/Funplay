import type { AppState, PromptAttachment, PromptStreamEvent, PromptStreamHandle } from '../../shared/types';
import { cancelAgentPromptStream, startAgentPromptStream } from './agent-platform/stream-manager';

export function startChatPromptStream(params: {
  getState: () => AppState;
  persistState: (state: AppState) => Promise<void>;
  projectId: string;
  sessionId?: string;
  message: string;
  attachments?: PromptAttachment[];
  uiLanguage?: 'zh-CN' | 'en-US';
  dispatchEvent: (event: PromptStreamEvent) => void;
}): PromptStreamHandle {
  return startAgentPromptStream(params);
}

export function cancelChatPromptStream(streamId: string): { success: true } {
  return cancelAgentPromptStream(streamId);
}
