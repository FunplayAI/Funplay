import { type JSX } from 'react';
import type { Project } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { formatProjectStatus } from '../../lib/app-helpers';
import { ModalShell } from '../settings-modals';
import { InfoRow } from '../shared/InfoComponents';

export function DeleteProjectModal(props: {
  project: Project;
  deleteSourceFiles: boolean;
  isDeleting: boolean;
  onChangeDeleteSourceFiles: (value: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const canDeleteSourceFiles = !!props.project.engine?.projectPath;

  return (
    <ModalShell
      title={localize(language, '删除项目', 'Delete Project')}
      subtitle={localize(language, '先确认删除范围；默认只从 Funplay 移除项目记录。', 'Confirm the deletion scope first. By default, only the Funplay record is removed.')}
    >
      <div className="delete-project-stack">
        <div className="warning-banner danger">
          {localize(language, `删除后会从顶栏和项目列表中移除《${props.project.name}》。`, `The project "${props.project.name}" will be removed from the top tabs and project list.`)}
        </div>

        <div className="delete-project-summary">
          <InfoRow label={localize(language, '项目名称', 'Project Name')} value={props.project.name} />
          <InfoRow label={localize(language, '项目路径', 'Project Path')} value={props.project.engine?.projectPath || localize(language, '未记录源文件路径', 'No source path recorded')} />
          <InfoRow label={localize(language, '当前状态', 'Current Status')} value={formatProjectStatus(props.project.status)} />
        </div>

        <label className={`delete-project-checkbox ${canDeleteSourceFiles ? '' : 'disabled'}`}>
          <input
            type="checkbox"
            checked={props.deleteSourceFiles}
            disabled={!canDeleteSourceFiles || props.isDeleting}
            onChange={(event) => props.onChangeDeleteSourceFiles(event.target.checked)}
          />
          <span>{localize(language, '同时删除源文件目录', 'Also delete source project directory')}</span>
        </label>
        <div className="helper-copy">
          {canDeleteSourceFiles
            ? props.deleteSourceFiles
              ? localize(language, '将同时删除项目源文件目录，此操作不可恢复。', 'The source project directory will also be deleted. This action cannot be undone.')
              : localize(language, '不勾选时仅从 Funplay 中移除项目，不删除磁盘上的项目目录。', 'If unchecked, only the Funplay record will be removed and files on disk will be kept.')
            : localize(language, '这个旧项目还没有记录真实源文件路径，因此只能从 Funplay 中移除。', 'This legacy project has no recorded source path, so only the Funplay record can be removed.')}
        </div>

        <div className="modal-actions">
          <button className="prototype-secondary" onClick={props.onClose} disabled={props.isDeleting}>
            {localize(language, '取消', 'Cancel')}
          </button>
          <button className="prototype-danger" onClick={props.onConfirm} disabled={props.isDeleting}>
            {props.isDeleting
              ? localize(language, '删除中…', 'Deleting…')
              : props.deleteSourceFiles
                ? localize(language, '删除项目和源文件', 'Delete project and files')
                : localize(language, '仅删除项目', 'Delete project only')}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
