import type { AgentOperationStatus } from '../../../shared/types';

export type ExecutePlanStagePhase =
  | 'prepare'
  | 'checkpoint'
  | 'execute'
  | 'diagnose'
  | 'repair'
  | 'verify'
  | 'rollback'
  | 'replan'
  | 'commit'
  | 'complete';

export interface ExecutePlanStageEvent {
  stageId: string;
  phase: ExecutePlanStagePhase;
  title: string;
  target: string;
  status: AgentOperationStatus;
  input?: Record<string, unknown>;
  summary?: string;
  errorMessage?: string;
}

interface ExecutePlanStageTemplate {
  title: string;
  stageId: string;
  target: string;
}

interface ExecutePlanStageEmitOptions {
  stageId?: string;
  title?: string;
  target?: string;
  actionId?: string;
  input?: Record<string, unknown>;
  summary?: string;
  errorMessage?: string;
}

const executePlanStageTemplates: Record<ExecutePlanStagePhase, ExecutePlanStageTemplate> = {
  prepare: {
    stageId: 'stage:execute_plan_prepare',
    title: '准备执行计划',
    target: 'execute-plan'
  },
  checkpoint: {
    stageId: 'stage:checkpoint',
    title: '建立执行计划检查点',
    target: 'stage:checkpoint'
  },
  execute: {
    stageId: 'stage:execute_plan_execute',
    title: '执行计划动作',
    target: 'execute-plan'
  },
  diagnose: {
    stageId: 'stage:execute_plan_diagnose',
    title: '收集计划级诊断',
    target: 'execute-plan'
  },
  repair: {
    stageId: 'stage:execute_plan_repair',
    title: '生成并执行修复动作',
    target: 'execute-plan'
  },
  verify: {
    stageId: 'stage:execute_plan_verify',
    title: '验证执行结果',
    target: 'execute-plan'
  },
  rollback: {
    stageId: 'stage:execute_plan_rollback',
    title: '执行回滚',
    target: 'execute-plan'
  },
  replan: {
    stageId: 'stage:execute_plan_replan',
    title: '生成下一轮计划',
    target: 'execute-plan'
  },
  commit: {
    stageId: 'stage:execute_plan_commit',
    title: '提交执行结果',
    target: 'execute-plan'
  },
  complete: {
    stageId: 'stage:execute_plan_complete',
    title: '完成执行计划运行',
    target: 'execute-plan'
  }
};

function actionScopedStageId(phase: ExecutePlanStagePhase, actionId?: string): string | undefined {
  if (!actionId) {
    return undefined;
  }

  if (phase === 'execute') {
    return `stage:execute_action:${actionId}`;
  }

  return `stage:${phase}:${actionId}`;
}

export function createExecutePlanStageMachine(emit?: (stage: ExecutePlanStageEvent) => void) {
  return {
    emit(phase: ExecutePlanStagePhase, status: AgentOperationStatus, options: ExecutePlanStageEmitOptions = {}): void {
      const template = executePlanStageTemplates[phase];
      const stageId = options.stageId ?? actionScopedStageId(phase, options.actionId) ?? template.stageId;
      const target = options.target ?? (options.actionId ? `action:${options.actionId}` : template.target);
      emit?.({
        stageId,
        phase,
        title: options.title ?? template.title,
        target,
        status,
        input: {
          phase,
          ...options.input
        },
        summary: options.summary,
        errorMessage: options.errorMessage
      });
    }
  };
}

export type ExecutePlanStageMachine = ReturnType<typeof createExecutePlanStageMachine>;
