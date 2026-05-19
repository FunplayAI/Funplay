import { useEffect, useMemo, useState } from 'react';
import { getPlatformCards, applyUiPreferences, persistUiPreferences, readUiPreferences } from '../lib/app-helpers';
import type { UiPreferences } from '../lib/app-types';

export function useUiPreferences() {
  const [uiPreferences, setUiPreferences] = useState(() => readUiPreferences());
  const platformCards = useMemo(() => getPlatformCards(uiPreferences.language), [uiPreferences.language]);

  useEffect(() => {
    applyUiPreferences(uiPreferences);
    persistUiPreferences(uiPreferences);
  }, [uiPreferences]);

  useEffect(() => {
    if (uiPreferences.theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) {
      return;
    }

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (): void => applyUiPreferences(uiPreferences);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, [uiPreferences]);

  return { uiPreferences, setUiPreferences, platformCards };
}
