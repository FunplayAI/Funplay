import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import electron from 'electron';
import type { AssetGenerationProviderConfig } from '../../shared/types';

const ASSET_PROVIDER_SECRETS_FILE_NAME = 'funplay-asset-provider-secrets.json';

const safeStorage = electron.safeStorage;

interface PersistedAssetProviderSecrets {
  encrypted: boolean;
  payload: string;
}

let assetProviderSecretsPath = '';

export function initializeAssetGenerationSecretStore(userDataPath: string): void {
  assetProviderSecretsPath = join(userDataPath, ASSET_PROVIDER_SECRETS_FILE_NAME);
}

async function readSecretMap(): Promise<Record<string, string>> {
  if (!assetProviderSecretsPath) {
    return {};
  }

  try {
    const raw = await readFile(assetProviderSecretsPath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedAssetProviderSecrets;
    const serialized = parsed.encrypted && safeStorage?.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(parsed.payload, 'base64'))
      : parsed.payload;
    const secrets = JSON.parse(serialized) as Record<string, string>;
    return Object.fromEntries(
      Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    );
  } catch {
    return {};
  }
}

async function writeSecretMap(secretMap: Record<string, string>): Promise<void> {
  if (!assetProviderSecretsPath) {
    return;
  }

  const serialized = JSON.stringify(secretMap, null, 2);
  const encrypted = Boolean(safeStorage?.isEncryptionAvailable());
  const payload = encrypted
    ? safeStorage!.encryptString(serialized).toString('base64')
    : serialized;

  await writeFile(assetProviderSecretsPath, JSON.stringify({ encrypted, payload }, null, 2), 'utf8');
}

export async function hydrateAssetGenerationProvidersWithSecrets(providers: AssetGenerationProviderConfig[]): Promise<AssetGenerationProviderConfig[]> {
  const secretMap = await readSecretMap();
  return providers.map((provider) => {
    const secret = secretMap[provider.id] ?? provider.apiKey.trim();
    return {
      ...provider,
      apiKey: secret,
      hasStoredApiKey: Boolean(secret)
    };
  });
}

export async function persistAssetGenerationProviderSecret(providerId: string, apiKey: string): Promise<void> {
  const secretMap = await readSecretMap();
  if (apiKey.trim()) {
    secretMap[providerId] = apiKey.trim();
  } else {
    delete secretMap[providerId];
  }
  await writeSecretMap(secretMap);
}

export async function deleteAssetGenerationProviderSecret(providerId: string): Promise<void> {
  const secretMap = await readSecretMap();
  if (!(providerId in secretMap)) {
    return;
  }
  delete secretMap[providerId];
  await writeSecretMap(secretMap);
}

export function sanitizeAssetGenerationProviderForRenderer(provider: AssetGenerationProviderConfig): AssetGenerationProviderConfig {
  return {
    ...provider,
    apiKey: '',
    hasStoredApiKey: provider.hasStoredApiKey ?? Boolean(provider.apiKey.trim())
  };
}

export function sanitizeAssetGenerationProvidersForRenderer(providers: AssetGenerationProviderConfig[]): AssetGenerationProviderConfig[] {
  return providers.map(sanitizeAssetGenerationProviderForRenderer);
}
