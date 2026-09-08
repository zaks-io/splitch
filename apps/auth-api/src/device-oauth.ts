import type { AccessTokenAuthorization } from "@splitch/contracts";
import { rememberMemberProfile } from "@splitch/contracts";
import type { PerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import type { DeviceFlowPort } from "./device-flow";
import { openDeviceGrant, sealDeviceGrant } from "./device-grant";
import type { DeviceRefreshSession, DeviceRefreshSessionStore } from "./device-session-store";
import {
  type MembershipAuthorityRepo,
  parseSelectedAppRequest,
  resolveAppSelectionForUser,
} from "./membership-authority";
import { OAuthError, renderDoorFault, renderOAuthError } from "./oauth-errors";
import type { RateLimiter } from "./rate-limit";
import { DeviceAuthorizationRequestSchema, DeviceTokenRequestSchema } from "./schemas";
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
  spans?: PerformanceSpanRecorder;
  tokenSigner: TokenSigner;
  deviceFlow: DeviceFlowPort;
  deviceRefreshSessions: DeviceRefreshSessionStore;
  /** Shared SESSION_STORE — writes member-profile:{userId} at login/refresh. */
  sessionStore: KVNamespace;
  accessSecret: string;
  now: () => number;
  repo: MembershipAuthorityRepo;
  deviceAuthorizationRateLimiter: RateLimiter;
}

export interface ResourceBinding {
  scope: string;
  appId: string | null;
}

export interface ResolvedAccess {
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

export async function authorizeDevice(
  deps: DeviceOAuthDeps,
  body: unknown,
  remoteIp: string,
): Promise<Response> {
  const parsed = DeviceAuthorizationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(
      new OAuthError("invalid_request", "malformed /oauth2/device_authorization body"),
    );
  }
  try {
    requireFirstPartyClient(parsed.data.client_id);
    await deps.deviceAuthorizationRateLimiter.assertUnderCeiling(remoteIp, deps.now());
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

function requireDeviceEmail(token: { userId: string; email?: string }): string {
  if (!token.email) {
    throw new OAuthError(
      "email_unverified",
      "authenticated user has no verified email; verify the email address with the identity provider before retrying login",
    );
  }
  return token.email;
}

export function requireRefreshSession(
  token: { refreshToken?: string; providerSessionId?: string },
  authority: Omit<DeviceRefreshSession, "providerSessionId">,
): DeviceRefreshSession {
  if (!token.refreshToken || !token.providerSessionId) {
    throw new OAuthError("server_error", "device token response missing refresh session");
  }
  return { ...authority, providerSessionId: token.providerSessionId };
}

export function tokenResponse(
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
