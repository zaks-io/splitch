import type { DeviceFlowPort } from "./device-flow";
import { openDeviceGrant, sealDeviceGrant } from "./device-grant";
import type { DeviceRefreshSession, DeviceRefreshSessionStore } from "./device-session-store";
import {
  type MembershipAuthorityRepo,
  parseSelectedAppRequest,
  resolveAppSelectionForUser,
  resolveOrgSelectionForUser,
} from "./membership-authority";
import { OAuthError, renderOAuthError } from "./oauth-errors";
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
  accessSecret: string;
  now: () => number;
  repo: MembershipAuthorityRepo;
}

interface ResourceBinding {
  scope: string;
  appId: string | null;
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
    return renderDeviceFault(cause);
  }
}

export async function exchangeDeviceCode(
  deps: DeviceOAuthDeps,
  body: unknown,
  nowSeconds: number,
  resolveAudience: (resource: string | undefined) => string,
): Promise<Response> {
  const parsed = DeviceTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
  }
  try {
    requireFirstPartyClient(parsed.data.client_id);
    const audience = resolveAudience(parsed.data.resource);
    const grant = await openDeviceGrant(parsed.data.device_code, deps.accessSecret, deps.now());
    if (parsed.data.scope) {
      const polled = parseSelectedAppRequest(parsed.data.scope);
      if (polled.selector !== grant.selectedAppSelector) {
        throw new OAuthError(
          "invalid_grant",
          "device grant App selection cannot be changed while polling",
        );
      }
    }
    const deviceToken = await deps.deviceFlow.exchangeDeviceCode({
      deviceCode: grant.deviceCode,
    });
    const binding = grant.selectedAppSelector
      ? await resolveAppSelectionForUser(deps.repo, deviceToken.userId, grant.selectedAppSelector)
      : null;
    const session = requireRefreshSession(deviceToken, {
      userId: deviceToken.userId,
      providerOrganizationId: deviceToken.organizationId ?? null,
      selectedAppSelector: binding?.appId ?? null,
    });
    await deps.deviceRefreshSessions.remember(deviceToken.refreshToken as string, session);
    const accessToken = await deps.tokenSigner.mintAccessToken(
      deviceToken.userId,
      binding ? [binding.scope] : [],
      "device_flow",
      nowSeconds,
      audience,
    );
    return tokenResponse(
      accessToken,
      deviceToken.refreshToken as string,
      deviceToken.userId,
      binding?.appId ?? null,
    );
  } catch (cause) {
    return renderDeviceFault(cause);
  }
}

export async function exchangeRefreshToken(
  deps: DeviceOAuthDeps,
  body: unknown,
  nowSeconds: number,
  resolveAudience: (resource: string | undefined) => string,
): Promise<Response> {
  const parsed = RefreshTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
  }
  try {
    requireFirstPartyClient(parsed.data.client_id);
    const stored = await deps.deviceRefreshSessions.lookup(parsed.data.refresh_token);
    if (!stored?.userId || !stored.providerSessionId) {
      throw new OAuthError("invalid_grant", "refresh token authority is unknown");
    }
    // Resolve the binding BEFORE touching the provider: WorkOS refresh tokens
    // are single-use, so an unresolvable app/org selector must fail this one
    // request, not consume the token and strand the whole session.
    const binding = await resolveRefreshBinding(deps.repo, stored, {
      app: parsed.data.app,
      org: parsed.data.org,
    });
    const providerToken = await deps.deviceFlow.refreshProviderToken({
      refreshToken: parsed.data.refresh_token,
      organizationId: stored.providerOrganizationId ?? undefined,
    });
    requireUnchangedProviderAuthority(stored, providerToken);
    const nextSession = requireRefreshSession(providerToken, {
      userId: providerToken.userId,
      // The provider Org pin only ever acquires, never drops: a session that
      // was pinned stays pinned even if a later provider response omits the
      // Organization, so the check above cannot be walked past by attrition.
      providerOrganizationId: stored.providerOrganizationId ?? providerToken.organizationId ?? null,
      // The session's default binding is its identity; a per-mint rebind
      // (`app`/`org` on this request) never rewrites it.
      selectedAppSelector: stored.selectedAppSelector,
    });
    // Sign before rotating: rotation deletes the presented token's hash, so a
    // signer fault after rotation would strand the client on a forgotten
    // token. Signing is local and leaves no durable state on failure.
    const accessToken = await deps.tokenSigner.mintAccessToken(
      providerToken.userId,
      binding ? [binding.scope] : [],
      "device_flow",
      nowSeconds,
      resolveAudience(parsed.data.resource),
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
      binding?.appId ?? null,
    );
  } catch (cause) {
    return renderDeviceFault(cause);
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
  requested: { app?: string; org?: string },
): Promise<ResourceBinding | null> {
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
  appId: string | null,
): Response {
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    user_id: userId,
    ...(appId ? { app_id: appId } : {}),
  });
}

function renderDeviceFault(cause: unknown): Response {
  if (cause instanceof OAuthError) return renderOAuthError(cause);
  return renderOAuthError(new OAuthError("server_error", "auth door fault"));
}
