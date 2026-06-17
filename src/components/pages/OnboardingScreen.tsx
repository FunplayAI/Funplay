import { useEffect, useState, type JSX } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FilePlus2,
  FolderInput,
  FolderOpen,
  Search
} from 'lucide-react';
import type {
  CocosEngineVariant,
  EngineProjectDimension,
  EnvironmentActionResult,
  EnvironmentDiagnostics,
  EnvironmentTask,
  InstalledUnityEditorOption,
  PlatformChoice,
  ProjectSetupMode
} from '../../../shared/types';
import { StandaloneAppShell } from '../layout/AppShell';
import { CocosVariantSelector } from './CocosVariantSelector';
import {
  buildOnboardingHeadings,
  CompatibleEditorsNote,
  ImportDetectedDimensionNote,
  PlatformCardIcon,
  StepIndicator,
  Step3ErrorBanner,
  useCocosVariantPrerequisite
} from './onboarding/OnboardingPieces';
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

export function OnboardingScreen(props: {
  step: 1 | 2 | 3;
  view: 'setup' | 'environment';
  mode: ProjectSetupMode;
  platform: PlatformChoice;
  dimension: EngineProjectDimension;
  cocosVariant: CocosEngineVariant;
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
  onCocosVariantChange: (value: CocosEngineVariant) => void;
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
  // Step-3 project-creation failure recovery (optional — falls back to a no-banner
  // completion screen + onEnter retry when the host has not wired these yet).
  createError?: string;
  onRetryEnter?: () => void;
  onBackToEnvironment?: () => void;
  // Step-2 note: the dimension an import auto-detected, when it differs from the
  // user's Step-1 choice (optional).
  detectedDimension?: EngineProjectDimension | null;
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
  // Non-blocking precheck of the selected Cocos variant's prerequisite, used to
  // warn on the Step-1 variant card before the heavy Step-2 diagnostics run.
  const cocosPrerequisite = useCocosVariantPrerequisite(props.platform, props.cocosVariant);
  const isGenericProject = props.platform === 'web';
  const { heading: projectSetupHeading, sourceLabel: projectSourceLabel } = buildOnboardingHeadings(props.mode, isGenericProject, language);

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
  const passedEnvironmentChecks = steps.filter((step) => step.status === 'passed').length;
  const environmentProgressLabel = steps.length === 0 ? t('准备中', 'Preparing') : `${passedEnvironmentChecks}/${steps.length}`;

  return (
    <StandaloneAppShell title={t('Funplay — 项目配置向导', 'Funplay — Project Setup Wizard')}>
      <div className="onboarding-screen">
        <div className="onboarding-desktop-layout">
          {props.step === 1 && props.view === 'environment' ? (
            <div className="onboarding-main-panel">
              <div className="onboarding-main-scroll onboarding-wizard-scroll">
                <div className="onboarding-body onboarding-body-wizard">
                  <div className="onboarding-wizard-card onboarding-environment-card">
                    <aside className="onboarding-wizard-rail" aria-label={t('环境体检步骤', 'Environment check steps')}>
                      <StepIndicator step={2} />
                      <div className="onboarding-rail-copy">
                        <div className="section-heading">{t('项目配置向导', 'Project Setup')}</div>
                        <h2>{t('环境体检', 'Environment Check')}</h2>
                      </div>
                      <div className="onboarding-rail-summary">
                        <div>
                          <span>{t('引擎', 'Engine')}</span>
                          <strong>{formatPlatformLabel(props.platform)}</strong>
                        </div>
                        <div>
                          <span>{t('状态', 'Status')}</span>
                          <strong>{environmentProgressLabel}</strong>
                        </div>
                        <div>
                          <span>{t('当前', 'Current')}</span>
                          <strong>{activeStep?.title ?? t('等待检查', 'Waiting')}</strong>
                        </div>
                      </div>
                    </aside>

                    <div className="onboarding-wizard-content onboarding-environment-content">
                      <section className="onboarding-choice-section environment-overview-section" aria-labelledby="environment-checklist-title">
                        <div className="onboarding-section-heading">
                          <div>
                            <div className="section-heading">{t('检查清单', 'Checklist')}</div>
                            <h3 id="environment-checklist-title">{t('确认运行环境', 'Verify Runtime Environment')}</h3>
                          </div>
                          <span>{t('第 2 步 / 共 3 步', 'Step 2 of 3')}</span>
                        </div>
                        {props.actionMessage ? <div className="helper-copy onboarding-action-message environment-inline-message">{props.actionMessage}</div> : null}
                        {props.mode === 'import' ? <ImportDetectedDimensionNote detected={props.detectedDimension} language={language} /> : null}
                        <div className="wizard-stepper-track environment-stepper-track">
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
                              </div>
                            );
                          })}
                        </div>
                      </section>

                      {activeStep ? (
                        <section className={`diagnostic-step-card onboarding-diagnostic-card ${activeStep.status}`}>
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
                                  // Link-style remedies (e.g. "open the Node.js install guide")
                                  // open the URL in the external browser; they have no in-app task
                                  // and are never busy.
                                  const isExternal = Boolean(action.externalUrl);
                                  const disabled = !isExternal && busyActionIds.has(action.id);
                                  return (
                                    <Button
                                      key={action.externalUrl ?? action.id}
                                      className="small-action"
                                      size="sm"
                                      variant={action.primary ? 'primary' : 'secondary'}
                                      loading={disabled}
                                      onClick={() => {
                                        if (isExternal) {
                                          void window.funplay.openExternal(action.externalUrl!);
                                          return;
                                        }
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
                        </section>
                      ) : null}
                    </div>

                    <div className="onboarding-footer-bar onboarding-wizard-footer">
                      <Button variant="ghost" leadingIcon={<ArrowLeft size={14} aria-hidden="true" />} onClick={props.onBackToSetup}>
                        {t('返回上一级', 'Back')}
                      </Button>
                      <Button variant="primary" trailingIcon={<ArrowRight size={14} aria-hidden="true" />} onClick={props.onNext} disabled={!props.detectionOk}>
                        {t('完成环境准备', 'Finish Environment Setup')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : props.step === 1 ? (
            <div className="onboarding-main-panel">
              <div className="onboarding-main-scroll onboarding-wizard-scroll">
                <div className="onboarding-body onboarding-body-wizard">
                  <div className="onboarding-wizard-card">
                    <aside className="onboarding-wizard-rail" aria-label={t('配置步骤', 'Setup steps')}>
                      <StepIndicator step={1} skipEnvironment={isGenericProject} language={language} />
                      <div className="onboarding-rail-copy">
                        <div className="section-heading">{t('项目配置向导', 'Project Setup')}</div>
                        <h2>{t('选择项目入口', 'Choose how to start')}</h2>
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
                            </span>
                          </Button>
                          <Button variant="ghost" size="compact" className={`setup-mode-card ${props.mode === 'import' ? 'selected' : ''}`} onClick={() => props.onModeChange('import')}>
                            <span className="option-card-icon" aria-hidden="true"><FolderInput size={18} /></span>
                            <span className="option-card-copy">
                              <strong>{t('导入已有项目', 'Import Existing Project')}</strong>
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
                              </span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="compact"
                              className={`setup-mode-card ${props.dimension === '3d' ? 'selected' : ''}`}
                              onClick={() => props.onDimensionChange('3d')}
                            >
                              <span className="option-card-copy">
                                <strong>{t('3D 项目', '3D Project')}</strong>
                              </span>
                            </Button>
                          </div>
                          {props.platform === 'unity' ? (
                            <CompatibleEditorsNote editors={props.unityEditors} dimension={props.dimension} language={language} />
                          ) : null}
                        </section>
                      ) : null}

                      {props.platform === 'cocos' ? (
                        <CocosVariantSelector
                          value={props.cocosVariant}
                          onChange={props.onCocosVariantChange}
                          prerequisite={cocosPrerequisite}
                          language={language}
                        />
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
                  <StepIndicator step={3} skipEnvironment={isGenericProject} language={language} />
                  {props.createError ? (
                    <Step3ErrorBanner
                      message={props.createError}
                      busy={props.isCreatingProject}
                      onRetry={props.onRetryEnter ?? props.onEnter}
                      onBack={props.onBackToEnvironment ?? props.onBackToSetup}
                      language={language}
                    />
                  ) : (
                    <>
                      <div className="celebration">✓</div>
                      <h2>{t('配置完成!', 'Setup Complete!')}</h2>
                    </>
                  )}
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
                  <div className="helper-copy">{t('进入工作台后，第一步请在应用设置里添加 AI 模型（Provider），否则无法开始对话；MCP、Skills 等可稍后再配置。', 'After entering the workspace, first add an AI model (Provider) in App Settings — chatting requires it — then set up MCP, Skills, and the rest later.')}</div>
                </div>
              </div>

              <div className="onboarding-footer-bar">
                <Button variant="ghost" leadingIcon={<ArrowLeft size={14} aria-hidden="true" />} onClick={props.onBackToSetup}>
                  {t('返回调整', 'Adjust Settings')}
                </Button>
                <Button
                  variant="primary"
                  trailingIcon={<ArrowRight size={14} aria-hidden="true" />}
                  loading={props.isCreatingProject}
                  disabled={props.isCreatingProject}
                  onClick={props.onEnter}
                >
                  {props.isCreatingProject ? t('创建中…', 'Creating…') : t('进入工作台', 'Enter Workspace')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </StandaloneAppShell>
  );
}
