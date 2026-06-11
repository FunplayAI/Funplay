import type { ProjectSessionRuntimeId } from './project';
import type { AiProviderProtocol } from './provider';
import type { RuntimeDiagnosticSeverity, RuntimeRecoveryAction } from './diagnostics';

export type AppNotificationPriority = 'low' | 'normal' | 'urgent';
export type AppUpdateStatus =
  | 'idle'
  | 'not_configured'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'not_available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';
export type ScheduledNotificationTaskStatus = 'active' | 'completed' | 'cancelled';
export type ScheduledNotificationTaskType = 'once' | 'interval' | 'cron';

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  priority: AppNotificationPriority;
  createdAt: string;
  source?: string;
}

export interface AppUpdateInfo {
  version: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  stagingPercentage?: number;
  minimumSystemVersion?: string;
}

export interface AppUpdateProgress {
  total: number;
  delta: number;
  transferred: number;
  percent: number;
  bytesPerSecond: number;
}

export interface AppUpdateSnapshot {
  status: AppUpdateStatus;
  currentVersion: string;
  updateInfo?: AppUpdateInfo;
  progress?: AppUpdateProgress;
  error?: string;
  lastCheckedAt?: string;
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
  isPackaged: boolean;
  feedSource: 'github' | 'embedded' | 'none';
  autoDownload: boolean;
}

export interface ScheduledNotificationTask {
  id: string;
  name: string;
  prompt: string;
  scheduleType: ScheduledNotificationTaskType;
  scheduleValue: string;
  priority: AppNotificationPriority;
  notifyOnComplete: boolean;
  status: ScheduledNotificationTaskStatus;
  nextRun?: string;
  durable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeDoctorFinding {
  severity: RuntimeDiagnosticSeverity;
  code: string;
  summary: string;
  detail?: string;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
  providerId?: string;
  protocol?: AiProviderProtocol;
  baseUrl?: string;
  model?: string;
  upstreamModel?: string;
  runtimeId?: ProjectSessionRuntimeId;
}

export interface RuntimeDoctorProbe {
  id: string;
  title: string;
  severity: RuntimeDiagnosticSeverity;
  findings: RuntimeDoctorFinding[];
  durationMs: number;
}

export interface RuntimeRepairAction {
  id: string;
  label: string;
  description: string;
  addresses: string[];
  params?: Record<string, string>;
}

export interface RuntimeDoctorResult {
  overallSeverity: RuntimeDiagnosticSeverity;
  probes: RuntimeDoctorProbe[];
  repairs: RuntimeRepairAction[];
  generatedAt: string;
  durationMs: number;
  providerId?: string;
  runtimeId?: ProjectSessionRuntimeId;
  exportedLog?: string;
}
