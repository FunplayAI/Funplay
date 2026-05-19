import { useEffect, useState, type JSX } from 'react';
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
                      <button className="prototype-secondary" onClick={props.onBackToSetup}>
                        {t('返回上一级', 'Back')}
                      </button>
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
                            <button
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
                            </button>
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
                            <label className="field compact">
                              <span>{t('本机已安装引擎', 'Installed engine')}</span>
                              <select
                                value={props.selectedUnityEditorVersion}
                                onChange={(event) => props.onUnityEditorVersionChange(event.target.value)}
                              >
                                {props.unityEditors.length === 0 ? <option value="">{t('未检测到可用 Unity', 'No Unity installation detected')}</option> : null}
                                {props.unityEditors.map((editor) => (
                                  <option key={editor.version} value={editor.version} disabled={!editor.compatible}>
                                    {`${editor.displayName}${editor.compatible ? '' : t(' · 不支持当前模板', ' · Template unsupported')}`}
                                  </option>
                                ))}
                              </select>
                            </label>
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
                                  <button
                                    key={action.id}
                                    className={action.primary ? 'prototype-primary small-action' : 'prototype-secondary small-action'}
                                    onClick={() => {
                                      if (action.id === 'create_unity_project') {
                                        setHiddenActionIds((current) => new Set(current).add(action.id));
                                      }
                                      props.onRunAction(action.id);
                                    }}
                                    disabled={disabled}
                                  >
                                    {disabled ? t('处理中…', 'Processing…') : action.label}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <div />
                          )}

                          <div className="diagnostic-step-nav">
                            <button
                              className="prototype-secondary small-action"
                              onClick={() => setCurrentStepIndex((current) => Math.max(current - 1, 0))}
                              disabled={currentStepIndex === 0}
                            >
                              {t('上一步', 'Previous')}
                            </button>
                            <button
                              className="prototype-secondary small-action"
                              onClick={() => setCurrentStepIndex((current) => Math.min(current + 1, highestUnlockedIndex))}
                              disabled={currentStepIndex >= highestUnlockedIndex}
                            >
                              {t('下一步', 'Next')}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="onboarding-footer-bar">
                <button className="prototype-ghost" onClick={props.onBackToSetup}>
                  {t('返回上一级', 'Back')}
                </button>
                <button className="prototype-primary" onClick={props.onNext} disabled={!props.detectionOk}>
                  {t('完成环境准备', 'Finish Environment Setup')}
                </button>
              </div>
            </div>
          ) : props.step === 1 ? (
            <div className="onboarding-main-panel">
              <div className="onboarding-main-scroll">
                <div className="onboarding-body">
                  <div className="onboarding-fixed-header">
                    <StepIndicator step={1} />
                    <div>
                      <h2>{t('选择项目来源并准备引擎项目', 'Choose a project source and prepare the engine project')}</h2>
                    </div>
                  </div>

                  <div className="onboarding-setup-stack">
                    <div className="onboarding-section-card">
                      <div className="section-heading">{t('项目来源', 'Project Source')}</div>
                      <div className="setup-mode-grid">
                        <button className={`setup-mode-card ${props.mode === 'create' ? 'selected' : ''}`} onClick={() => props.onModeChange('create')}>
                          <strong>{t('新建项目', 'Create New Project')}</strong>
                          <span>{t('从一个新的项目开始。', 'Start from a brand-new project.')}</span>
                        </button>
                        <button className={`setup-mode-card ${props.mode === 'import' ? 'selected' : ''}`} onClick={() => props.onModeChange('import')}>
                          <strong>{t('导入已有项目', 'Import Existing Project')}</strong>
                          <span>{t('接入已经存在的项目目录。', 'Connect an existing project folder.')}</span>
                        </button>
                      </div>
                      <div className="platform-grid">
                        {platformCards.map((card) => (
                          <button
                            key={card.id}
                            className={`platform-card ${props.platform === card.id ? 'selected' : ''}`}
                            onClick={() => !card.disabled && props.onPlatformChange(card.id)}
                            disabled={card.disabled}
                          >
                            <div>{card.name}</div>
                            <span>{card.description}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="onboarding-section-card">
                      {(props.platform === 'unity' || props.platform === 'cocos') && props.mode === 'create' ? (
                        <>
                          <div className="section-heading">{t('项目类型', 'Project Type')}</div>
                          <div className="setup-mode-grid compact">
                            <button className={`setup-mode-card ${props.dimension === '2d' ? 'selected' : ''}`} onClick={() => props.onDimensionChange('2d')}>
                              <strong>{t('2D 项目', '2D Project')}</strong>
                              <span>{t('像素、横版、卡牌或其他 2D 原型。', 'Pixel art, side-scrollers, card games, or other 2D prototypes.')}</span>
                            </button>
                            <button
                              className={`setup-mode-card ${props.dimension === '3d' ? 'selected' : ''} ${props.platform !== 'unity' ? 'disabled-card' : ''}`}
                              onClick={() => props.platform === 'unity' && props.onDimensionChange('3d')}
                              disabled={props.platform !== 'unity'}
                            >
                              <strong>{t('3D 项目', '3D Project')}</strong>
                              <span>{props.platform === 'unity' ? t('三维场景、平台跳跃、第三人称。', '3D scenes, platformers, third-person gameplay.') : t('当前引擎暂不支持 3D。', 'This engine does not support 3D yet.')}</span>
                            </button>
                          </div>
                        </>
                      ) : null}

                      <div className="onboarding-panel">
                        <div className="section-heading">{projectSetupHeading}</div>
                        {props.mode === 'create' ? (
                          <label className="field">
                            <span>{t('项目名称', 'Project Name')}</span>
                            <input
                              value={props.projectName}
                              onChange={(event) => props.onProjectNameChange(event.target.value)}
                              placeholder={isGenericProject ? t('例如：我的工作区', 'Example: My Workspace') : t('例如：Flappy Bird', 'Example: Flappy Bird')}
                            />
                          </label>
                        ) : null}
                        <label className="field">
                          <span>
                            {props.mode === 'create'
                              ? isGenericProject
                                ? t('项目存放目录', 'Project Destination Folder')
                                : t('项目创建目录', 'Project Destination Folder')
                              : t('已有项目目录', 'Existing Project Folder')}
                          </span>
                          <div className="inline-field">
                            <input
                              value={props.projectPath}
                              onChange={(event) => props.onPathChange(event.target.value)}
                              placeholder={props.mode === 'create' ? '~/Downloads' : t('选择已有项目文件夹', 'Choose an existing project folder')}
                            />
                            <button className="prototype-secondary" onClick={props.onBrowsePath}>
                              {t('浏览...', 'Browse...')}
                            </button>
                          </div>
                        </label>
                        {isGenericProject ? (
                          <div className="helper-copy">{t('通用项目不会绑定游戏引擎，可直接进入工作台。', 'Generic projects do not bind a game engine and can enter the workspace directly.')}</div>
                        ) : null}
                        {props.actionMessage ? <div className="helper-copy onboarding-action-message">{props.actionMessage}</div> : null}
                        {props.detectionMessage && !props.detectionOk ? <div className="helper-copy onboarding-action-message">{props.detectionMessage}</div> : null}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="onboarding-footer-bar">
                <button className="prototype-ghost" onClick={props.onSkip}>
                  {t('跳过引导，稍后配置', 'Skip for now')}
                </button>
                <button
                  className="prototype-primary"
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
                </button>
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
                <button className="prototype-ghost" onClick={props.onBackToSetup}>
                  {t('返回调整', 'Adjust Settings')}
                </button>
                <button className="prototype-primary" onClick={props.onEnter}>
                  {t('进入工作台', 'Enter Workspace')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </StandaloneAppShell>
  );
}
