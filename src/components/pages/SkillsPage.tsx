import { type JSX } from 'react';
import { Download, Pencil, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { AgentSkillCatalogItem, AgentSkillCatalogResult, Project, ProjectAgentSkill } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import type { ProjectAgentSkillDraft } from '../../lib/app-types';
import { makeCatalogProjectSkillId } from '../../lib/app-helpers';
import { Button, CheckboxField, TextAreaField, TextField } from '../ui/index';

export function SkillsPage(props: {
  project: Project | null;
  draft: ProjectAgentSkillDraft;
  editingSkillId: string;
  catalog: AgentSkillCatalogResult | null;
  isLoadingCatalog: boolean;
  catalogError: string;
  onRefreshCatalog: () => Promise<void>;
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
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<RefreshCw size={13} aria-hidden="true" />}
            loading={props.isLoadingCatalog}
            onClick={() => void props.onRefreshCatalog()}
          >
            {props.isLoadingCatalog ? t('同步中…', 'Syncing…') : t('从仓库同步', 'Sync')}
          </Button>
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
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon={<Download size={13} aria-hidden="true" />}
                    disabled={!props.project}
                    onClick={() => void props.onInstallCatalogSkill(catalogSkill)}
                  >
                    {installedSkill ? t('更新并启用', 'Update and Enable') : t('启用到项目', 'Enable for Project')}
                  </Button>
                  {installedSkill ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      leadingIcon={<Pencil size={13} aria-hidden="true" />}
                      disabled={!props.project}
                      onClick={() => props.onEditSkill(installedSkill)}
                    >
                      {t('编辑覆盖', 'Edit Override')}
                    </Button>
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
            <Button size="sm" variant="ghost" onClick={props.onCancelEdit}>
              {t('取消编辑', 'Cancel')}
            </Button>
          ) : null}
        </div>

        <div className="skill-form-grid">
          <TextField
            label={t('名称', 'Name')}
            value={props.draft.name}
            disabled={!props.project}
            placeholder={t('例如：Unity 2D 场景搭建', 'Example: Unity 2D Scene Setup')}
            onValueChange={(value) => props.onChangeDraft({ ...props.draft, name: value })}
          />
          <TextField
            label={t('触发场景', 'Trigger')}
            value={props.draft.trigger}
            disabled={!props.project}
            placeholder={t('例如：用户要求搭建或调整 Unity 场景时', 'Example: when asked to build or tune a Unity scene')}
            onValueChange={(value) => props.onChangeDraft({ ...props.draft, trigger: value })}
          />
        </div>

        <TextField
          label={t('简短说明', 'Description')}
          value={props.draft.description}
          disabled={!props.project}
          placeholder={t('这项技能解决什么问题', 'What this skill is for')}
          onValueChange={(value) => props.onChangeDraft({ ...props.draft, description: value })}
        />

        <TextAreaField
          label={t('执行准则', 'Instructions')}
          value={props.draft.instruction}
          disabled={!props.project}
          placeholder={t('写入具体规则、偏好、验收方式、禁止事项等。', 'Add concrete rules, preferences, acceptance checks, and constraints.')}
          onValueChange={(value) => props.onChangeDraft({ ...props.draft, instruction: value })}
        />

        <div className="skill-editor-footer">
          <CheckboxField
            className="skill-toggle-row"
            label={t('保存后立即启用', 'Enable after saving')}
            checked={props.draft.enabled}
            disabled={!props.project}
            onCheckedChange={(checked) => props.onChangeDraft({ ...props.draft, enabled: checked })}
          />
          <Button
            variant="primary"
            leadingIcon={props.editingSkillId ? <Save size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            disabled={!canSave}
            onClick={() => void props.onSaveSkill()}
          >
            {props.editingSkillId ? t('保存 Skill', 'Save Skill') : t('添加 Skill', 'Add Skill')}
          </Button>
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
              <Button size="sm" variant="secondary" disabled={!props.project} onClick={() => void props.onToggleSkill(skill.id)}>
                {skill.enabled ? t('停用', 'Disable') : t('启用', 'Enable')}
              </Button>
              <Button size="sm" variant="secondary" leadingIcon={<Pencil size={13} aria-hidden="true" />} disabled={!props.project} onClick={() => props.onEditSkill(skill)}>
                {t('编辑', 'Edit')}
              </Button>
              <Button size="sm" variant="danger" leadingIcon={<Trash2 size={13} aria-hidden="true" />} disabled={!props.project} onClick={() => void props.onDeleteSkill(skill.id)}>
                {t('删除', 'Delete')}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
