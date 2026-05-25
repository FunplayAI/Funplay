import type {
  AgentRunControllerAction,
  AgentRunControllerContinuationReason,
  AgentRunControllerSnapshot
} from './controller';
import {
  createAgentIncompleteTodoContinuationPrompt,
  createAgentLengthContinuationPrompt,
  createAgentPartialWriteContinuationPrompt,
  type AgentTodoContinuationSnapshot
} from '../../../shared/agent-continuation-policy';

export type AgentRunControllerContinuationCounterKey =
  | 'incompleteTodoContinuationCount'
  | 'partialWriteContinuationCount';

export interface AgentRunControllerCommandContext {
  assistantMessage?: string;
  latestTodoSnapshot?: AgentTodoContinuationSnapshot;
}

export interface AgentRunControllerContinuationEffectCommand {
  prompt: string;
  counterKey?: AgentRunControllerContinuationCounterKey;
}

export type AgentRunControllerCommand =
  | {
      action: 'continue';
      reason: AgentRunControllerContinuationReason;
      detail: string;
      controllerAction: AgentRunControllerAction;
      effect?: AgentRunControllerContinuationEffectCommand;
    }
  | {
      action: 'complete';
      detail: string;
      controllerAction: AgentRunControllerAction;
    }
  | {
      action: 'fail';
      detail: string;
      controllerAction: AgentRunControllerAction;
    }
  | {
      action: 'unsupported';
      detail: string;
      controllerAction: AgentRunControllerAction;
    };

function resolveContinuationEffectCommand(
  reason: AgentRunControllerContinuationReason,
  context: AgentRunControllerCommandContext
): AgentRunControllerContinuationEffectCommand | undefined {
  const assistantMessage = context.assistantMessage ?? '';
  if (reason === 'incomplete_todo') {
    if (!context.latestTodoSnapshot) {
      return undefined;
    }
    return {
      prompt: createAgentIncompleteTodoContinuationPrompt(context.latestTodoSnapshot, assistantMessage),
      counterKey: 'incompleteTodoContinuationCount'
    };
  }
  if (reason === 'partial_write') {
    return {
      prompt: createAgentPartialWriteContinuationPrompt(assistantMessage),
      counterKey: 'partialWriteContinuationCount'
    };
  }
  if (reason === 'length') {
    return {
      prompt: createAgentLengthContinuationPrompt(assistantMessage)
    };
  }
  return undefined;
}

export function resolveAgentRunControllerCommand(
  snapshot: AgentRunControllerSnapshot,
  context: AgentRunControllerCommandContext = {}
): AgentRunControllerCommand {
  if (snapshot.lastContinuation) {
    return {
      action: 'continue',
      reason: snapshot.lastContinuation.reason,
      detail: snapshot.lastContinuation.detail ?? snapshot.lastDecision?.reason ?? 'Controller requested another provider input.',
      controllerAction: snapshot.nextAction,
      effect: resolveContinuationEffectCommand(snapshot.lastContinuation.reason, context)
    };
  }

  if (snapshot.nextAction === 'fail') {
    return {
      action: 'fail',
      detail: snapshot.lastDecision?.reason ?? 'Provider did not produce a completable no-tool step.',
      controllerAction: snapshot.nextAction
    };
  }

  if (snapshot.nextAction === 'complete') {
    return {
      action: 'complete',
      detail: snapshot.lastDecision?.reason ?? 'Provider stopped without tool calls and produced final text.',
      controllerAction: snapshot.nextAction
    };
  }

  return {
    action: 'unsupported',
    detail: `Agent Run Controller returned ${snapshot.nextAction} for this provider step.`,
    controllerAction: snapshot.nextAction
  };
}
