export type RuntimeDiagnosticSeverity = 'ok' | 'warn' | 'error';

export interface RuntimeRecoveryAction {
  label: string;
  url?: string;
  command?: string;
}
