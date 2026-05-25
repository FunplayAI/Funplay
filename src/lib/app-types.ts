export type ProjectSettingsTab = 'engine' | 'agent' | 'runs' | 'usage' | 'mcp' | 'skills';
export type AppSettingsTab = 'appearance' | 'language' | 'agent' | 'provider' | 'asset-provider' | 'mcp' | 'web-search' | 'claude' | 'memory' | 'notifications' | 'about';
export type ThemePreference = 'system' | 'light' | 'dark';
export interface UiPreferences {
  theme: ThemePreference;
  language: LanguagePreference;
  developerMode: boolean;
}
export type ProjectMcpBindingDraft = string[];
export interface ProjectAgentSkillDraft {
  id?: string;
  name: string;
  description: string;
  trigger: string;
  instruction: string;
  enabled: boolean;
}
export type LanguagePreference = 'zh-CN' | 'en-US';
export type AssetLibrarySource = 'project-file';
export type AssetLibraryCategoryId = 'image' | 'audio' | 'model' | 'animation';
export interface AssetLibraryFileItem {
  id: string;
  source: AssetLibrarySource;
  openId: string;
  name: string;
  path: string;
  description: string;
  meta: string;
  category: AssetLibraryCategoryId;
  statusKind: 'planned' | 'generating' | 'ready';
  statusLabel: string;
  previewable: boolean;
}
export interface AssetLibraryCategory {
  id: AssetLibraryCategoryId;
  label: string;
  items: AssetLibraryFileItem[];
}
