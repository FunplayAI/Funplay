import { useEffect, useState, type JSX } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FilePlus2,
  FolderInput,
  FolderOpen,
  Globe2,
  Search
} from 'lucide-react';
import type {
  EngineProjectDimension,
  EnvironmentActionResult,
  EnvironmentDiagnostics,
  EnvironmentTask,
  InstalledUnityEditorOption,
  PlatformChoice,
  ProjectSetupMode
} from '../../../shared/types';
import { StandaloneAppShell } from '../layout/AppShell';
import { localize, useUiLanguage } from '../../i18n';
import {
  formatDiagnosticStatus,
  formatDimensionLabel,
  formatEnvironmentTaskStage,
  formatEnvironmentTaskStatus,
  formatPlatformLabel,
  getPlatformCards,
  mapTaskStatusToDiagnostic
} from '../../lib/app-helpers';
import type { LanguagePreference } from '../../lib/app-types';
import { Button, SelectField, TextField } from '../ui/index';

function PlatformCardIcon(props: { id: PlatformChoice }): JSX.Element {
  return (
    <span className={`option-card-icon platform-logo-icon platform-logo-${props.id}`} aria-hidden="true">
      <PlatformLogoGlyph id={props.id} />
    </span>
  );
}

function PlatformLogoGlyph(props: { id: PlatformChoice }): JSX.Element {
  if (props.id === 'unity') {
    return (
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M14.5 3.1 21 6.9v7.6l-6.5 3.8-2.1-3.7 4.4-2.5V9.3l-4.4-2.5 2.1-3.7Z" />
        <path d="M9.5 3.1 11.6 6.8 7.2 9.3v5.1l4.4 2.5-2.1 3.7L3 16.8V7.2l6.5-4.1Z" />
        <path d="M8.2 10.2H15.8L12 16.7 8.2 10.2Z" />
      </svg>
    );
  }

  if (props.id === 'cocos') {
    return (
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M12 2.4 20.3 7.2v9.6L12 21.6 3.7 16.8V7.2L12 2.4Z" />
        <path className="platform-logo-cutout" d="M14.8 8.6a4.35 4.35 0 1 0 0 6.8l-1.9-2.1a1.55 1.55 0 1 1 0-2.6l1.9-2.1Z" />
        <path className="platform-logo-cutout" d="M15.4 7.2 18 8.7l-2.6 2.7-2.5-1.5 2.5-2.7Z" />
      </svg>
    );
  }

  if (props.id === 'godot') {
    return (
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M4.2 10.2 5.4 6.7 8.2 8l1.2-3.3h5.2L15.8 8l2.8-1.3 1.2 3.5 1.8 1.5-1.5 7.2H3.9l-1.5-7.2 1.8-1.5Z" />
        <path className="platform-logo-cutout" d="M7.2 13.8a1.7 1.7 0 1 0 0-.1Zm9.6 0a1.7 1.7 0 1 0 0-.1Z" />
        <path className="platform-logo-cutout" d="M8.2 17.1c1 1.1 2.3 1.6 3.8 1.6s2.8-.5 3.8-1.6l-1.1-1.1c-.7.7-1.6 1.1-2.7 1.1s-2-.4-2.7-1.1l-1.1 1.1Z" />
      </svg>
    );
  }

  if (props.id === 'unreal') {
    return (
      <svg viewBox="0 0 24 24" focusable="false">
        <circle cx="12" cy="12" r="9.2" />
        <path className="platform-logo-cutout" d="M7 6.9h3v6.2c0 1.7.8 2.7 2.2 2.7 1.3 0 2.1-1 2.1-2.7V6.9h3v6.3c0 3.5-2 5.4-5.1 5.4S7 16.7 7 13.2V6.9Z" />
        <path className="platform-logo-cutout" d="M15.3 16.8 18.6 19l-2.1-3.7-1.2 1.5Z" />
      </svg>
    );
  }

  return <Globe2 size={18} />;
}

export function StepIndicator(props: { step: 1 | 2 | 3 }): JSX.Element {
  return (
    <div className="step-indicator">
      <div className={`step-dot ${props.step === 1 ? 'active' : 'complete'}`}>{props.step > 1 ? '✓' : '1'}</div>
      <div className="step-line" />
      <div className={`step-dot ${props.step === 2 ? 'active' : props.step > 2 ? 'complete' : ''}`}>{props.step > 2 ? '✓' : '2'}</div>
      <div className="step-line" />
      <div className={`step-dot ${props.step === 3 ? 'active complete' : ''}`}>3</div>
    </div>
  );
}

export function OnboardingScreen(props: {
  step: 1 | 2 | 3;
  view: 'setup' | 'environment';
  mode: ProjectSetupMode;
  platform: PlatformChoice;
  dimension: EngineProjectDimension;
  projectName: string;
  projectPath: string;
  unityEditors: InstalledUnityEditorOption[];
  selectedUnityEditorVersion: string;
  diagnostics: EnvironmentDiagnostics | null;
  tasks: EnvironmentTask[];
  detectionMessage: string;
  detectionOk: boolean;
  actionMessage: string;
  isChecking: boolean;
  isCreatingProject: boolean;
  onModeChange: (value: ProjectSetupMode) => void;
  onPlatformChange: (value: PlatformChoice) => void;
  onDimensionChange: (value: EngineProjectDimension) => void;
  onProjectNameChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onUnityEditorVersionChange: (value: string) => void;
  onBrowsePath: () => void;
  onDetect: () => void;
  onRunAction: (actionId: EnvironmentActionResult['actionId']) => void;
  onBackToSetup: () => void;
  onSkip: () => void;
  onNext: () => void;
  onEnter: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const platformCards = getPlatformCards(language);
  const steps = props.diagnostics?.checks ?? [];
  const firstIncompleteIndex = steps.findIndex((check) => check.status !== 'passed');
  const highestUnlockedIndex =
    steps.length === 0 ? 0 : firstIncompleteIndex === -1 ? Math.max(steps.length - 1, 0) : firstIncompleteIndex;
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [hiddenActionIds, setHiddenActionIds] = useState<Set<string>>(() => new Set());
  const isGenericProject = props.platform === 'web';
  const projectSetupHeading = props.mode === 'create'
    ? isGenericProject
      ? t('新建通用项目', 'Create Generic Project')
      : t('新建引擎项目', 'Create Engine Project')
    : isGenericProject
      ? t('导入通用项目', 'Import Generic Project')
      : t('导入已有引擎项目', 'Import Engine Project');
  const projectSourceLabel = props.mode === 'create'
    ? isGenericProject
      ? t('新建通用项目', 'Create Generic Project')
      : t('新建引擎项目', 'Create Engine Project')
    : isGenericProject
      ? t('导入通用项目', 'Import Generic Project')
      : t('导入已有项目', 'Import Existing Project');

  useEffect(() => {
    if (steps.length === 0) {
      setCurrentStepIndex(0);
      return;
    }

    setCurrentStepIndex((current) => {
      if (current > highestUnlockedIndex) {
        return highestUnlockedIndex;
      }
      return current;
    });
  }, [steps.length, highestUnlockedIndex]);

  useEffect(() => {
    if (props.view === 'setup') {
      setHiddenActionIds(new Set());
    }
  }, [props.view]);

  const activeStep = steps[currentStepIndex] ?? null;
  const selectedUnityEditor = props.unityEditors.find((editor) => editor.version === props.selectedUnityEditorVersion) ?? null;
  const busyActionIds = new Set(
    props.tasks
      .filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'needs_user')
      .map((task) => task.actionId)
  );
  const canStartEnvironmentCheck =
    props.mode === 'create' ? props.projectName.trim().length > 0 && props.projectPath.trim().length > 0 : props.projectPath.trim().length > 0;
  const activeStepDetail =
    props.platform === 'unity' && props.mode === 'create' && activeStep?.id === 'engine-project' && selectedUnityEditor
      ? selectedUnityEditor.compatible
        ? props.projectName.trim() && props.projectPath.trim()
          ? t(
              `已选择创建目录：${props.projectPath}，项目名称：${props.projectName}，将使用 ${selectedUnityEditor.version} 创建 ${props.dimension === '2d' ? '2D URP' : '3D URP'} 官方模板项目。`,
              `Destination: ${props.projectPath}. Project name: ${props.projectName}. Funplay will use ${selectedUnityEditor.version} to create the official ${props.dimension === '2d' ? '2D URP' : '3D URP'} template.`
            )
          : activeStep.detail
        : t(
            `当前所选 Unity ${selectedUnityEditor.version} 不支持 ${props.dimension === '2d' ? '2D URP' : '3D URP'} 官方模板，请改选其他已安装版本。`,
            `The selected Unity ${selectedUnityEditor.version} does not support the official ${props.dimension === '2d' ? '2D URP' : '3D URP'} template. Choose another installed version.`
          )
      : activeStep?.detail ?? '';

  return (
    <StandaloneAppShell title={t('Funplay — 项目配置向导', 'Funplay — Project Setup Wizard')}>
      <div className="onboarding-screen">
        <div className="onboarding-desktop-layout">
          {props.step === 1 && props.view === 'environment' ? (
            <div className="onboarding-main-panel">
              <div className="onboarding-main-scroll">
                <div className="onboarding-body">
                  <div className="onboarding-fixed-header">
                    <StepIndicator step={2} />
                    <div className="settings-header">
                      <div>
                        <h2>{t('环境体检', 'Environment Check')}</h2>
                        <p>{t('按步骤完成引擎项目创建、打开和 Bridge 连通。', 'Complete engine project creation, opening, and Bridge connection step by step.')}</p>
                      </div>
                      <Button variant="secondary" leadingIcon={<ArrowLeft size={14} aria-hidden="true" />} onClick={props.onBackToSetup}>
                        {t('返回上一级', 'Back')}
                      </Button>
                    </div>
                  </div>
                  {props.actionMessage ? <div className="helper-copy onboarding-action-message">{props.actionMessage}</div> : null}
                  <div className="diagnostic-stepper-shell">
                    <div className="wizard-stepper-track">
                      {steps.length === 0 ? <div className="empty-note">{t('正在准备环境体检结果…', 'Preparing environment check results…')}</div> : null}
                      {steps.map((step, index) => {
                        const unlocked = index <= highestUnlockedIndex;
                        const completed = step.status === 'passed';
                        const active = index === currentStepIndex;
                        return (
                          <div key={step.id} className="wizard-stepper-node">
                            <Button
                              variant="ghost"
                              size="compact"
                              className={`wizard-step ${active ? 'active' : ''} ${completed ? 'completed' : ''} ${!unlocked ? 'locked' : ''}`}
                              onClick={() => {
                                if (unlocked) setCurrentStepIndex(index);
                              }}
                              disabled={!unlocked}
                            >
                              <span className="wizard-step-index">{completed ? '✓' : index + 1}</span>
                              <div className="wizard-step-copy">
                                <strong>{t(`步骤 ${index + 1}`, `Step ${index + 1}`)}</strong>
                                <small>{step.title}</small>
                              </div>
                            </Button>
                            {index < steps.length - 1 ? <div className={`wizard-step-line ${index < highestUnlockedIndex ? 'active' : ''}`} /> : null}
                          </div>
                        );
                      })}
                    </div>

                    {activeStep ? (
                      <div className={`diagnostic-step-card ${activeStep.status}`}>
                        <div className="diagnostic-step-content">
                          <div className="diagnostic-card-top">
                            <div>
                              <strong>{activeStep.title}</strong>
                              <div className="helper-copy">{activeStep.description}</div>
                            </div>
                            <span className={`diagnostic-status ${activeStep.status}`}>{formatDiagnosticStatus(activeStep.status)}</span>
                          </div>
                          {props.platform === 'unity' && props.mode === 'create' && activeStep.id === 'engine-project' ? (
                            <SelectField
                              className="compact"
                              label={t('本机已安装引擎', 'Installed engine')}
                              value={props.selectedUnityEditorVersion}
                              options={props.unityEditors.length === 0
                                ? [{ value: '', label: t('未检测到可用 Unity', 'No Unity installation detected') }]
                                : props.unityEditors.map((editor) => ({
                                  value: editor.version,
                                  label: `${editor.displayName}${editor.compatible ? '' : t(' · 不支持当前模板', ' · Template unsupported')}`,
                                  disabled: !editor.compatible
                                }))}
                              onValueChange={props.onUnityEditorVersionChange}
                            />
                          ) : null}
                          <div className="diagnostic-detail">{activeStepDetail}</div>

                          {props.tasks[0] ? (
                            <div className="task-inline-card">
                              <div className="task-run-top">
                                <div>
                                  <strong>{props.tasks[0].title}</strong>
                                  <div className="helper-copy">{`${t('阶段', 'Stage')}: ${formatEnvironmentTaskStage(props.tasks[0].stage)}`}</div>
                                </div>
                                <span className={`diagnostic-status ${mapTaskStatusToDiagnostic(props.tasks[0].status)}`}>{formatEnvironmentTaskStatus(props.tasks[0].status)}</span>
                              </div>
                              <div className="task-run-message">{props.tasks[0].message}</div>
                              <div className="task-run-progress">
                                <div className="task-run-progress-fill" style={{ width: `${props.tasks[0].progress}%` }} />
                              </div>
                            </div>
                          ) : null}
                        </div>

                        <div className="diagnostic-step-footer">
                          {activeStep.actions.length > 0 ? (
                            <div className="diagnostic-actions">
                              {activeStep.actions.filter((action) => {
                                if (action.id !== 'create_unity_project') {
                                  return true;
                                }
                                return !hiddenActionIds.has(action.id) && !props.tasks.some((task) => task.actionId === 'create_unity_project');
                              }).map((action) => {
                                const disabled = busyActionIds.has(action.id);
                                return (
                                  <Button
                                    key={action.id}
                                    className="small-action"
                                    size="sm"
                                    variant={action.primary ? 'primary' : 'secondary'}
                                    loading={disabled}
                                    onClick={() => {
                                      if (action.id === 'create_unity_project') {
                                        setHiddenActionIds((current) => new Set(current).add(action.id));
                                      }
                                      props.onRunAction(action.id);
                                    }}
                                    disabled={disabled}
                                  >
                                    {disabled ? t('处理中…', 'Processing…') : action.label}
                                  </Button>
                                );
                              })}
                            </div>
                          ) : (
                            <div />
                          )}

                          <div className="diagnostic-step-nav">
                            <Button
                              className="small-action"
                              size="sm"
                              variant="secondary"
                              leadingIcon={<ArrowLeft size={13} aria-hidden="true" />}
                              onClick={() => setCurrentStepIndex((current) => Math.max(current - 1, 0))}
                              disabled={currentStepIndex === 0}
                            >
                              {t('上一步', 'Previous')}
                            </Button>
                            <Button
                              className="small-action"
                              size="sm"
                              variant="secondary"
                              trailingIcon={<ArrowRight size={13} aria-hidden="true" />}
                              onClick={() => setCurrentStepIndex((current) => Math.min(current + 1, highestUnlockedIndex))}
                              disabled={currentStepIndex >= highestUnlockedIndex}
                            >
                              {t('下一步', 'Next')}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="onboarding-footer-bar">
                <Button variant="ghost" leadingIcon={<ArrowLeft size={14} aria-hidden="true" />} onClick={props.onBackToSetup}>
                  {t('返回上一级', 'Back')}
                </Button>
                <Button variant="primary" trailingIcon={<ArrowRight size={14} aria-hidden="true" />} onClick={props.onNext} disabled={!props.detectionOk}>
                  {t('完成环境准备', 'Finish Environment Setup')}
                </Button>
              </div>
            </div>
          ) : props.step === 1 ? (
            <div className="onboarding-main-panel">
              <div className="onboarding-main-scroll">
                <div className="onboarding-body onboarding-body-wizard">
                  <div className="onboarding-wizard-card">
                    <aside className="onboarding-wizard-rail" aria-label={t('配置步骤', 'Setup steps')}>
                      <StepIndicator step={1} />
                      <div className="onboarding-rail-copy">
                        <div className="section-heading">{t('项目配置向导', 'Project Setup')}</div>
                        <h2>{t('选择项目入口', 'Choose how to start')}</h2>
                        <p>{t('Funplay 会根据项目来源和引擎类型，把后续环境检查收进下一步。', 'Funplay will tailor the next environment check from your source and engine choice.')}</p>
                      </div>
                      <div className="onboarding-rail-summary">
                        <div>
                          <span>{t('来源', 'Source')}</span>
                          <strong>{props.mode === 'create' ? t('新建项目', 'Create') : t('导入项目', 'Import')}</strong>
                        </div>
                        <div>
                          <span>{t('引擎', 'Engine')}</span>
                          <strong>{formatPlatformLabel(props.platform)}</strong>
                        </div>
                        <div>
                          <span>{t('下一步', 'Next')}</span>
                          <strong>{isGenericProject ? t('进入工作台', 'Enter workspace') : t('环境体检', 'Environment check')}</strong>
                        </div>
                      </div>
                    </aside>

                    <div className="onboarding-wizard-content">
                      <section className="onboarding-choice-section" aria-labelledby="project-source-title">
                        <div className="onboarding-section-heading">
                          <div>
                            <div className="section-heading">{t('项目来源', 'Project Source')}</div>
                            <h3 id="project-source-title">{t('你要从哪里开始？', 'Where do you want to start?')}</h3>
                          </div>
                          <span>{t('第 1 步 / 共 3 步', 'Step 1 of 3')}</span>
                        </div>
                        <div className="setup-mode-grid">
                          <Button variant="ghost" size="compact" className={`setup-mode-card ${props.mode === 'create' ? 'selected' : ''}`} onClick={() => props.onModeChange('create')}>
                            <span className="option-card-icon" aria-hidden="true"><FilePlus2 size={18} /></span>
                            <span className="option-card-copy">
                              <strong>{t('新建项目', 'Create New Project')}</strong>
                              <span>{t('从玩法想法或空工程开始。', 'Start from a gameplay idea or blank workspace.')}</span>
                            </span>
                          </Button>
                          <Button variant="ghost" size="compact" className={`setup-mode-card ${props.mode === 'import' ? 'selected' : ''}`} onClick={() => props.onModeChange('import')}>
                            <span className="option-card-icon" aria-hidden="true"><FolderInput size={18} /></span>
                            <span className="option-card-copy">
                              <strong>{t('导入已有项目', 'Import Existing Project')}</strong>
                              <span>{t('接入本机已有的游戏或 Web 项目。', 'Connect an existing local game or web project.')}</span>
                            </span>
                          </Button>
                        </div>
                      </section>

                      <section className="onboarding-choice-section" aria-labelledby="project-platform-title">
                        <div className="onboarding-section-heading compact">
                          <div>
                            <div className="section-heading">{t('项目类型', 'Project Type')}</div>
                            <h3 id="project-platform-title">{t('选择主要工作流', 'Choose the main workflow')}</h3>
                          </div>
                        </div>
                        <div className="platform-grid">
                          {platformCards.map((card) => (
                            <Button
                              key={card.id}
                              variant="ghost"
                              size="compact"
                              className={`platform-card ${props.platform === card.id ? 'selected' : ''}`}
                              onClick={() => !card.disabled && props.onPlatformChange(card.id)}
                              disabled={card.disabled}
                            >
                              <PlatformCardIcon id={card.id} />
                              <span className="option-card-copy">
                                <strong>{card.name}</strong>
                                <span>{card.description}</span>
                              </span>
                            </Button>
                          ))}
                        </div>
                      </section>

                      {(props.platform === 'unity' || props.platform === 'cocos') && props.mode === 'create' ? (
                        <section className="onboarding-choice-section compact" aria-labelledby="project-dimension-title">
                          <div className="onboarding-section-heading compact">
                            <div>
                              <div className="section-heading">{t('维度', 'Dimension')}</div>
                              <h3 id="project-dimension-title">{t('选择项目维度', 'Choose project dimension')}</h3>
                            </div>
                          </div>
                          <div className="setup-mode-grid compact">
                            <Button variant="ghost" size="compact" className={`setup-mode-card ${props.dimension === '2d' ? 'selected' : ''}`} onClick={() => props.onDimensionChange('2d')}>
                              <span className="option-card-copy">
                                <strong>{t('2D 项目', '2D Project')}</strong>
                                <span>{t('像素、横版、卡牌或其他 2D 原型。', 'Pixel art, side-scrollers, card games, or other 2D prototypes.')}</span>
                              </span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="compact"
                              className={`setup-mode-card ${props.dimension === '3d' ? 'selected' : ''} ${props.platform !== 'unity' ? 'disabled-card' : ''}`}
                              onClick={() => props.platform === 'unity' && props.onDimensionChange('3d')}
                              disabled={props.platform !== 'unity'}
                            >
                              <span className="option-card-copy">
                                <strong>{t('3D 项目', '3D Project')}</strong>
                                <span>{props.platform === 'unity' ? t('三维场景、平台跳跃、第三人称。', '3D scenes, platformers, third-person gameplay.') : t('当前引擎暂不支持 3D。', 'This engine does not support 3D yet.')}</span>
                              </span>
                            </Button>
                          </div>
                        </section>
                      ) : null}

                      <section className="onboarding-panel onboarding-project-form" aria-labelledby="project-details-title">
                        <div className="onboarding-section-heading compact">
                          <div>
                            <div className="section-heading">{t('项目详情', 'Project Details')}</div>
                            <h3 id="project-details-title">{projectSetupHeading}</h3>
                          </div>
                        </div>
                        <div className="onboarding-form-grid">
                          {props.mode === 'create' ? (
                            <TextField
                              label={t('项目名称', 'Project Name')}
                              value={props.projectName}
                              onValueChange={props.onProjectNameChange}
                              placeholder={isGenericProject ? t('例如：我的工作区', 'Example: My Workspace') : t('例如：Flappy Bird', 'Example: Flappy Bird')}
                            />
                          ) : null}
                          <div className="fp-field">
                            <span className="fp-field-label">
                              {props.mode === 'create'
                                ? isGenericProject
                                  ? t('项目存放目录', 'Project Destination Folder')
                                  : t('项目创建目录', 'Project Destination Folder')
                                : t('已有项目目录', 'Existing Project Folder')}
                            </span>
                            <div className="inline-field">
                              <TextField
                                className="onboarding-path-field"
                                label={t('项目路径', 'Project path')}
                                inputClassName="onboarding-path-input"
                                value={props.projectPath}
                                onValueChange={props.onPathChange}
                                placeholder={props.mode === 'create' ? '~/Downloads' : t('选择已有项目文件夹', 'Choose an existing project folder')}
                              />
                              <Button variant="secondary" leadingIcon={<FolderOpen size={14} aria-hidden="true" />} onClick={props.onBrowsePath}>
                                {t('浏览...', 'Browse...')}
                              </Button>
                            </div>
                          </div>
                        </div>
                        <div className="onboarding-form-note">
                          {isGenericProject
                            ? t('通用项目不会绑定游戏引擎，可直接进入工作台。', 'Generic projects do not bind a game engine and can enter the workspace directly.')
                            : t('引擎项目会在下一步检查编辑器、项目版本和 MCP 连接状态。', 'Engine projects continue with editor, project version, and MCP connection checks.')}
                        </div>
                        {props.actionMessage ? <div className="helper-copy onboarding-action-message">{props.actionMessage}</div> : null}
                        {props.detectionMessage && !props.detectionOk ? <div className="helper-copy onboarding-action-message">{props.detectionMessage}</div> : null}
                      </section>
                    </div>

                    <div className="onboarding-footer-bar onboarding-wizard-footer">
                      <Button variant="ghost" onClick={props.onSkip}>
                        {t('跳过引导，稍后配置', 'Skip for now')}
                      </Button>
                      <Button
                        variant="primary"
                        leadingIcon={isGenericProject ? <CheckCircle2 size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
                        loading={isGenericProject ? props.isCreatingProject : props.isChecking}
                        onClick={isGenericProject ? props.onEnter : props.onDetect}
                        disabled={!canStartEnvironmentCheck || props.isChecking || props.isCreatingProject}
                      >
                        {isGenericProject
                          ? props.isCreatingProject
                            ? t('创建中…', 'Creating…')
                            : t('进入工作台', 'Enter Workspace')
                          : props.isChecking
                            ? t('检测中…', 'Checking…')
                            : t('开始环境体检', 'Start Environment Check')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="onboarding-main-panel">
              <div className="onboarding-main-scroll">
                <div className="onboarding-body center">
                  <StepIndicator step={3} />
                  <div className="celebration">✓</div>
                  <h2>{t('配置完成!', 'Setup Complete!')}</h2>
                  <p>{isGenericProject ? t('工作区已准备好，现在可以进入使用。', 'The workspace is ready. You can enter and start working.') : t('引擎已绑定，现在可以进入工作台开始使用了。', 'The engine is now connected. You can enter the workspace and start building.')}</p>
                  <div className="summary-card">
                    <div><span>{t('目标平台', 'Target Platform')}</span><strong>{formatPlatformLabel(props.platform)}</strong></div>
                    <div><span>{t('项目来源', 'Project Source')}</span><strong>{projectSourceLabel}</strong></div>
                    {props.mode === 'create' ? <div><span>{t('项目名称', 'Project Name')}</span><strong>{props.projectName || t('未填写', 'Not set')}</strong></div> : null}
                    <div><span>{t('项目类型', 'Project Type')}</span><strong>{isGenericProject ? t('通用工作区', 'Generic Workspace') : props.dimension === 'unknown' ? t('自动识别中', 'Detecting') : props.dimension.toUpperCase()}</strong></div>
                    <div>
                      <span>{t('项目状态', 'Project Status')}</span>
                      <strong>{isGenericProject ? t('可直接进入', 'Ready') : props.detectionOk ? t('已打开并通过桥接检测', 'Opened and Bridge check passed') : t('待完成环境准备', 'Environment setup pending')}</strong>
                    </div>
                    <div><span>{t('项目路径', 'Project Path')}</span><strong>{props.projectPath}</strong></div>
                  </div>
                  <div className="helper-copy">{t('MCP、Skills 等二级项目配置，可在进入工作台后继续完成；AI Provider 统一在应用设置中配置。', 'Secondary project settings like MCP and Skills can be completed after entering the workspace; AI Providers are configured centrally in App Settings.')}</div>
                </div>
              </div>

              <div className="onboarding-footer-bar">
                <Button variant="ghost" leadingIcon={<ArrowLeft size={14} aria-hidden="true" />} onClick={props.onBackToSetup}>
                  {t('返回调整', 'Adjust Settings')}
                </Button>
                <Button variant="primary" trailingIcon={<ArrowRight size={14} aria-hidden="true" />} onClick={props.onEnter}>
                  {t('进入工作台', 'Enter Workspace')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </StandaloneAppShell>
  );
}
