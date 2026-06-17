import { useEffect, useId, useMemo, useState, type JSX } from 'react';
import { RefreshCw } from 'lucide-react';
import { AI_PROVIDER_PRESETS, resolveProviderAvailableModels } from '../../../shared/provider-catalog';
import type { AiProvider, AiProviderApiMode, AiProviderAuthStyle, AiProviderInput, AiProviderModelListRequest, AiProviderModelListResult, AiProviderProtocol } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Badge, Button, CheckboxField, SelectField, TextAreaField, TextField } from '../ui/index';
import {
  authStyleForProtocol,
  createProviderDraft,
  createProviderInputFromDraft,
  describeProviderPreset,
  formatPresetProtocol,
  formatStringRecord,
  mergeProviderModelCandidates,
  parseOptionalInteger,
  parseStringRecord,
  providerApiKeyHint,
  type ProviderDraft
} from './provider-editor-utils';

// Mirror the backend isValidHttpUrl (ipc-validation.ts) so the Save gate matches
// what the schema will accept — avoids enabling Save on a URL the backend rejects.
function isLikelyHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function ProviderEditor(props: {
  provider: AiProvider | null;
  onCancel?: () => void;
  onCreate: (input: AiProviderInput) => Promise<void>;
  onUpdate: (providerId: string, input: AiProviderInput) => Promise<void>;
  onListModels: (input: AiProviderModelListRequest) => Promise<AiProviderModelListResult>;
}): JSX.Element {
  const language = useUiLanguage();
  const modelListId = useId();
  const upstreamModelListId = useId();
  const initialDraft = useMemo(() => createProviderDraft(props.provider), [props.provider?.id]);
  const [draft, setDraft] = useState<ProviderDraft>(initialDraft);
  const [modelFetchState, setModelFetchState] = useState<{
    loading: boolean;
    tone: 'neutral' | 'success' | 'error';
    message: string;
  }>({ loading: false, tone: 'neutral', message: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    setDraft(initialDraft);
    setModelFetchState({ loading: false, tone: 'neutral', message: '' });
    setSaving(false);
    setSaveError('');
    setAdvancedOpen(false);
  }, [initialDraft]);

  const preset = AI_PROVIDER_PRESETS.find((item) => item.id === draft.presetId) ?? AI_PROVIDER_PRESETS[0];
  const apiKeyHint = providerApiKeyHint(language, preset.id, preset.apiKeyHint);
  const resolvedModelChoices = useMemo(() => resolveProviderAvailableModels({
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    availableModels: draft.availableModels
  }), [draft.name, draft.protocol, draft.baseUrl, draft.availableModels]);
  const suggestedUpstreamModels = useMemo(() => {
    const values = new Set<string>();
    for (const model of resolvedModelChoices) {
      if (model.upstreamModelId?.trim()) values.add(model.upstreamModelId.trim());
      if (model.modelId.trim()) values.add(model.modelId.trim());
    }
    return [...values];
  }, [resolvedModelChoices]);
  const canFetchModelList = Boolean(draft.baseUrl.trim() && (draft.apiKey.trim() || props.provider?.hasStoredApiKey));
  const baseUrlValue = draft.baseUrl.trim();
  // bedrock/vertex authenticate via region/project env overrides, not a Base URL,
  // so don't require (or force the advanced section open for) an empty Base URL.
  const baseUrlRequired = draft.protocol !== 'bedrock' && draft.protocol !== 'vertex';
  const baseUrlMalformed = Boolean(baseUrlValue) && !isLikelyHttpUrl(baseUrlValue);
  const effectiveAuthStyle = draft.authStyle ?? 'api_key';
  const apiKeyRequired = effectiveAuthStyle === 'api_key';
  const apiKeyMissing = apiKeyRequired && !draft.apiKey.trim() && !props.provider?.hasStoredApiKey;
  const canSave = Boolean(draft.name.trim() && draft.model.trim() && (!baseUrlRequired || baseUrlValue)) && !baseUrlMalformed && !apiKeyMissing;
  const needsAdvanced = (baseUrlRequired && !baseUrlValue) || !draft.model.trim() || baseUrlMalformed;

  const applyProviderPreset = (presetId: string): void => {
    const next = AI_PROVIDER_PRESETS.find((item) => item.id === presetId);
    if (!next) return;
    setDraft((current) => ({
      ...current,
      presetId: next.id,
      name: props.provider ? current.name : next.name,
      protocol: next.protocol,
      authStyle: next.authStyle ?? authStyleForProtocol(next.protocol, current.authStyle),
      apiMode: next.protocol === 'openai-compatible' ? next.apiMode ?? current.apiMode ?? 'chat' : undefined,
      baseUrl: next.baseUrl,
      model: props.provider ? current.model : next.defaultModel,
      upstreamModel: next.upstreamModel,
      headers: next.defaultHeaders,
      envOverrides: next.defaultEnvOverrides,
      availableModels: next.availableModels,
      providerMeta: next.providerMeta
    }));
  };

  const fetchModelList = async (): Promise<void> => {
    if (!canFetchModelList || modelFetchState.loading) return;
    setModelFetchState({ loading: true, tone: 'neutral', message: localize(language, '正在获取模型列表…', 'Fetching model list…') });
    try {
      const result = await props.onListModels({
        providerId: props.provider?.id,
        provider: createProviderInputFromDraft(draft, { modelFallback: 'model-list-probe' })
      });
      setDraft((current) => ({ ...current, availableModels: mergeProviderModelCandidates(current.availableModels, result.models) }));
      setModelFetchState({
        loading: false,
        tone: result.models.length ? 'success' : 'neutral',
        message: result.models.length
          ? localize(language, `已获取 ${result.models.length} 个模型，并加入候选。`, `Fetched ${result.models.length} models and added them to suggestions.`)
          : localize(language, '服务商没有返回可用模型。', 'The provider did not return any usable models.')
      });
    } catch (error) {
      setModelFetchState({
        loading: false,
        tone: 'error',
        message: error instanceof Error ? error.message : localize(language, '获取模型列表失败。', 'Failed to fetch model list.')
      });
    }
  };

  return (
    <>
      <div className="provider-editor-section provider-preset-picker">
        <div className="provider-editor-section-header">
          <strong>{localize(language, '服务商预设', 'Provider Presets')}</strong>
        </div>
        <div className="provider-preset-card-grid" role="list">
          {AI_PROVIDER_PRESETS.map((item) => (
            <Button
              key={item.id}
              size="compact"
              variant="ghost"
              className={`provider-preset-card ${draft.presetId === item.id ? 'active' : ''}`}
              onClick={() => applyProviderPreset(item.id)}
            >
              <strong>{item.name}</strong>
              <span>{describeProviderPreset(language, item.id, item.description)}</span>
              <em>{formatPresetProtocol(language, item.protocol, item.apiMode)} · {item.defaultModel}</em>
            </Button>
          ))}
        </div>
      </div>
      <div className="provider-editor-section provider-core-config">
        <div className="provider-editor-section-header">
          <strong>{localize(language, '核心配置', 'Core Configuration')}</strong>
        </div>
        <TextField label={localize(language, '名称', 'Name')} value={draft.name} onValueChange={(value) => setDraft((current) => ({ ...current, name: value }))} />
        <TextField
          label={(
            <span className="provider-field-label-row">
              {localize(language, 'API Key', 'API Key')}
              {apiKeyRequired ? <span className="provider-field-required" aria-hidden="true"> *</span> : null}
              <Badge tone={props.provider?.hasStoredApiKey ? 'success' : 'neutral'}>
                {props.provider?.hasStoredApiKey ? localize(language, '已保存', 'Saved') : localize(language, '未保存', 'Unsaved')}
              </Badge>
            </span>
          )}
          value={draft.apiKey}
          placeholder={apiKeyHint}
          onValueChange={(value) => setDraft((current) => ({ ...current, apiKey: value }))}
          helper={effectiveAuthStyle === 'env_only'
            ? localize(language, '当前认证方式为 env_only，API Key 从环境变量读取，无需在此填写。', 'Auth style is env_only; the API key is read from environment variables and is not required here.')
            : apiKeyMissing
              ? localize(language, '该认证方式需要填写 API Key 才能保存。', 'This auth style requires an API Key before you can save.')
              : props.provider?.hasStoredApiKey
                ? localize(language, '留空将保留当前已保存的 API Key。', 'Leave blank to keep the currently saved API key.')
                : undefined}
        />
        {baseUrlValue && draft.model.trim() && !baseUrlMalformed ? (
          <div className="provider-core-summary">
            <div className="provider-core-summary-items">
              <span><em>{localize(language, '接口', 'Endpoint')}</em>{draft.baseUrl}</span>
              <span><em>{localize(language, '模型', 'Model')}</em>{draft.model}</span>
              <span><em>{localize(language, '协议', 'Protocol')}</em>{formatPresetProtocol(language, draft.protocol, draft.apiMode)}</span>
            </div>
            <Button type="button" variant="ghost" size="compact" className="provider-core-summary-edit" onClick={() => setAdvancedOpen(true)}>
              {localize(language, '调整', 'Adjust')}
            </Button>
          </div>
        ) : null}
      </div>
      <details
        className="provider-advanced-section"
        open={advancedOpen || needsAdvanced}
        onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open || needsAdvanced)}
      >
        <summary>
          <span>{localize(language, '高级设置', 'Advanced Settings')}</span>
          <em>{localize(language, 'Base URL · 模型 · 协议 · 超时', 'Base URL · model · protocol · timeouts')}</em>
        </summary>
        <TextField
          label={localize(language, '基础 URL', 'Base URL')}
          value={draft.baseUrl}
          onValueChange={(value) => setDraft((current) => ({ ...current, baseUrl: value }))}
          helper={baseUrlMalformed
            ? localize(language, 'Base URL 需以 http:// 或 https:// 开头。例如 https://api.openai.com/v1，按服务商要求包含 /v1 等路径。', 'Base URL must start with http:// or https://. For example https://api.openai.com/v1; include paths such as /v1 as the provider requires.')
            : undefined}
        />
        <div className="provider-model-fetch-row">
          <TextField
            label={localize(language, '默认模型', 'Default Model')}
            list={modelListId}
            value={draft.model}
            onValueChange={(value) => setDraft((current) => ({ ...current, model: value }))}
          />
          <Button
            type="button"
            variant="secondary"
            className="provider-model-fetch-button"
            disabled={!canFetchModelList || modelFetchState.loading}
            loading={modelFetchState.loading}
            onClick={() => void fetchModelList()}
            leadingIcon={<RefreshCw size={14} aria-hidden="true" />}
            title={canFetchModelList
              ? localize(language, '从服务商获取模型列表', 'Fetch models from provider')
              : localize(language, '需要先填写 Base URL 和 API Key', 'Base URL and API Key are required first')}
          >
            {modelFetchState.loading ? localize(language, '获取中', 'Fetching') : localize(language, '获取模型', 'Fetch Models')}
          </Button>
        </div>
        {modelFetchState.message ? <div className={`provider-model-fetch-message ${modelFetchState.tone}`}>{modelFetchState.message}</div> : null}
        <datalist id={modelListId}>
          {resolvedModelChoices.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName || model.modelId}
            </option>
          ))}
        </datalist>
        {resolvedModelChoices.length ? (
          <div className="agent-settings-chip-grid" role="list">
            {resolvedModelChoices.map((model) => (
              <Button
                key={model.modelId}
                size="compact"
                variant="ghost"
                className={`agent-settings-chip-button ${draft.model.trim() === model.modelId ? 'active' : ''}`}
                onClick={() => setDraft((current) => ({ ...current, model: model.modelId }))}
                title={model.displayName || model.modelId}
              >
                {model.displayName || model.modelId}
              </Button>
            ))}
          </div>
        ) : null}
        <TextField
          label={localize(language, '上游模型 ID', 'Upstream Model ID')}
          list={upstreamModelListId}
          value={draft.upstreamModel ?? ''}
          onValueChange={(value) => setDraft((current) => ({ ...current, upstreamModel: value }))}
        />
        <datalist id={upstreamModelListId}>
          {suggestedUpstreamModels.map((modelId) => <option key={modelId} value={modelId} />)}
        </datalist>
        <SelectField
          label={localize(language, '协议', 'Protocol')}
          value={draft.protocol}
          options={[
            { value: 'openai-compatible', label: 'openai-compatible' },
            { value: 'anthropic', label: 'anthropic' },
            { value: 'google', label: 'google' },
            { value: 'bedrock', label: 'bedrock' },
            { value: 'vertex', label: 'vertex' }
          ]}
          onValueChange={(value) => {
            const protocol = value as AiProviderProtocol;
            setDraft((current) => ({
              ...current,
              protocol,
              authStyle: authStyleForProtocol(protocol, current.authStyle),
              apiMode: protocol === 'openai-compatible' ? current.apiMode ?? 'chat' : undefined
            }));
          }}
        />
        {draft.protocol === 'openai-compatible' ? (
          <SelectField
            label={localize(language, '接口模式', 'API Mode')}
            value={draft.apiMode ?? 'chat'}
            options={[{ value: 'responses', label: 'responses' }, { value: 'chat', label: 'chat completions' }]}
            onValueChange={(value) => setDraft((current) => ({ ...current, apiMode: value as AiProviderApiMode }))}
          />
        ) : null}
        <SelectField
          label={localize(language, '认证方式', 'Auth Style')}
          value={draft.authStyle ?? 'api_key'}
          options={[
            { value: 'api_key', label: 'api_key' },
            { value: 'auth_token', label: 'auth_token' },
            { value: 'env_only', label: 'env_only' },
            { value: 'custom_header', label: 'custom_header' }
          ]}
          onValueChange={(value) => setDraft((current) => ({ ...current, authStyle: value as AiProviderAuthStyle }))}
        />
        <div className="provider-role-model-grid">
          <TextField
            className="compact"
            label={localize(language, '上下文窗口 tokens', 'Context Window tokens')}
            type="number"
            min={1024}
            max={2_000_000}
            step={1024}
            value={typeof draft.contextWindowTokens === 'number' ? String(draft.contextWindowTokens) : ''}
            placeholder={localize(language, '留空使用预设', 'Empty uses preset')}
            onValueChange={(value) => setDraft((current) => ({ ...current, contextWindowTokens: parseOptionalInteger(value) }))}
          />
          <TextField
            className="compact"
            label={localize(language, '单步输出上限 tokens', 'Max Output tokens')}
            type="number"
            min={1}
            max={1_000_000}
            step={1}
            value={typeof draft.maxOutputTokens === 'number' ? String(draft.maxOutputTokens) : ''}
            placeholder="32000"
            onValueChange={(value) => setDraft((current) => ({ ...current, maxOutputTokens: parseOptionalInteger(value) }))}
          />
          <TextField
            className="compact"
            label={localize(language, '请求超时 ms', 'Request Timeout ms')}
            type="number"
            min={1}
            max={60 * 60 * 1000}
            step={1000}
            disabled={draft.requestTimeoutMs === false}
            value={typeof draft.requestTimeoutMs === 'number' ? String(draft.requestTimeoutMs) : ''}
            placeholder="300000"
            onValueChange={(value) => setDraft((current) => ({ ...current, requestTimeoutMs: parseOptionalInteger(value) }))}
          />
          <TextField
            className="compact"
            label={localize(language, 'SSE 分块超时 ms', 'SSE Chunk Timeout ms')}
            type="number"
            min={1}
            max={60 * 60 * 1000}
            step={1000}
            value={typeof draft.chunkTimeoutMs === 'number' ? String(draft.chunkTimeoutMs) : ''}
            placeholder={localize(language, '留空不限制', 'Empty for no limit')}
            onValueChange={(value) => setDraft((current) => ({ ...current, chunkTimeoutMs: parseOptionalInteger(value) }))}
          />
        </div>
        <CheckboxField
          label={localize(language, '禁用请求超时', 'Disable Request Timeout')}
          checked={draft.requestTimeoutMs === false}
          onCheckedChange={(checked) => setDraft((current) => ({ ...current, requestTimeoutMs: checked ? false : undefined }))}
        />
        <TextAreaField label="Headers" value={formatStringRecord(draft.headers)} onValueChange={(value) => setDraft((current) => ({ ...current, headers: parseStringRecord(value) }))} placeholder="X-Custom-Header=value" />
        <TextAreaField label="Env Overrides" value={formatStringRecord(draft.envOverrides)} onValueChange={(value) => setDraft((current) => ({ ...current, envOverrides: parseStringRecord(value) }))} placeholder="HTTPS_PROXY=http://127.0.0.1:7890" />
      </details>
      <TextAreaField label={localize(language, '备注', 'Notes')} value={draft.notes} onValueChange={(value) => setDraft((current) => ({ ...current, notes: value }))} />
      {saveError ? <div className="provider-model-fetch-message error" role="alert">{saveError}</div> : null}
      <div className="modal-actions">
        {props.onCancel ? <Button variant="secondary" disabled={saving} onClick={props.onCancel}>{localize(language, '取消', 'Cancel')}</Button> : null}
        <Button
          variant="primary"
          loading={saving}
          disabled={!canSave || saving}
          title={canSave
            ? undefined
            : baseUrlMalformed
              ? localize(language, 'Base URL 需以 http:// 或 https:// 开头', 'Base URL must start with http:// or https://')
              : apiKeyMissing
                ? localize(language, '请先填写 API Key', 'Fill in the API Key first')
                : localize(language, '请先填写名称、Base URL 和默认模型', 'Fill in Name, Base URL, and Default Model first')}
          onClick={async () => {
            if (!canSave || saving) return;
            setSaveError('');
            setSaving(true);
            try {
              const payload = createProviderInputFromDraft(draft);
              if (props.provider) await props.onUpdate(props.provider.id, payload);
              else await props.onCreate(payload);
            } catch (error) {
              setSaveError(error instanceof Error ? error.message : localize(language, '保存失败,请重试。', 'Failed to save, please try again.'));
            } finally {
              setSaving(false);
            }
          }}
        >
          {localize(language, '保存', 'Save')}
        </Button>
      </div>
    </>
  );
}
