import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, ProjectFileEntry } from '../../shared/types';
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

  const selectedProjectId = selectedProject?.id;

  const handleOpenProjectFile = useCallback(
    async (filePath: string): Promise<void> => {
      if (!selectedProjectId) {
        return;
      }

      setSelectedFileId(filePath);
      try {
        const file = await window.funplay.readProjectFile(selectedProjectId, filePath);
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
    },
    [language, selectedProjectId, setRightInspectorCollapsed]
  );

  const handleSaveSelectedProjectFile = useCallback(async (): Promise<void> => {
    if (!selectedProjectId || !selectedOverlayFile) {
      return;
    }

    setIsSavingProjectFile(true);
    setFileInspectorSaveError('');
    try {
      const file = await window.funplay.writeProjectFile(
        selectedProjectId,
        selectedOverlayFile.path,
        fileInspectorDraft
      );
      const overlayFile = mapProjectFileContentToOverlay(file);
      setSelectedFileId(overlayFile.path);
      setSelectedOverlayFile(overlayFile);
      setFileInspectorDraft(overlayFile.content);
      setFileInspectorSavedAt(new Date().toISOString());
      dispatchRefreshFileTree({ projectId: selectedProjectId, reason: 'manual' });
      await refreshProjectFiles(selectedProjectId);
    } catch (error) {
      setFileInspectorSaveError(
        error instanceof Error ? error.message : localize(language, '保存文件失败。', 'Failed to save file.')
      );
    } finally {
      setIsSavingProjectFile(false);
    }
  }, [fileInspectorDraft, language, refreshProjectFiles, selectedOverlayFile, selectedProjectId]);

  const handleCloseFileInspector = useCallback((): void => {
    setSelectedFileId('');
    setSelectedOverlayFile(null);
    setRightInspectorCollapsed(true);
  }, [setRightInspectorCollapsed]);

  const handleOpenVirtualFile = useCallback(
    (fileId: string): void => {
      const target = virtualProjectFiles.find((file) => file.id === fileId);
      if (!target) {
        return;
      }

      setSelectedFileId(fileId);
      setSelectedOverlayFile(target);
      setRightInspectorCollapsed(false);
    },
    [setRightInspectorCollapsed, virtualProjectFiles]
  );

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
    handleCloseFileInspector,
    handleSaveSelectedProjectFile,
    handleOpenVirtualFile
  };
}

export function useChatFileOpeners(input: {
  projectFiles: ProjectFileEntry[];
  virtualProjectFiles: ProjectFileItem[];
  handleOpenProjectFile: (filePath: string) => Promise<void>;
  handleOpenVirtualFile: (fileId: string) => void;
}): {
  chatOpenablePaths: string[];
  handleOpenChatFilePath: (path: string) => void;
} {
  const projectOpenablePathKey = useMemo(
    () =>
      input.projectFiles
        .filter((file) => file.type !== 'directory')
        .map((file) => file.path)
        .join('\0'),
    [input.projectFiles]
  );
  const virtualOpenablePathKey = useMemo(
    () => input.virtualProjectFiles.map((file) => file.path).join('\0'),
    [input.virtualProjectFiles]
  );
  const chatOpenablePaths = useMemo(
    () => [
      ...projectOpenablePathKey.split('\0').filter(Boolean),
      ...virtualOpenablePathKey.split('\0').filter(Boolean)
    ],
    [projectOpenablePathKey, virtualOpenablePathKey]
  );
  const virtualProjectFilesRef = useRef(input.virtualProjectFiles);
  const handleOpenProjectFileRef = useRef(input.handleOpenProjectFile);
  const handleOpenVirtualFileRef = useRef(input.handleOpenVirtualFile);

  useEffect(() => {
    virtualProjectFilesRef.current = input.virtualProjectFiles;
    handleOpenProjectFileRef.current = input.handleOpenProjectFile;
    handleOpenVirtualFileRef.current = input.handleOpenVirtualFile;
  }, [input.handleOpenProjectFile, input.handleOpenVirtualFile, input.virtualProjectFiles]);

  const handleOpenChatFilePath = useCallback((path: string): void => {
    const virtualFile = virtualProjectFilesRef.current.find((file) => file.path === path);
    if (virtualFile) {
      handleOpenVirtualFileRef.current(virtualFile.id);
      return;
    }
    void handleOpenProjectFileRef.current(path);
  }, []);

  return {
    chatOpenablePaths,
    handleOpenChatFilePath
  };
}
