import { type JSX } from 'react';
import type { AgentSkillCatalogItem, AgentSkillCatalogResult, AgentSkillRegistrySnapshot, Project, ProjectAgentSkill } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import type { ProjectAgentSkillDraft } from '../../lib/app-types';
import { makeCatalogProjectSkillId } from '../../lib/app-helpers';

export function SkillsPage(props: {
  project: Project | null;
  draft: ProjectAgentSkillDraft;
  editingSkillId: string;
  catalog: AgentSkillCatalogResult | null;
  registry: AgentSkillRegistrySnapshot | null;
  isLoadingCatalog: boolean;
  isLoadingRegistry: boolean;
  catalogError: string;
  registryError: string;
  onRefreshCatalog: () => Promise<void>;
  onRefreshRegistry: () => Promise<void>;
  onInstallCatalogSkill: (skill: AgentSkillCatalogItem) => Promise<void>;
  onChangeDraft: (draft: ProjectAgentSkillDraft) => void;
  onSaveSkill: () => Promise<void>;
  onEditSkill: (skill: ProjectAgentSkill) => void;
  onCancelEdit: () => void;
  onToggleSkill: (skillId: string) => Promise<void>;
  onDeleteSkill: (skillId: string) => Promise<void>;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const skills = props.project?.agentPolicy?.skills ?? [];
  const enabledCount = skills.filter((skill) => skill.enabled).length;
  const canSave = Boolean(props.project && props.draft.name.trim() && props.draft.instruction.trim());
  const findInstalledSkill = (catalogSkill: AgentSkillCatalogItem): ProjectAgentSkill | undefined =>
    skills.find((skill) =>
      skill.source === 'funplay-skill'
        ? skill.sourceId === catalogSkill.id
        : skill.id === catalogSkill.id || skill.id === makeCatalogProjectSkillId(catalogSkill.id)
    );

  return (
    <div className="skills-page">
      <div className="skills-toolbar">
        <div>
          <div className="section-heading">{t('项目 Skills', 'Project Skills')}</div>
          <div className="helper-copy">{t('这里维护的是用户赋予 Agent 的项目级工作技能与准则，不暴露内置工具能力。', 'These are user-provided project skills and working rules for the agent; built-in tool capabilities stay hidden.')}</div>
        </div>
        <div className="skills-count-pill">{t(`${enabledCount}/${skills.length} 已启用`, `${enabledCount}/${skills.length} enabled`)}</div>
      </div>

      <div className="skill-catalog-panel">
        <div className="skill-editor-header">
          <div>
            <strong>{t('Claude Code 文件系统 Skills', 'Claude Code Filesystem Skills')}</strong>
            <span>
              {props.registry
                ? t(
                    `${props.registry.skills.length} 个索引 · ${props.registry.conflicts.length} 个覆盖冲突 · ${props.registry.sourcePrecedence.length} 个来源`,
                    `${props.registry.skills.length} indexed · ${props.registry.conflicts.length} overrides · ${props.registry.sourcePrecedence.length} sources`
                  )
                : t('读取项目与用户 .claude/skills 的平台索引。', 'Read the platform index from project and user .claude/skills.')}
            </span>
          </div>
          <button className="prototype-secondary small" disabled={props.isLoadingRegistry || !props.project} onClick={() => void props.onRefreshRegistry()}>
            {props.isLoadingRegistry ? t('刷新中…', 'Refreshing…') : t('刷新索引', 'Refresh Index')}
          </button>
        </div>
        {props.registryError ? <div className="warning-banner error">{props.registryError}</div> : null}
        <div className="skill-card-meta">
          {t('优先级：项目 Skill 先发现，用户 Skill 后覆盖；Agent 只自动激活可信且不需要额外审批的匹配项。', 'Precedence: project skills are discovered first and user skills override later; the Agent only auto-activates trusted matching skills that do not require extra approval.')}
        </div>
        {props.registry?.sourcePrecedence.length ? (
          <div className="skill-card-meta">
            {props.registry.sourcePrecedence.map((source) => `${source.source}:${source.priority}`).join(' → ')}
          </div>
        ) : null}
        {props.registry?.conflicts.length ? (
          <div className="warning-banner">
            {props.registry.conflicts.map((conflict) =>
              t(
                `${conflict.name} 由 ${conflict.candidates.at(-1)?.source ?? 'unknown'} 覆盖 ${conflict.candidates.length - 1} 个同名来源`,
                `${conflict.name} is resolved from ${conflict.candidates.at(-1)?.source ?? 'unknown'} over ${conflict.candidates.length - 1} same-name source(s)`
              )
            ).join('\n')}
          </div>
        ) : null}
        <div className="skill-catalog-grid">
          {props.registry?.skills.slice(0, 12).map((skill) => (
            <div key={skill.id} className="skill-catalog-card">
              <div className="skill-card-top">
                <strong>{skill.name}</strong>
                <span className={`skill-status ${skill.trustLevel === 'trusted' ? 'ok' : skill.permissionPolicy === 'approval_required' ? 'warning' : 'neutral'}`}>
                  {skill.trustLevel}
                </span>
              </div>
              {skill.description ? <p>{skill.description}</p> : null}
              <div className="skill-card-meta">{skill.source} · {skill.verificationStatus}</div>
              <div className="skill-card-meta">{skill.permissionPolicy} · {skill.scriptPolicy}</div>
              {skill.allowedTools?.length ? <div className="skill-card-meta">{t('建议工具：', 'Suggested tools: ')}{skill.allowedTools.join(', ')}</div> : null}
            </div>
          ))}
          {props.registry && props.registry.skills.length === 0 ? (
            <div className="empty-state">
              <strong>{t('没有发现文件系统 Skills', 'No filesystem skills found')}</strong>
              <span>{t('在项目或用户目录创建 .claude/skills/*/SKILL.md 后会显示在这里。', 'Create .claude/skills/*/SKILL.md in the project or user directory to show entries here.')}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="skill-catalog-panel">
        <div className="skill-editor-header">
          <div>
            <strong>{t('Funplay Skill 仓库', 'Funplay Skill Repository')}</strong>
            <span>
              {props.catalog
                ? t(
                    `已获取 ${props.catalog.skills.length} 个 Skill · ${props.catalog.cached ? '缓存' : '最新'} · ${props.catalog.repositoryRef}`,
                    `${props.catalog.skills.length} skills · ${props.catalog.cached ? 'cached' : 'fresh'} · ${props.catalog.repositoryRef}`
                  )
                : t('从 FunplayAI/funplay-skill 获取可复用的游戏开发 Skills。', 'Fetch reusable game-development skills from FunplayAI/funplay-skill.')}
            </span>
          </div>
          <button className="prototype-secondary small" disabled={props.isLoadingCatalog} onClick={() => void props.onRefreshCatalog()}>
            {props.isLoadingCatalog ? t('同步中…', 'Syncing…') : t('从仓库同步', 'Sync')}
          </button>
        </div>
        {props.catalogError ? <div className="warning-banner error">{props.catalogError}</div> : null}
        <div className="skill-catalog-grid">
          {props.catalog?.skills.map((catalogSkill) => {
            const installedSkill = findInstalledSkill(catalogSkill);
            return (
              <div key={catalogSkill.id} className="skill-catalog-card">
                <div className="skill-card-top">
                  <strong>{catalogSkill.name}</strong>
                  <span className={`skill-status ${installedSkill?.enabled ? 'ok' : installedSkill ? 'neutral' : 'warning'}`}>
                    {installedSkill?.enabled ? t('已启用', 'Enabled') : installedSkill ? t('已导入', 'Imported') : t('未导入', 'Not imported')}
                  </span>
                </div>
                {catalogSkill.description ? <p>{catalogSkill.description}</p> : null}
                {catalogSkill.dependencies.length ? (
                  <div className="skill-card-meta">{t('依赖：', 'Dependencies: ')}{catalogSkill.dependencies.join(', ')}</div>
                ) : null}
                <div className="skill-card-actions">
                  <button className="prototype-secondary small" disabled={!props.project} onClick={() => void props.onInstallCatalogSkill(catalogSkill)}>
                    {installedSkill ? t('更新并启用', 'Update and Enable') : t('启用到项目', 'Enable for Project')}
                  </button>
                  {installedSkill ? (
                    <button className="prototype-secondary small" disabled={!props.project} onClick={() => props.onEditSkill(installedSkill)}>
                      {t('编辑覆盖', 'Edit Override')}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
          {!props.catalog && !props.isLoadingCatalog ? (
            <div className="empty-state">
              <strong>{t('尚未同步 Skill 仓库', 'Skill repository not synced')}</strong>
              <span>{t('点击“从仓库同步”获取当前开源仓库中的 Skills。', 'Click Sync to fetch skills from the open-source repository.')}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="skill-editor">
        <div className="skill-editor-header">
          <div>
            <strong>{props.editingSkillId ? t('编辑项目 Skill', 'Edit Project Skill') : t('添加自定义 Skill', 'Add Custom Skill')}</strong>
            <span>{t('写清楚什么时候使用，以及 Agent 应该遵守的具体工作方式。', 'Define when it applies and the concrete behavior the agent should follow.')}</span>
          </div>
          {props.editingSkillId ? (
            <button className="prototype-ghost small" onClick={props.onCancelEdit}>
              {t('取消编辑', 'Cancel')}
            </button>
          ) : null}
        </div>

        <div className="skill-form-grid">
          <label className="skill-form-row">
            <span>{t('名称', 'Name')}</span>
            <input
              value={props.draft.name}
              disabled={!props.project}
              placeholder={t('例如：Unity 2D 场景搭建', 'Example: Unity 2D Scene Setup')}
              onChange={(event) => props.onChangeDraft({ ...props.draft, name: event.target.value })}
            />
          </label>
          <label className="skill-form-row">
            <span>{t('触发场景', 'Trigger')}</span>
            <input
              value={props.draft.trigger}
              disabled={!props.project}
              placeholder={t('例如：用户要求搭建或调整 Unity 场景时', 'Example: when asked to build or tune a Unity scene')}
              onChange={(event) => props.onChangeDraft({ ...props.draft, trigger: event.target.value })}
            />
          </label>
        </div>

        <label className="skill-form-row">
          <span>{t('简短说明', 'Description')}</span>
          <input
            value={props.draft.description}
            disabled={!props.project}
            placeholder={t('这项技能解决什么问题', 'What this skill is for')}
            onChange={(event) => props.onChangeDraft({ ...props.draft, description: event.target.value })}
          />
        </label>

        <label className="skill-form-row">
          <span>{t('执行准则', 'Instructions')}</span>
          <textarea
            value={props.draft.instruction}
            disabled={!props.project}
            placeholder={t('写入具体规则、偏好、验收方式、禁止事项等。', 'Add concrete rules, preferences, acceptance checks, and constraints.')}
            onChange={(event) => props.onChangeDraft({ ...props.draft, instruction: event.target.value })}
          />
        </label>

        <div className="skill-editor-footer">
          <label className="skill-toggle-row">
            <input
              type="checkbox"
              checked={props.draft.enabled}
              disabled={!props.project}
              onChange={(event) => props.onChangeDraft({ ...props.draft, enabled: event.target.checked })}
            />
            <span>{t('保存后立即启用', 'Enable after saving')}</span>
          </label>
          <button className="prototype-primary" disabled={!canSave} onClick={() => void props.onSaveSkill()}>
            {props.editingSkillId ? t('保存 Skill', 'Save Skill') : t('添加 Skill', 'Add Skill')}
          </button>
        </div>
      </div>

      <div className="skill-grid">
        {skills.length === 0 ? (
          <div className="empty-state">
            <strong>{t('还没有项目 Skills', 'No project skills yet')}</strong>
            <span>{t('添加一项 Skill 后，Agent 会在项目运行时按启用的规则执行。', 'After adding a skill, the agent will follow enabled rules during project runs.')}</span>
          </div>
        ) : null}
        {skills.map((skill) => (
          <div key={skill.id} className="skill-card">
            <div className="skill-card-top">
              <strong>{skill.name}</strong>
              <span className={`skill-status ${skill.enabled ? 'ok' : 'warning'}`}>
                {skill.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}
              </span>
            </div>
            {skill.description ? <p>{skill.description}</p> : null}
            {skill.trigger ? <div className="skill-card-meta">{t('触发：', 'Trigger: ')}{skill.trigger}</div> : null}
            <div className="skill-instruction-preview">{skill.instruction}</div>
            <div className="skill-card-actions">
              <button className="prototype-secondary small" disabled={!props.project} onClick={() => void props.onToggleSkill(skill.id)}>
                {skill.enabled ? t('停用', 'Disable') : t('启用', 'Enable')}
              </button>
              <button className="prototype-secondary small" disabled={!props.project} onClick={() => props.onEditSkill(skill)}>
                {t('编辑', 'Edit')}
              </button>
              <button className="prototype-danger small" disabled={!props.project} onClick={() => void props.onDeleteSkill(skill.id)}>
                {t('删除', 'Delete')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
