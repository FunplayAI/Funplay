import type { JSX } from 'react';
import { Play, RefreshCw, Wrench, X } from 'lucide-react';
import type {
  EnvironmentAction,
  EnvironmentActionKind,
  EnvironmentCheck,
  EnvironmentDiagnostics,
  Project
} from '../../../../shared/types';
import { localize, useUiLanguage, type UiLanguage } from '../../../i18n';
import { Button, IconButton } from '../../ui/index';

export function EngineStatusDialog(props: {
  project: Project;
  diagnostics: EnvironmentDiagnostics | null;
  loading: boolean;
  actionId: EnvironmentActionKind | null;
  error: string;
  actionMessage: string;
  onClose: () => void;
  onRefresh: () => void;
  onRunAction: (actionId: EnvironmentActionKind) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const platform = props.project.engine?.platform ?? props.diagnostics?.platform ?? 'unity';
  const labels = getEngineStatusLabels(platform, language);
  const hubCheck = findEnvironmentCheck(props.diagnostics, platform === 'cocos' ? 'cocos-dashboard' : 'unity-hub');
  const projectCheck = findEnvironmentCheck(props.diagnostics, 'engine-opened');
  const projectValidityCheck = findEnvironmentCheck(props.diagnostics, 'engine-project');
  const bridgeInstalledCheck = findEnvironmentCheck(props.diagnostics, 'bridge-installed');
  const bridgeConnectedCheck = findEnvironmentCheck(props.diagnostics, 'bridge-connected');
  const mcpStatus = bridgeConnectedCheck?.status === 'passed'
    ? 'passed'
    : bridgeInstalledCheck?.status === 'failed'
      ? 'failed'
      : bridgeInstalledCheck?.status === 'warning' || bridgeConnectedCheck?.status === 'warning'
      ? 'warning'
      : bridgeConnectedCheck?.status ?? bridgeInstalledCheck?.status ?? 'pending';
  const hubStatus = platform === 'unity' && hubCheck?.actions.some((action) => action.id === 'open_unity_hub')
    ? 'warning'
    : hubCheck?.status ?? 'pending';
  const projectActions = dedupeEnvironmentActions([
    ...(projectCheck?.actions ?? []),
    ...(projectValidityCheck?.status === 'passed' ? [] : projectValidityCheck?.actions ?? [])
  ]);
  const mcpActions = dedupeEnvironmentActions([
    ...(bridgeConnectedCheck?.actions ?? []),
    ...(bridgeInstalledCheck?.actions ?? [])
  ]);

  return (
    <div className="modal-backdrop engine-status-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section className="fp-modal modal-card engine-status-modal" role="dialog" aria-modal="true" aria-labelledby="engine-status-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">{t('引擎状态', 'Engine Status')}</div>
            <h2 id="engine-status-title" className="page-title">{formatEnginePlatformLabel(platform)}</h2>
          </div>
          <div className="engine-status-header-actions">
            <IconButton
              label={t('刷新状态', 'Refresh status')}
              icon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={props.onRefresh}
              loading={props.loading}
            />
            <IconButton label={t('关闭', 'Close')} icon={<X size={16} aria-hidden="true" />} onClick={props.onClose} />
          </div>
        </div>
        <div className="modal-stack engine-status-stack">
          <div className="engine-status-path">{props.project.engine?.projectPath || t('未记录项目路径', 'No project path recorded')}</div>
          {props.error ? <div className="warning-banner compact error">{props.error}</div> : null}
          {props.actionMessage ? <div className="status-banner compact ok">{props.actionMessage}</div> : null}
          <EngineStatusRow
            title={labels.hub}
            status={hubStatus}
            detail={hubCheck?.detail ?? t('尚未检测。', 'Not checked yet.')}
            actions={hubCheck?.actions ?? []}
            actionId={props.actionId}
            onRunAction={props.onRunAction}
          />
          <EngineStatusRow
            title={labels.project}
            status={projectCheck?.status ?? projectValidityCheck?.status ?? 'pending'}
            detail={[projectValidityCheck?.detail, projectCheck?.detail].filter(Boolean).join(' · ') || t('尚未检测。', 'Not checked yet.')}
            actions={projectActions}
            actionId={props.actionId}
            onRunAction={props.onRunAction}
          />
          <EngineStatusRow
            title={labels.mcp}
            status={mcpStatus}
            detail={[bridgeInstalledCheck?.detail, bridgeConnectedCheck?.detail].filter(Boolean).join(' · ') || t('尚未检测。', 'Not checked yet.')}
            actions={mcpActions}
            actionId={props.actionId}
            onRunAction={props.onRunAction}
          />
        </div>
      </section>
    </div>
  );
}

function EngineStatusRow(props: {
  title: string;
  status: EnvironmentCheck['status'];
  detail: string;
  actions: EnvironmentAction[];
  actionId: EnvironmentActionKind | null;
  onRunAction: (actionId: EnvironmentActionKind) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  return (
    <div className={`engine-status-row ${props.status}`}>
      <div className="engine-status-row-main">
        <div className="engine-status-row-title">
          <strong>{props.title}</strong>
          <span className={`engine-status-badge ${props.status}`}>{formatEnvironmentStatusLabel(language, props.status)}</span>
        </div>
        <p>{props.detail}</p>
      </div>
      {props.actions.length > 0 ? (
        <div className="engine-status-row-actions">
          {props.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.primary ? 'primary' : 'secondary'}
              loading={props.actionId === action.id}
              leadingIcon={action.id === 'install_project_bridge' || action.id === 'install_cocos_bridge' ? <Wrench size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
              onClick={() => props.onRunAction(action.id)}
            >
              {action.label || t('打开', 'Open')}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function findEnvironmentCheck(diagnostics: EnvironmentDiagnostics | null, id: string): EnvironmentCheck | undefined {
  return diagnostics?.checks.find((check) => check.id === id);
}

function dedupeEnvironmentActions(actions: EnvironmentAction[]): EnvironmentAction[] {
  return [...new Map(actions.map((action) => [action.id, action])).values()];
}

function formatEnvironmentStatusLabel(language: UiLanguage, status: EnvironmentCheck['status']): string {
  if (status === 'passed') return localize(language, '已就绪', 'Ready');
  if (status === 'warning') return localize(language, '需处理', 'Needs Action');
  if (status === 'failed') return localize(language, '不可用', 'Unavailable');
  return localize(language, '待检测', 'Pending');
}

function getEngineStatusLabels(platform: NonNullable<Project['engine']>['platform'], language: UiLanguage): {
  hub: string;
  project: string;
  mcp: string;
} {
  if (platform === 'cocos') {
    return {
      hub: 'Cocos Dashboard',
      project: localize(language, 'Cocos 项目', 'Cocos Project'),
      mcp: 'Cocos MCP'
    };
  }
  if (platform === 'godot') {
    return {
      hub: 'Godot',
      project: localize(language, 'Godot 项目', 'Godot Project'),
      mcp: 'Godot MCP'
    };
  }
  if (platform === 'unreal') {
    return {
      hub: 'Unreal Launcher',
      project: localize(language, 'Unreal 项目', 'Unreal Project'),
      mcp: 'Unreal MCP'
    };
  }
  return {
    hub: 'Unity Hub',
    project: localize(language, 'Unity 项目', 'Unity Project'),
    mcp: 'Unity MCP'
  };
}

export function formatEnginePlatformLabel(platform: Exclude<Project['engine'], undefined>['platform']): string {
  if (platform === 'unity') return 'Unity';
  if (platform === 'cocos') return 'Cocos';
  if (platform === 'godot') return 'Godot';
  if (platform === 'unreal') return 'Unreal';
  return 'Engine';
}
