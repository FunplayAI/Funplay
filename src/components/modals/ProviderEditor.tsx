import { useEffect, useId, useMemo, useState, type JSX } from 'react';
import { RefreshCw } from 'lucide-react';
import { AI_PROVIDER_PRESETS, resolveProviderAvailableModels, resolveProviderTokenLimits } from '../../../shared/provider-catalog';
import type { AiProvider, AiProviderApiMode, AiProviderAuthStyle, AiProviderInput, AiProviderModelListRequest, AiProviderModelListResult, AiProviderProtocol } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Badge, Button, CheckboxField, SelectField, TextAreaField, TextField } from '../ui/index';
import {
  authStyleForProtocol,
  createProviderDraft,
  createProviderInputFromDraft,
  describeProviderPreset,
  formatCompactTokenLimit,
  formatPresetProtocol,
  formatStringRecord,
  mergeProviderModelCandidates,
  parseOptionalInteger,
  parseStringRecord,
  providerApiKeyHint,
  type ProviderDraft
} from './provider-editor-utils';

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
  const presetDescription = describeProviderPreset(language, preset.id, preset.description);
  const apiKeyHint = providerApiKeyHint(language, preset.id, preset.apiKeyHint);
  const draftTokenLimits = useMemo(() => resolveProviderTokenLimits({
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    model: draft.model,
    upstreamModel: draft.upstreamModel,
    availableModels: draft.availableModels,
    contextWindowTokens: draft.contextWindowTokens,
    maxOutputTokens: draft.maxOutputTokens
  }), [draft.name, draft.protocol, draft.baseUrl, draft.model, draft.upstreamModel, draft.availableModels, draft.contextWindowTokens, draft.maxOutputTokens]);
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
  const baseUrlMalformed = Boolean(baseUrlValue) && !/^https?:\/\//i.test(baseUrlValue);
  const effectiveAuthStyle = draft.authStyle ?? 'api_key';
  const apiKeyRequired = effectiveAuthStyle === 'api_key';
  const apiKeyMissing = apiKeyRequired && !draft.apiKey.trim() && !props.provider?.hasStoredApiKey;
  const canSave = Boolean(draft.name.trim() && draft.baseUrl.trim() && draft.model.trim()) && !baseUrlMalformed && !apiKeyMissing;
  const needsAdvanced = !draft.baseUrl.trim() || !draft.model.trim() || baseUrlMalformed;

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
          <span>{presetDescription}</span>
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
          <span>{apiKeyHint}</span>
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
                : localize(language, '填好上面的 API Key 一般就能用了，其余按预设自动配置。', 'Once the API Key above is set you are usually ready — everything else is auto-filled by the preset.')}
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
            : localize(language, '选了上面的预设后会自动填好；自定义端点时按服务商要求填写，例如 https://api.openai.com/v1。', 'Auto-filled when you pick a preset above; for a custom endpoint enter it as the provider requires, e.g. https://api.openai.com/v1.')}
        />
        <div className="provider-model-fetch-row">
          <TextField
            label={localize(language, '默认模型', 'Default Model')}
            list={modelListId}
            value={draft.model}
            onValueChange={(value) => setDraft((current) => ({ ...current, model: value }))}
            helper={draftTokenLimits.modelId
              ? localize(
                language,
                `可直接输入自定义模型，也可从预设候选里选择。当前命中：${draftTokenLimits.displayName || draftTokenLimits.modelId}；默认上下文 ${formatCompactTokenLimit(draftTokenLimits.presetContextWindowTokens)}，默认单步输出 ${formatCompactTokenLimit(draftTokenLimits.presetMaxOutputTokens)}。`,
                `You can type a custom model or choose a preset suggestion. Current match: ${draftTokenLimits.displayName || draftTokenLimits.modelId}; default context ${formatCompactTokenLimit(draftTokenLimits.presetContextWindowTokens)}, default max output ${formatCompactTokenLimit(draftTokenLimits.presetMaxOutputTokens)}.`
              )
              : localize(
                language,
                '可直接输入自定义模型，也可从预设候选里选择。当前模型没有命中内置预设；如果是代理、自定义别名或新模型，建议按服务商文档填写上下文窗口和单步输出上限。',
                'You can type a custom model or choose a preset suggestion. This model does not match a built-in preset; for proxies, custom aliases, or newer models, set context window and max output limits from your provider docs.'
              )}
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
          helper={localize(language, '留空时使用默认模型；也可以手写真实上游模型 ID，或从已知候选里快速填入。', 'Leave this empty to use the default model; you can also type the real upstream model ID or pick a known suggestion.')}
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
            helper={localize(
              language,
              '不同服务商支持的协议不同；OpenAI 官方推荐 responses，国内兼容通道通常推荐 chat completions。',
              'Different providers support different modes; official OpenAI prefers responses, while most domestic compatible gateways prefer chat completions.'
            )}
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
            helper={draftTokenLimits.presetContextWindowTokens
              ? localize(language, `用于判断何时压缩会话历史；留空时当前模型默认按 ${formatCompactTokenLimit(draftTokenLimits.presetContextWindowTokens)} 处理。`, `Used to decide when to compact history; when empty, the current model defaults to ${formatCompactTokenLimit(draftTokenLimits.presetContextWindowTokens)}.`)
              : localize(language, '用于判断何时压缩会话历史；代理或自定义模型建议按实际窗口填写。', 'Used to decide when to compact history; set the real window for proxy or custom models.')}
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
            helper={draftTokenLimits.presetMaxOutputTokens
              ? localize(language, `用于 Native Agent 每次流式请求的 max_tokens/max_output_tokens；留空时当前模型默认按 ${formatCompactTokenLimit(draftTokenLimits.presetMaxOutputTokens)} 处理。`, `Used for Native Agent max_tokens/max_output_tokens on each streamed request; when empty, the current model defaults to ${formatCompactTokenLimit(draftTokenLimits.presetMaxOutputTokens)}.`)
              : localize(language, '用于 Native Agent 每次流式请求的 max_tokens/max_output_tokens。', 'Used for Native Agent max_tokens/max_output_tokens on each streamed request.')}
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
          description={localize(language, '默认 300000ms；只有服务商自己稳定处理超长连接时才建议关闭。', 'Default is 300000ms; disable only when the provider reliably handles very long connections.')}
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
