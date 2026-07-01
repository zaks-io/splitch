const DEVICE_REFRESH_SESSION_PREFIX = "device-refresh-session:";

export interface DeviceRefreshSessionStore {
  remember(refreshToken: string, sessionId: string): Promise<void>;
  lookup(refreshToken: string): Promise<string | null>;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function refreshTokenKey(refreshToken: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(refreshToken) as unknown as BufferSource,
  );
  return `${DEVICE_REFRESH_SESSION_PREFIX}${bytesToBase64Url(new Uint8Array(digest))}`;
}

export function makeKvDeviceRefreshSessionStore(kv: KVNamespace): DeviceRefreshSessionStore {
  return {
    async remember(refreshToken, sessionId) {
      await kv.put(await refreshTokenKey(refreshToken), sessionId);
    },

    async lookup(refreshToken) {
      return kv.get(await refreshTokenKey(refreshToken));
    },
  };
}
