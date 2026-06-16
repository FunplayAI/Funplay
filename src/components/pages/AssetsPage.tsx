import { useEffect, useState, type JSX } from 'react';
import {
  Box,
  Clock3,
  Film,
  Image as ImageIcon,
  Library,
  Music,
  Sparkles,
  type LucideIcon
} from 'lucide-react';
import type {
  AssetGenerationKind,
  AssetGenerationProviderProfile,
  AssetGenerationRequest,
  Project,
  ProjectFileEntry
} from '../../../shared/types';
import {
  ASSET_GENERATION_IMAGE_DIMENSION_LIMITS,
  formatAssetGenerationImageDimensionValidation,
  isAssetGenerationImageDimensionConstrainedKind,
  validateAssetGenerationImageDimensions
} from '../../../shared/asset-generation-validation';
import { localize, useUiLanguage } from '../../i18n';
import type { AssetLibraryCategoryId, AssetLibraryFileItem } from '../../lib/app-types';
import type { ProjectFileItem } from '../layout/WorkspacePanels';
import { AudioWaveformPreview } from '../layout/file-preview-components';
import { mapProjectFileContentToOverlay } from '../layout/WorkspacePanels';
import {
  assetCategorySymbol,
  buildAssetLibraryCategories,
  buildExistingAssetFileItems
} from '../../lib/app-helpers';
import {
  defaultTitleForKind,
  formatGenerationKind,
  generationKindOptions,
  isAudioGenerationKind,
  isVisualGenerationKind
} from '../../lib/asset-generation-ui';
import { Button, SelectField, TextAreaField, TextField } from '../ui/index';
import { AssetGenerationJobCard } from './AssetGenerationJobCard';

export type AssetLibraryViewId = AssetLibraryCategoryId | 'all' | 'generate' | 'jobs';

export function AssetLibraryPreview(props: { asset: AssetLibraryFileItem; preview?: ProjectFileItem }): JSX.Element {
  const language = useUiLanguage();
  const preview = props.preview;

  if (preview?.previewDataUrl && props.asset.category === 'image') {
    return (
      <div className="asset-inline-preview image">
        <img src={preview.previewDataUrl} alt={props.asset.name} />
      </div>
    );
  }

  if (preview?.previewDataUrl && props.asset.category === 'audio') {
    return (
      <div className="asset-inline-preview audio">
        <AudioWaveformPreview src={preview.previewDataUrl} compact />
      </div>
    );
  }

  if (preview?.previewDataUrl && props.asset.category === 'animation') {
    const mimeType = preview.mimeType ?? '';
    return (
      <div className="asset-inline-preview animation">
        {mimeType.startsWith('video/') ? (
          <video controls muted preload="metadata" src={preview.previewDataUrl} />
        ) : (
          <img src={preview.previewDataUrl} alt={props.asset.name} />
        )}
      </div>
    );
  }

  return (
    <div className={`asset-inline-preview placeholder ${props.asset.category}`}>
      <div className="asset-inline-preview-symbol">{assetCategorySymbol(props.asset.category)}</div>
      <span>{props.asset.previewable ? localize(language, '正在准备预览', 'Preparing preview') : props.asset.meta}</span>
    </div>
  );
}

export function AssetsPage(props: {
  project: Project | null;
  projectFiles: ProjectFileEntry[];
  assetGenerationProviders?: AssetGenerationProviderProfile[];
  onOpenAsset: (fileId: string) => void;
  onOpenProjectFile: (path: string) => void;
  onGenerateAsset?: (input: AssetGenerationRequest) => Promise<Project>;
  onImportGeneratedAsset?: (jobId: string) => Promise<Project>;
  onCancelAssetGenerationJob?: (jobId: string) => Promise<Project>;
  onRetryAssetGenerationJob?: (jobId: string) => Promise<Project>;
  activeViewId?: AssetLibraryViewId;
  onActiveViewChange?: (viewId: AssetLibraryViewId) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const existingAssetFiles = buildExistingAssetFileItems(props.projectFiles);
  const [assetPreviews, setAssetPreviews] = useState<Record<string, ProjectFileItem>>({});
  const [localActiveAssetCategory, setLocalActiveAssetCategory] = useState<AssetLibraryViewId>('all');
  const [generationKind, setGenerationKind] = useState<AssetGenerationKind>('image_2d');
  const [generationProviderId, setGenerationProviderId] = useState('');
  const [generationTitle, setGenerationTitle] = useState('');
  const [generationPrompt, setGenerationPrompt] = useState('');
  const [generationCount, setGenerationCount] = useState('1');
  const [generationWidth, setGenerationWidth] = useState('1024');
  const [generationHeight, setGenerationHeight] = useState('1024');
  const [generationDuration, setGenerationDuration] = useState('1');
  const [generationError, setGenerationError] = useState('');
  const [activeGenerationSubmissions, setActiveGenerationSubmissions] = useState(0);
  const providers = props.assetGenerationProviders ?? [];
  const enabledProviders = providers.filter((provider) => provider.enabled && provider.supportedKinds.includes(generationKind));
  const selectedProvider = enabledProviders.find((provider) => provider.id === generationProviderId) ?? enabledProviders[0];
  const generationDimensionHelper = t(
    `最大边 ≤ ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.maxEdge}px；宽高需为 ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.multiple}px 倍数；比例 ≤ ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.maxAspectRatio}:1；总像素 ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.minPixels.toLocaleString('en-US')} - ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.maxPixels.toLocaleString('en-US')}。`,
    `Longest edge ≤ ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.maxEdge}px; width/height must be multiples of ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.multiple}px; ratio ≤ ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.maxAspectRatio}:1; total pixels ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.minPixels.toLocaleString('en-US')} - ${ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.maxPixels.toLocaleString('en-US')}.`
  );
  const generationJobs = [...(props.project?.assetGenerationJobs ?? [])].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
  );
  const runningGenerationCount = generationJobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const activeGenerationCount = Math.max(runningGenerationCount, activeGenerationSubmissions);
  const activeAssetCategory = props.activeViewId ?? localActiveAssetCategory;
  const setActiveAssetCategory = (viewId: AssetLibraryViewId): void => {
    props.onActiveViewChange?.(viewId);
    if (props.activeViewId === undefined) {
      setLocalActiveAssetCategory(viewId);
    }
  };

  useEffect(() => {
    if (!props.project) {
      setAssetPreviews({});
      return;
    }

    let cancelled = false;
    const previewFiles = existingAssetFiles
      .filter((item) => item.previewable && item.source === 'project-file')
      .slice(0, 80);

    if (previewFiles.length === 0) {
      setAssetPreviews({});
      return;
    }

    void Promise.all(
      previewFiles.map(async (item) => {
        try {
          const file = await window.funplay.readProjectFile(props.project!.id, item.path);
          return [item.path, mapProjectFileContentToOverlay(file)] as const;
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (cancelled) {
        return;
      }
      setAssetPreviews(Object.fromEntries(entries.filter((entry): entry is readonly [string, ProjectFileItem] => Boolean(entry))));
    });

    return () => {
      cancelled = true;
    };
  }, [props.project?.id, props.projectFiles]);

  useEffect(() => {
    if (!selectedProvider && enabledProviders[0]) {
      setGenerationProviderId(enabledProviders[0].id);
      return;
    }
    if (selectedProvider && selectedProvider.id !== generationProviderId) {
      setGenerationProviderId(selectedProvider.id);
    }
  }, [enabledProviders, generationProviderId, selectedProvider]);

  if (!props.project) {
    return <PlaceholderPage title={t('素材库', 'Assets')} description={t('先创建项目后查看资源产物。', 'Create a project first to view generated assets.')} />;
  }

  const categories = buildAssetLibraryCategories(existingAssetFiles, language);
  const visibleCategories =
    activeAssetCategory === 'all' || activeAssetCategory === 'generate' || activeAssetCategory === 'jobs'
      ? categories
      : categories.filter((category) => category.id === activeAssetCategory);
  const totalAssetCount = categories.reduce((total, category) => total + category.items.length, 0);
  const visibleAssets = visibleCategories.flatMap((category) => category.items);
  const activeCategoryLabel = activeAssetCategory === 'generate'
    ? t('生成素材', 'Generate Assets')
    : activeAssetCategory === 'jobs'
      ? t('生成记录', 'Generation Jobs')
      : activeAssetCategory === 'all'
        ? t('全部素材', 'All Assets')
        : categories.find((category) => category.id === activeAssetCategory)?.label ?? t('当前分类', 'Current Category');
  const categoryDescriptions: Record<AssetLibraryCategoryId | 'all', string> = {
    all: t('全部可识别素材', 'All recognized assets'),
    image: t('图片、UI 与纹理', 'Images, UI, textures'),
    audio: t('音效与音乐', 'Sound effects and music'),
    model: t('模型与 3D 文件', 'Models and 3D files'),
    animation: t('动画与视频', 'Animation and video')
  };
  const categoryIcons: Record<AssetLibraryCategoryId | 'all', LucideIcon> = {
    all: Library,
    image: ImageIcon,
    audio: Music,
    model: Box,
    animation: Film
  };
  const categoryTabs: Array<{ id: AssetLibraryCategoryId | 'all'; label: string; count: number; description: string; Icon: LucideIcon }> = [
    { id: 'all', label: t('全部', 'All'), count: totalAssetCount, description: categoryDescriptions.all, Icon: Library },
    ...categories.map((category) => ({
      id: category.id,
      label: category.label,
      count: category.items.length,
      description: categoryDescriptions[category.id],
      Icon: categoryIcons[category.id]
    }))
  ];
  const workflowTabs: Array<{ id: 'generate' | 'jobs'; label: string; count: number; description: string; Icon: LucideIcon }> = [
    { id: 'generate', label: t('生成素材', 'Generate'), count: enabledProviders.length, description: t('2D、3D、动画、音频', '2D, 3D, animation, audio'), Icon: Sparkles },
    { id: 'jobs', label: t('生成记录', 'Jobs'), count: generationJobs.length, description: t('输出、导入与状态', 'Outputs, imports, status'), Icon: Clock3 }
  ];
  const activeAssetSummary = t(
    activeAssetCategory === 'generate'
      ? `${enabledProviders.length} 个可用生成器 · ${generationKindOptions.length} 类素材${activeGenerationCount > 0 ? ` · ${activeGenerationCount} 个生成中` : ''}`
      : activeAssetCategory === 'jobs'
        ? `${generationJobs.length} 个生成任务 · ${generationJobs.filter((job) => job.status === 'completed').length} 个已完成${activeGenerationCount > 0 ? ` · ${activeGenerationCount} 个生成中` : ''}`
        : `${visibleAssets.length} 个当前素材 · ${totalAssetCount} 个素材总计 · ${existingAssetFiles.length} 个项目文件可识别`,
    activeAssetCategory === 'generate'
      ? `${enabledProviders.length} available generators · ${generationKindOptions.length} asset kinds${activeGenerationCount > 0 ? ` · ${activeGenerationCount} generating` : ''}`
      : activeAssetCategory === 'jobs'
        ? `${generationJobs.length} generation jobs · ${generationJobs.filter((job) => job.status === 'completed').length} completed${activeGenerationCount > 0 ? ` · ${activeGenerationCount} generating` : ''}`
        : `${visibleAssets.length} current assets · ${totalAssetCount} assets total · ${existingAssetFiles.length} recognized project files`
  );
  const detailCount = activeAssetCategory === 'generate'
    ? enabledProviders.length
    : activeAssetCategory === 'jobs'
      ? generationJobs.length
      : visibleAssets.length;
  const openAsset = (asset: AssetLibraryFileItem): void => {
    props.onOpenProjectFile(asset.path);
  };
  const submitGeneration = async (): Promise<void> => {
    if (!props.onGenerateAsset) {
      return;
    }
    const title = generationTitle.trim() || defaultTitleForKind(generationKind, language);
    const prompt = generationPrompt.trim();
    if (!prompt) {
      setGenerationError(t('请先填写素材描述。', 'Describe the asset first.'));
      return;
    }
    if (!selectedProvider) {
      setGenerationError(t('当前没有可用的素材生成器。', 'No asset generation provider is available.'));
      return;
    }
    setGenerationError('');
    try {
      const outputSpec: AssetGenerationRequest['outputSpec'] = {};
      if (isVisualGenerationKind(generationKind)) {
        const width = Number.parseInt(generationWidth, 10);
        const height = Number.parseInt(generationHeight, 10);
        const dimensionValidation = validateAssetGenerationImageDimensions(width, height);
        if (!dimensionValidation.ok && isAssetGenerationImageDimensionConstrainedKind(generationKind)) {
          setGenerationError(formatAssetGenerationImageDimensionValidation(dimensionValidation, language));
          return;
        }
        outputSpec.width = width;
        outputSpec.height = height;
        outputSpec.transparentBackground = generationKind === 'ui_2d';
      }
      if (isAudioGenerationKind(generationKind) || generationKind === 'animation_3d') {
        outputSpec.durationSeconds = Number.parseFloat(generationDuration) || 1;
        outputSpec.loop = generationKind === 'audio_music' || generationKind === 'animation_3d';
      }
      setActiveGenerationSubmissions((count) => count + 1);
      setActiveAssetCategory('jobs');
      await props.onGenerateAsset({
        title,
        kind: generationKind,
        prompt,
        providerId: selectedProvider.id,
        providerAdapter: selectedProvider.adapter,
        outputSpec,
        count: Number.parseInt(generationCount, 10) || 1,
        createdBy: 'user',
        targetEngine: props.project?.engine?.platform
      });
      setGenerationTitle('');
      setGenerationPrompt('');
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : t('素材生成失败。', 'Asset generation failed.'));
    } finally {
      setActiveGenerationSubmissions((count) => Math.max(0, count - 1));
    }
  };

  return (
    <div className="assets-page project-settings-page">
      <aside className="project-settings-sidebar asset-library-sidebar">
        <div className="project-settings-sidebar-header">
          <div className="sidebar-section-label">{t('素材库', 'Assets')}</div>
          <h2>{props.project.name}</h2>
        </div>

        <nav className="project-settings-nav asset-library-nav" aria-label={t('素材库分类', 'Asset library categories')}>
          {workflowTabs.map((category) => {
            const Icon = category.Icon;
            return (
              <Button
                key={category.id}
                size="compact"
                variant="ghost"
                className={`project-settings-nav-item ${activeAssetCategory === category.id ? 'active' : ''}`}
                aria-current={activeAssetCategory === category.id ? 'page' : undefined}
                title={`${category.label} · ${category.description} · ${category.count}`}
                onClick={() => setActiveAssetCategory(category.id)}
              >
                <span className="project-settings-nav-icon" aria-hidden="true">
                  <Icon size={15} />
                </span>
                <span className="project-settings-nav-copy">
                  <strong>{category.label}</strong>
                  <span>{category.description}</span>
                </span>
                <span className="project-settings-nav-badge">{category.count}</span>
              </Button>
            );
          })}
          {categoryTabs.map((category) => {
            const Icon = category.Icon;
            return (
              <Button
                key={category.id}
                size="compact"
                variant="ghost"
                className={`project-settings-nav-item ${activeAssetCategory === category.id ? 'active' : ''}`}
                aria-current={activeAssetCategory === category.id ? 'page' : undefined}
                title={`${category.label} · ${category.description} · ${category.count}`}
                onClick={() => setActiveAssetCategory(category.id)}
              >
                <span className="project-settings-nav-icon" aria-hidden="true">
                  <Icon size={15} />
                </span>
                <span className="project-settings-nav-copy">
                  <strong>{category.label}</strong>
                  <span>{category.description}</span>
                </span>
                <span className="project-settings-nav-badge">{category.count}</span>
              </Button>
            );
          })}
        </nav>
      </aside>

      <section className="project-settings-detail asset-library-detail">
        <div className="project-settings-detail-header asset-library-detail-header">
          <div>
            <h2>{activeCategoryLabel}</h2>
            <p>{activeAssetSummary}</p>
          </div>
          <span className="asset-library-detail-stat">{detailCount}</span>
        </div>

        <div className="project-settings-detail-body asset-library-detail-body">
          {activeAssetCategory === 'generate' ? (
            <div className="asset-generation-center">
              <section className="asset-generation-form">
                <div className="asset-generation-form-grid">
                  <SelectField
                    label={t('素材类型', 'Asset Type')}
                    value={generationKind}
                    options={generationKindOptions.map((kind) => ({ value: kind, label: formatGenerationKind(kind, language) }))}
                    onValueChange={(value) => setGenerationKind(value as AssetGenerationKind)}
                  />
                  <SelectField
                    label={t('生成器', 'Provider')}
                    value={selectedProvider?.id ?? ''}
                    options={enabledProviders.map((provider) => ({
                      value: provider.id,
                      label: `${provider.name}${provider.modelLabel ? ` · ${provider.modelLabel}` : ''}`
                    }))}
                    placeholder={t('没有可用生成器', 'No provider')}
                    disabled={enabledProviders.length === 0}
                    onValueChange={setGenerationProviderId}
                  />
                  <TextField
                    label={t('名称', 'Name')}
                    value={generationTitle}
                    placeholder={defaultTitleForKind(generationKind, language)}
                    onValueChange={setGenerationTitle}
                  />
                  <SelectField
                    label={t('数量', 'Count')}
                    value={generationCount}
                    options={['1', '2', '3', '4'].map((value) => ({ value, label: value }))}
                    onValueChange={setGenerationCount}
                  />
                </div>
                <TextAreaField
                  label={t('描述', 'Prompt')}
                  value={generationPrompt}
                  rows={7}
                  placeholder={t(
                    '描述主题、风格、用途、尺寸感和需要避开的元素。',
                    'Describe subject, style, use, scale, and anything to avoid.'
                  )}
                  onValueChange={setGenerationPrompt}
                />
                <div className="asset-generation-form-grid compact">
                  {isVisualGenerationKind(generationKind) ? (
                    <>
                      <TextField label={t('宽度', 'Width')} value={generationWidth} inputMode="numeric" helper={generationDimensionHelper} onValueChange={setGenerationWidth} />
                      <TextField label={t('高度', 'Height')} value={generationHeight} inputMode="numeric" helper={generationDimensionHelper} onValueChange={setGenerationHeight} />
                    </>
                  ) : null}
                  {isAudioGenerationKind(generationKind) || generationKind === 'animation_3d' ? (
                    <TextField
                      label={t('时长（秒）', 'Duration (s)')}
                      value={generationDuration}
                      inputMode="decimal"
                      onValueChange={setGenerationDuration}
                    />
                  ) : null}
                </div>
                {generationError ? <div className="asset-generation-error">{generationError}</div> : null}
                <div className="asset-generation-actions">
                  <Button
                    variant="primary"
                    onClick={() => void submitGeneration()}
                    disabled={!props.onGenerateAsset || enabledProviders.length === 0}
                  >
                    <Sparkles size={16} />
                    {t('生成', 'Generate')}
                  </Button>
                </div>
              </section>
              <section className="asset-generation-queue-panel">
                <div className="asset-generation-queue-head">
                  <div>
                    <strong>{t('任务队列', 'Task Queue')}</strong>
                    <span>{activeGenerationCount > 0 ? t(`${activeGenerationCount} 个生成中`, `${activeGenerationCount} generating`) : t('当前没有生成中任务', 'No active generation jobs')}</span>
                  </div>
                  <Button size="compact" variant="secondary" onClick={() => setActiveAssetCategory('jobs')}>
                    {t('查看全部', 'View all')}
                  </Button>
                </div>
                {generationJobs.length === 0 ? (
                  <div className="asset-library-empty compact">
                    <strong>{t('还没有生成任务', 'No generation jobs yet')}</strong>
                    <span>{t('提交后会在这里看到进度、输出路径和失败原因。', 'After submitting, progress, output paths, and failures appear here.')}</span>
                  </div>
                ) : (
                  <div className="asset-generation-queue-list">
                    {generationJobs.slice(0, 4).map((job) => (
                      <AssetGenerationJobCard
                        key={job.id}
                        job={job}
                        language={language}
                        compact
                        onOpenOutput={props.onOpenProjectFile}
                        onImport={props.onImportGeneratedAsset}
                        onCancel={props.onCancelAssetGenerationJob}
                        onRetry={props.onRetryAssetGenerationJob}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : activeAssetCategory === 'jobs' ? (
            <div className="asset-generation-jobs">
              {generationJobs.length === 0 ? (
                <div className="asset-library-empty">
                  <strong>{t('暂无生成记录', 'No generation jobs yet')}</strong>
                  <span>{t('生成完成后会在这里查看输出文件、状态和导入记录。', 'Generated outputs, status, and imports will appear here.')}</span>
                </div>
              ) : null}
              {generationJobs.map((job) => (
                <AssetGenerationJobCard
                  key={job.id}
                  job={job}
                  language={language}
                  onOpenOutput={props.onOpenProjectFile}
                  onImport={props.onImportGeneratedAsset}
                  onCancel={props.onCancelAssetGenerationJob}
                  onRetry={props.onRetryAssetGenerationJob}
                />
              ))}
            </div>
          ) : (
            <div className="asset-library-sections">
            {visibleAssets.length === 0 ? (
              <div className="asset-library-empty">
                <strong>{t('暂无素材', 'No assets yet')}</strong>
                <span>{t('当前分类下还没有图片/UI、音频、模型/3D 或动画素材。', 'No image/UI, audio, model/3D, or animation assets in this category yet.')}</span>
              </div>
            ) : null}
            {visibleCategories.map((category) => (
              <section key={category.id} className="asset-library-section">
                <div className="asset-library-section-header">
                  <h3>{category.label}</h3>
                  <span>{category.items.length}</span>
                </div>
                <div className="asset-card-list">
                  {category.items.map((asset) => (
                    <Button
                      key={asset.id}
                      variant="ghost"
                      size="compact"
                      className="asset-library-card"
                      onClick={() => openAsset(asset)}
                    >
                      <AssetLibraryPreview asset={asset} preview={assetPreviews[asset.path]} />
                      <div className="asset-library-top">
                        <strong>{asset.name}</strong>
                        <span className={`asset-status ${asset.statusKind}`}>{asset.statusLabel}</span>
                      </div>
                      <div className="helper-copy">{asset.description}</div>
                      <div className="asset-library-meta">
                        <span>{asset.path}</span>
                        <span>{asset.meta}</span>
                      </div>
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function PlaceholderPage(props: { title: string; description: string }): JSX.Element {
  return (
    <div className="placeholder-page">
      <h2>{props.title}</h2>
      <p>{props.description}</p>
    </div>
  );
}
