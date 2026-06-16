import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  AssetGenerationProviderProfile,
  AssetGenerationRequest,
  Project
} from '../../shared/types';
import { localize } from '../i18n';
import { dispatchRefreshFileTree } from '../lib/file-tree-events';
import type { LanguagePreference } from '../lib/app-types';

export function useAssetGenerationCenter(input: {
  appMode: 'welcome' | 'onboarding' | 'workspace';
  mcpPlugins: unknown[];
  assetGenerationProviderConfigs: unknown[];
  selectedProjectView: Project | null | undefined;
  language: LanguagePreference;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  refreshProjectFiles: (projectId: string) => Promise<void>;
}): {
  assetGenerationProviders: AssetGenerationProviderProfile[];
  handleGenerateAsset: (request: AssetGenerationRequest) => Promise<Project>;
  handleImportGeneratedAsset: (jobId: string) => Promise<Project>;
  handleCancelAssetGenerationJob: (jobId: string) => Promise<Project>;
  handleRetryAssetGenerationJob: (jobId: string) => Promise<Project>;
} {
  const [assetGenerationProviders, setAssetGenerationProviders] = useState<AssetGenerationProviderProfile[]>([]);
  const completedJobIdsRef = useRef(new Set<string>());

  const refreshAssetGenerationProviders = useCallback(async (): Promise<void> => {
    if (!window.funplay?.listAssetGenerationProviders) {
      setAssetGenerationProviders([]);
      return;
    }
    try {
      setAssetGenerationProviders(await window.funplay.listAssetGenerationProviders());
    } catch {
      setAssetGenerationProviders([]);
    }
  }, []);

  useEffect(() => {
    if (input.appMode !== 'workspace') {
      return;
    }
    void refreshAssetGenerationProviders();
  }, [input.appMode, input.mcpPlugins, input.assetGenerationProviderConfigs, refreshAssetGenerationProviders]);

  const requireProject = useCallback((): Project => {
    if (!input.selectedProjectView) {
      throw new Error(localize(input.language, '请先选择项目。', 'Select a project first.'));
    }
    return input.selectedProjectView;
  }, [input.language, input.selectedProjectView]);

  const commitProject = useCallback((updated: Project): void => {
    input.setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
  }, [input.setProjects]);

  useEffect(() => {
    if (input.appMode !== 'workspace' || !window.funplay?.onAssetGenerationProjectUpdated) {
      return;
    }
    return window.funplay.onAssetGenerationProjectUpdated((updated) => {
      commitProject(updated);
      const completedJobs = (updated.assetGenerationJobs ?? []).filter((job) => job.status === 'completed' && job.outputs.length > 0);
      const hasNewCompletedOutput = completedJobs.some((job) => !completedJobIdsRef.current.has(job.id));
      for (const job of completedJobs) {
        completedJobIdsRef.current.add(job.id);
      }
      if (hasNewCompletedOutput) {
        void input.refreshProjectFiles(updated.id);
        dispatchRefreshFileTree({ projectId: updated.id, reason: 'asset-generation' });
      }
    });
  }, [commitProject, input.appMode, input.refreshProjectFiles]);

  const handleGenerateAsset = useCallback(async (request: AssetGenerationRequest): Promise<Project> => {
    const project = requireProject();
    const updated = await window.funplay.generateAsset(project.id, request);
    commitProject(updated);
    await input.refreshProjectFiles(updated.id);
    dispatchRefreshFileTree({ projectId: updated.id, reason: 'asset-generation' });
    return updated;
  }, [commitProject, input, requireProject]);

  const handleImportGeneratedAsset = useCallback(async (jobId: string): Promise<Project> => {
    const project = requireProject();
    const updated = await window.funplay.importGeneratedAsset(project.id, jobId);
    commitProject(updated);
    await input.refreshProjectFiles(updated.id);
    dispatchRefreshFileTree({ projectId: updated.id, reason: 'asset-import' });
    return updated;
  }, [commitProject, input, requireProject]);

  const handleCancelAssetGenerationJob = useCallback(async (jobId: string): Promise<Project> => {
    const project = requireProject();
    const updated = await window.funplay.cancelAssetGenerationJob(project.id, jobId);
    commitProject(updated);
    return updated;
  }, [commitProject, requireProject]);

  const handleRetryAssetGenerationJob = useCallback(async (jobId: string): Promise<Project> => {
    const project = requireProject();
    const job = (project.assetGenerationJobs ?? []).find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(localize(input.language, '找不到要重试的任务。', 'Could not find the job to retry.'));
    }
    const request: AssetGenerationRequest = {
      title: job.title,
      kind: job.kind,
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      providerId: job.providerId,
      providerAdapter: job.providerAdapter,
      stylePresetId: job.stylePresetId,
      references: job.references,
      targetEngine: job.targetEngine,
      outputSpec: job.outputSpec,
      createdBy: job.createdBy
    };
    return handleGenerateAsset(request);
  }, [handleGenerateAsset, input.language, requireProject]);

  return {
    assetGenerationProviders,
    handleGenerateAsset,
    handleImportGeneratedAsset,
    handleCancelAssetGenerationJob,
    handleRetryAssetGenerationJob
  };
}
