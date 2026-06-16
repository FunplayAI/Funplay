import type { JSX } from 'react';
import { Button } from '../ui/index';
import { localize, type UiLanguage } from '../../i18n';
import type { CocosEngineVariant } from '../../../shared/types';

// Engine-variant picker for the cocos create/import onboarding: Cocos Creator 3.x
// (GUI editor + funplay-cocos-mcp) vs the headless cocos4 + cocos-cli toolchain.
// Extracted as its own component so OnboardingScreen stays under the size ratchet.
export function CocosVariantSelector(props: {
  value: CocosEngineVariant;
  onChange: (value: CocosEngineVariant) => void;
  language: UiLanguage;
}): JSX.Element {
  const t = (zh: string, en: string): string => localize(props.language, zh, en);
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
            <span>
              {t(
                '图形编辑器 + Funplay MCP 扩展（需在 Creator 中手动启动 MCP Server）。',
                'GUI editor + the Funplay MCP extension (start the MCP Server manually inside Creator).'
              )}
            </span>
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
            <span>
              {t(
                '官方 cocos4 + cocos-cli，无需打开编辑器；Funplay 会下载约 3.5G 引擎。',
                'Official cocos4 + cocos-cli, no editor GUI; Funplay downloads the ~3.5G engine.'
              )}
            </span>
          </span>
        </Button>
      </div>
    </section>
  );
}
