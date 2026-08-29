const APP_IDENTITY_RESET_FENCE_KEY = "privacy:app-reset-identity-versions";

interface IdentityResetFenceStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export function requireDestroyedIdentityVersions(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((version) => typeof version !== "string" || version.length === 0)
  ) {
    throw new TypeError("App identity reset requires destroyed identity versions");
  }
  return [...new Set(value)];
}

export async function extendAppIdentityResetFence(
  storage: IdentityResetFenceStorage,
  destroyedVersions: readonly string[],
): Promise<readonly string[]> {
  const required = requireDestroyedIdentityVersions(destroyedVersions);
  const existing = await readAppIdentityResetFence(storage);
  const next = [...new Set([...existing, ...required])].sort();
  await storage.put(APP_IDENTITY_RESET_FENCE_KEY, next);
  return next;
}

export async function isAppIdentityVersionReset(
  storage: IdentityResetFenceStorage,
  identityVersion: string,
): Promise<boolean> {
  return (await readAppIdentityResetFence(storage)).includes(identityVersion);
}

export async function readAppIdentityResetFence(
  storage: IdentityResetFenceStorage,
): Promise<readonly string[]> {
  const stored = await storage.get<unknown>(APP_IDENTITY_RESET_FENCE_KEY);
  if (stored === undefined) return [];
  return requireDestroyedIdentityVersions(stored);
}
