import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AiProvider, AppUpdateSnapshot, PromptAttachment } from '../../shared/types.ts';
import { UiLanguageProvider } from '../../src/i18n.tsx';
import { ChatComposer } from '../../src/components/chat/ChatComposer.tsx';
import { AppShell } from '../../src/components/layout/AppShell.tsx';

export function renderZh(element: ReactElement): string {
  return renderToStaticMarkup(createElement(UiLanguageProvider, {
    language: 'zh-CN'
  }, element));
}

export function noop(): void {}

export async function noopAsync(): Promise<void> {}

export const contextUsage = {
  usedTokens: 128,
  tokenBudget: 1000000,
  percent: 0.01,
  sessionTokens: 96,
  draftTokens: 12,
  attachmentTokens: 0,
  streamTokens: 20,
  messageCount: 2,
  modelLabel: 'mimo-v2.5-pro'
};

export const provider: AiProvider = {
  id: 'provider_mimo',
  name: 'Xiaomi MiMo',
  protocol: 'openai-compatible',
  apiMode: 'chat',
  baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
  apiKey: '',
  model: 'mimo-v2.5-pro',
  enabled: true,
  isDefault: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

export const secondaryProvider: AiProvider = {
  id: 'provider_deepseek',
  name: 'DeepSeek',
  protocol: 'openai-compatible',
  apiMode: 'chat',
  authStyle: 'api_key',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  hasStoredApiKey: false,
  model: 'deepseek-chat',
  enabled: true,
  isDefault: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

export function renderComposer(
  permissionMode: 'full-access' | 'read-only',
  engineConnection?: Parameters<typeof ChatComposer>[0]['engineConnection'],
  overrides: Partial<Parameters<typeof ChatComposer>[0]> = {}
): string {
  return renderZh(createElement(ChatComposer, {
    draft: '',
    attachments: [] as PromptAttachment[],
    contextUsage,
    error: '',
    queuedPrompts: [],
    isSending: false,
    isExecutingPlan: false,
    engineConnection,
    permissionLabel: permissionMode === 'full-access' ? 'Build' : 'Plan',
    activeProviderLabel: 'Xiaomi MiMo',
    providers: [provider],
    defaultProviderId: provider.id,
    activeProviderId: provider.id,
    permissionMode,
    onDraftChange: noop,
    onPickAttachments: noop,
    onImportAttachments: noop,
    onRemoveAttachment: noop,
    onSubmit: noop,
    onCancelStream: noop,
    onRespondPermission: noop,
    onRespondUserInput: noop,
    onUpdateSessionRuntime: noop,
    onUpdatePermissionMode: noop,
    onRemoveQueuedPrompt: noop,
    onOpenAppSettings: noop,
    onOpenProjectAgentSettings: noop,
    ...overrides
  }));
}

export function createUpdateSnapshot(status: AppUpdateSnapshot['status']): AppUpdateSnapshot {
  return {
    status,
    currentVersion: '0.1.0',
    updateInfo: status === 'not_available' ? undefined : { version: '0.2.0' },
    canCheck: true,
    canDownload: status === 'available',
    canInstall: status === 'downloaded',
    isPackaged: true,
    feedSource: 'embedded',
    autoDownload: false
  };
}

export function renderAppShell(updateStatus: AppUpdateSnapshot | null, overrides: Partial<Parameters<typeof AppShell>[0]> = {}): string {
  return renderZh(createElement(AppShell, {
    projects: [{ id: 'project_1', name: 'Rogue' }],
    selectedProjectId: 'project_1',
    onSelectProject: noop,
    onDeleteProject: noop,
    onAddProject: noop,
    onOpenAppSettings: noop,
    appUpdateStatus: updateStatus,
    onOpenAppUpdate: noop,
    showChangePanelToggle: true,
    changePanelOpen: false,
    onToggleChangePanel: noop,
    leftCollapsed: true,
    rightCollapsed: true,
    onToggleLeftSidebar: noop,
    onToggleRightInspector: noop,
    leftWidth: 320,
    rightWidth: 360,
    onLeftWidthChange: noop,
    onRightWidthChange: noop,
    children: createElement('main', null, 'Workspace'),
    ...overrides
  }));
}
