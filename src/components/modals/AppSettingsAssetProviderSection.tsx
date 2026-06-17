import { useState, type JSX } from 'react';
import type { AssetGenerationProviderConfig, AssetGenerationProviderInput } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { AssetProviderEditor, AssetProviderSettingsPage, buildAssetProviderToggleInput } from '../pages/AssetProviderSettingsPage';

export function AppSettingsAssetProviderSection(props: {
  providers: AssetGenerationProviderConfig[];
  onCreateProvider?: (input: AssetGenerationProviderInput) => Promise<void>;
  onUpdateProvider?: (providerId: string, input: AssetGenerationProviderInput) => Promise<void>;
  onDeleteProvider?: (providerId: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<AssetGenerationProviderConfig | null>(null);
  const t = (zh: string, en: string): string => localize(language, zh, en);

  if (editorOpen) {
    return (
      <section className="app-settings-section provider-settings-embedded">
        <div className="app-settings-inline-editor">
          <div className="app-settings-inline-editor-header">
            <strong>{editingTarget ? t('编辑素材 Provider', 'Edit Asset Provider') : t('添加素材 Provider', 'Add Asset Provider')}</strong>
          </div>
          <AssetProviderEditor
            provider={editingTarget}
            onCancel={() => {
              setEditorOpen(false);
              setEditingTarget(null);
            }}
            onCreate={async (input) => {
              await props.onCreateProvider?.(input);
              setEditorOpen(false);
              setEditingTarget(null);
            }}
            onUpdate={async (providerId, input) => {
              await props.onUpdateProvider?.(providerId, input);
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
      <AssetProviderSettingsPage
        providers={props.providers}
        onAddProvider={() => {
          setEditingTarget(null);
          setEditorOpen(true);
        }}
        onEditProvider={(provider) => {
          setEditingTarget(provider);
          setEditorOpen(true);
        }}
        onDeleteProvider={(providerId) => props.onDeleteProvider?.(providerId)}
        onToggleProvider={(provider, enabled) => void props.onUpdateProvider?.(provider.id, buildAssetProviderToggleInput(provider, enabled))}
        embedded
      />
    </section>
  );
}
