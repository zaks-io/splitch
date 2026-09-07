import type { AccessTokenAuthorization } from "@splitch/contracts";
import { rememberMemberProfile } from "@splitch/contracts";
import { noopPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import {
  type DeviceOAuthDeps,
  type ResolvedAccess,
  type ResourceBinding,
  requireFirstPartyClient,
  requireRefreshSession,
  tokenResponse,
} from "./device-oauth";
import type { DeviceRefreshSession } from "./device-session-store";
import {
  type MembershipAuthorityRepo,
  resolveAppSelectionForUser,
  resolveOrgSelectionForUser,
} from "./membership-authority";
import { OAuthError, renderDoorFault, renderOAuthError } from "./oauth-errors";
import { RefreshTokenRequestSchema } from "./schemas";

export async function exchangeRefreshToken(
  deps: DeviceOAuthDeps,
  body: unknown,
  nowSeconds: number,
  resolveAccess: (
    resource: string | undefined,
    authorization: AccessTokenAuthorization | undefined,
  ) => ResolvedAccess,
): Promise<Response> {
  const parsed = RefreshTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
  }
  const spans = deps.spans ?? noopPerformanceSpanRecorder;
  try {
    requireFirstPartyClient(parsed.data.client_id);
    const stored = await spans.record(
      { name: "OAuth refresh session lookup", op: "auth" },
      async () => deps.deviceRefreshSessions.lookup(parsed.data.refresh_token),
    );
    if (!stored?.userId || !stored.providerSessionId)
      throw new OAuthError("invalid_grant", "refresh token authority is unknown");
    // Resolve the binding BEFORE touching the provider: WorkOS refresh tokens
    // are single-use, so an unresolvable app/org selector must fail this one
    // request, not consume the token and strand the whole session.
    const binding = await spans.record(
      { name: "OAuth refresh scope resolution", op: "auth" },
      async () =>
        resolveRefreshBinding(deps.repo, stored, {
          app: parsed.data.app,
          org: parsed.data.org,
          authorization: parsed.data.authorization,
        }),
    );
    const access = resolveAccess(parsed.data.resource, parsed.data.authorization);
    const providerToken = await spans.record(
      { name: "OAuth provider refresh", op: "auth" },
      async () =>
        deps.deviceFlow.refreshProviderToken({
          refreshToken: parsed.data.refresh_token,
          organizationId: stored.providerOrganizationId ?? undefined,
        }),
    );
    requireUnchangedProviderAuthority(stored, providerToken);
    const nextSession = requireRefreshSession(providerToken, {
      userId: providerToken.userId,
      // The pin is acquire-once: an unpinned session takes whatever Org the
      // provider first reports, and from then on the check above rejects any
      // mint whose provider Org differs, including one that omits it. So this
      // only ever writes back the value that check just proved unchanged.
      providerOrganizationId: stored.providerOrganizationId ?? providerToken.organizationId ?? null,
      // The session's default binding is its identity; a per-mint rebind
      // (`app`/`org` on this request) never rewrites it.
      selectedAppSelector: stored.selectedAppSelector,
    });
    // WorkOS refresh tokens are single-use. If the verified-email gate fails
    // after the provider already rotated, persist that rotation first so the
    // session stays coherent and the CLI can retry with the returned token
    // after the user verifies — never leave the client holding a dead R1.
    const email = await spans.record(
      { name: "OAuth refresh email verification", op: "auth" },
      async () =>
        requireDeviceEmailAfterRefreshRotate(deps, {
          presentedRefreshToken: parsed.data.refresh_token,
          providerToken,
          nextSession,
        }),
    );
    // Refresh is the backfill path for sessions minted before the identity
    // cache existed: every successful mint rewrites member-profile:{userId}.
    await spans.record({ name: "OAuth member profile persistence", op: "cache.put" }, async () =>
      rememberMemberProfile(deps.sessionStore, providerToken.userId, email),
    );
    // Sign before rotating on the happy path: rotation deletes the presented
    // token's hash, so a signer fault after rotation would strand the client
    // on a forgotten token. Signing is local and leaves no durable state on
    // failure. (The unverified-email path above already rotated.)
    const accessToken = await spans.record(
      { name: "OAuth access token signing", op: "auth" },
      async () =>
        deps.tokenSigner.mintAccessToken(
          providerToken.userId,
          access.authorization ? [] : binding ? [binding.scope] : [],
          "device_flow",
          nowSeconds,
          access.audience,
          access.authorization,
        ),
    );
    await spans.record({ name: "OAuth refresh session rotation", op: "auth" }, async () =>
      deps.deviceRefreshSessions.rotate(
        parsed.data.refresh_token,
        providerToken.refreshToken as string,
        nextSession,
      ),
    );
    return tokenResponse(
      accessToken,
      providerToken.refreshToken as string,
      providerToken.userId,
      email,
      binding?.appId ?? null,
    );
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

function requireUnchangedProviderAuthority(
  stored: DeviceRefreshSession,
  providerToken: { userId: string; organizationId?: string },
): void {
  if (
    providerToken.userId !== stored.userId ||
    (stored.providerOrganizationId &&
      providerToken.organizationId !== stored.providerOrganizationId)
  ) {
    throw new OAuthError("invalid_grant", "provider refresh authority changed");
  }
}

/**
 * Which resource should this mint bind? An explicit `app`/`org` on the
 * request wins (the CLI rescoping for one command); wide read authority
 * temporarily suppresses the session default; otherwise the session's
 * login-time App if it has one; otherwise unbound. Every selector path
 * resolves against live membership at mint time — removed membership fails
 * loud here.
 */
async function resolveRefreshBinding(
  repo: MembershipAuthorityRepo,
  stored: DeviceRefreshSession,
  requested: {
    app?: string;
    org?: string;
    authorization?: AccessTokenAuthorization;
  },
): Promise<ResourceBinding | null> {
  if (requested.authorization) {
    return null;
  }
  if (requested.app) {
    const selected = await resolveAppSelectionForUser(repo, stored.userId, requested.app);
    return { scope: selected.scope, appId: selected.appId };
  }
  if (requested.org) {
    const selected = await resolveOrgSelectionForUser(repo, stored.userId, requested.org);
    return { scope: selected.scope, appId: null };
  }
  if (stored.selectedAppSelector) {
    const selected = await resolveAppSelectionForUser(
      repo,
      stored.userId,
      stored.selectedAppSelector,
    );
    return { scope: selected.scope, appId: selected.appId };
  }
  return null;
}

/**
 * On refresh, the provider has already consumed the presented token. When the
 * verified-email gate fails, rotate first and attach the new refresh_token to
 * the 403 so the CLI can store it and retry after verification — without this,
 * verify-then-retry collapses to invalid_grant / forced re-login.
 */
async function requireDeviceEmailAfterRefreshRotate(
  deps: DeviceOAuthDeps,
  input: {
    presentedRefreshToken: string;
    providerToken: {
      userId: string;
      email?: string;
      refreshToken?: string;
      providerSessionId?: string;
    };
    nextSession: DeviceRefreshSession;
  },
): Promise<string> {
  if (input.providerToken.email) {
    return input.providerToken.email;
  }
  const nextRefresh = input.providerToken.refreshToken;
  if (!nextRefresh) {
    throw new OAuthError("server_error", "device token response missing refresh session");
  }
  await deps.deviceRefreshSessions.rotate(
    input.presentedRefreshToken,
    nextRefresh,
    input.nextSession,
  );
  throw new OAuthError(
    "email_unverified",
    "authenticated user has no verified email; verify the email address with the identity provider before retrying login",
    { refresh_token: nextRefresh },
  );
}
