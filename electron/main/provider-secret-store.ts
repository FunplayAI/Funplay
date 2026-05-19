import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import electron from 'electron';
import type { AiProvider } from '../../shared/types';

const PROVIDER_SECRETS_FILE_NAME = 'funplay-provider-secrets.json';

const safeStorage = electron.safeStorage;

interface PersistedProviderSecrets {
  encrypted: boolean;
  payload: string;
}

let providerSecretsPath = '';

export function initializeProviderSecretStore(userDataPath: string): void {
  providerSecretsPath = join(userDataPath, PROVIDER_SECRETS_FILE_NAME);
}

async function readSecretMap(): Promise<Record<string, string>> {
  if (!providerSecretsPath) {
    return {};
  }

  try {
    const raw = await readFile(providerSecretsPath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedProviderSecrets;
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
  if (!providerSecretsPath) {
    return;
  }

  const serialized = JSON.stringify(secretMap, null, 2);
  const encrypted = Boolean(safeStorage?.isEncryptionAvailable());
  const payload = encrypted
    ? safeStorage!.encryptString(serialized).toString('base64')
    : serialized;

  const persisted: PersistedProviderSecrets = {
    encrypted,
    payload
  };

  await writeFile(providerSecretsPath, JSON.stringify(persisted, null, 2), 'utf8');
}

export async function migrateProviderSecretsFromProviders(providers: AiProvider[]): Promise<void> {
  const secretMap = await readSecretMap();
  let changed = false;

  for (const provider of providers) {
    const secret = provider.apiKey.trim();
    if (secret && secretMap[provider.id] !== secret) {
      secretMap[provider.id] = secret;
      changed = true;
    }
  }

  if (changed) {
    await writeSecretMap(secretMap);
  }
}

export async function hydrateProvidersWithSecrets(providers: AiProvider[]): Promise<AiProvider[]> {
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

export async function persistProviderSecret(providerId: string, apiKey: string): Promise<void> {
  const secretMap = await readSecretMap();
  if (apiKey.trim()) {
    secretMap[providerId] = apiKey.trim();
  } else {
    delete secretMap[providerId];
  }
  await writeSecretMap(secretMap);
}

export async function deleteProviderSecret(providerId: string): Promise<void> {
  const secretMap = await readSecretMap();
  if (!(providerId in secretMap)) {
    return;
  }
  delete secretMap[providerId];
  await writeSecretMap(secretMap);
}

export function sanitizeProviderForRenderer(provider: AiProvider): AiProvider {
  return {
    ...provider,
    apiKey: '',
    hasStoredApiKey: provider.hasStoredApiKey ?? Boolean(provider.apiKey.trim())
  };
}

export function sanitizeProvidersForRenderer(providers: AiProvider[]): AiProvider[] {
  return providers.map(sanitizeProviderForRenderer);
}
