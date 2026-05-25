import { activeProcesses, activeSdkQueries } from './constants';

export function interruptClaudeRuntimeProcess(runIdOrSessionId: string): void {
  const query = activeSdkQueries.get(runIdOrSessionId);
  if (query) {
    query.close();
    activeSdkQueries.delete(runIdOrSessionId);
  }

  const child = activeProcesses.get(runIdOrSessionId);
  if (!child) {
    return;
  }
  child.kill('SIGTERM');
  activeProcesses.delete(runIdOrSessionId);
}

export function disposeClaudeRuntimeProcesses(): void {
  for (const query of activeSdkQueries.values()) {
    query.close();
  }
  activeSdkQueries.clear();

  for (const child of activeProcesses.values()) {
    child.kill('SIGTERM');
  }
  activeProcesses.clear();
}
