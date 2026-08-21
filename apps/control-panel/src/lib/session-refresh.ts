import { OauthException } from "@workos-inc/node/worker";
import {
  type AuthKitClient,
  authKitRequestContext,
  createAuthKitClient,
  decodeWorkOsAccessTokenClaims,
} from "./authkit";
import type { ControlPanelBindings } from "./bindings";
import { loadSessionFromCookieHeader, refreshSession, type SessionLoadResult } from "./session";
import { nowSeconds } from "./session-cookie";

const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 30;

// The same set the WorkOS SDK's own CookieSession.authenticate treats as "the
// user must go back through AuthKit". Any other OauthException (invalid_client,
// a 5xx with an OAuth error body) is a panel or provider fault and must surface
// as an error, never as a sign-out (ADR-0036).
const SESSION_ENDED_OAUTH_ERRORS = new Set(["invalid_grant", "mfa_enrollment", "sso_required"]);

export async function loadSessionFromRequest(
  bindings: ControlPanelBindings,
  request: Request,
  now = Date.now(),
  deps?: { authKit?: AuthKitClient },
): Promise<SessionLoadResult> {
  const loaded = await loadSessionFromCookieHeader(
    bindings.SESSION_STORE,
    request.headers.get("cookie"),
    now,
  );
  if (!loaded.ok) {
    return loaded;
  }

  const refreshToken = loaded.session.workosRefreshToken;
  const accessTokenExpiresAt = loaded.session.workosAccessTokenExpiresAt;
  if (refreshToken === undefined || accessTokenExpiresAt === undefined) {
    return loaded;
  }

  if (accessTokenExpiresAt > nowSeconds(now) + ACCESS_TOKEN_REFRESH_SKEW_SECONDS) {
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
    if (!(cause instanceof OauthException) || !SESSION_ENDED_OAUTH_ERRORS.has(cause.error ?? "")) {
      throw cause;
    }
    // The KV record is left for its TTL on purpose. Parallel requests that read
    // the same stale record converge on identical tokens inside WorkOS's 30s
    // replay grace; a replay after that window is refused, and because KV reads
    // can lag a concurrent rotation by up to a minute, this request cannot tell
    // a dead session from a stale replica. Deleting here could destroy the
    // rotated record another request just wrote.
    return { ok: false, reason: "expired" };
  }
}
