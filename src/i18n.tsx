import { createContext, useContext, type ReactNode } from 'react';

export type UiLanguage = 'zh-CN' | 'en-US';

const UiLanguageContext = createContext<UiLanguage>('zh-CN');

export function UiLanguageProvider(props: {
  language: UiLanguage;
  children: ReactNode;
}): ReactNode {
  return <UiLanguageContext.Provider value={props.language}>{props.children}</UiLanguageContext.Provider>;
}

export function useUiLanguage(): UiLanguage {
  return useContext(UiLanguageContext);
}

export function localize(language: UiLanguage, zh: string, en: string): string {
  return language === 'en-US' ? en : zh;
}

export function getDocumentLanguage(): UiLanguage {
  if (typeof document === 'undefined') {
    return 'zh-CN';
  }
  return document.documentElement.lang === 'en-US' ? 'en-US' : 'zh-CN';
}
