import { useState } from 'react';
import type { ProjectMemoryClearScope, ProjectMemoryFileContent, ProjectMemoryFileSummary } from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';

export function useProjectMemory(projectId: string | undefined, language: UiLanguage) {
  const [memoryFiles, setMemoryFiles] = useState<ProjectMemoryFileSummary[]>([]);
  const [selectedMemoryPath, setSelectedMemoryPath] = useState('');
  const [selectedMemoryFile, setSelectedMemoryFile] = useState<ProjectMemoryFileContent | null>(null);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [isLoadingMemory, setIsLoadingMemory] = useState(false);
  const [isSavingMemory, setIsSavingMemory] = useState(false);
  const [memoryError, setMemoryError] = useState('');

  async function loadProjectMemoryFile(filePath: string): Promise<void> {
    if (!projectId || !filePath) {
      setSelectedMemoryFile(null);
      setMemoryDraft('');
      return;
    }

    setIsLoadingMemory(true);
    setMemoryError('');
    try {
      const file = await window.funplay.readProjectMemoryFile(projectId, filePath);
      setSelectedMemoryPath(file.path);
      setSelectedMemoryFile(file);
      setMemoryDraft(file.content);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : localize(language, 'Memory 文件读取失败。', 'Failed to read memory file.'));
    } finally {
      setIsLoadingMemory(false);
    }
  }

  async function refreshProjectMemoryFiles(preferredPath = selectedMemoryPath): Promise<void> {
    if (!projectId) {
      setMemoryFiles([]);
      setSelectedMemoryPath('');
      setSelectedMemoryFile(null);
      setMemoryDraft('');
      setMemoryError(localize(language, '请先选择一个项目。', 'Select a project first.'));
      return;
    }

    setIsLoadingMemory(true);
    setMemoryError('');
    try {
      const files = await window.funplay.listProjectMemoryFiles(projectId);
      setMemoryFiles(files);
      const nextPath =
        (preferredPath && files.some((file) => file.path === preferredPath) ? preferredPath : '') ||
        files[0]?.path ||
        '';
      setSelectedMemoryPath(nextPath);
      if (nextPath) {
        const file = await window.funplay.readProjectMemoryFile(projectId, nextPath);
        setSelectedMemoryFile(file);
        setMemoryDraft(file.content);
      } else {
        setSelectedMemoryFile(null);
        setMemoryDraft('');
      }
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : localize(language, 'Memory 列表读取失败。', 'Failed to load memory files.'));
    } finally {
      setIsLoadingMemory(false);
    }
  }

  async function handleSaveMemoryFile(): Promise<void> {
    if (!projectId || !selectedMemoryPath) {
      return;
    }

    setIsSavingMemory(true);
    setMemoryError('');
    try {
      const file = await window.funplay.saveProjectMemoryFile(projectId, selectedMemoryPath, memoryDraft);
      setSelectedMemoryFile(file);
      setMemoryDraft(file.content);
      await refreshProjectMemoryFiles(file.path);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : localize(language, 'Memory 保存失败。', 'Failed to save memory.'));
    } finally {
      setIsSavingMemory(false);
    }
  }

  async function handleClearProjectMemory(scope: ProjectMemoryClearScope, filePath?: string): Promise<void> {
    if (!projectId) {
      return;
    }

    setIsSavingMemory(true);
    setMemoryError('');
    try {
      const files = await window.funplay.clearProjectMemory(projectId, { scope, filePath });
      setMemoryFiles(files);
      const nextPath =
        scope === 'file' && filePath && files.some((file) => file.path === filePath)
          ? filePath
          : files[0]?.path || '';
      if (nextPath) {
        await loadProjectMemoryFile(nextPath);
      } else {
        setSelectedMemoryPath('');
        setSelectedMemoryFile(null);
        setMemoryDraft('');
      }
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : localize(language, 'Memory 清理失败。', 'Failed to clear memory.'));
    } finally {
      setIsSavingMemory(false);
    }
  }

  return {
    memoryFiles,
    selectedMemoryPath,
    selectedMemoryFile,
    memoryDraft,
    setMemoryDraft,
    isLoadingMemory,
    isSavingMemory,
    memoryError,
    loadProjectMemoryFile,
    refreshProjectMemoryFiles,
    handleSaveMemoryFile,
    handleClearProjectMemory
  };
}
