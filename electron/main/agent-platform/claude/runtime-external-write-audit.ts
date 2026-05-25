import type { ProjectFileEntry } from '../../../../shared/types';
import { listProjectFilesForProject } from '../../project-file-service';
import type { ConversationOperationStageEvent } from '../operation-log';
import type { GenericAgentRuntimeParams } from '../types';
import {
  captureExternalWriteBaseline,
  diffFileSnapshots,
  mapFileSnapshot,
  recordExternalWriteRollbackCheckpoint
} from './external-write-audit';
import type { ExternalWriteBaseline } from './types';

export interface ClaudeExternalWriteAuditBaseline {
  fileSnapshot?: Map<string, Pick<ProjectFileEntry, 'size' | 'modifiedAt'>>;
  rollbackBaseline?: ExternalWriteBaseline;
}

export async function captureClaudeExternalWriteAuditBaseline(params: GenericAgentRuntimeParams): Promise<ClaudeExternalWriteAuditBaseline> {
  try {
    return {
      fileSnapshot: mapFileSnapshot(await listProjectFilesForProject(params.project)),
      rollbackBaseline: await captureExternalWriteBaseline(params)
    };
  } catch {
    return {};
  }
}

export async function emitClaudeExternalWriteAudit(options: {
  params: GenericAgentRuntimeParams;
  baseline: ClaudeExternalWriteAuditBaseline;
  emitStage: (stage: ConversationOperationStageEvent) => void;
}): Promise<void> {
  const { params, baseline, emitStage } = options;
  try {
    const afterExternalWriteSnapshot = mapFileSnapshot(await listProjectFilesForProject(params.project));
    const diff = baseline.fileSnapshot
      ? diffFileSnapshots(baseline.fileSnapshot, afterExternalWriteSnapshot)
      : {
          added: [],
          modified: [],
          removed: []
        };
    const rollback = await recordExternalWriteRollbackCheckpoint(params, baseline.rollbackBaseline, diff);
    emitStage({
      stageId: 'stage:external_write_audit',
      title: '审计 Claude 外部写入',
      target: 'stage:external_write_audit',
      status: 'completed',
      summary: baseline.fileSnapshot
        ? `外部写入审计：added=${diff.added.length}, modified=${diff.modified.length}, removed=${diff.removed.length}, rollback=${rollback.rollbackFiles.length}, auditOnly=${rollback.auditOnlyFiles.length}`
        : 'Claude 外部写入审计未能获取运行前文件快照。',
      input: {
        checkpointPolicy: rollback.rollbackFiles.length ? 'external_rollback_available' : 'external_best_effort',
        added: diff.added.slice(0, 20),
        modified: diff.modified.slice(0, 20),
        removed: diff.removed.slice(0, 20),
        rollbackFiles: rollback.rollbackFiles.slice(0, 20),
        auditOnlyFiles: rollback.auditOnlyFiles.slice(0, 20),
        baselineSkippedFiles: baseline.rollbackBaseline?.skippedFiles.slice(0, 20) ?? []
      }
    });
  } catch (error) {
    emitStage({
      stageId: 'stage:external_write_audit',
      title: '审计 Claude 外部写入',
      target: 'stage:external_write_audit',
      status: 'failed',
      summary: error instanceof Error ? error.message : 'Claude 外部写入审计失败。',
      errorMessage: error instanceof Error ? error.message : 'external_write_audit_failed'
    });
  }
}
