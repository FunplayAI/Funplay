import type { JSX } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui/index';
import { localize, type UiLanguage } from '../../i18n';
import type { CocosEngineVariant, CocosVariantPrerequisite } from '../../../shared/types';

// Engine-variant picker for the cocos create/import onboarding: Cocos Creator 3.x
// (GUI editor + funplay-cocos-mcp) vs the headless cocos4 + cocos-cli toolchain.
// Extracted as its own component so OnboardingScreen stays under the size ratchet.
export function CocosVariantSelector(props: {
  value: CocosEngineVariant;
  onChange: (value: CocosEngineVariant) => void;
  // Lightweight precheck of the *selected* variant's prerequisite (non-blocking);
  // null while the check is still loading or hasn't run.
  prerequisite: CocosVariantPrerequisite | null;
  language: UiLanguage;
}): JSX.Element {
  const t = (zh: string, en: string): string => localize(props.language, zh, en);
  const renderWarning = (variant: CocosEngineVariant): JSX.Element | null => {
    if (props.value !== variant || !props.prerequisite || props.prerequisite.variant !== variant || props.prerequisite.satisfied) {
      return null;
    }
    return (
      <span className="onboarding-variant-warning" role="status">
        <AlertTriangle size={13} aria-hidden="true" />
        {props.prerequisite.warning}
      </span>
    );
  };
  return (
    <section className="onboarding-choice-section compact" aria-labelledby="cocos-variant-title">
      <div className="onboarding-section-heading compact">
        <div>
          <div className="section-heading">{t('引擎', 'Engine')}</div>
          <h3 id="cocos-variant-title">{t('选择 Cocos 引擎', 'Choose Cocos engine')}</h3>
        </div>
      </div>
      <div className="setup-mode-grid compact">
        <Button
          variant="ghost"
          size="compact"
          className={`setup-mode-card ${props.value === 'creator3' ? 'selected' : ''}`}
          onClick={() => props.onChange('creator3')}
        >
          <span className="option-card-copy">
            <strong>{t('Cocos Creator 3.x', 'Cocos Creator 3.x')}</strong>
            <span className="option-card-meta">
              {t(
                '前置条件：需已安装 Cocos Creator（GUI 编辑器）。',
                'Prerequisite: Cocos Creator (GUI editor) must already be installed.'
              )}
            </span>
            {renderWarning('creator3')}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="compact"
          className={`setup-mode-card ${props.value === 'cocos4' ? 'selected' : ''}`}
          onClick={() => props.onChange('cocos4')}
        >
          <span className="option-card-copy">
            <strong>{t('Cocos 4（headless）', 'Cocos 4 (headless)')}</strong>
            <span className="option-card-meta">
              {t(
                '前置条件：独立命令行，无需编辑器；首次需下载约 3.5G，并要求 Node.js 22+、git。',
                'Prerequisite: standalone CLI, no editor; first run downloads ~3.5G and needs Node.js 22+ and git.'
              )}
            </span>
            {renderWarning('cocos4')}
          </span>
        </Button>
      </div>
    </section>
  );
}
