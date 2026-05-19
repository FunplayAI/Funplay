import type { ProjectSessionRuntimeId } from '../../../shared/types';
import { makeId } from '../../../shared/utils';
import type { GenericAgentRuntimeParams } from './types';
import type { StreamContext } from './stream-types';
import { registerPendingPermission } from './permission-registry';
import { registerPendingUserInput } from './user-input-registry';
import {
  recordActiveRunPermissionRequest,
  recordActiveRunPermissionResolved,
  recordActiveRunUserInputRequest,
  recordActiveRunUserInputResolved
} from './run-registry';

const USER_INPUT_RESPONSE_PREVIEW_CHARS = 600;

function buildUserInputResponseEvent(
  requestId: string,
  response: Awaited<ReturnType<NonNullable<GenericAgentRuntimeParams['requestUserInput']>>>
) {
  const answer = typeof response.answer === 'string' ? response.answer : '';
  return {
    requestId,
    answerPreview: answer.length > USER_INPUT_RESPONSE_PREVIEW_CHARS
      ? `${answer.slice(0, USER_INPUT_RESPONSE_PREVIEW_CHARS)}…`
      : answer || undefined,
    answerLength: answer ? answer.length : undefined,
    optionId: response.optionId,
    optionIds: response.optionIds,
    cancelled: response.cancelled
  };
}

function recordPermissionRequest(ctx: StreamContext, request: {
  requestId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  toolName?: string;
  impact?: Record<string, unknown>;
}): void {
  recordActiveRunPermissionRequest(ctx.activeRunId, request);
}

export function makePermissionHandlers(
  ctx: StreamContext,
  opts: {
    getRuntimeId: () => ProjectSessionRuntimeId | undefined;
    getCwd: () => string | undefined;
  }
): {
  onPermissionRequest: NonNullable<GenericAgentRuntimeParams['onPermissionRequest']>;
  requestPermission: NonNullable<GenericAgentRuntimeParams['requestPermission']>;
} {
  return {
    onPermissionRequest: (request) => {
      const impact = request.impact ? { ...request.impact, cwd: request.impact.cwd ?? opts.getCwd() } : undefined;
      recordPermissionRequest(ctx, {
        requestId: request.requestId,
        title: request.title,
        detail: request.detail,
        risk: request.risk,
        toolName: request.toolName,
        impact: impact as Record<string, unknown> | undefined
      });
      ctx.dispatchEvent({
        type: 'permission_request',
        streamId: ctx.streamId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        requestId: request.requestId,
        title: request.title,
        detail: request.detail,
        risk: request.risk,
        toolName: request.toolName,
        impact,
        startedAt: ctx.startedAt
      });
    },
    requestPermission: (request) => {
      const requestId = makeId('perm');
      const impact = request.impact ? { ...request.impact, cwd: request.impact.cwd ?? opts.getCwd() } : undefined;
      recordPermissionRequest(ctx, {
        requestId,
        title: request.title,
        detail: request.detail,
        risk: request.risk,
        toolName: request.toolName,
        impact: impact as Record<string, unknown> | undefined
      });
      ctx.dispatchEvent({
        type: 'permission_request',
        streamId: ctx.streamId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        requestId,
        title: request.title,
        detail: request.detail,
        risk: request.risk,
        toolName: request.toolName,
        impact,
        startedAt: ctx.startedAt
      });
      return registerPendingPermission({
        requestId,
        streamId: ctx.streamId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        title: request.title,
        detail: request.detail,
        risk: request.risk,
        toolName: request.toolName,
        impact,
        runtimeId: opts.getRuntimeId(),
        cwd: opts.getCwd(),
        createdAt: ctx.startedAt,
        abortSignal: ctx.controller.signal,
        onResolve: (entry, decision) => {
          recordActiveRunPermissionResolved(ctx.activeRunId, {
            requestId: entry.requestId,
            decision
          });
          ctx.dispatchEvent({
            type: 'permission_resolved',
            streamId: entry.streamId,
            projectId: entry.projectId,
            sessionId: entry.sessionId,
            requestId: entry.requestId,
            decision,
            startedAt: entry.createdAt
          });
        }
      });
    }
  };
}

export function makeUserInputHandlers(ctx: StreamContext): {
  onUserInputRequest: NonNullable<GenericAgentRuntimeParams['onUserInputRequest']>;
  requestUserInput: NonNullable<GenericAgentRuntimeParams['requestUserInput']>;
} {
  return {
    onUserInputRequest: (request) => {
      recordActiveRunUserInputRequest(ctx.activeRunId, {
        requestId: request.requestId,
        title: request.title,
        question: request.question,
        detail: request.detail,
        options: request.options,
        multiSelect: request.multiSelect,
        allowFreeText: request.allowFreeText,
        placeholder: request.placeholder,
        toolName: request.toolName
      });
      ctx.dispatchEvent({
        type: 'user_input_request',
        streamId: ctx.streamId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        requestId: request.requestId,
        title: request.title,
        question: request.question,
        detail: request.detail,
        options: request.options,
        multiSelect: request.multiSelect,
        allowFreeText: request.allowFreeText,
        placeholder: request.placeholder,
        toolName: request.toolName,
        startedAt: ctx.startedAt
      });
    },
    requestUserInput: (request) => {
      const requestId = makeId('input');
      const title = request.title?.trim() || 'Agent 需要你的输入';
      recordActiveRunUserInputRequest(ctx.activeRunId, {
        requestId,
        title,
        question: request.question,
        detail: request.detail,
        options: request.options,
        multiSelect: request.multiSelect,
        allowFreeText: request.allowFreeText,
        placeholder: request.placeholder,
        toolName: request.toolName
      });
      ctx.dispatchEvent({
        type: 'user_input_request',
        streamId: ctx.streamId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        requestId,
        title,
        question: request.question,
        detail: request.detail,
        options: request.options,
        multiSelect: request.multiSelect,
        allowFreeText: request.allowFreeText,
        placeholder: request.placeholder,
        toolName: request.toolName,
        startedAt: ctx.startedAt
      });
      return registerPendingUserInput({
        requestId,
        streamId: ctx.streamId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        title,
        question: request.question,
        detail: request.detail,
        options: request.options,
        multiSelect: request.multiSelect,
        allowFreeText: request.allowFreeText,
        placeholder: request.placeholder,
        toolName: request.toolName,
        createdAt: ctx.startedAt,
        abortSignal: ctx.controller.signal,
        onResolve: (entry, response) => {
          recordActiveRunUserInputResolved(ctx.activeRunId, buildUserInputResponseEvent(entry.requestId, response));
          ctx.dispatchEvent({
            type: 'user_input_resolved',
            streamId: entry.streamId,
            projectId: entry.projectId,
            sessionId: entry.sessionId,
            requestId: entry.requestId,
            response,
            startedAt: entry.createdAt
          });
        }
      });
    }
  };
}
