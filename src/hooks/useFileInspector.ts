import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';
import { isPreviewableFile } from '../components/layout/file-type-detection';
import {
  mapProjectFileContentToOverlay,
  type FileInspectorMode,
  type ProjectFileItem
} from '../components/layout/WorkspacePanels';
import { dispatchRefreshFileTree } from '../lib/file-tree-events';

export function useFileInspector(
  selectedProject: Project | null,
  refreshProjectFiles: (projectId: string) => Promise<void>,
  virtualProjectFiles: ProjectFileItem[],
  setRightInspectorCollapsed: (collapsed: boolean) => void,
  language: UiLanguage
) {
  const [selectedFileId, setSelectedFileId] = useState('');
  const [selectedOverlayFile, setSelectedOverlayFile] = useState<ProjectFileItem | null>(null);
  const [fileInspectorMode, setFileInspectorMode] = useState<FileInspectorMode>('edit');
  const [fileInspectorDraft, setFileInspectorDraft] = useState('');
  const [isSavingProjectFile, setIsSavingProjectFile] = useState(false);
  const [fileInspectorSaveError, setFileInspectorSaveError] = useState('');
  const [fileInspectorSavedAt, setFileInspectorSavedAt] = useState('');
  const selectedOverlayFilePathRef = useRef<string | null>(null);

  useEffect(() => {
    const previousPath = selectedOverlayFilePathRef.current;
    const nextPath = selectedOverlayFile?.path ?? null;

    if (!selectedOverlayFile) {
      setFileInspectorDraft('');
      setFileInspectorMode('edit');
      setFileInspectorSaveError('');
      setFileInspectorSavedAt('');
      selectedOverlayFilePathRef.current = null;
      return;
    }

    setFileInspectorDraft(selectedOverlayFile.content);
    if (previousPath !== nextPath) {
      setFileInspectorMode(isPreviewableFile(selectedOverlayFile.path) ? 'preview' : 'edit');
      setFileInspectorSaveError('');
      setFileInspectorSavedAt('');
    }
    selectedOverlayFilePathRef.current = nextPath;
  }, [selectedOverlayFile]);

  async function handleOpenProjectFile(filePath: string): Promise<void> {
    if (!selectedProject) {
      return;
    }

    setSelectedFileId(filePath);
    try {
      const file = await window.funplay.readProjectFile(selectedProject.id, filePath);
      setSelectedOverlayFile(mapProjectFileContentToOverlay(file));
      setRightInspectorCollapsed(false);
    } catch (error) {
      setSelectedOverlayFile({
        id: filePath,
        label: filePath.split('/').pop() || filePath,
        path: filePath,
        content: error instanceof Error ? error.message : localize(language, '读取文件失败。', 'Failed to read file.')
      });
      setRightInspectorCollapsed(false);
    }
  }

  async function handleSaveSelectedProjectFile(): Promise<void> {
    if (!selectedProject || !selectedOverlayFile) {
      return;
    }

    setIsSavingProjectFile(true);
    setFileInspectorSaveError('');
    try {
      const file = await window.funplay.writeProjectFile(selectedProject.id, selectedOverlayFile.path, fileInspectorDraft);
      const overlayFile = mapProjectFileContentToOverlay(file);
      setSelectedFileId(overlayFile.path);
      setSelectedOverlayFile(overlayFile);
      setFileInspectorDraft(overlayFile.content);
      setFileInspectorSavedAt(new Date().toISOString());
      dispatchRefreshFileTree({ projectId: selectedProject.id, reason: 'manual' });
      await refreshProjectFiles(selectedProject.id);
    } catch (error) {
      setFileInspectorSaveError(error instanceof Error ? error.message : localize(language, '保存文件失败。', 'Failed to save file.'));
    } finally {
      setIsSavingProjectFile(false);
    }
  }

  function handleOpenVirtualFile(fileId: string): void {
    const target = virtualProjectFiles.find((file) => file.id === fileId);
    if (!target) {
      return;
    }

    setSelectedFileId(fileId);
    setSelectedOverlayFile(target);
    setRightInspectorCollapsed(false);
  }

  return {
    selectedFileId,
    setSelectedFileId,
    selectedOverlayFile,
    setSelectedOverlayFile,
    fileInspectorMode,
    setFileInspectorMode,
    fileInspectorDraft,
    setFileInspectorDraft,
    isSavingProjectFile,
    fileInspectorSaveError,
    setFileInspectorSaveError,
    fileInspectorSavedAt,
    handleOpenProjectFile,
    handleSaveSelectedProjectFile,
    handleOpenVirtualFile
  };
}
