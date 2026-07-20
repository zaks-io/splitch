import type { DeviceFlowPort } from "./device-flow";
import { openDeviceGrant, sealDeviceGrant } from "./device-grant";
import type { DeviceRefreshSession, DeviceRefreshSessionStore } from "./device-session-store";
import {
  type MembershipAuthorityRepo,
  parseSelectedAppRequest,
  resolveSelectedAppAuthority,
} from "./membership-authority";
import { OAuthError, renderOAuthError } from "./oauth-errors";
import {
  DeviceAuthorizationRequestSchema,
  DeviceTokenRequestSchema,
  RefreshTokenRequestSchema,
} from "./schemas";
import type { TokenSigner } from "./token-exchange";

export interface DeviceOAuthDeps {
  tokenSigner: TokenSigner;
  deviceFlow: DeviceFlowPort;
  deviceRefreshSessions: DeviceRefreshSessionStore;
  accessSecret: string;
  now: () => number;
  repo: MembershipAuthorityRepo;
}

export async function authorizeDevice(deps: DeviceOAuthDeps, body: unknown): Promise<Response> {
  const parsed = DeviceAuthorizationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(
      new OAuthError("invalid_request", "malformed /oauth2/device_authorization body"),
    );
  }
  try {
    const requested = parsed.data.app
      ? { selector: parsed.data.app, role: "owner" as const }
      : parseSelectedAppRequest(parsed.data.scope);
    const grant = await deps.deviceFlow.authorizeDevice({ clientId: parsed.data.client_id });
    return Response.json({
      ...grant,
      device_code: await sealDeviceGrant(
        {
          deviceCode: grant.device_code,
          selectedAppSelector: requested.selector,
          requestedRole: requested.role,
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
    const audience = resolveAudience(parsed.data.resource);
    const grant = await openDeviceGrant(parsed.data.device_code, deps.accessSecret, deps.now());
    if (parsed.data.scope) {
      const polled = parseSelectedAppRequest(parsed.data.scope);
      if (polled.selector !== grant.selectedAppSelector || polled.role !== grant.requestedRole) {
        throw new OAuthError(
          "invalid_grant",
          "device grant App selection cannot be changed while polling",
        );
      }
    }
    const deviceToken = await deps.deviceFlow.exchangeDeviceCode({
      clientId: parsed.data.client_id,
      deviceCode: grant.deviceCode,
    });
    const selected = await resolveSelectedAppAuthority(
      deps.repo,
      deviceToken.userId,
      deviceToken.organizationId,
      grant.selectedAppSelector,
      grant.requestedRole,
    );
    const session = requireRefreshSession(deviceToken, {
      userId: deviceToken.userId,
      providerOrganizationId: deviceToken.organizationId,
      selectedAppScope: selected.scope,
    });
    await deps.deviceRefreshSessions.remember(deviceToken.refreshToken as string, session);
    const accessToken = await deps.tokenSigner.mintAccessToken(
      deviceToken.userId,
      [selected.scope],
      "device_flow",
      nowSeconds,
      audience,
    );
    return tokenResponse(
      accessToken,
      deviceToken.refreshToken as string,
      deviceToken.userId,
      selected.appId,
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
    const stored = await deps.deviceRefreshSessions.lookup(parsed.data.refresh_token);
    if (
      !stored?.userId ||
      !stored.providerOrganizationId ||
      !stored.selectedAppScope ||
      !stored.providerSessionId
    ) {
      throw new OAuthError("invalid_grant", "refresh token authority is unknown");
    }
    const requested = parseSelectedAppRequest(stored.selectedAppScope);
    const providerToken = await deps.deviceFlow.refreshProviderToken({
      clientId: parsed.data.client_id,
      refreshToken: parsed.data.refresh_token,
      organizationId: stored.providerOrganizationId,
    });
    if (
      providerToken.userId !== stored.userId ||
      providerToken.organizationId !== stored.providerOrganizationId
    ) {
      throw new OAuthError("invalid_grant", "provider refresh authority changed");
    }
    const selected = await resolveSelectedAppAuthority(
      deps.repo,
      providerToken.userId,
      providerToken.organizationId,
      requested.selector,
      requested.role,
    );
    const nextSession = requireRefreshSession(providerToken, {
      userId: providerToken.userId,
      providerOrganizationId: providerToken.organizationId,
      selectedAppScope: selected.scope,
    });
    await deps.deviceRefreshSessions.rotate(
      parsed.data.refresh_token,
      providerToken.refreshToken as string,
      nextSession,
    );
    const accessToken = await deps.tokenSigner.mintAccessToken(
      providerToken.userId,
      [selected.scope],
      "device_flow",
      nowSeconds,
      resolveAudience(parsed.data.resource),
    );
    return tokenResponse(
      accessToken,
      providerToken.refreshToken as string,
      providerToken.userId,
      selected.appId,
    );
  } catch (cause) {
    return renderDeviceFault(cause);
  }
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
  appId: string,
): Response {
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    user_id: userId,
    app_id: appId,
  });
}

function renderDeviceFault(cause: unknown): Response {
  if (cause instanceof OAuthError) return renderOAuthError(cause);
  return renderOAuthError(new OAuthError("server_error", "auth door fault"));
}
