export interface GenericAgentLoopStep<TState> {
  id: string;
  run: (state: TState) => Promise<TState>;
}

export interface StatefulAgentLoopIteration<TState> {
  state: TState;
  stop?: boolean;
  repeatKey?: string;
}

export async function runGenericAgentLoop<TState>(params: {
  initialState: TState;
  steps: GenericAgentLoopStep<TState>[];
  abortSignal?: AbortSignal;
  maxSteps?: number;
}): Promise<TState> {
  const maxSteps = params.maxSteps ?? params.steps.length;
  let state = params.initialState;

  for (let index = 0; index < params.steps.length && index < maxSteps; index += 1) {
    params.abortSignal?.throwIfAborted();
    state = await params.steps[index].run(state);
  }

  return state;
}

export async function runStatefulAgentLoop<TState>(params: {
  initialState: TState;
  abortSignal?: AbortSignal;
  maxSteps: number;
  maxRepeatsPerKey?: number;
  runStep: (state: TState, stepIndex: number) => Promise<StatefulAgentLoopIteration<TState>>;
  onRepeatLimit?: (state: TState, repeatKey: string, repeatCount: number, stepIndex: number) => Promise<TState> | TState;
}): Promise<TState> {
  const repeatLimit = Math.max(1, params.maxRepeatsPerKey ?? 2);
  const repeatedActions = new Map<string, number>();
  let state = params.initialState;

  for (let stepIndex = 0; stepIndex < params.maxSteps; stepIndex += 1) {
    params.abortSignal?.throwIfAborted();
    const iteration = await params.runStep(state, stepIndex);

    if (iteration.repeatKey) {
      const repeatCount = (repeatedActions.get(iteration.repeatKey) ?? 0) + 1;
      repeatedActions.set(iteration.repeatKey, repeatCount);
      if (repeatCount > repeatLimit) {
        state = params.onRepeatLimit
          ? await params.onRepeatLimit(iteration.state, iteration.repeatKey, repeatCount, stepIndex)
          : iteration.state;
        continue;
      }
    }

    state = iteration.state;
    if (iteration.stop) {
      return state;
    }
  }

  return state;
}
