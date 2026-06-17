import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { MCP_PLUGIN_PRESETS } from '../../shared/mcp-plugin-catalog';
import type { McpPlugin, McpPluginInput, McpTransport } from '../../shared/types';
import { localize, useUiLanguage } from '../i18n';
import { Button, CheckboxField, IconButton, SelectField, TextAreaField, TextField, useDialogFocus } from './ui/index';

type McpPluginDraft = Omit<McpPluginInput, 'args' | 'env' | 'toolPolicies'> & {
  presetId: string;
  argsText: string;
  envText: string;
  toolPoliciesText: string;
};

const emptyPluginDraft: McpPluginDraft = {
  presetId: MCP_PLUGIN_PRESETS[0].id,
  name: MCP_PLUGIN_PRESETS[0].name,
  kind: MCP_PLUGIN_PRESETS[0].kind,
  transport: MCP_PLUGIN_PRESETS[0].transport,
  baseUrl: MCP_PLUGIN_PRESETS[0].baseUrl,
  command: MCP_PLUGIN_PRESETS[0].command,
  cwd: '',
  argsText: (MCP_PLUGIN_PRESETS[0].args ?? []).join('\n'),
  envText: '',
  defaultToolPermission: 'infer',
  defaultToolRisk: 'infer',
  toolPoliciesText: '',
  enabled: true,
  notes: ''
};

function parseLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseEnvLines(value: string): Record<string, string> | undefined {
  const entries: Record<string, string> = {};
  for (const line of parseLines(value)) {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const val = line.slice(separator + 1);
    if (key) {
      entries[key] = val;
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function formatToolPolicies(input?: McpPlugin['toolPolicies']): string {
  return input && Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : '';
}

function parseToolPolicies(input: string): McpPluginInput['toolPolicies'] {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool policies must be a JSON object.');
  }
  const permissionValues = new Set(['infer', 'allow', 'ask', 'deny']);
  const riskValues = new Set(['infer', 'read', 'write']);
  const output: NonNullable<McpPluginInput['toolPolicies']> = {};
  for (const [toolName, rawPolicy] of Object.entries(parsed as Record<string, unknown>)) {
    const normalizedToolName = toolName.trim();
    if (!normalizedToolName) {
      throw new Error('Tool policy names cannot be empty.');
    }
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
      throw new Error(`Tool policy for "${normalizedToolName}" must be an object.`);
    }
    const policy = rawPolicy as Record<string, unknown>;
    const next: NonNullable<McpPluginInput['toolPolicies']>[string] = {};
    if (policy.permission !== undefined) {
      if (typeof policy.permission !== 'string' || !permissionValues.has(policy.permission)) {
        throw new Error(`Tool policy "${normalizedToolName}" has invalid permission.`);
      }
      next.permission = policy.permission as NonNullable<McpPluginInput['defaultToolPermission']>;
    }
    if (policy.risk !== undefined) {
      if (typeof policy.risk !== 'string' || !riskValues.has(policy.risk)) {
        throw new Error(`Tool policy "${normalizedToolName}" has invalid risk.`);
      }
      next.risk = policy.risk as NonNullable<McpPluginInput['defaultToolRisk']>;
    }
    if (policy.notes !== undefined) {
      if (typeof policy.notes !== 'string') {
        throw new Error(`Tool policy "${normalizedToolName}" notes must be a string.`);
      }
      next.notes = policy.notes;
    }
    output[normalizedToolName] = next;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function McpPluginModal(props: {
  plugin: McpPlugin | null;
  projectId?: string;
  onClose: () => void;
  onCreate: (input: McpPluginInput) => Promise<void>;
  onUpdate: (pluginId: string, input: McpPluginInput) => Promise<void>;
}): JSX.Element {
  const language = useUiLanguage();
  const initialDraft = useMemo<McpPluginDraft>(() => props.plugin
    ? {
        presetId: 'custom-mcp',
        projectId: props.plugin.projectId,
        name: props.plugin.name,
        kind: props.plugin.kind,
        transport: props.plugin.transport,
        baseUrl: props.plugin.baseUrl,
        command: props.plugin.command || '',
        cwd: props.plugin.cwd || '',
        argsText: (props.plugin.args ?? []).join('\n'),
        envText: Object.entries(props.plugin.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
        defaultToolPermission: props.plugin.defaultToolPermission ?? 'infer',
        defaultToolRisk: props.plugin.defaultToolRisk ?? 'infer',
        toolPoliciesText: formatToolPolicies(props.plugin.toolPolicies),
        enabled: props.plugin.enabled,
        notes: props.plugin.notes || ''
      }
    : {
        ...emptyPluginDraft,
        projectId: props.projectId
      }, [props.plugin, props.projectId]);
  const [draft, setDraft] = useState<McpPluginDraft>(initialDraft);
  const [policyError, setPolicyError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  useEffect(() => {
    setDraft(initialDraft);
    setPolicyError('');
    setSaveError('');
  }, [initialDraft]);
  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initialDraft), [draft, initialDraft]);

  function validatePolicyText(value: string): void {
    try {
      parseToolPolicies(value);
      setPolicyError('');
    } catch (error) {
      setPolicyError(error instanceof Error ? error.message : localize(language, '工具策略 JSON 无效。', 'Invalid tool policy JSON.'));
    }
  }

  async function handleSave(): Promise<void> {
    let toolPolicies: McpPluginInput['toolPolicies'];
    try {
      toolPolicies = parseToolPolicies(draft.toolPoliciesText);
    } catch (error) {
      setPolicyError(error instanceof Error ? error.message : localize(language, '工具策略 JSON 无效。', 'Invalid tool policy JSON.'));
      return;
    }
    const payload: McpPluginInput = {
      projectId: draft.projectId,
      name: draft.name,
      kind: draft.kind,
      transport: draft.transport as McpTransport,
      baseUrl: draft.baseUrl,
      command: draft.command,
      args: parseLines(draft.argsText),
      cwd: draft.cwd,
      env: parseEnvLines(draft.envText),
      defaultToolPermission: draft.defaultToolPermission ?? 'infer',
      defaultToolRisk: draft.defaultToolRisk ?? 'infer',
      toolPolicies,
      enabled: draft.enabled,
      notes: draft.notes
    };
    setSaveError('');
    setIsSaving(true);
    try {
      if (props.plugin) {
        await props.onUpdate(props.plugin.id, payload);
      } else {
        await props.onCreate(payload);
      }
    } catch (error) {
      // Keep the modal open on failure and surface the error instead of swallowing it.
      setSaveError(error instanceof Error ? error.message : localize(language, '保存失败。', 'Failed to save.'));
    } finally {
      setIsSaving(false);
    }
  }
  return (
    <ModalShell
      title={props.plugin ? localize(language, '编辑 MCP 插件', 'Edit MCP Plugin') : localize(language, '添加 MCP 插件', 'Add MCP Plugin')}
      subtitle=""
      onClose={props.onClose}
      isDirty={isDirty && !isSaving}
      confirmCloseWhenDirty
    >
      <SelectField
        label={localize(language, '预设', 'Preset')}
        value={draft.presetId}
        options={MCP_PLUGIN_PRESETS.map((item) => ({ value: item.id, label: item.name }))}
        onValueChange={(value) => {
            const next = MCP_PLUGIN_PRESETS.find((item) => item.id === value);
            if (!next) return;
            setDraft((current) => ({
              ...current,
              presetId: next.id,
              projectId: props.projectId,
              name: props.plugin ? current.name : next.name,
              kind: next.kind,
              transport: next.transport,
              baseUrl: next.baseUrl,
              command: next.command,
              argsText: (next.args ?? []).join('\n'),
              envText: '',
              defaultToolPermission: 'infer',
              defaultToolRisk: 'infer',
              toolPoliciesText: ''
            }));
            setPolicyError('');
        }}
      />
      <TextField
        label={localize(language, '名称', 'Name')}
        value={draft.name}
        onValueChange={(value) => setDraft((current) => ({ ...current, name: value }))}
      />
      {draft.transport === 'stdio' ? (
        <>
          <TextField
            label={localize(language, '命令', 'Command')}
            value={draft.command ?? ''}
            onValueChange={(value) => setDraft((current) => ({ ...current, command: value }))}
          />
          <TextAreaField
            label={localize(language, '参数', 'Arguments')}
            value={draft.argsText}
            placeholder={'--flag\nvalue'}
            onValueChange={(value) => setDraft((current) => ({ ...current, argsText: value }))}
          />
          <TextField
            label={localize(language, 'CWD', 'CWD')}
            value={draft.cwd ?? ''}
            onValueChange={(value) => setDraft((current) => ({ ...current, cwd: value }))}
          />
          <TextAreaField
            label={localize(language, '环境', 'Environment')}
            value={draft.envText}
            placeholder="KEY=value"
            onValueChange={(value) => setDraft((current) => ({ ...current, envText: value }))}
          />
        </>
      ) : (
        <TextField
          label={localize(language, '基础 URL', 'Base URL')}
          value={draft.baseUrl}
          onValueChange={(value) => setDraft((current) => ({ ...current, baseUrl: value }))}
        />
      )}
      <div className="fp-field provider-compat-section">
        <div className="provider-compat-title">{localize(language, '工具权限策略', 'Tool Permission Policy')}</div>
        <SelectField
          label={localize(language, '默认权限', 'Default Permission')}
          value={draft.defaultToolPermission ?? 'infer'}
          options={[
            { value: 'infer', label: localize(language, '自动推断', 'Infer') },
            { value: 'allow', label: localize(language, '允许', 'Allow') },
            { value: 'ask', label: localize(language, '询问确认', 'Ask') },
            { value: 'deny', label: localize(language, '拒绝', 'Deny') }
          ]}
          onValueChange={(value) => setDraft((current) => ({ ...current, defaultToolPermission: value as NonNullable<McpPluginInput['defaultToolPermission']> }))}
        />
        <SelectField
          label={localize(language, '默认风险', 'Default Risk')}
          value={draft.defaultToolRisk ?? 'infer'}
          options={[
            { value: 'infer', label: localize(language, '自动推断', 'Infer') },
            { value: 'read', label: localize(language, '只读', 'Read-only') },
            { value: 'write', label: localize(language, '可写入/高风险', 'Write / High risk') }
          ]}
          onValueChange={(value) => setDraft((current) => ({ ...current, defaultToolRisk: value as NonNullable<McpPluginInput['defaultToolRisk']> }))}
        />
        <TextAreaField
          label={localize(language, '工具覆盖 JSON', 'Tool Override JSON')}
          value={draft.toolPoliciesText}
          placeholder={'{\n  "unity.echo": { "permission": "ask", "risk": "write" }\n}'}
          onValueChange={(value) => {
            setDraft((current) => ({ ...current, toolPoliciesText: value }));
            validatePolicyText(value);
          }}
        />
        {policyError ? <div className="helper-copy form-error">{policyError}</div> : null}
      </div>
      <CheckboxField
        label={localize(language, '启用 Server', 'Enable server')}
        checked={draft.enabled ?? true}
        onCheckedChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
      />
      <TextAreaField
        label={localize(language, '备注', 'Notes')}
        value={draft.notes}
        onValueChange={(value) => setDraft((current) => ({ ...current, notes: value }))}
      />
      {saveError ? <div className="helper-copy form-error">{saveError}</div> : null}
      <div className="modal-actions">
        <Button variant="secondary" onClick={props.onClose} disabled={isSaving}>
          {localize(language, '取消', 'Cancel')}
        </Button>
        <Button
          variant="primary"
          loading={isSaving}
          disabled={isSaving || Boolean(policyError)}
          onClick={() => void handleSave()}
        >
          {isSaving ? localize(language, '保存中…', 'Saving…') : localize(language, '保存', 'Save')}
        </Button>
      </div>
    </ModalShell>
  );
}

export function ModalShell(props: { title: string; subtitle?: string; children: ReactNode; className?: string; onClose?: () => void; isDirty?: boolean; confirmCloseWhenDirty?: boolean }): JSX.Element {
  const language = useUiLanguage();
  const titleId = useId();
  const subtitleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const requestClose = props.onClose
    ? () => {
        if (props.confirmCloseWhenDirty && props.isDirty && !window.confirm(localize(language, '有未保存的修改，确定关闭？', 'You have unsaved changes. Close anyway?'))) {
          return;
        }
        props.onClose?.();
      }
    : undefined;
  useDialogFocus({
    enabled: true,
    containerRef: cardRef,
    onEscape: requestClose
  });

  return (
    <div className="modal-backdrop" data-modal-state="open">
      <div
        ref={cardRef}
        className={`modal-card fp-modal ${props.className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.subtitle ? subtitleId : undefined}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <div className="page-title" id={titleId}>{props.title}</div>
            {props.subtitle ? <div className="page-subtitle" id={subtitleId}>{props.subtitle}</div> : null}
          </div>
          {props.onClose ? (
            <IconButton className="modal-close-button" icon={<X size={16} aria-hidden="true" />} label={localize(language, '关闭', 'Close')} onClick={requestClose} />
          ) : null}
        </div>
        <div className="modal-stack">{props.children}</div>
      </div>
    </div>
  );
}
