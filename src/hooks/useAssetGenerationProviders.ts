import { useState } from 'react';
import type { AssetGenerationProviderConfig, AssetGenerationProviderInput } from '../../shared/types';

/**
 * Owns the asset-generation provider configs and their CRUD handlers. The setter
 * is exposed so the bootstrap payload can seed the list. Mirrors the
 * useProviderManager extraction pattern.
 */
export function useAssetGenerationProviders() {
  const [assetGenerationProviderConfigs, setAssetGenerationProviderConfigs] = useState<AssetGenerationProviderConfig[]>(
    []
  );

  async function handleCreateAssetGenerationProvider(input: AssetGenerationProviderInput): Promise<void> {
    const provider = await window.funplay.createAssetGenerationProvider(input);
    setAssetGenerationProviderConfigs((current) => [provider, ...current.filter((item) => item.id !== provider.id)]);
  }

  async function handleUpdateAssetGenerationProvider(
    providerId: string,
    input: AssetGenerationProviderInput
  ): Promise<void> {
    const provider = await window.funplay.updateAssetGenerationProvider(providerId, input);
    setAssetGenerationProviderConfigs((current) => current.map((item) => (item.id === provider.id ? provider : item)));
  }

  async function handleDeleteAssetGenerationProvider(providerId: string): Promise<void> {
    await window.funplay.deleteAssetGenerationProvider(providerId);
    setAssetGenerationProviderConfigs((current) => current.filter((provider) => provider.id !== providerId));
  }

  return {
    assetGenerationProviderConfigs,
    setAssetGenerationProviderConfigs,
    handleCreateAssetGenerationProvider,
    handleUpdateAssetGenerationProvider,
    handleDeleteAssetGenerationProvider
  };
}
