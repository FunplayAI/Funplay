import { useState, type JSX } from 'react';
import type { AiProvider, AiProviderInput, AiTestResult } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { ProviderSettingsPage, buildProviderToggleInput } from '../pages/ProviderSettingsPage';
import { ProviderEditor } from '../settings-modals';

export function AppSettingsAiProviderSection(props: {
  providers: AiProvider[];
  providerTests: Record<string, AiTestResult>;
  selectedProjectId?: string;
  onCreateProvider: (input: AiProviderInput) => Promise<void>;
  onUpdateProvider: (providerId: string, input: AiProviderInput) => Promise<void>;
  onDeleteProvider: (providerId: string) => void;
  onTestProvider: (providerId: string) => void;
  onSetDefaultProvider: (providerId: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<AiProvider | null>(null);
  const t = (zh: string, en: string): string => localize(language, zh, en);

  if (editorOpen) {
    return (
      <section className="app-settings-section provider-settings-embedded">
        <div className="app-settings-inline-editor">
          <div className="app-settings-inline-editor-header">
            <strong>{editingTarget ? t('编辑 Provider', 'Edit Provider') : t('添加 Provider', 'Add Provider')}</strong>
            <div className="helper-copy">{t('直接在当前设置页内完成模型服务配置。', 'Configure model services directly inside this settings page.')}</div>
          </div>
          <ProviderEditor
            provider={editingTarget}
            onCancel={() => {
              setEditorOpen(false);
              setEditingTarget(null);
            }}
            onCreate={async (input) => {
              await props.onCreateProvider(input);
              setEditorOpen(false);
              setEditingTarget(null);
            }}
            onUpdate={async (providerId, input) => {
              await props.onUpdateProvider(providerId, input);
              setEditorOpen(false);
              setEditingTarget(null);
            }}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="app-settings-section provider-settings-embedded">
      <ProviderSettingsPage
        providers={props.providers}
        providerTests={props.providerTests}
        selectedProjectId={props.selectedProjectId}
        onAddProvider={() => {
          setEditingTarget(null);
          setEditorOpen(true);
        }}
        onEditProvider={(provider) => {
          setEditingTarget(provider);
          setEditorOpen(true);
        }}
        onDeleteProvider={props.onDeleteProvider}
        onTestProvider={props.onTestProvider}
        onSetDefaultProvider={props.onSetDefaultProvider}
        onToggleProvider={(provider, enabled) => void props.onUpdateProvider(provider.id, buildProviderToggleInput(provider, enabled))}
        embedded
      />
    </section>
  );
}
