import type { Repository } from "@splitch/db";

const DEVICE_REFRESH_SESSION_PREFIX = "device-refresh-session:";

export interface DeviceRefreshSession {
  providerSessionId: string;
  userId: string;
  providerOrganizationId: string;
  selectedAppScope: string;
}

export interface DeviceRefreshSessionStore {
  remember(refreshToken: string, session: DeviceRefreshSession): Promise<void>;
  lookup(refreshToken: string): Promise<DeviceRefreshSession | null>;
  rotate(
    previousRefreshToken: string,
    nextRefreshToken: string,
    session: DeviceRefreshSession,
  ): Promise<void>;
  forget(refreshToken: string): Promise<void>;
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
    async remember(refreshToken, session) {
      const hash = await refreshTokenHash(refreshToken);
      await repo.identity.rememberDeviceRefreshSession({
        refreshTokenHash: hash,
        ...session,
        createdAt: new Date(opts.now()).toISOString(),
      });
      await putCache(opts.cache, cacheKey(hash), session);
    },

    async lookup(refreshToken) {
      const hash = await refreshTokenHash(refreshToken);
      const row = await repo.identity.getDeviceRefreshSession(hash);
      if (!row) {
        return null;
      }
      const session = {
        providerSessionId: row.providerSessionId,
        userId: row.userId,
        providerOrganizationId: row.providerOrganizationId,
        selectedAppScope: row.selectedAppScope,
      };
      await putCache(opts.cache, cacheKey(hash), session);
      return session;
    },

    async rotate(previousRefreshToken, nextRefreshToken, session) {
      await this.remember(nextRefreshToken, session);
      if (previousRefreshToken !== nextRefreshToken) {
        await this.forget(previousRefreshToken);
      }
    },

    async forget(refreshToken) {
      const hash = await refreshTokenHash(refreshToken);
      await repo.identity.deleteDeviceRefreshSession(hash);
      await deleteCache(opts.cache, cacheKey(hash));
    },
  };
}

async function deleteCache(cache: KVNamespace | undefined, key: string): Promise<void> {
  try {
    await cache?.delete(key);
  } catch {
    // KV is a cache only; D1 remains the consistency authority.
  }
}

async function putCache(
  cache: KVNamespace | undefined,
  key: string,
  session: DeviceRefreshSession,
): Promise<void> {
  try {
    await cache?.put(key, JSON.stringify(session));
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
