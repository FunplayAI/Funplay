import { useEffect, useMemo, useState, type JSX } from 'react';
import { PROJECT_SESSION_RUNTIME_OPTIONS, getProjectSessionRuntimeLabel } from '../../../../shared/agent-runtimes';
import type {
  AgentPermissionMode,
  AgentRuntimeStrategy,
  AiProvider,
  Project,
  ProjectSession,
  ProjectSessionEffort,
  ProjectSessionRuntimeId
} from '../../../../shared/types';
import { localize, useUiLanguage, type UiLanguage } from '../../../i18n';
import { Card, InfoRow } from '../../shared/InfoComponents';
import { Button, TextField } from '../../ui/index';

export type SessionRuntimeUpdate = {
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  effort?: ProjectSessionEffort;
};

export function ProjectAgentSettings(props: {
  project: Project | null;
  providers: AiProvider[];
  activeProvider: AiProvider | null;
  defaultProviderId?: string;
  activeSession: ProjectSession | null;
  sessionProviderId?: string;
  sessionModel?: string;
  sessionRuntimeId?: ProjectSessionRuntimeId;
  sessionEffort: ProjectSessionEffort;
  globalRuntimeStrategy: AgentRuntimeStrategy;
  onUpdatePermissionMode: (permissionMode: AgentPermissionMode) => Promise<void>;
  onUpdateSessionRuntime: (runtime: SessionRuntimeUpdate) => Promise<void>;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const [modelDraft, setModelDraft] = useState(props.sessionModel ?? '');
  const projectPermissionMode = props.project?.agentPolicy?.permissionMode;
  const providerOverrideActive = Boolean(
    props.sessionProviderId && props.sessionProviderId !== (props.defaultProviderId || '')
  );
  const activeProviderLabel = props.activeProvider?.name ?? t('本地规划器', 'Local Planner');
  const activeModelLabel = props.sessionModel || props.activeProvider?.model || t('本地规划器', 'Local Planner');
  const globalRuntimeLabel = formatRuntimeStrategyLabel(props.globalRuntimeStrategy, language);
  const runtimeLabel = props.sessionRuntimeId
    ? getProjectSessionRuntimeLabel(props.sessionRuntimeId)
    : t(`默认 · ${globalRuntimeLabel}`, `Default · ${globalRuntimeLabel}`);
  const permissionOptions: Array<[AgentPermissionMode, string]> = [
    ['full-access', t('Build', 'Build')],
    ['read-only', t('Plan', 'Plan')]
  ];
  const effortOptions: Array<{ value: ProjectSessionEffort; label: string }> = [
    { value: 'auto', label: t('自动', 'Auto') },
    { value: 'low', label: t('低', 'Low') },
    { value: 'medium', label: t('中', 'Medium') },
    { value: 'high', label: t('高', 'High') },
    { value: 'xhigh', label: t('极高', 'XHigh') },
    { value: 'max', label: t('最大', 'Max') }
  ];
  const modelOptions = useMemo(
    () => [
      ...new Set(
        [props.activeProvider?.model, ...props.providers.map((provider) => provider.model)]
          .map((model) => model?.trim())
          .filter((model): model is string => Boolean(model))
      )
    ],
    [props.activeProvider?.model, props.providers]
  );

  useEffect(() => {
    setModelDraft(props.sessionModel ?? '');
  }, [props.sessionModel, props.activeSession?.id]);

  function updateRuntime(runtime: SessionRuntimeUpdate): void {
    if (!props.activeSession) {
      return;
    }
    void props.onUpdateSessionRuntime(runtime);
  }

  function applyModel(model: string): void {
    const normalized = model.trim();
    setModelDraft(normalized);
    updateRuntime({ model: normalized || undefined });
  }

  return (
    <div className="engine-settings-grid">
      <Card title={t('当前会话运行', 'Current Session Runtime')}>
        <InfoRow label={t('会话', 'Session')} value={props.activeSession?.title || t('未选择', 'No Session')} />
        <InfoRow
          label="Provider"
          value={
            providerOverrideActive
              ? activeProviderLabel
              : t(`默认 · ${activeProviderLabel}`, `Default · ${activeProviderLabel}`)
          }
        />
        <InfoRow label={t('模型', 'Model')} value={activeModelLabel} />
        <InfoRow label="Runtime" value={runtimeLabel} />
      </Card>
      <Card title={t('模型', 'Model')}>
        <div className="agent-settings-control-stack">
          <TextField
            label={t('当前会话模型覆盖', 'Current session model override')}
            value={modelDraft}
            disabled={!props.activeSession}
            onValueChange={setModelDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyModel(modelDraft);
              }
            }}
            placeholder={props.activeProvider?.model || t('跟随 Provider 默认模型', 'Use provider default model')}
          />
          <div className="agent-settings-button-row">
            <Button size="sm" variant="primary" disabled={!props.activeSession} onClick={() => applyModel(modelDraft)}>
              {t('应用模型', 'Apply Model')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!props.activeSession || !props.sessionModel}
              onClick={() => applyModel('')}
            >
              {t('跟随默认模型', 'Use Default Model')}
            </Button>
          </div>
          {modelOptions.length > 0 ? (
            <div className="agent-settings-chip-grid">
              {modelOptions.map((model) => (
                <Button
                  key={model}
                  size="compact"
                  variant="ghost"
                  className={`agent-settings-chip-button ${(props.sessionModel || props.activeProvider?.model) === model ? 'active' : ''}`}
                  disabled={!props.activeSession}
                  onClick={() => applyModel(model)}
                >
                  {model}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </Card>
      <Card title="Runtime">
        <div className="agent-settings-control-stack">
          <div className="segmented-options">
            <Button
              size="compact"
              variant="ghost"
              className={`settings-choice-button ${!props.sessionRuntimeId ? 'active' : ''}`}
              disabled={!props.activeSession}
              onClick={() => updateRuntime({ runtimeId: undefined })}
            >
              {t('跟随默认', 'Use Default')}
            </Button>
            {PROJECT_SESSION_RUNTIME_OPTIONS.map((runtime) => (
              <Button
                key={runtime.id}
                size="compact"
                variant="ghost"
                className={`settings-choice-button ${props.sessionRuntimeId === runtime.id ? 'active' : ''}`}
                disabled={!props.activeSession}
                onClick={() => updateRuntime({ runtimeId: runtime.id })}
              >
                {runtime.label}
              </Button>
            ))}
          </div>
          <div className="helper-copy">
            {props.sessionRuntimeId === 'claude-code-sdk'
              ? t(
                  'Claude Code SDK 运行时会使用本地 Claude Code 链路。',
                  'Claude Code SDK runtime uses the local Claude Code path.'
                )
              : t(
                  'Native 运行时使用 Funplay 内置多 Provider 工具循环。',
                  'Native runtime uses Funplay built-in multi-provider tool loop.'
                )}
          </div>
        </div>
      </Card>
      <Card title={t('智能强度', 'Reasoning Effort')}>
        <div className="agent-settings-control-stack">
          <div className="agent-settings-section-label">{t('智能强度', 'Reasoning Effort')}</div>
          <div className="segmented-options">
            {effortOptions.map((option) => (
              <Button
                key={option.value}
                size="compact"
                variant="ghost"
                className={`settings-choice-button ${props.sessionEffort === option.value ? 'active' : ''}`}
                disabled={!props.activeSession}
                onClick={() => updateRuntime({ effort: option.value })}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>
      <Card title={t('Agent 模式', 'Agent Mode')}>
        <div className="helper-copy">
          {projectPermissionMode
            ? t(
                '当前项目已选择 Agent 模式；当前会话仍可在聊天输入区临时切换。',
                'This project has an Agent mode selected; the current session can still switch from the chat composer.'
              )
            : t(
                '为当前项目选择 Build 或 Plan。Build 用于直接开发；Plan 用于只读探索和方案规划。',
                'Choose Build or Plan for this project. Build is for direct development; Plan is for read-only exploration and planning.'
              )}
        </div>
        <div className="segmented-options">
          {permissionOptions.map(([mode, label]) => (
            <Button
              key={mode}
              size="compact"
              variant="ghost"
              className={`settings-choice-button ${projectPermissionMode === mode ? 'active' : ''}`}
              disabled={!props.project}
              onClick={() => void props.onUpdatePermissionMode(mode)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function formatRuntimeStrategyLabel(strategy: AgentRuntimeStrategy, language: UiLanguage): string {
  const labels: Record<AgentRuntimeStrategy, string> = {
    auto: localize(language, 'Auto', 'Auto'),
    native: localize(language, 'Native', 'Native'),
    'claude-code-sdk': localize(language, 'Claude Code', 'Claude Code')
  };
  return labels[strategy];
}
