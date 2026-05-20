import { useEffect, useState, type JSX } from 'react';
import type { Project, ProjectFileEntry } from '../../../shared/types';
import { getDocumentLanguage, localize, useUiLanguage, type UiLanguage } from '../../i18n';
import type { AssetLibraryCategory, AssetLibraryCategoryId, AssetLibraryFileItem } from '../../lib/app-types';
import type { ProjectFileItem } from '../layout/WorkspacePanels';
import { mapProjectFileContentToOverlay } from '../layout/WorkspacePanels';
import {
  assetCategorySymbol,
  buildAssetLibraryCategories,
  buildExistingAssetFileItems,
  formatAbsoluteTime,
  formatAssetFileCategory,
  formatFileSize,
  getPathExtension,
  isAssetFilePreviewable,
  mapGeneratedAssetCategory,
  slugifyAssetName,
  summarizeProjectAssetFile
} from '../../lib/app-helpers';
import { Button } from '../ui/index';

export function AssetLibraryPreview(props: { asset: AssetLibraryFileItem; preview?: ProjectFileItem }): JSX.Element {
  const language = useUiLanguage();
  const preview = props.preview;

  if (props.asset.source === 'generated') {
    return (
      <div className={`asset-inline-preview generated ${props.asset.category}`}>
        <div className="asset-inline-preview-symbol">{assetCategorySymbol(props.asset.category)}</div>
        <span>{localize(language, '生成记录', 'Generated Record')}</span>
      </div>
    );
  }

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
        <audio controls src={preview.previewDataUrl} />
      </div>
    );
  }

  if (preview?.previewDataUrl && props.asset.category === 'animation') {
    const mimeType = preview.mimeType ?? '';
    return (
      <div className="asset-inline-preview animation">
        {mimeType.startsWith('video/') ? (
          <video controls muted src={preview.previewDataUrl} />
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
  onOpenAsset: (fileId: string) => void;
  onOpenProjectFile: (path: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const existingAssetFiles = buildExistingAssetFileItems(props.projectFiles);
  const assetDiscovery = buildAssetDiscoverySummary(props.projectFiles, existingAssetFiles.length, language);
  const [assetPreviews, setAssetPreviews] = useState<Record<string, ProjectFileItem>>({});
  const [activeAssetCategory, setActiveAssetCategory] = useState<AssetLibraryCategoryId | 'all'>('all');

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

  if (!props.project) {
    return <PlaceholderPage title={t('素材库', 'Assets')} description={t('先创建项目后查看资源产物。', 'Create a project first to view generated assets.')} />;
  }

  const categories = buildAssetLibraryCategories(props.project.assets, existingAssetFiles, language);
  const visibleCategories =
    activeAssetCategory === 'all' ? categories : categories.filter((category) => category.id === activeAssetCategory);
  const totalAssetCount = categories.reduce((total, category) => total + category.items.length, 0);
  const categoryTabs: Array<{ id: AssetLibraryCategoryId | 'all'; label: string; count: number }> = [
    { id: 'all', label: t('全部', 'All'), count: totalAssetCount },
    ...categories.map((category) => ({
      id: category.id,
      label: category.label,
      count: category.items.length
    }))
  ];

  return (
    <div className="assets-page">
      <div className="asset-browser-header">
        <h2>{t('素材库', 'Assets')}</h2>
        <div className="asset-category-tabs">
          {categoryTabs.map((category) => (
            <Button
              key={category.id}
              variant="secondary"
              size="sm"
              className={activeAssetCategory === category.id ? 'active' : ''}
              onClick={() => setActiveAssetCategory(category.id)}
            >
              <span>{category.label}</span>
              <strong>{category.count}</strong>
            </Button>
          ))}
        </div>
      </div>

      <div className="asset-library-sections">
        {visibleCategories.length === 0 ? (
          <div className="asset-library-empty">
            <strong>{t('暂无素材', 'No assets yet')}</strong>
            <span>{t('当前分类下还没有图片/UI、音频、模型/3D 或动画素材。', 'No image/UI, audio, model/3D, or animation assets in this category yet.')}</span>
            <div className="asset-library-discovery" aria-label={t('素材扫描结果', 'Asset scan result')}>
              <div className="asset-discovery-stats">
                <span>
                  <strong>{assetDiscovery.directoryCount}</strong>
                  <em>{t('目录', 'Folders')}</em>
                </span>
                <span>
                  <strong>{assetDiscovery.fileCount}</strong>
                  <em>{t('项目文件', 'Project Files')}</em>
                </span>
                <span>
                  <strong>{assetDiscovery.assetFileCount}</strong>
                  <em>{t('可识别素材', 'Recognized Assets')}</em>
                </span>
              </div>
              <div className="asset-discovery-paths">
                <strong>{assetDiscovery.title}</strong>
                <div>
                  {assetDiscovery.paths.map((path) => (
                    <span key={path}>
                      {path}
                    </span>
                  ))}
                </div>
              </div>
              <span>{assetDiscovery.hint}</span>
            </div>
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
                  onClick={() => {
                    if (asset.source === 'generated') {
                      props.onOpenAsset(asset.openId);
                      return;
                    }
                    props.onOpenProjectFile(asset.path);
                  }}
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

function buildAssetDiscoverySummary(files: ProjectFileEntry[], assetFileCount: number, language: UiLanguage): {
  directoryCount: number;
  fileCount: number;
  assetFileCount: number;
  title: string;
  paths: string[];
  hint: string;
} {
  const directoryPaths = files
    .filter((file) => file.type === 'directory')
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
  const likelyAssetDirectories = directoryPaths.filter((path) => /(^|\/)(assets?|images?|audio|sounds?|fonts?|sprites?|textures?|models?|animations?|misc)(\/|$)/i.test(path));
  const fallbackPaths = ['assets/images', 'assets/audio', 'assets/fonts', 'assets/misc'];
  const paths = (likelyAssetDirectories.length > 0 ? likelyAssetDirectories : fallbackPaths).slice(0, 8);

  return {
    directoryCount: directoryPaths.length,
    fileCount: files.filter((file) => file.type === 'file').length,
    assetFileCount,
    title: likelyAssetDirectories.length > 0
      ? localize(language, '已发现资源目录', 'Detected Asset Folders')
      : localize(language, '建议资源目录', 'Suggested Asset Folders'),
    paths,
    hint: likelyAssetDirectories.length > 0
      ? localize(language, '这些目录会在加入图片、音频、模型或动画文件后自动出现在素材库。', 'These folders will appear in Assets automatically after image, audio, model, or animation files are added.')
      : localize(language, '可以让 Agent 创建这些目录并写入项目记忆，后续素材文件会自动归类。', 'Ask Agent to create these folders and write project memory; future asset files will be categorized automatically.')
  };
}
