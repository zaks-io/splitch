import { OauthException } from "@workos-inc/node/worker";
import {
  type AuthKitClient,
  authKitRequestContext,
  createAuthKitClient,
  decodeWorkOsAccessTokenClaims,
} from "./authkit";
import type { ControlPanelBindings } from "./bindings";
import {
  loadSessionFromCookieHeader,
  refreshSession,
  type SessionLoadResult,
  sessionKey,
} from "./session";
import { nowSeconds } from "./session-cookie";

const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 30;

export async function loadSessionFromRequest(
  bindings: ControlPanelBindings,
  request: Request,
  now = Date.now(),
  deps?: { authKit?: AuthKitClient },
): Promise<SessionLoadResult> {
  const cookieHeader = request.headers.get("cookie");
  const loaded = await loadSessionFromCookieHeader(bindings.SESSION_STORE, cookieHeader, now);
  if (!loaded.ok) {
    return loaded;
  }

  const refreshToken = loaded.session.workosRefreshToken;
  const accessTokenExpiresAt = loaded.session.workosAccessTokenExpiresAt;
  if (refreshToken === undefined || accessTokenExpiresAt === undefined) {
    return loaded;
  }

  const currentSeconds = nowSeconds(now);
  if (accessTokenExpiresAt > currentSeconds + ACCESS_TOKEN_REFRESH_SKEW_SECONDS) {
    return loaded;
  }

  const authKit = deps?.authKit ?? createAuthKitClient(bindings);
  try {
    const authentication = await authKit.authenticateWithRefreshToken({
      clientId: bindings.WORKOS_CLIENT_ID,
      refreshToken,
      ...authKitRequestContext(request),
    });
    const claims = decodeWorkOsAccessTokenClaims(authentication.accessToken);
    const refreshed = {
      ...loaded.session,
      workosAccessToken: authentication.accessToken,
      workosRefreshToken: authentication.refreshToken,
      workosAccessTokenExpiresAt: claims.expiresAt,
      workosSessionId: claims.sessionId,
    };
    await refreshSession(bindings.SESSION_STORE, loaded.tokenHash, refreshed, now);
    return { ok: true, session: refreshed, tokenHash: loaded.tokenHash };
  } catch (cause) {
    if (!(cause instanceof OauthException)) {
      throw cause;
    }
    return expireRefusedRefresh(bindings.SESSION_STORE, cookieHeader, loaded, currentSeconds, now);
  }
}

async function expireRefusedRefresh(
  kv: KVNamespace,
  cookieHeader: string | null,
  loaded: Extract<SessionLoadResult, { ok: true }>,
  currentSeconds: number,
  now: number,
): Promise<SessionLoadResult> {
  const concurrent = await loadSessionFromCookieHeader(kv, cookieHeader, now);
  if (
    concurrent.ok &&
    concurrent.session.workosAccessTokenExpiresAt !== undefined &&
    concurrent.session.workosAccessTokenExpiresAt > currentSeconds
  ) {
    return concurrent;
  }

  await kv.delete(sessionKey(loaded.tokenHash));
  return { ok: false, reason: "expired" };
}
