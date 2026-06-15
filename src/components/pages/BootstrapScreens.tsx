import type { Dispatch, JSX, SetStateAction } from 'react';
import type { AppNotification, McpPlugin, Project } from '../../../shared/types';
import { UiLanguageProvider, localize, type UiLanguage } from '../../i18n';
import type { AppMode } from '../../stores/uiShellStore';
import type { useOnboarding } from '../../hooks/useOnboarding';
import { WelcomeScreen } from './WelcomeScreen';
import { OnboardingScreen } from './OnboardingScreen';
import { NotificationToastStack } from '../shared/NotificationToastStack';

/**
 * The four mutually-exclusive full-screen early returns extracted from App.tsx:
 * the loading splash, the bootstrap-error card, the welcome screen, and the
 * onboarding wizard. A pure presentational component — everything it renders
 * originates in App's hooks/stores, so it is threaded as props. Returns null
 * when appMode is 'workspace' (App falls through to the main workspace return).
 */
export function BootstrapScreens(props: {
  isLoading: boolean;
  bootstrapError: string;
  appMode: AppMode;
  setAppMode: Dispatch<SetStateAction<AppMode>>;
  projects: Project[];
  language: UiLanguage;
  mcpPlugins: McpPlugin[];
  onboarding: ReturnType<typeof useOnboarding>;
  openProject: (projectId: string) => void;
  appNotifications: AppNotification[];
  dismissNotification: (id: string) => void;
}): JSX.Element | null {
  const {
    isLoading,
    bootstrapError,
    appMode,
    setAppMode,
    projects,
    language,
    mcpPlugins,
    onboarding,
    openProject,
    appNotifications,
    dismissNotification
  } = props;

  const toasts = <NotificationToastStack notifications={appNotifications} onDismiss={dismissNotification} />;

  if (isLoading) {
    return (
      <UiLanguageProvider language={language}>
        <>
          <div className="app-bootstrap-screen">{localize(language, '正在加载 Funplay…', 'Loading Funplay…')}</div>
          {toasts}
        </>
      </UiLanguageProvider>
    );
  }

  if (bootstrapError) {
    return (
      <UiLanguageProvider language={language}>
        <>
          <div className="app-bootstrap-screen">
            <div className="bootstrap-error-card">
              <strong>{localize(language, 'Funplay 启动失败', 'Funplay failed to start')}</strong>
              <div>{bootstrapError}</div>
            </div>
          </div>
          {toasts}
        </>
      </UiLanguageProvider>
    );
  }

  if (appMode === 'welcome') {
    return (
      <UiLanguageProvider language={language}>
        <>
          <WelcomeScreen
            projects={projects}
            mcpPlugins={mcpPlugins}
            onCreate={() => {
              onboarding.startOnboarding();
              setAppMode('onboarding');
            }}
            onOpen={openProject}
            onOpenExisting={() => void onboarding.handlePickExistingProjectFromWelcome()}
          />
          {toasts}
        </>
      </UiLanguageProvider>
    );
  }

  if (appMode === 'onboarding') {
    return (
      <UiLanguageProvider language={language}>
        <>
          <OnboardingScreen
            step={onboarding.onboardingStep}
            view={onboarding.onboardingView}
            mode={onboarding.onboardingMode}
            platform={onboarding.onboardingPlatform}
            dimension={onboarding.onboardingDimension}
            projectName={onboarding.onboardingProjectName}
            projectPath={onboarding.onboardingProjectPath}
            unityEditors={onboarding.onboardingUnityEditors}
            selectedUnityEditorVersion={onboarding.onboardingUnityEditorVersion}
            diagnostics={onboarding.environmentDiagnostics}
            tasks={onboarding.environmentTasks}
            detectionMessage={onboarding.onboardingDetectionMessage}
            detectionOk={onboarding.onboardingDetectionOk}
            actionMessage={onboarding.environmentActionMessage}
            isChecking={onboarding.isCheckingEngine}
            isCreatingProject={onboarding.isCreatingProject}
            onModeChange={onboarding.setOnboardingMode}
            onPlatformChange={onboarding.setOnboardingPlatform}
            onDimensionChange={onboarding.setOnboardingDimension}
            onProjectNameChange={onboarding.setOnboardingProjectName}
            onPathChange={onboarding.setOnboardingProjectPath}
            onUnityEditorVersionChange={onboarding.setOnboardingUnityEditorVersion}
            onBrowsePath={() => void onboarding.handleBrowseOnboardingProjectPath()}
            onDetect={() => void onboarding.handleCheckOnboardingConnection()}
            onRunAction={(actionId) => void onboarding.handleRunEnvironmentAction(actionId)}
            onBackToSetup={() => onboarding.setOnboardingView('setup')}
            onSkip={() => setAppMode('workspace')}
            onNext={() => void onboarding.handleFinishOnboarding()}
            onEnter={() => void onboarding.handleEnterWorkspace()}
          />
          {toasts}
        </>
      </UiLanguageProvider>
    );
  }

  return null;
}
