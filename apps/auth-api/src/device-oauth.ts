import type { DeviceFlowPort } from "./device-flow";
import { openDeviceGrant, sealDeviceGrant } from "./device-grant";
import type { DeviceRefreshSessionStore } from "./device-session-store";
import {
  type MembershipAuthorityRepo,
  narrowMembershipAuthority,
  parseSelectedAppScope,
  resolveMembershipAuthority,
} from "./membership-authority";
import { OAuthError, renderOAuthError } from "./oauth-errors";
import { DeviceAuthorizationRequestSchema, DeviceTokenRequestSchema } from "./schemas";
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
    const [selectedAppScope] = parseSelectedAppScope(parsed.data.scope);
    const grant = await deps.deviceFlow.authorizeDevice(parsed.data);
    return Response.json({
      ...grant,
      device_code: await sealDeviceGrant(
        {
          deviceCode: grant.device_code,
          selectedAppScope: selectedAppScope as string,
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
    const [requestedAppScope] = parseSelectedAppScope(parsed.data.scope);
    if (requestedAppScope !== grant.selectedAppScope) {
      throw new OAuthError(
        "invalid_grant",
        "device grant App scope cannot be changed while polling",
      );
    }
    const deviceToken = await deps.deviceFlow.exchangeDeviceCode({
      clientId: parsed.data.client_id,
      deviceCode: grant.deviceCode,
    });
    if (deviceToken.refreshToken) {
      if (!deviceToken.providerSessionId) {
        throw new OAuthError("server_error", "device refresh token missing session id");
      }
      await deps.deviceRefreshSessions.remember(
        deviceToken.refreshToken,
        deviceToken.providerSessionId,
      );
    }
    const authority = await resolveMembershipAuthority(deps.repo, deviceToken.userId);
    const scopes = narrowMembershipAuthority(authority, deviceToken.scopes, [
      grant.selectedAppScope,
    ]);
    if (scopes.length !== 1) {
      throw new OAuthError("invalid_grant", "selected App scope is not authorized by this grant");
    }
    const accessToken = await deps.tokenSigner.mintAccessToken(
      deviceToken.userId,
      scopes,
      "device_flow",
      nowSeconds,
      audience,
    );
    return tokenResponse(accessToken, deviceToken.refreshToken);
  } catch (cause) {
    return renderDeviceFault(cause);
  }
}

function tokenResponse(accessToken: string, refreshToken?: string): Response {
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  });
}

function renderDeviceFault(cause: unknown): Response {
  if (cause instanceof OAuthError) return renderOAuthError(cause);
  return renderOAuthError(new OAuthError("server_error", "auth door fault"));
}
