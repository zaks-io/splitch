import type { AccessTokenAuthorization } from "@splitch/contracts";
import { rememberMemberProfile } from "@splitch/contracts";
import type { DeviceFlowPort } from "./device-flow";
import { openDeviceGrant, sealDeviceGrant } from "./device-grant";
import type { DeviceRefreshSession, DeviceRefreshSessionStore } from "./device-session-store";
import {
  type MembershipAuthorityRepo,
  parseSelectedAppRequest,
  resolveAppSelectionForUser,
  resolveOrgSelectionForUser,
} from "./membership-authority";
import { OAuthError, renderDoorFault, renderOAuthError } from "./oauth-errors";
import {
  DeviceAuthorizationRequestSchema,
  DeviceTokenRequestSchema,
  RefreshTokenRequestSchema,
} from "./schemas";
import type { TokenSigner } from "./token-exchange";

/**
 * The first-party public clients allowed through the splitch OAuth device
 * surface. The caller's `client_id` is validated here and goes no further:
 * every provider call authenticates as the configured WorkOS client
 * (device-flow-contract.ts). An unknown id fails loud as `invalid_client`
 * with the id named, never as an opaque provider 400.
 */
const FIRST_PARTY_CLIENT_IDS: ReadonlySet<string> = new Set(["splitch-cli"]);

export interface DeviceOAuthDeps {
  tokenSigner: TokenSigner;
  deviceFlow: DeviceFlowPort;
  deviceRefreshSessions: DeviceRefreshSessionStore;
  /** Shared SESSION_STORE — writes member-profile:{userId} at login/refresh. */
  sessionStore: KVNamespace;
  accessSecret: string;
  now: () => number;
  repo: MembershipAuthorityRepo;
}

interface ResourceBinding {
  scope: string;
  appId: string | null;
}

interface ResolvedAccess {
  audience: string;
  authorization?: AccessTokenAuthorization;
}

export function requireFirstPartyClient(clientId: string | undefined): void {
  if (!clientId || !FIRST_PARTY_CLIENT_IDS.has(clientId)) {
    throw new OAuthError(
      "invalid_client",
      `unknown client_id "${clientId ?? ""}"; expected a first-party splitch client such as "splitch-cli"`,
    );
  }
}

export async function authorizeDevice(deps: DeviceOAuthDeps, body: unknown): Promise<Response> {
  const parsed = DeviceAuthorizationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(
      new OAuthError("invalid_request", "malformed /oauth2/device_authorization body"),
    );
  }
  try {
    requireFirstPartyClient(parsed.data.client_id);
    // An App selector at login remains supported, but a cold-start login has
    // no App to name — the grant then mints an unbound session (quickstart
    // step 1: authenticate first, create the Org and App after).
    const selector =
      parsed.data.app ??
      (parsed.data.scope ? parseSelectedAppRequest(parsed.data.scope).selector : null);
    const grant = await deps.deviceFlow.authorizeDevice({});
    return Response.json({
      ...grant,
      device_code: await sealDeviceGrant(
        {
          deviceCode: grant.device_code,
          selectedAppSelector: selector,
          expiresAt: deps.now() + grant.expires_in * 1000,
        },
        deps.accessSecret,
      ),
    });
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

export async function exchangeDeviceCode(
  deps: DeviceOAuthDeps,
  body: unknown,
  nowSeconds: number,
  resolveAccess: (
    resource: string | undefined,
    authorization: AccessTokenAuthorization | undefined,
  ) => ResolvedAccess,
): Promise<Response> {
  const parsed = DeviceTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
  }
  try {
    requireFirstPartyClient(parsed.data.client_id);
    const access = resolveAccess(parsed.data.resource, parsed.data.authorization);
    const grant = await openDeviceGrant(parsed.data.device_code, deps.accessSecret, deps.now());
    assertUnchangedDeviceSelection(parsed.data.scope, grant.selectedAppSelector);
    assertCompatibleDeviceAuthorization(access.authorization, grant.selectedAppSelector);
    const deviceToken = await deps.deviceFlow.exchangeDeviceCode({
      deviceCode: grant.deviceCode,
    });
    const email = requireDeviceEmail(deviceToken);
    await rememberMemberProfile(deps.sessionStore, deviceToken.userId, email);
    const binding = await resolveDeviceBinding(
      deps.repo,
      deviceToken.userId,
      grant.selectedAppSelector,
    );
    const session = requireRefreshSession(deviceToken, {
      userId: deviceToken.userId,
      providerOrganizationId: deviceToken.organizationId ?? null,
      selectedAppSelector: binding?.appId ?? null,
    });
    await deps.deviceRefreshSessions.remember(deviceToken.refreshToken as string, session);
    const accessToken = await deps.tokenSigner.mintAccessToken(
      deviceToken.userId,
      access.authorization ? [] : binding ? [binding.scope] : [],
      "device_flow",
      nowSeconds,
      access.audience,
      access.authorization,
    );
    return tokenResponse(
      accessToken,
      deviceToken.refreshToken as string,
      deviceToken.userId,
      email,
      binding?.appId ?? null,
    );
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

function assertUnchangedDeviceSelection(
  requestedScope: string | undefined,
  grantedSelector: string | null,
): void {
  if (!requestedScope) return;
  if (parseSelectedAppRequest(requestedScope).selector !== grantedSelector) {
    throw new OAuthError(
      "invalid_grant",
      "device grant App selection cannot be changed while polling",
    );
  }
}

function assertCompatibleDeviceAuthorization(
  authorization: AccessTokenAuthorization | undefined,
  selector: string | null,
): void {
  if (authorization && selector) {
    throw new OAuthError(
      "invalid_request",
      "membership-wide read authorization cannot be combined with an App selection",
    );
  }
}

async function resolveDeviceBinding(
  repo: MembershipAuthorityRepo,
  userId: string,
  selector: string | null,
): Promise<ResourceBinding | null> {
  return selector ? resolveAppSelectionForUser(repo, userId, selector) : null;
}

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
  try {
    requireFirstPartyClient(parsed.data.client_id);
    const stored = await deps.deviceRefreshSessions.lookup(parsed.data.refresh_token);
    if (!stored?.userId || !stored.providerSessionId)
      throw new OAuthError("invalid_grant", "refresh token authority is unknown");
    assertCompatibleDeviceAuthorization(parsed.data.authorization, stored.selectedAppSelector);
    // Resolve the binding BEFORE touching the provider: WorkOS refresh tokens
    // are single-use, so an unresolvable app/org selector must fail this one
    // request, not consume the token and strand the whole session.
    const binding = await resolveRefreshBinding(deps.repo, stored, {
      app: parsed.data.app,
      org: parsed.data.org,
      authorization: parsed.data.authorization,
    });
    const access = resolveAccess(parsed.data.resource, parsed.data.authorization);
    const providerToken = await deps.deviceFlow.refreshProviderToken({
      refreshToken: parsed.data.refresh_token,
      organizationId: stored.providerOrganizationId ?? undefined,
    });
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
    const email = await requireDeviceEmailAfterRefreshRotate(deps, {
      presentedRefreshToken: parsed.data.refresh_token,
      providerToken,
      nextSession,
    });
    // Refresh is the backfill path for sessions minted before the identity
    // cache existed: every successful mint rewrites member-profile:{userId}.
    await rememberMemberProfile(deps.sessionStore, providerToken.userId, email);
    // Sign before rotating on the happy path: rotation deletes the presented
    // token's hash, so a signer fault after rotation would strand the client
    // on a forgotten token. Signing is local and leaves no durable state on
    // failure. (The unverified-email path above already rotated.)
    const accessToken = await deps.tokenSigner.mintAccessToken(
      providerToken.userId,
      access.authorization ? [] : binding ? [binding.scope] : [],
      "device_flow",
      nowSeconds,
      access.audience,
      access.authorization,
    );
    await deps.deviceRefreshSessions.rotate(
      parsed.data.refresh_token,
      providerToken.refreshToken as string,
      nextSession,
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
 * request wins (the CLI rescoping for one command); otherwise the session's
 * login-time App if it has one; otherwise unbound. Every path resolves
 * against live membership at mint time — removed membership fails loud here.
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

function requireDeviceEmail(token: { userId: string; email?: string }): string {
  if (!token.email) {
    throw new OAuthError(
      "email_unverified",
      "authenticated user has no verified email; verify the email address with the identity provider before retrying login",
    );
  }
  return token.email;
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

function requireRefreshSession(
  token: { refreshToken?: string; providerSessionId?: string },
  authority: Omit<DeviceRefreshSession, "providerSessionId">,
): DeviceRefreshSession {
  if (!token.refreshToken || !token.providerSessionId) {
    throw new OAuthError("server_error", "device token response missing refresh session");
  }
  return { ...authority, providerSessionId: token.providerSessionId };
}

function tokenResponse(
  accessToken: string,
  refreshToken: string,
  userId: string,
  email: string,
  appId: string | null,
): Response {
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    user_id: userId,
    email,
    ...(appId ? { app_id: appId } : {}),
  });
}
