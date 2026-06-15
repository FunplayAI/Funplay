// Lightweight, scoped diagnostics logging for the engine/MCP reliability layer.
//
// Engine connection failures are deliberately swallowed in many probe/cleanup
// paths (a probe that fails just means "offline", recorded in the snapshot), but
// that left no way to answer "why did my bridge drop?" after the fact. These
// helpers give those sites an observable channel without adding noise to normal
// runs: warnings always print (genuine mid-session deaths), while the verbose
// per-probe failure reasons are gated behind FUNPLAY_DEBUG_ENGINE=1.
//
// Mirrors the established `console.warn('[scope]', ...)` pattern (see
// update-service.ts) rather than pulling in a logging framework.

const DEBUG_ENGINE = process.env.FUNPLAY_DEBUG_ENGINE === '1';

function describeError(error: unknown): string {
  if (error === undefined) {
    return '';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function logEngineWarn(scope: string, message: string, error?: unknown): void {
  const detail = describeError(error);
  if (detail) {
    console.warn(`[engine:${scope}]`, message, detail);
  } else {
    console.warn(`[engine:${scope}]`, message);
  }
}

export function logEngineDebug(scope: string, message: string, error?: unknown): void {
  if (!DEBUG_ENGINE) {
    return;
  }
  const detail = describeError(error);
  if (detail) {
    console.debug(`[engine:${scope}]`, message, detail);
  } else {
    console.debug(`[engine:${scope}]`, message);
  }
}
