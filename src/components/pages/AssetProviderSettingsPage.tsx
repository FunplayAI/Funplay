import { useEffect, useMemo, useState, type JSX } from 'react';
import { ChevronLeft, Plus, Settings2, Trash2 } from 'lucide-react';
import type {
  AssetGenerationConfigurableProviderAdapterKind,
  AssetGenerationProviderConfig,
  AssetGenerationProviderInput
} from '../../../shared/types';
import { localize, useUiLanguage, type UiLanguage } from '../../i18n';
import { Badge, Button, ConfigDetailActionBar, ConfigListPanel, SelectField, SwitchField, TextAreaField, TextField, ToggleSwitch, type ConfigDetailAction, type ConfigListItem } from '../ui/index';

type AssetProviderPreset = {
  adapter: AssetGenerationConfigurableProviderAdapterKind;
  name: string;
  baseUrl: string;
  model: string;
  descriptionZh: string;
  descriptionEn: string;
};

const assetProviderPresets: AssetProviderPreset[] = [
  {
    adapter: 'openai-image',
    name: 'OpenAI Images',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-2',
    descriptionZh: '生成 2D 图片、UI 和纹理。',
    descriptionEn: 'Generates 2D images, UI, and textures.'
  },
  {
    adapter: 'stability',
    name: 'Stability AI',
    baseUrl: 'https://api.stability.ai',
    model: 'core',
    descriptionZh: '调用 Stability Stable Image 接口。',
    descriptionEn: 'Uses Stability Stable Image APIs.'
  },
  {
    adapter: 'replicate',
    name: 'Replicate',
    baseUrl: 'https://api.replicate.com/v1',
    model: '',
    descriptionZh: '按模型或版本调用 Replicate，适合扩展图片、动画、3D 和音频模型。',
    descriptionEn: 'Runs Replicate models or versions for images, animation, 3D, and audio.'
  },
  {
    adapter: 'comfyui',
    name: 'ComfyUI',
    baseUrl: 'http://127.0.0.1:8188',
    model: '',
    descriptionZh: '连接本地或远端 ComfyUI 工作流。',
    descriptionEn: 'Connects to a local or remote ComfyUI workflow.'
  },
  {
    adapter: 'meshy',
    name: 'Meshy',
    baseUrl: 'https://api.meshy.ai/openapi/v2',
    model: 'meshy-6',
    descriptionZh: '生成 3D 模型。',
    descriptionEn: 'Generates 3D models.'
  },
  {
    adapter: 'elevenlabs',
    name: 'ElevenLabs Audio',
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'eleven_text_to_sound_v2',
    descriptionZh: '生成音效、音乐循环和可选语音。',
    descriptionEn: 'Generates sound effects, music loops, and optional voice.'
  }
];

type AssetProviderDraft = AssetGenerationProviderInput;

function presetForAdapter(adapter: AssetGenerationConfigurableProviderAdapterKind): AssetProviderPreset {
  return assetProviderPresets.find((preset) => preset.adapter === adapter) ?? assetProviderPresets[0];
}

/**
 * Renderer-side mirror of the main process `configuredProviderReady` adapter rules
 * (electron/main/asset-generation-service.ts). ComfyUI needs Base URL + workflow,
 * Replicate needs key + model, others need an API key. The renderer only knows
 * whether a key is stored (`hasStoredApiKey`), not its value, which is sufficient.
 */
function assetProviderReadiness(provider: AssetGenerationProviderConfig): { ready: boolean; missing: { zh: string; en: string } } {
  if (provider.adapter === 'comfyui') {
    const ready = Boolean(provider.baseUrl?.trim() && (provider.workflowJson?.trim() || provider.workflowPath?.trim()));
    return { ready, missing: { zh: '缺少 Base URL 或工作流', en: 'Missing Base URL or workflow' } };
  }
  if (provider.adapter === 'replicate') {
    const ready = Boolean(provider.hasStoredApiKey && provider.model?.trim());
    return { ready, missing: { zh: '缺少密钥或模型', en: 'Missing key or model' } };
  }
  return { ready: Boolean(provider.hasStoredApiKey), missing: { zh: '缺少密钥', en: 'Missing key' } };
}

function createAssetProviderDraft(provider: AssetGenerationProviderConfig | null): AssetProviderDraft {
  if (provider) {
    return {
      name: provider.name,
      adapter: provider.adapter,
      enabled: provider.enabled,
      baseUrl: provider.baseUrl ?? presetForAdapter(provider.adapter).baseUrl,
      apiKey: '',
      model: provider.model ?? '',
      workflowJson: provider.workflowJson ?? '',
      workflowPath: provider.workflowPath ?? '',
      voiceId: provider.voiceId ?? '',
      notes: provider.notes ?? ''
    };
  }
  const preset = assetProviderPresets[0];
  return {
    name: preset.name,
    adapter: preset.adapter,
    enabled: true,
    baseUrl: preset.baseUrl,
    apiKey: '',
    model: preset.model,
    workflowJson: '',
    workflowPath: '',
    voiceId: '',
    notes: ''
  };
}

export function AssetProviderSettingsPage(props: {
  providers: AssetGenerationProviderConfig[];
  onAddProvider: () => void;
  onEditProvider: (provider: AssetGenerationProviderConfig) => void;
  onDeleteProvider: (providerId: string) => void;
  onToggleProvider: (provider: AssetGenerationProviderConfig, enabled: boolean) => void;
  embedded?: boolean;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const [detailProviderId, setDetailProviderId] = useState('');
  const detailProvider = props.providers.find((provider) => provider.id === detailProviderId) ?? null;
  const enabledCount = props.providers.filter((provider) => provider.enabled).length;
  const providerItems: ConfigListItem[] = props.providers.map((provider) => {
    const readiness = assetProviderReadiness(provider);
    return {
      id: provider.id,
      title: provider.name,
      subtitle: `${formatAssetProviderAdapter(provider.adapter, language)} · ${provider.model || provider.workflowPath || t('未配置模型', 'No model')}`,
      description: provider.baseUrl,
      statusLabel: provider.enabled ? t('启用', 'Enabled') : t('停用', 'Disabled'),
      statusTone: provider.enabled ? 'success' : 'neutral',
      enabled: provider.enabled,
      meta: [
        provider.adapter === 'comfyui' ? t('本地/自托管', 'Local / self-hosted') : t('云端服务', 'Cloud service'),
        readiness.ready ? t('可用', 'Ready') : t(`未就绪 · ${readiness.missing.zh}`, `Incomplete · ${readiness.missing.en}`)
      ],
      searchText: [provider.adapter, provider.model, provider.workflowPath, provider.baseUrl, provider.notes].filter(Boolean).join(' ')
    };
  });

  useEffect(() => {
    if (detailProviderId && !props.providers.some((provider) => provider.id === detailProviderId)) {
      setDetailProviderId('');
    }
  }, [detailProviderId, props.providers]);

  return (
    <div className={`provider-settings-page asset-provider-settings-page ${props.embedded ? 'embedded' : ''}`}>
      <div className={`settings-header ${props.embedded ? 'embedded' : ''}`}>
        <div>
          <h2>{t('素材 Provider', 'Asset Providers')}</h2>
          <div className="provider-settings-meta">
            <span>{t(`已配置 ${props.providers.length} 个素材 Provider`, `${props.providers.length} asset providers configured`)}</span>
            <span>{t(`启用 ${enabledCount} 个`, `${enabledCount} enabled`)}</span>
          </div>
        </div>
        <Button
          variant="primary"
          className="asset-provider-add-button"
          onClick={props.onAddProvider}
          leadingIcon={<Plus size={15} aria-hidden="true" />}
        >
          {t('添加素材 Provider', 'Add Asset Provider')}
        </Button>
      </div>

      {detailProvider ? (
        <div className="settings-detail-panel provider-settings-detail-route">
          <AssetProviderDetail
            provider={detailProvider}
            language={language}
            onBack={() => setDetailProviderId('')}
            onEdit={() => props.onEditProvider(detailProvider)}
            onDelete={() => props.onDeleteProvider(detailProvider.id)}
          />
        </div>
      ) : (
        <ConfigListPanel
          className="provider-settings-list-panel"
          items={providerItems}
          emptyTitle={t('暂无素材 Provider', 'No asset providers yet')}
          emptyDescription=""
          onOpenItem={setDetailProviderId}
          renderItemActions={(item) => {
            const provider = props.providers.find((candidate) => candidate.id === item.id);
            return provider ? (
              <ToggleSwitch
                label={provider.enabled ? t('停用素材 Provider', 'Disable asset provider') : t('启用素材 Provider', 'Enable asset provider')}
                checked={provider.enabled}
                onCheckedChange={(enabled) => props.onToggleProvider(provider, enabled)}
              />
            ) : null;
          }}
        />
      )}
    </div>
  );
}

export function AssetProviderEditor(props: {
  provider: AssetGenerationProviderConfig | null;
  onCancel: () => void;
  onCreate: (input: AssetGenerationProviderInput) => Promise<void>;
  onUpdate: (providerId: string, input: AssetGenerationProviderInput) => Promise<void>;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const [draft, setDraft] = useState<AssetProviderDraft>(() => createAssetProviderDraft(props.provider));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const preset = presetForAdapter(draft.adapter);

  useEffect(() => {
    setDraft(createAssetProviderDraft(props.provider));
    setError('');
  }, [props.provider?.id]);

  const adapterOptions = useMemo(
    () => assetProviderPresets.map((item) => ({
      value: item.adapter,
      label: formatAssetProviderAdapter(item.adapter, language)
    })),
    [language]
  );

  function friendlyAssetProviderError(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes('baseurl') || lower.includes('base url')) {
      return t('Base URL 需是有效网址，例如 https://api.example.com（本地 ComfyUI 可用 http://127.0.0.1:8188）。', 'Base URL must be a valid URL, e.g. https://api.example.com (local ComfyUI can use http://127.0.0.1:8188).');
    }
    if (lower.includes('configuration is incomplete') || message.includes('配置不完整')) {
      // Backend readiness errors are already bilingual and actionable; pass through.
      return message;
    }
    if (lower.includes('api key') || message.includes('API Key')) {
      return t('请填写有效的 API Key。', 'Please provide a valid API Key.');
    }
    return message;
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      if (props.provider) {
        await props.onUpdate(props.provider.id, draft);
      } else {
        await props.onCreate(draft);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? friendlyAssetProviderError(saveError.message) : t('保存失败。', 'Save failed.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="provider-editor asset-provider-editor">
      <SelectField
        label={t('素材服务类型', 'Asset Provider Type')}
        value={draft.adapter}
        options={adapterOptions}
        onValueChange={(value) => {
          const nextPreset = presetForAdapter(value as AssetGenerationConfigurableProviderAdapterKind);
          setDraft((current) => ({
            ...current,
            adapter: nextPreset.adapter,
            name: props.provider ? current.name : nextPreset.name,
            baseUrl: nextPreset.baseUrl,
            model: nextPreset.model,
            workflowJson: nextPreset.adapter === 'comfyui' ? current.workflowJson : '',
            workflowPath: nextPreset.adapter === 'comfyui' ? current.workflowPath : '',
            voiceId: nextPreset.adapter === 'elevenlabs' ? current.voiceId : ''
          }));
        }}
      />
      <TextField
        label={t('名称', 'Name')}
        value={draft.name}
        onValueChange={(value) => setDraft((current) => ({ ...current, name: value }))}
      />
      <TextField
        label={t('基础 URL', 'Base URL')}
        value={draft.baseUrl ?? ''}
        onValueChange={(value) => setDraft((current) => ({ ...current, baseUrl: value }))}
      />
      {draft.adapter !== 'comfyui' ? (
        <TextField
          label={t('API Key', 'API Key')}
          type="password"
          value={draft.apiKey ?? ''}
          placeholder={props.provider?.hasStoredApiKey ? t('已保存，留空表示不修改', 'Saved. Leave blank to keep unchanged.') : ''}
          onValueChange={(value) => setDraft((current) => ({ ...current, apiKey: value }))}
        />
      ) : null}
      {draft.adapter !== 'comfyui' ? (
        <TextField
          label={draft.adapter === 'replicate' ? t('模型或版本', 'Model or Version') : t('模型', 'Model')}
          value={draft.model ?? ''}
          placeholder={draft.adapter === 'replicate' ? 'owner/model 或 version hash' : preset.model}
          onValueChange={(value) => setDraft((current) => ({ ...current, model: value }))}
        />
      ) : null}
      {draft.adapter === 'elevenlabs' ? (
        <TextField
          label={t('音色 ID', 'Voice ID')}
          value={draft.voiceId ?? ''}
          onValueChange={(value) => setDraft((current) => ({ ...current, voiceId: value }))}
        />
      ) : null}
      {draft.adapter === 'comfyui' ? (
        <>
          <TextField
            label={t('工作流文件路径', 'Workflow File Path')}
            value={draft.workflowPath ?? ''}
            placeholder="/Users/me/comfy-workflow.json"
            onValueChange={(value) => setDraft((current) => ({ ...current, workflowPath: value }))}
          />
          <TextAreaField
            label={t('工作流 JSON', 'Workflow JSON')}
            value={draft.workflowJson ?? ''}
            placeholder={'{"1": {"inputs": {"text": "{{prompt}}"}}}'}
            helper={t('支持 {{prompt}}、{{negativePrompt}}、{{width}}、{{height}}、{{seed}} 占位符。', 'Supports {{prompt}}, {{negativePrompt}}, {{width}}, {{height}}, and {{seed}} placeholders.')}
            onValueChange={(value) => setDraft((current) => ({ ...current, workflowJson: value }))}
          />
        </>
      ) : null}
      <SwitchField
        label={t('启用素材 Provider', 'Enable Asset Provider')}
        checked={draft.enabled ?? true}
        onCheckedChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
      />
      <TextAreaField
        label={t('备注', 'Notes')}
        value={draft.notes ?? ''}
        onValueChange={(value) => setDraft((current) => ({ ...current, notes: value }))}
      />
      {error ? <div className="helper-copy form-error">{error}</div> : null}
      <div className="modal-actions">
        <Button variant="secondary" onClick={props.onCancel} disabled={saving}>
          {t('取消', 'Cancel')}
        </Button>
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={saving}>
          {saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}
        </Button>
      </div>
    </div>
  );
}

export function buildAssetProviderToggleInput(provider: AssetGenerationProviderConfig, enabled: boolean): AssetGenerationProviderInput {
  return {
    name: provider.name,
    adapter: provider.adapter,
    enabled,
    baseUrl: provider.baseUrl,
    apiKey: '',
    model: provider.model,
    workflowJson: provider.workflowJson,
    workflowPath: provider.workflowPath,
    voiceId: provider.voiceId,
    notes: provider.notes
  };
}

function AssetProviderDetail(props: {
  provider: AssetGenerationProviderConfig;
  language: UiLanguage;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const t = (zh: string, en: string): string => localize(props.language, zh, en);
  const preset = presetForAdapter(props.provider.adapter);
  const readiness = assetProviderReadiness(props.provider);
  const primaryActions: ConfigDetailAction[] = [
    { id: 'edit', label: t('编辑', 'Edit'), icon: <Settings2 size={14} aria-hidden="true" />, onAction: props.onEdit }
  ];
  const dangerActions: ConfigDetailAction[] = [
    { id: 'delete', label: t('删除', 'Delete'), tone: 'danger', icon: <Trash2 size={14} aria-hidden="true" />, onAction: props.onDelete }
  ];
  return (
    <div className="provider-channel-detail">
      <div className="settings-header compact">
        <div>
          <Button variant="ghost" size="sm" className="settings-detail-back-button" onClick={props.onBack} leadingIcon={<ChevronLeft size={14} aria-hidden="true" />}>
            {t('返回', 'Back')}
          </Button>
          <h2>{props.provider.name}</h2>
          <p>{props.provider.notes || localize(props.language, preset.descriptionZh, preset.descriptionEn)}</p>
        </div>
        <ConfigDetailActionBar actions={primaryActions} />
      </div>

      <div className="provider-channel-detail-grid">
        <div className="provider-detail-card">
          <span>{t('服务类型', 'Adapter')}</span>
          <strong>{formatAssetProviderAdapter(props.provider.adapter, props.language)}</strong>
        </div>
        <div className="provider-detail-card">
          <span>{t('模型/工作流', 'Model / Workflow')}</span>
          <strong>{props.provider.model || props.provider.workflowPath || (props.provider.workflowJson ? t('内联工作流', 'Inline workflow') : t('未配置', 'Not configured'))}</strong>
        </div>
        <div className="provider-detail-card">
          <span>Base URL</span>
          <strong>{props.provider.baseUrl || preset.baseUrl}</strong>
        </div>
        <div className="provider-detail-card">
          <span>API Key</span>
          <strong>{props.provider.adapter === 'comfyui' ? t('不需要', 'Not required') : props.provider.hasStoredApiKey ? t('已保存', 'Saved') : t('未配置', 'Missing')}</strong>
        </div>
      </div>

      <div className="tag-row provider-channel-tags">
        <Badge>{formatAssetProviderAdapter(props.provider.adapter, props.language)}</Badge>
        <Badge tone={props.provider.enabled ? 'success' : 'neutral'}>{props.provider.enabled ? t('启用', 'Enabled') : t('停用', 'Disabled')}</Badge>
        {props.provider.adapter === 'comfyui' ? <Badge>{t('本地/自托管', 'Local / self-hosted')}</Badge> : <Badge>{t('云端服务', 'Cloud service')}</Badge>}
        {readiness.ready
          ? <Badge tone="success">{t('就绪', 'Ready')}</Badge>
          : <Badge tone="warning">{t(`未就绪 · ${readiness.missing.zh}`, `Incomplete · ${readiness.missing.en}`)}</Badge>}
      </div>

      <div className="provider-card-actions">
        <ConfigDetailActionBar actions={dangerActions} />
      </div>
    </div>
  );
}

function formatAssetProviderAdapter(adapter: AssetGenerationConfigurableProviderAdapterKind, language: UiLanguage): string {
  const labels: Record<AssetGenerationConfigurableProviderAdapterKind, string> = {
    'openai-image': localize(language, 'OpenAI 图片', 'OpenAI Images'),
    stability: 'Stability AI',
    replicate: 'Replicate',
    comfyui: 'ComfyUI',
    meshy: 'Meshy',
    elevenlabs: 'ElevenLabs'
  };
  return labels[adapter];
}
