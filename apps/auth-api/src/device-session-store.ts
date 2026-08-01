import type { Repository } from "@splitch/db";

const DEVICE_REFRESH_SESSION_PREFIX = "device-refresh-session:";

export interface DeviceRefreshSession {
  providerSessionId: string;
  userId: string;
  /** Null for personal AuthKit sign-ins, which carry no WorkOS Organization. */
  providerOrganizationId: string | null;
  /**
   * The App the login named, as its canonical ID — or null for a cold-start
   * session bound to nothing yet. Roles are never stored: authority is
   * reintersected with live membership at every mint.
   */
  selectedAppSelector: string | null;
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
        providerSessionId: session.providerSessionId,
        userId: session.userId,
        // The D1 columns are NOT NULL DEFAULT '' (migration 0012); '' is the
        // storage encoding of "unbound", translated only at this seam.
        providerOrganizationId: session.providerOrganizationId ?? "",
        selectedAppScope: session.selectedAppSelector ?? "",
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
        providerOrganizationId: row.providerOrganizationId || null,
        selectedAppSelector: selectorFromStoredScope(row.selectedAppScope),
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

/**
 * Rows written before the cold-start redesign stored a full membership scope
 * (`app:<id>:<role>`); new rows store the bare App ID (or '' for unbound).
 * Either way the App ID is the durable fact — the role is live-resolved.
 */
function selectorFromStoredScope(stored: string): string | null {
  if (!stored) return null;
  const legacy = /^app:([^:]+):(?:owner|admin|member)$/.exec(stored);
  return legacy ? (legacy[1] as string) : stored;
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
