interface SessionRunLock {
  token: string;
  owner: string;
  acquiredAt: string;
}

const locks = new Map<string, SessionRunLock>();

function makeToken(): string {
  return `lock_${Math.random().toString(36).slice(2, 10)}`;
}

export function acquireAgentSessionLock(sessionId: string, owner: string): string | undefined {
  if (locks.has(sessionId)) {
    return undefined;
  }

  const token = makeToken();
  locks.set(sessionId, {
    token,
    owner,
    acquiredAt: new Date().toISOString()
  });
  return token;
}

export function releaseAgentSessionLock(sessionId: string, token: string): void {
  const lock = locks.get(sessionId);
  if (lock?.token === token) {
    locks.delete(sessionId);
  }
}

export function getAgentSessionLock(sessionId: string): SessionRunLock | undefined {
  return locks.get(sessionId);
}
