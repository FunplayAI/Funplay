import { useEffect, useState, type JSX } from 'react';
import type { AgentPermissionImpact, AgentUserInputOption, AgentUserInputResponse } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Button, TextAreaControl } from '../ui/index';

type PermissionDecision = 'allow' | 'allow_session' | 'deny';

export interface PendingPermissionCard {
  requestId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  impact?: AgentPermissionImpact;
}

export interface PendingUserInputCard {
  requestId: string;
  title: string;
  question: string;
  detail?: string;
  options?: AgentUserInputOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
  placeholder?: string;
}

// composer-3 + error-handling-1: the permission card owns its own in-flight + inline-error
// state. The handler now returns a promise (App.tsx → AgentChatView), so we disable all three
// buttons + show a spinner while awaiting, and surface failures inline on the card with a Retry
// instead of a generic error at the composer bottom. The card stays visible on failure.
export function AgentPermissionCard(props: {
  pending: PendingPermissionCard;
  contextLabel?: string;
  onRespond: (decision: PermissionDecision) => void | Promise<unknown>;
}): JSX.Element {
  const language = useUiLanguage();
  const [inFlight, setInFlight] = useState<PermissionDecision | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setInFlight(null);
    setError('');
  }, [props.pending.requestId]);

  async function respond(decision: PermissionDecision): Promise<void> {
    if (inFlight) {
      return;
    }
    setInFlight(decision);
    setError('');
    try {
      await props.onRespond(decision);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : localize(language, '权限响应失败，请重试。', 'Failed to submit the permission decision. Please try again.')
      );
    } finally {
      setInFlight(null);
    }
  }

  const busy = inFlight !== null;
  return (
    <div className={`agent-permission-card ${props.pending.risk}`}>
      <div className="agent-permission-copy">
        <strong>{props.pending.title}</strong>
        {props.contextLabel ? <em>{props.contextLabel}</em> : null}
        <span>{props.pending.detail}</span>
        <PermissionImpactSummary impact={props.pending.impact} />
      </div>
      {error ? <div className="agent-composer-error">{error}</div> : null}
      <div className="agent-permission-actions">
        <Button size="sm" variant="danger" loading={inFlight === 'deny'} disabled={busy} onClick={() => void respond('deny')}>
          {localize(language, '拒绝', 'Deny')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={inFlight === 'allow_session'}
          disabled={busy}
          title={localize(language, '本会话内一直允许此工具操作', 'Allow this tool for the rest of this session')}
          onClick={() => void respond('allow_session')}
        >
          {localize(language, '允许本会话', 'Allow Session')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={inFlight === 'allow'}
          disabled={busy}
          title={localize(language, '仅允许这一次操作', 'Allow only this single operation')}
          onClick={() => void respond('allow')}
        >
          {localize(language, '允许本次', 'Allow Once')}
        </Button>
      </div>
    </div>
  );
}

// composer-3 + error-handling-2: same in-flight + inline-error pattern for the user-input card.
// The Submit button spins while awaiting the (now promise-returning) handler and failures show
// inline with the answer preserved so the user can retry by pressing Submit again.
export function AgentUserInputCard(props: {
  pending: PendingUserInputCard;
  onRespond: (response: AgentUserInputResponse) => void | Promise<unknown>;
}): JSX.Element {
  const language = useUiLanguage();
  const [draft, setDraft] = useState('');
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft('');
    setSelectedOptionIds([]);
    setSubmitting(false);
    setError('');
  }, [props.pending.requestId]);

  function toggleOption(optionId: string): void {
    if (props.pending.multiSelect) {
      setSelectedOptionIds((current) =>
        current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId]
      );
      return;
    }
    setSelectedOptionIds([optionId]);
  }

  async function submit(cancelled = false): Promise<void> {
    if (submitting) {
      return;
    }
    if (cancelled) {
      setSubmitting(true);
      setError('');
      try {
        await props.onRespond({ answer: '', cancelled: true });
      } catch (cause) {
        setError(resolveError(cause));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const selectedOptions = props.pending.options?.filter((option) => selectedOptionIds.includes(option.id)) ?? [];
    const selectedAnswer = selectedOptions.map((option) => option.label).join(', ');
    const draftAnswer = draft.trim();
    const answer = [selectedAnswer, draftAnswer].filter(Boolean).join(draftAnswer && selectedAnswer ? '\n' : '');
    if (!answer) {
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await props.onRespond({
        answer,
        optionId: selectedOptions[0]?.id,
        optionIds: selectedOptions.length > 0 ? selectedOptions.map((option) => option.id) : undefined
      });
    } catch (cause) {
      setError(resolveError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  function resolveError(cause: unknown): string {
    return cause instanceof Error
      ? cause.message
      : localize(language, '回答提交失败，请重试。', 'Failed to submit the answer. Please try again.');
  }

  const canSubmit = Boolean(draft.trim() || selectedOptionIds.length > 0);
  return (
    <div className="agent-user-input-card">
      <div className="agent-user-input-scroll">
        <div className="agent-permission-copy">
          <strong>{props.pending.title}</strong>
          <span>{props.pending.question}</span>
          {props.pending.detail ? <em>{props.pending.detail}</em> : null}
        </div>
        {props.pending.options?.length ? (
          <div className="agent-user-input-options">
            {props.pending.options.map((option) => (
              <Button
                key={option.id}
                variant="secondary"
                size="sm"
                disabled={submitting}
                className={selectedOptionIds.includes(option.id) ? 'selected' : ''}
                onClick={() => toggleOption(option.id)}
              >
                <strong>{option.label}</strong>
                {option.description ? <span>{option.description}</span> : null}
              </Button>
            ))}
          </div>
        ) : null}
        {props.pending.allowFreeText !== false ? (
          <TextAreaControl
            className="agent-user-input-textarea"
            value={draft}
            onValueChange={setDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={props.pending.placeholder || localize(language, '输入你的回答…', 'Enter your answer…')}
          />
        ) : null}
        {error ? <div className="agent-composer-error">{error}</div> : null}
      </div>
      <div className="agent-permission-actions agent-user-input-actions">
        <Button size="sm" variant="secondary" disabled={submitting} onClick={() => void submit(true)}>
          {localize(language, '取消', 'Cancel')}
        </Button>
        <Button size="sm" variant="primary" loading={submitting} onClick={() => void submit()} disabled={submitting || !canSubmit}>
          {error ? localize(language, '重试', 'Retry') : localize(language, '提交回答', 'Submit Answer')}
        </Button>
      </div>
    </div>
  );
}

function PermissionImpactSummary(props: { impact?: AgentPermissionImpact }): JSX.Element | null {
  const language = useUiLanguage();
  const impact = props.impact;
  if (!impact) {
    return null;
  }

  const entries = [
    impact.toolTitle || impact.toolName
      ? localize(language, `工具：${impact.toolTitle || impact.toolName}`, `Tool: ${impact.toolTitle || impact.toolName}`)
      : '',
    impact.paths?.length
      ? localize(language, `路径：${impact.paths.join(' · ')}`, `Paths: ${impact.paths.join(' · ')}`)
      : '',
    impact.commands?.length
      ? localize(language, `命令：${impact.commands.join(' · ')}`, `Commands: ${impact.commands.join(' · ')}`)
      : '',
    impact.mcp?.pluginName || impact.mcp?.pluginId || impact.mcp?.toolName
      ? localize(language, `MCP：${[impact.mcp.pluginName ?? impact.mcp.pluginId, impact.mcp.toolName].filter(Boolean).join(' / ')}`, `MCP: ${[impact.mcp.pluginName ?? impact.mcp.pluginId, impact.mcp.toolName].filter(Boolean).join(' / ')}`)
      : '',
    impact.mcp?.permission || impact.mcp?.risk || impact.mcp?.policySource
      ? localize(language, `MCP 策略：${[impact.mcp.permission, impact.mcp.risk, impact.mcp.policySource].filter(Boolean).join(' / ')}`, `MCP policy: ${[impact.mcp.permission, impact.mcp.risk, impact.mcp.policySource].filter(Boolean).join(' / ')}`)
      : '',
    impact.cwd ? localize(language, `目录：${impact.cwd}`, `Directory: ${impact.cwd}`) : '',
    impact.reason ? localize(language, `原因：${impact.reason}`, `Reason: ${impact.reason}`) : '',
    impact.checkpointPolicy
      ? localize(language, `恢复策略：${impact.checkpointPolicy}`, `Recovery: ${impact.checkpointPolicy}`)
      : ''
  ].filter(Boolean);

  const detailEntries = impact.inputSummary?.filter(Boolean).slice(0, 4) ?? [];
  if (entries.length === 0 && detailEntries.length === 0) {
    return null;
  }

  return (
    <div className="agent-permission-impact">
      {entries.map((entry, index) => <span key={`impact-${index}`}>{entry}</span>)}
      {detailEntries.map((entry, index) => <span key={`detail-${index}`}>{entry}</span>)}
    </div>
  );
}
