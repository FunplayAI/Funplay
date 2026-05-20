import { type JSX } from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { SessionCheckpointPreview } from '../../../shared/types';
import { localize, useUiLanguage, type UiLanguage } from '../../i18n';
import { formatAbsoluteTime } from '../../lib/app-helpers';
import { ModalShell } from '../settings-modals';
import { InfoRow } from '../shared/InfoComponents';
import { Button, IconButton } from '../ui/index';

export function SessionChangesPanel(props: {
  preview: SessionCheckpointPreview | null;
  isLoading: boolean;
  onRestore: (snapshotId: string) => void;
  onClose: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const fileChanges = props.preview?.fileChanges ?? [];
  const skippedFiles = props.preview?.skippedFileChanges ?? [];

  return (
    <section className="session-changes-panel" aria-label={localize(language, '本轮变更', 'Current Run Changes')}>
      <div className="session-changes-header">
        <div>
          <strong>{localize(language, '本轮变更', 'Current Run Changes')}</strong>
          <span>
            {props.isLoading
              ? localize(language, '正在读取 checkpoint…', 'Reading checkpoint…')
              : props.preview
                ? formatAbsoluteTime(props.preview.checkpointCreatedAt)
                : localize(language, '暂无 checkpoint', 'No checkpoint yet')}
          </span>
        </div>
        <div className="session-changes-actions">
          {props.preview ? (
            <Button
              size="compact"
              variant="secondary"
              leadingIcon={<RotateCcw size={12} aria-hidden="true" />}
              onClick={() => props.onRestore(props.preview!.snapshotId)}
            >
              {localize(language, '恢复', 'Restore')}
            </Button>
          ) : null}
          <IconButton
            className="session-changes-icon-button"
            icon={<X size={15} aria-hidden="true" />}
            label={localize(language, '关闭本轮变更', 'Close current run changes')}
            onClick={props.onClose}
          />
        </div>
      </div>

      {props.preview ? (
        <>
          <div className="session-changes-stats">
            <span>{localize(language, `消息回退 ${props.preview.addedMessages}`, `${props.preview.addedMessages} message(s)`)}</span>
            <span>{localize(language, `文件 ${fileChanges.length}`, `${fileChanges.length} file(s)`)}</span>
          </div>

          {fileChanges.length > 0 ? (
            <div className="session-changes-file-list">
              {fileChanges.map((file) => (
                <details key={file.path} className="session-change-file">
                  <summary>
                    <span>{file.path}</span>
                    <em>{formatCheckpointFileStatus(file.status, language)}</em>
                  </summary>
                  <SessionChangeDiffPreview path={file.path} diffPreview={file.diffPreview} />
                </details>
              ))}
            </div>
          ) : (
            <div className="session-changes-empty">
              {localize(language, '当前 checkpoint 没有记录文件变更。', 'No file changes recorded for this checkpoint.')}
            </div>
          )}

          {skippedFiles.length > 0 ? (
            <div className="session-changes-empty warning">
              {localize(language, '无法预览：', 'Could not preview: ')}{skippedFiles.join(', ')}
            </div>
          ) : null}
        </>
      ) : (
        <div className="session-changes-empty">
          {localize(language, 'Agent 写入文件后，这里会显示本轮 diff 与恢复入口。', 'After Agent writes files, this panel shows diffs and restore controls.')}
        </div>
      )}
    </section>
  );
}

export function RestoreCheckpointModal(props: {
  preview: SessionCheckpointPreview;
  isRestoring: boolean;
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const fileChanges = props.preview.fileChanges ?? [];
  const skippedFileChanges = props.preview.skippedFileChanges ?? [];

  return (
    <ModalShell
      title={localize(language, '恢复会话检查点', 'Restore Session Checkpoint')}
      subtitle={localize(language, '恢复前先确认这次回退会影响当前会话的哪些消息。', 'Review the impact before rolling the current session back.')}
    >
      <div className="delete-project-stack">
        <div className="warning-banner">
          {localize(
            language,
            `将恢复到“${props.preview.checkpointNote}”，当前会话后续消息会被回退。`,
            `The session will be restored to "${props.preview.checkpointNote}", and later messages will be rolled back.`
          )}
        </div>

        <div className="delete-project-summary">
          <InfoRow label={localize(language, '检查点时间', 'Checkpoint Time')} value={formatAbsoluteTime(props.preview.checkpointCreatedAt)} />
          <InfoRow label={localize(language, '当前消息数', 'Current Messages')} value={String(props.preview.currentMessageCount)} />
          <InfoRow label={localize(language, '检查点消息数', 'Checkpoint Messages')} value={String(props.preview.checkpointMessageCount)} />
          <InfoRow label={localize(language, '将回退消息', 'Messages Rolled Back')} value={String(props.preview.addedMessages)} />
        </div>

        {props.preview.currentLatestPreview ? (
          <div className="helper-copy">
            <strong>{localize(language, '当前最新消息', 'Current Latest Message')}</strong>
            <div>{props.preview.currentLatestPreview}</div>
          </div>
        ) : null}

        {props.preview.checkpointLatestPreview ? (
          <div className="helper-copy">
            <strong>{localize(language, '恢复后最新消息', 'Latest Message After Restore')}</strong>
            <div>{props.preview.checkpointLatestPreview}</div>
          </div>
        ) : null}

        {fileChanges.length > 0 ? (
          <div className="helper-copy">
            <strong>{localize(language, '将同步恢复文件', 'Files Restored Together')}</strong>
            <div>
              {localize(
                language,
                `将恢复 ${fileChanges.length} 个本轮 Agent 写入过的文件。`,
                `${fileChanges.length} file(s) written by this Agent run will be restored.`
              )}
            </div>
            {fileChanges.slice(0, 6).map((file) => (
              <details key={file.path}>
                <summary>
                  {file.path} · {formatCheckpointFileStatus(file.status, language)}
                </summary>
                <SessionChangeDiffPreview path={file.path} diffPreview={file.diffPreview} />
              </details>
            ))}
            {fileChanges.length > 6 ? (
              <div>{localize(language, `另有 ${fileChanges.length - 6} 个文件未展开显示。`, `${fileChanges.length - 6} more file(s) not expanded.`)}</div>
            ) : null}
          </div>
        ) : null}

        {skippedFileChanges.length > 0 ? (
          <div className="helper-copy">
            <strong>{localize(language, '无法预览的文件', 'Files Not Previewed')}</strong>
            <div>{skippedFileChanges.join(', ')}</div>
          </div>
        ) : null}

        <div className="modal-actions">
          <Button variant="secondary" onClick={props.onClose} disabled={props.isRestoring}>
            {localize(language, '取消', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            loading={props.isRestoring}
            leadingIcon={<RotateCcw size={14} aria-hidden="true" />}
            onClick={props.onConfirm}
          >
            {props.isRestoring ? localize(language, '恢复中…', 'Restoring…') : localize(language, '确认恢复', 'Confirm Restore')}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

export function formatCheckpointFileStatus(status: 'added' | 'modified' | 'removed', language: UiLanguage): string {
  if (status === 'added') return localize(language, '新增', 'Added');
  if (status === 'removed') return localize(language, '删除', 'Removed');
  return localize(language, '修改', 'Modified');
}

function SessionChangeDiffPreview(props: {
  path: string;
  diffPreview: string;
}): JSX.Element {
  const language = useUiLanguage();
  const lines = props.diffPreview.length > 0 ? props.diffPreview.split('\n') : [''];

  return (
    <div className="session-change-diff-preview file-editor-shell" role="region" aria-label={localize(language, `${props.path} 的变更预览`, `Change preview for ${props.path}`)}>
      <div className="file-editor-gutter session-change-diff-gutter" aria-hidden="true">
        {lines.map((line, index) => (
          <span key={`${index + 1}-${line}`} className="file-editor-gutter-line">
            {index + 1}
          </span>
        ))}
      </div>
      <pre className="file-editor-highlight session-change-diff-code">
        {lines.map((line, index) => {
          const kind = getDiffLineKind(line);
          const marker = getDiffLineMarker(line, kind);
          const text = marker ? line.slice(1) : line;
          return (
            <span key={`${index + 1}-${line}`} className={`session-change-diff-line ${kind}`}>
              <span className="session-change-diff-marker" aria-hidden="true">{marker}</span>
              <code>{text || ' '}</code>
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function getDiffLineKind(line: string): 'add' | 'remove' | 'header' | 'context' {
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('@@')
  ) {
    return 'header';
  }
  if (line.startsWith('+')) {
    return 'add';
  }
  if (line.startsWith('-')) {
    return 'remove';
  }
  return 'context';
}

function getDiffLineMarker(line: string, kind: 'add' | 'remove' | 'header' | 'context'): string {
  if (kind === 'add') return '+';
  if (kind === 'remove') return '-';
  return line.startsWith(' ') ? ' ' : '';
}
