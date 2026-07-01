import type { Repository } from "@splitch/db";

const DEVICE_REFRESH_SESSION_PREFIX = "device-refresh-session:";

export interface DeviceRefreshSessionStore {
  remember(refreshToken: string, providerSessionId: string): Promise<void>;
  lookup(refreshToken: string): Promise<string | null>;
}

interface DeviceRefreshSessionStoreOptions {
  cache?: KVNamespace;
  now: () => number;
}

export function makeD1DeviceRefreshSessionStore(
  repo: Repository,
  opts: DeviceRefreshSessionStoreOptions,
): DeviceRefreshSessionStore {
  return {
    async remember(refreshToken, providerSessionId) {
      const hash = await refreshTokenHash(refreshToken);
      await repo.identity.rememberDeviceRefreshSession({
        refreshTokenHash: hash,
        providerSessionId,
        createdAt: new Date(opts.now()).toISOString(),
      });
      await putCache(opts.cache, cacheKey(hash), providerSessionId);
    },

    async lookup(refreshToken) {
      const hash = await refreshTokenHash(refreshToken);
      const cachedSessionId = await getCache(opts.cache, cacheKey(hash));
      if (cachedSessionId) {
        return cachedSessionId;
      }

      const row = await repo.identity.getDeviceRefreshSession(hash);
      if (!row) {
        return null;
      }

      await putCache(opts.cache, cacheKey(hash), row.providerSessionId);
      return row.providerSessionId;
    },
  };
}

async function getCache(cache: KVNamespace | undefined, key: string): Promise<string | null> {
  try {
    return (await cache?.get(key)) ?? null;
  } catch {
    // KV is a cache only; D1 remains the consistency authority.
    return null;
  }
}

async function putCache(
  cache: KVNamespace | undefined,
  key: string,
  providerSessionId: string,
): Promise<void> {
  try {
    await cache?.put(key, providerSessionId);
  } catch {
    // KV is a cache only; D1 remains the consistency authority.
  }
}

async function refreshTokenHash(refreshToken: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(refreshToken) as unknown as BufferSource,
  );
  return base64Url(new Uint8Array(digest));
}

function cacheKey(hash: string): string {
  return `${DEVICE_REFRESH_SESSION_PREFIX}${hash}`;
}

function base64Url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) {
    raw += String.fromCharCode(byte);
  }
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
