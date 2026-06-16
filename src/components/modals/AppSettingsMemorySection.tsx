import { useMemo, useState, type JSX } from 'react';
import { RefreshCw, RotateCcw, Save, Trash2 } from 'lucide-react';
import type {
  ProjectMemoryClearScope,
  ProjectMemoryEntryKind,
  ProjectMemoryFileContent,
  ProjectMemoryFileSummary
} from '../../../shared/types';
import { localize, type UiLanguage } from '../../i18n';
import {
  formatAbsoluteTime,
  formatFileSize,
  formatMemoryEntryKindLabel,
  formatMemoryKindLabel
} from '../../lib/app-helpers';
import { Button, TextAreaField, TextField } from '../ui/index';

export function AppSettingsMemorySection(props: {
  language: UiLanguage;
  selectedProjectId?: string;
  memoryFiles: ProjectMemoryFileSummary[];
  selectedMemoryPath: string;
  selectedMemoryFile: ProjectMemoryFileContent | null;
  memoryDraft: string;
  isLoadingMemory: boolean;
  isSavingMemory: boolean;
  memoryError: string;
  onRefreshMemoryFiles: () => Promise<void>;
  onSelectMemoryFile: (filePath: string) => Promise<void>;
  onChangeMemoryDraft: (value: string) => void;
  onSaveMemoryFile: () => Promise<void>;
  onClearMemory: (scope: ProjectMemoryClearScope, filePath?: string) => Promise<void>;
}): JSX.Element {
  const { language } = props;
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryKindFilter, setMemoryKindFilter] = useState<ProjectMemoryEntryKind | ''>('');
  const [memoryTagFilter, setMemoryTagFilter] = useState('');
  const [clearSuccess, setClearSuccess] = useState('');

  const allMemoryTags = useMemo(
    () => [...new Set(props.memoryFiles.flatMap((file) => file.tags))].sort((left, right) => left.localeCompare(right)),
    [props.memoryFiles]
  );
  const allMemoryKinds = useMemo(
    () => [...new Set(props.memoryFiles.flatMap((file) => file.memoryKinds))],
    [props.memoryFiles]
  );
  const filteredMemoryFiles = useMemo(() => {
    const query = memoryQuery.trim().toLowerCase();
    const tag = memoryTagFilter.trim().toLowerCase();
    return props.memoryFiles.filter((file) => {
      const matchesKind = !memoryKindFilter || file.memoryKinds.includes(memoryKindFilter);
      const matchesTag = !tag || file.tags.includes(tag);
      const matchesQuery =
        !query ||
        `${file.title}\n${file.path}\n${file.excerpt}\n${file.tags.join(' ')}`.toLowerCase().includes(query);
      return matchesKind && matchesTag && matchesQuery;
    });
  }, [memoryKindFilter, memoryQuery, memoryTagFilter, props.memoryFiles]);
  const memoryDirty = !!props.selectedMemoryFile && props.memoryDraft !== props.selectedMemoryFile.content;

  async function clearMemory(scope: ProjectMemoryClearScope, filePath?: string): Promise<void> {
    setClearSuccess('');
    await props.onClearMemory(scope, filePath);
    setClearSuccess(
      scope === 'file'
        ? t('已清空当前文件。', 'Memory file cleared.')
        : scope === 'daily'
          ? t('已清空所有「每日」记忆。', 'Daily memory cleared.')
          : t('已清空全部项目记忆。', 'All project memory cleared.')
    );
  }

  return (
    <section className="app-settings-section memory-center-section">
      <div className="memory-center-header">
        <div>
          <strong>{t('记忆', 'Memory')}</strong>
          <div className="helper-copy">
            {props.selectedProjectId
              ? t(
                  `${props.memoryFiles.length} 个文件 · ${allMemoryKinds.length} 类记忆 · ${allMemoryTags.length} 个标签`,
                  `${props.memoryFiles.length} files · ${allMemoryKinds.length} memory kinds · ${allMemoryTags.length} tags`
                )
              : t('未选择项目', 'No project selected')}
          </div>
        </div>
        <div className="modal-actions compact">
          <Button size="sm" variant="secondary" leadingIcon={<RefreshCw size={14} aria-hidden="true" />} loading={props.isLoadingMemory} onClick={() => void props.onRefreshMemoryFiles()}>
            {props.isLoadingMemory ? t('刷新中…', 'Refreshing…') : t('刷新', 'Refresh')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            leadingIcon={<Save size={14} aria-hidden="true" />}
            onClick={() => void props.onSaveMemoryFile()}
            disabled={!memoryDirty || props.isSavingMemory || props.isLoadingMemory}
            loading={props.isSavingMemory}
          >
            {props.isSavingMemory ? t('保存中…', 'Saving…') : t('保存', 'Save')}
          </Button>
        </div>
      </div>

      <div className="memory-center-toolbar">
        <TextField
          className="memory-search-field"
          label={t('搜索 Memory', 'Search Memory')}
          value={memoryQuery}
          onValueChange={setMemoryQuery}
          placeholder={t('搜索标题、路径、内容摘要或标签', 'Search title, path, excerpt, or tags')}
        />
        <div className="memory-kind-filter" aria-label={t('记忆分类筛选', 'Memory kind filter')}>
          <Button size="compact" variant="ghost" className={!memoryKindFilter ? 'active' : ''} onClick={() => setMemoryKindFilter('')}>
            {t('全部分类', 'All Kinds')}
          </Button>
          {allMemoryKinds.map((kind) => (
            <Button key={kind} size="compact" variant="ghost" className={memoryKindFilter === kind ? 'active' : ''} onClick={() => setMemoryKindFilter(kind)}>
              {formatMemoryEntryKindLabel(kind, language)}
            </Button>
          ))}
        </div>
        <div className="memory-tag-filter" aria-label={t('记忆标签筛选', 'Memory tag filter')}>
          <Button size="compact" variant="ghost" className={!memoryTagFilter ? 'active' : ''} onClick={() => setMemoryTagFilter('')}>
            {t('全部', 'All')}
          </Button>
          {allMemoryTags.slice(0, 16).map((tag) => (
            <Button key={tag} size="compact" variant="ghost" className={memoryTagFilter === tag ? 'active' : ''} onClick={() => setMemoryTagFilter(tag)}>
              #{tag}
            </Button>
          ))}
        </div>
      </div>

      <div className="memory-center-layout">
        <div className="memory-file-list" aria-label={t('记忆文件列表', 'Memory files')}>
          {filteredMemoryFiles.length > 0 ? (
            filteredMemoryFiles.map((file) => (
              <Button
                key={file.path}
                size="compact"
                variant="ghost"
                className={`memory-file-row ${props.selectedMemoryPath === file.path ? 'active' : ''}`}
                onClick={() => void props.onSelectMemoryFile(file.path)}
              >
                <div className="memory-pill-row">
                  <span className={`memory-kind-pill ${file.kind}`}>{formatMemoryKindLabel(file.kind, language)}</span>
                  {file.memoryKinds.map((kind) => (
                    <span key={kind} className={`memory-entry-kind-pill ${kind}`}>{formatMemoryEntryKindLabel(kind, language)}</span>
                  ))}
                </div>
                <strong>{file.title}</strong>
                <span>{file.path}</span>
                {file.excerpt ? <em>{file.excerpt}</em> : null}
                <small>{[formatFileSize(file.size), `${file.lineCount} lines`, formatAbsoluteTime(file.updatedAt)].join(' · ')}</small>
              </Button>
            ))
          ) : (
            <div className="memory-empty-state">
              {props.isLoadingMemory ? t('正在读取 Memory…', 'Loading memory…') : t('没有匹配的 Memory 文件。', 'No matching memory files.')}
            </div>
          )}
        </div>

        <div className="memory-editor-panel">
          {props.selectedMemoryFile ? (
            <>
              <div className="memory-editor-header">
                <div>
                  <strong>{props.selectedMemoryFile.title}</strong>
                  <span>
                    {[
                      props.selectedMemoryFile.path,
                      formatMemoryKindLabel(props.selectedMemoryFile.kind, language),
                      ...props.selectedMemoryFile.memoryKinds.map((kind) => formatMemoryEntryKindLabel(kind, language))
                    ].join(' · ')}
                  </span>
                </div>
                <div className="memory-editor-tags">
                  {props.selectedMemoryFile.tags.length > 0
                    ? props.selectedMemoryFile.tags.map((tag) => (
                      <Button key={tag} size="compact" variant="ghost" onClick={() => setMemoryTagFilter(tag)}>
                        #{tag}
                      </Button>
                    ))
                    : <span>{t('无标签', 'No tags')}</span>}
                </div>
              </div>

              <TextAreaField
                label={t('内容', 'Content')}
                className="memory-editor-field"
                textareaClassName="memory-editor-textarea"
                value={props.memoryDraft}
                onValueChange={props.onChangeMemoryDraft}
                spellCheck={false}
              />

              <div className="memory-editor-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  title={t('清空当前文件', 'Clear the currently open memory file only')}
                  leadingIcon={<RotateCcw size={14} aria-hidden="true" />}
                  onClick={() => {
                    if (window.confirm(t('清空当前 Memory 文件？', 'Clear the current memory file?'))) {
                      void clearMemory('file', props.selectedMemoryFile?.path);
                    }
                  }}
                  disabled={props.isSavingMemory || props.isLoadingMemory}
                >
                  {t('清空当前', 'Clear File')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  title={t('清空所有「每日」记忆文件', 'Clear all daily memory files')}
                  leadingIcon={<RotateCcw size={14} aria-hidden="true" />}
                  onClick={() => {
                    if (window.confirm(t('清空所有 daily Memory？', 'Clear all daily memory?'))) {
                      void clearMemory('daily');
                    }
                  }}
                  disabled={props.isSavingMemory || props.isLoadingMemory}
                >
                  {t('清空 Daily', 'Clear Daily')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  title={t('清空全部项目记忆（含长期记忆）', 'Clear all project memory, including long-term memory')}
                  leadingIcon={<Trash2 size={14} aria-hidden="true" />}
                  onClick={() => {
                    if (window.confirm(t('清空全部 Memory？', 'Clear all memory?'))) {
                      void clearMemory('all');
                    }
                  }}
                  disabled={props.isSavingMemory || props.isLoadingMemory}
                >
                  {t('清空全部', 'Clear All')}
                </Button>
              </div>
            </>
          ) : (
            <div className="memory-empty-state">{t('选择一个 Memory 文件进行编辑。', 'Select a memory file to edit.')}</div>
          )}
        </div>
      </div>
      {clearSuccess && !props.memoryError ? <div className="memory-success-banner">{clearSuccess}</div> : null}
      {props.memoryError ? (
        <div className="memory-error-row">
          <span className="agent-composer-error neutral">{props.memoryError}</span>
          <Button size="compact" variant="secondary" leadingIcon={<RotateCcw size={13} aria-hidden="true" />} onClick={() => void props.onSaveMemoryFile()} disabled={props.isSavingMemory || props.isLoadingMemory}>
            {t('重试保存', 'Retry Save')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
