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

function describeMcpPreset(language: 'zh-CN' | 'en-US', presetId: string, fallback: string): string {
  const map: Record<string, { zh: string; en: string }> = {
    'unity-mcp': {
      zh: 'GameBooom / FunseaAI Unity MCP 预设。',
      en: 'GameBooom / FunseaAI Unity MCP preset.'
    },
    'custom-engine-mcp': {
      zh: '任意兼容 MCP HTTP JSON-RPC 的 Server。',
      en: 'Any server compatible with MCP HTTP JSON-RPC.'
    },
    'custom-asset-mcp': {
      zh: '任意兼容 MCP HTTP JSON-RPC 的 Server。',
      en: 'Any server compatible with MCP HTTP JSON-RPC.'
    },
    'custom-mcp': {
      zh: '任意兼容 MCP HTTP JSON-RPC 的 Server。',
      en: 'Any server compatible with MCP HTTP JSON-RPC.'
    },
    'custom-stdio-mcp': {
      zh: '通过本地命令启动的 MCP stdio Server。',
      en: 'MCP stdio server launched from a local command.'
    }
  };
  return map[presetId] ? localize(language, map[presetId].zh, map[presetId].en) : fallback;
}

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
  useEffect(() => {
    setDraft(initialDraft);
    setPolicyError('');
  }, [initialDraft]);
  const preset = MCP_PLUGIN_PRESETS.find((item) => item.id === draft.presetId) ?? MCP_PLUGIN_PRESETS[0];
  const presetDescription = describeMcpPreset(language, preset.id, preset.description);

  return (
    <ModalShell
      title={props.plugin ? localize(language, '编辑 MCP 插件', 'Edit MCP Plugin') : localize(language, '添加 MCP 插件', 'Add MCP Plugin')}
      subtitle={props.projectId ? localize(language, '这个 Server 只属于当前项目。', 'This server belongs only to the current project.') : localize(language, '这个 Server 会作为全局 MCP 供项目选择启用。', 'This server is registered globally and can be enabled by projects.')}
    >
      <SelectField
        label={localize(language, '预设', 'Preset')}
        value={draft.presetId}
        options={MCP_PLUGIN_PRESETS.map((item) => ({ value: item.id, label: item.name }))}
        helper={presetDescription}
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
            label="Command"
            value={draft.command ?? ''}
            onValueChange={(value) => setDraft((current) => ({ ...current, command: value }))}
          />
          <TextAreaField
            label="Arguments"
            value={draft.argsText}
            placeholder={'--flag\nvalue'}
            helper={localize(language, '每行一个参数。', 'One argument per line.')}
            onValueChange={(value) => setDraft((current) => ({ ...current, argsText: value }))}
          />
          <TextField
            label="CWD"
            value={draft.cwd ?? ''}
            onValueChange={(value) => setDraft((current) => ({ ...current, cwd: value }))}
          />
          <TextAreaField
            label="Environment"
            value={draft.envText}
            placeholder="KEY=value"
            helper={localize(language, '每行一个 KEY=value。', 'One KEY=value per line.')}
            onValueChange={(value) => setDraft((current) => ({ ...current, envText: value }))}
          />
        </>
      ) : (
        <TextField
          label="Base URL"
          value={draft.baseUrl}
          onValueChange={(value) => setDraft((current) => ({ ...current, baseUrl: value }))}
        />
      )}
      <div className="fp-field provider-compat-section">
        <div className="provider-compat-title">{localize(language, '工具权限策略', 'Tool Permission Policy')}</div>
        <div className="helper-copy">
          {localize(language, '默认使用自动推断；对高风险或特殊工具可用 JSON 覆盖。deny 会从 Agent 工具列表中隐藏并阻止通用调用。', 'Defaults use inference. Override high-risk or special tools with JSON. deny hides direct Agent tools and blocks generic calls.')}
        </div>
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
          helper={localize(language, '键是 MCP 原始工具名；permission 支持 infer/allow/ask/deny，risk 支持 infer/read/write。', 'Keys are original MCP tool names; permission supports infer/allow/ask/deny, risk supports infer/read/write.')}
          onValueChange={(value) => {
            setDraft((current) => ({ ...current, toolPoliciesText: value }));
            setPolicyError('');
          }}
        />
        {policyError ? <div className="helper-copy form-error">{policyError}</div> : null}
      </div>
      <CheckboxField
        label={localize(language, '启用 Server', 'Enable server')}
        description={localize(language, '停用后项目不能调用这个 MCP。', 'Disabled servers cannot be called by projects.')}
        checked={draft.enabled ?? true}
        onCheckedChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
      />
      <TextAreaField
        label={localize(language, '备注', 'Notes')}
        value={draft.notes}
        onValueChange={(value) => setDraft((current) => ({ ...current, notes: value }))}
      />
      <div className="modal-actions">
        <Button variant="secondary" onClick={props.onClose}>
          {localize(language, '取消', 'Cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
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
            if (props.plugin) {
              void props.onUpdate(props.plugin.id, payload);
            } else {
              void props.onCreate(payload);
            }
          }}
        >
          {localize(language, '保存', 'Save')}
        </Button>
      </div>
    </ModalShell>
  );
}

export function ModalShell(props: { title: string; subtitle: string; children: ReactNode; className?: string; onClose?: () => void }): JSX.Element {
  const titleId = useId();
  const subtitleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus({
    enabled: true,
    containerRef: cardRef,
    onEscape: props.onClose
  });

  return (
    <div className="modal-backdrop" data-modal-state="open">
      <div
        ref={cardRef}
        className={`modal-card fp-modal ${props.className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <div className="page-title" id={titleId}>{props.title}</div>
            <div className="page-subtitle" id={subtitleId}>{props.subtitle}</div>
          </div>
          {props.onClose ? (
            <IconButton className="modal-close-button" icon={<X size={16} aria-hidden="true" />} label="Close" onClick={props.onClose} />
          ) : null}
        </div>
        <div className="modal-stack">{props.children}</div>
      </div>
    </div>
  );
}
