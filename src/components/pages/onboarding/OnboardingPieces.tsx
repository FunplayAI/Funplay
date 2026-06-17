import { useEffect, useState, type JSX } from 'react';
import { AlertTriangle, Globe2, Info } from 'lucide-react';
import type {
  CocosEngineVariant,
  CocosVariantPrerequisite,
  EngineProjectDimension,
  InstalledUnityEditorOption,
  PlatformChoice,
  ProjectSetupMode
} from '../../../../shared/types';
import { localize, type UiLanguage } from '../../../i18n';
import { Button } from '../../ui/index';

// Step-1 / Step-3 heading + source label, varying by create/import and whether the
// project is a generic (web) workspace vs an engine project.
export function buildOnboardingHeadings(
  mode: ProjectSetupMode,
  isGenericProject: boolean,
  language: UiLanguage
): { heading: string; sourceLabel: string } {
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const heading =
    mode === 'create'
      ? isGenericProject
        ? t('新建通用项目', 'Create Generic Project')
        : t('新建引擎项目', 'Create Engine Project')
      : isGenericProject
        ? t('导入通用项目', 'Import Generic Project')
        : t('导入已有引擎项目', 'Import Engine Project');
  const sourceLabel =
    mode === 'create'
      ? isGenericProject
        ? t('新建通用项目', 'Create Generic Project')
        : t('新建引擎项目', 'Create Engine Project')
      : isGenericProject
        ? t('导入通用项目', 'Import Generic Project')
        : t('导入已有项目', 'Import Existing Project');
  return { heading, sourceLabel };
}

const platformLogoUrls: Partial<Record<PlatformChoice, string>> = {
  unity: './engine-logos/unity.svg',
  cocos: './engine-logos/cocos.svg',
  godot: './engine-logos/godotengine.svg',
  unreal: './engine-logos/unrealengine.svg'
};

export function PlatformCardIcon(props: { id: PlatformChoice }): JSX.Element {
  const logoUrl = platformLogoUrls[props.id];

  return (
    <span
      className={`option-card-icon platform-logo-icon platform-logo-${props.id} ${logoUrl ? 'has-brand-logo' : ''}`}
      aria-hidden="true"
    >
      {logoUrl ? <img className="platform-logo-image" src={logoUrl} alt="" draggable={false} /> : <Globe2 size={18} />}
    </span>
  );
}

// Non-blocking precheck of the selected Cocos variant's prerequisite (creator3 →
// Cocos Creator installed; cocos4 → Node 22+/git). Returns null while loading, off
// the cocos platform, or when the precheck API is unavailable.
export function useCocosVariantPrerequisite(
  platform: PlatformChoice,
  variant: CocosEngineVariant
): CocosVariantPrerequisite | null {
  const [prerequisite, setPrerequisite] = useState<CocosVariantPrerequisite | null>(null);
  useEffect(() => {
    if (platform !== 'cocos' || !window.funplay?.checkCocosVariantPrerequisite) {
      setPrerequisite(null);
      return;
    }
    let cancelled = false;
    setPrerequisite(null);
    void window.funplay
      .checkCocosVariantPrerequisite(variant)
      .then((result) => {
        if (!cancelled) {
          setPrerequisite(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPrerequisite(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [platform, variant]);
  return prerequisite;
}

// Step indicator for the onboarding wizard. Web / generic projects skip the
// engine environment check (Step 2), so for them we render Step 2 grayed and
// relabel it rather than implying a check that never happens.
export function StepIndicator(props: {
  step: 1 | 2 | 3;
  skipEnvironment?: boolean;
  language?: UiLanguage;
}): JSX.Element {
  if (props.skipEnvironment) {
    const skipLabel = localize(props.language ?? 'zh-CN', '引擎设置 — Web 项目跳过', 'Engine setup — skipped for web');
    return (
      <div className="step-indicator step-indicator-web">
        <div className={`step-dot ${props.step >= 3 ? 'complete' : 'active'}`}>{props.step >= 3 ? '✓' : '1'}</div>
        <div className="step-line" />
        <div className="step-dot skipped" aria-disabled="true" aria-label={skipLabel} title={skipLabel}>
          {'—'}
        </div>
        <div className="step-line" />
        <div className={`step-dot ${props.step >= 3 ? 'active complete' : ''}`}>3</div>
      </div>
    );
  }
  return (
    <div className="step-indicator">
      <div className={`step-dot ${props.step === 1 ? 'active' : 'complete'}`}>{props.step > 1 ? '✓' : '1'}</div>
      <div className="step-line" />
      <div className={`step-dot ${props.step === 2 ? 'active' : props.step > 2 ? 'complete' : ''}`}>
        {props.step > 2 ? '✓' : '2'}
      </div>
      <div className="step-line" />
      <div className={`step-dot ${props.step === 3 ? 'active complete' : ''}`}>3</div>
    </div>
  );
}

// Step-1 non-blocking note of dimension-compatible installed Unity editors, so the
// user learns about an incompatibility before reaching the Step-2 checks.
export function CompatibleEditorsNote(props: {
  editors: InstalledUnityEditorOption[];
  dimension: EngineProjectDimension;
  language: UiLanguage;
}): JSX.Element | null {
  const t = (zh: string, en: string): string => localize(props.language, zh, en);
  if (props.editors.length === 0) {
    return null;
  }
  const compatible = props.editors.filter((editor) => editor.compatible);
  const dimensionLabel = props.dimension === '2d' ? '2D' : props.dimension === '3d' ? '3D' : '';
  if (compatible.length === 0) {
    return (
      <div className="onboarding-form-note onboarding-editor-note warning">
        <AlertTriangle size={13} aria-hidden="true" />
        {t(
          `该维度暂无已安装的兼容编辑器，将在第 2 步安装 ${dimensionLabel} 兼容版本。`,
          `No installed editor is compatible with this dimension; a ${dimensionLabel}-compatible version will be installed in Step 2.`
        )}
      </div>
    );
  }
  const names = compatible.map((editor) => editor.displayName).join('、');
  return (
    <div className="onboarding-form-note onboarding-editor-note ok">
      <Info size={13} aria-hidden="true" />
      {t(`✓ 兼容编辑器：${names}`, `✓ Compatible editors: ${names}`)}
    </div>
  );
}

// Step-2 brief note when an import auto-detected a dimension differing from the
// user's Step-1 choice.
export function ImportDetectedDimensionNote(props: {
  detected: EngineProjectDimension | null | undefined;
  language: UiLanguage;
}): JSX.Element | null {
  if (!props.detected || props.detected === 'unknown') {
    return null;
  }
  const t = (zh: string, en: string): string => localize(props.language, zh, en);
  const label = props.detected.toUpperCase();
  return (
    <div className="helper-copy onboarding-action-message onboarding-detected-dimension">
      <Info size={13} aria-hidden="true" />
      {t(`已检测到：${label} 项目`, `Detected: ${label} project`)}
    </div>
  );
}

// Step-3 project-creation failure banner with a recovery path (Retry / Back).
export function Step3ErrorBanner(props: {
  message: string;
  busy: boolean;
  onRetry: () => void;
  onBack: () => void;
  language: UiLanguage;
}): JSX.Element {
  const t = (zh: string, en: string): string => localize(props.language, zh, en);
  return (
    <div className="onboarding-step3-error" role="alert">
      <div className="onboarding-step3-error-head">
        <AlertTriangle size={16} aria-hidden="true" />
        <strong>{t('创建项目失败', 'Project creation failed')}</strong>
      </div>
      <div className="onboarding-step3-error-message">{props.message}</div>
      <div className="onboarding-step3-error-actions">
        <Button
          variant="secondary"
          className="onboarding-step3-error-back"
          onClick={props.onBack}
          disabled={props.busy}
        >
          {t('返回', 'Back')}
        </Button>
        <Button
          variant="primary"
          className="onboarding-step3-error-retry"
          onClick={props.onRetry}
          disabled={props.busy}
        >
          {props.busy ? t('重试中…', 'Retrying…') : t('重试', 'Retry')}
        </Button>
      </div>
    </div>
  );
}
