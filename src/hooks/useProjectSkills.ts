import { useCallback, useEffect, useState } from 'react';
import type { AgentSkillCatalogItem, AgentSkillCatalogResult, Project, ProjectAgentSkill } from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';
import {
  createEmptyProjectSkillDraft,
  formatCatalogSkillInstruction,
  makeCatalogProjectSkillId,
  makeProjectSkillId
} from '../lib/app-helpers';
import type { ProjectAgentSkillDraft, ProjectSettingsTab } from '../lib/app-types';

interface UseProjectSkillsParams {
  selectedProjectView: Project | null;
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  language: UiLanguage;
  appMode: string;
  section: string;
  projectSettingsTab: ProjectSettingsTab;
}

export function useProjectSkills({
  selectedProjectView,
  setProjects,
  language,
  appMode,
  section,
  projectSettingsTab
}: UseProjectSkillsParams) {
  const [skillDraft, setSkillDraft] = useState<ProjectAgentSkillDraft>(() => createEmptyProjectSkillDraft());
  const [editingSkillId, setEditingSkillId] = useState('');
  const [skillCatalog, setSkillCatalog] = useState<AgentSkillCatalogResult | null>(null);
  const [isLoadingSkillCatalog, setIsLoadingSkillCatalog] = useState(false);
  const [skillCatalogError, setSkillCatalogError] = useState('');

  const loadSkillCatalog = useCallback(async (refresh = false): Promise<void> => {
    setIsLoadingSkillCatalog(true);
    setSkillCatalogError('');
    try {
      const catalog = await window.funplay.listAgentSkillCatalog({ refresh });
      setSkillCatalog(catalog);
    } catch (error) {
      setSkillCatalogError(error instanceof Error ? error.message : localize(language, 'Skill 仓库同步失败。', 'Failed to sync the skill repository.'));
    } finally {
      setIsLoadingSkillCatalog(false);
    }
  }, [language]);

  useEffect(() => {
    if (appMode !== 'workspace' || section !== 'settings' || projectSettingsTab !== 'skills' || skillCatalog || isLoadingSkillCatalog) {
      return;
    }
    void loadSkillCatalog(false);
  }, [appMode, section, projectSettingsTab, skillCatalog, isLoadingSkillCatalog, loadSkillCatalog]);

  async function updateSelectedProjectSkills(skills: ProjectAgentSkill[]): Promise<void> {
    if (!selectedProjectView) {
      return;
    }
    const updated = await window.funplay.updateProjectAgentPolicy(selectedProjectView.id, { skills });
    setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
  }

  async function handleSaveProjectSkill(): Promise<void> {
    if (!selectedProjectView) {
      return;
    }

    const name = skillDraft.name.trim();
    const instruction = skillDraft.instruction.trim();
    if (!name || !instruction) {
      return;
    }

    const now = new Date().toISOString();
    const currentSkills = selectedProjectView.agentPolicy?.skills ?? [];
    const existingSkill = editingSkillId
      ? currentSkills.find((skill) => skill.id === editingSkillId)
      : undefined;
    const nextSkill: ProjectAgentSkill = {
      ...existingSkill,
      id: existingSkill?.id ?? skillDraft.id ?? makeProjectSkillId(),
      name,
      description: skillDraft.description.trim() || undefined,
      trigger: skillDraft.trigger.trim() || undefined,
      instruction,
      enabled: skillDraft.enabled,
      createdAt: existingSkill?.createdAt ?? now,
      updatedAt: now
    };
    const nextSkills = existingSkill
      ? currentSkills.map((skill) => (skill.id === existingSkill.id ? nextSkill : skill))
      : [...currentSkills, nextSkill];

    await updateSelectedProjectSkills(nextSkills);
    setSkillDraft(createEmptyProjectSkillDraft());
    setEditingSkillId('');
  }

  async function handleInstallCatalogSkill(catalogSkill: AgentSkillCatalogItem): Promise<void> {
    if (!selectedProjectView) {
      return;
    }

    const now = new Date().toISOString();
    const currentSkills = selectedProjectView.agentPolicy?.skills ?? [];
    const existingSkill = currentSkills.find((skill) =>
      skill.source === 'funplay-skill'
        ? skill.sourceId === catalogSkill.id
        : skill.id === catalogSkill.id || skill.id === makeCatalogProjectSkillId(catalogSkill.id)
    );
    const nextSkill: ProjectAgentSkill = {
      id: existingSkill?.id ?? makeCatalogProjectSkillId(catalogSkill.id),
      name: catalogSkill.name,
      description: catalogSkill.description,
      trigger: catalogSkill.description,
      instruction: formatCatalogSkillInstruction(catalogSkill),
      enabled: true,
      source: 'funplay-skill',
      sourceId: catalogSkill.id,
      sourcePath: catalogSkill.sourcePath,
      repositoryUrl: catalogSkill.repositoryUrl,
      repositoryRef: catalogSkill.repositoryRef,
      version: catalogSkill.commitSha,
      dependencies: catalogSkill.dependencies,
      examples: catalogSkill.examples,
      createdAt: existingSkill?.createdAt ?? now,
      updatedAt: now
    };
    const nextSkills = existingSkill
      ? currentSkills.map((skill) => (skill.id === existingSkill.id ? nextSkill : skill))
      : [...currentSkills, nextSkill];

    await updateSelectedProjectSkills(nextSkills);
  }

  async function handleToggleProjectSkill(skillId: string): Promise<void> {
    if (!selectedProjectView) {
      return;
    }
    const now = new Date().toISOString();
    const currentSkills = selectedProjectView.agentPolicy?.skills ?? [];
    await updateSelectedProjectSkills(
      currentSkills.map((skill) =>
        skill.id === skillId
          ? {
              ...skill,
              enabled: !skill.enabled,
              updatedAt: now
            }
          : skill
      )
    );
  }

  async function handleDeleteProjectSkill(skillId: string): Promise<void> {
    if (!selectedProjectView) {
      return;
    }
    const currentSkills = selectedProjectView.agentPolicy?.skills ?? [];
    await updateSelectedProjectSkills(currentSkills.filter((skill) => skill.id !== skillId));
    if (editingSkillId === skillId) {
      setSkillDraft(createEmptyProjectSkillDraft());
      setEditingSkillId('');
    }
  }

  function handleEditProjectSkill(skill: ProjectAgentSkill): void {
    setEditingSkillId(skill.id);
    setSkillDraft({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? '',
      trigger: skill.trigger ?? '',
      instruction: skill.instruction,
      enabled: skill.enabled
    });
  }

  function handleCancelProjectSkillEdit(): void {
    setSkillDraft(createEmptyProjectSkillDraft());
    setEditingSkillId('');
  }

  return {
    skillDraft,
    setSkillDraft,
    editingSkillId,
    setEditingSkillId,
    skillCatalog,
    isLoadingSkillCatalog,
    skillCatalogError,
    loadSkillCatalog,
    handleSaveProjectSkill,
    handleInstallCatalogSkill,
    handleToggleProjectSkill,
    handleDeleteProjectSkill,
    handleEditProjectSkill,
    handleCancelProjectSkillEdit
  };
}
