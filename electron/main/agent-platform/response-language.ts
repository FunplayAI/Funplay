export type RuntimeUiLanguage = 'zh-CN' | 'en-US';

export function resolveRuntimeUiLanguage(language: RuntimeUiLanguage | undefined): RuntimeUiLanguage {
  return language === 'zh-CN' ? 'zh-CN' : 'en-US';
}

export function createResponseLanguageInstruction(language: RuntimeUiLanguage | undefined): string {
  return resolveRuntimeUiLanguage(language) === 'zh-CN'
    ? '默认回复语言：请使用简体中文回答用户；只有用户明确要求其他语言，或需要保留代码、命令、API 名称、文件名、错误原文时，才使用对应原文。'
    : 'Default response language: reply to the user in English; use another language only when the user explicitly asks for it, or when preserving code, commands, API names, file names, or original error text.';
}

export function createResponseLanguageContextLine(language: RuntimeUiLanguage | undefined): string {
  return resolveRuntimeUiLanguage(language) === 'zh-CN'
    ? '界面语言/默认回复语言：简体中文。'
    : 'Interface language / default response language: English.';
}
