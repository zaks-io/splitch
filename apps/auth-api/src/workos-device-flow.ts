import {
  DEVICE_CODE_GRANT,
  type DeviceAuthorizationResult,
  type DeviceFlowPort,
  type DeviceTokenResult,
  REFRESH_TOKEN_GRANT,
  type WorkOsDeviceFlowOptions,
} from "./device-flow-contract";
import { OAuthError, type OAuthErrorCode } from "./oauth-errors";

interface WorkOsDeviceTokenBody {
  user?: { id?: unknown; email?: unknown; email_verified?: unknown };
  access_token?: unknown;
  refresh_token?: unknown;
  session_id?: unknown;
  organization_id?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const DEFAULT_WORKOS_BASE_URL = "https://api.workos.com/user_management";

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function sessionIdFromAccessToken(accessToken: unknown): string | undefined {
  if (typeof accessToken !== "string") return undefined;
  const parts = accessToken.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as Record<
      string,
      unknown
    >;
    return typeof claims.sid === "string" ? claims.sid : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdFromTokenBody(body: WorkOsDeviceTokenBody): string | undefined {
  if (typeof body.session_id === "string") return body.session_id;
  return sessionIdFromAccessToken(body.access_token);
}

function deviceAuthorizationResult(json: Record<string, unknown>): DeviceAuthorizationResult {
  if (
    typeof json.device_code !== "string" ||
    typeof json.user_code !== "string" ||
    typeof json.verification_uri !== "string" ||
    typeof json.expires_in !== "number"
  ) {
    throw new OAuthError("server_error", "device authorization response missing fields");
  }
  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri,
    verification_uri_complete:
      typeof json.verification_uri_complete === "string"
        ? json.verification_uri_complete
        : undefined,
    expires_in: json.expires_in,
    interval: typeof json.interval === "number" ? json.interval : undefined,
  };
}

function deviceTokenResult(json: WorkOsDeviceTokenBody): DeviceTokenResult {
  if (!json.user || typeof json.user.id !== "string") {
    throw new OAuthError("invalid_grant", "device token response missing user");
  }
  const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : undefined;
  const providerSessionId = refreshToken ? sessionIdFromTokenBody(json) : undefined;
  if (refreshToken && !providerSessionId) {
    throw new OAuthError("server_error", "device token response missing session id");
  }
  const email = deviceUserEmail(json.user);
  return {
    userId: json.user.id,
    ...(email ? { email } : {}),
    // Personal AuthKit sign-ins carry no WorkOS Organization; splitch authority
    // derives from live D1 membership, never from this grant.
    organizationId:
      typeof json.organization_id === "string" && json.organization_id
        ? json.organization_id
        : undefined,
    refreshToken,
    providerSessionId,
  };
}

/**
 * Prefer a verified email; accept an unverified non-empty address only when the
 * provider omitted `email_verified` (fixture paths). Never invent a placeholder.
 */
function deviceUserEmail(user: { id?: unknown; email?: unknown; email_verified?: unknown }): string | undefined {
  if (typeof user.email !== "string" || user.email.length === 0) return undefined;
  if (user.email_verified === false) return undefined;
  return user.email;
}

async function expectJson(
  res: Response,
  fallbackCode: OAuthErrorCode = "invalid_grant",
): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return body;
  throw new OAuthError(
    deviceErrorCode(body.error, fallbackCode),
    typeof body.error_description === "string" ? body.error_description : "device flow failed",
  );
}

function deviceErrorCode(value: unknown, fallbackCode: OAuthErrorCode): OAuthErrorCode {
  switch (value) {
    case "authorization_pending":
    case "slow_down":
    case "expired_token":
    case "access_denied":
    case "invalid_request":
    case "invalid_grant":
      return value;
    default:
      return fallbackCode;
  }
}

export function makeWorkOsDeviceFlow(opts: WorkOsDeviceFlowOptions): DeviceFlowPort {
  const fetcher = opts.fetcher ?? fetch;
  const baseUrl = cleanBaseUrl(opts.baseUrl ?? DEFAULT_WORKOS_BASE_URL);

  async function revokeSession(sessionId: string): Promise<void> {
    if (!opts.apiKey) {
      throw new OAuthError("server_error", "WorkOS API key missing for refresh token revoke");
    }
    await expectJson(
      await fetcher(`${baseUrl}/sessions/revoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ session_id: sessionId }),
      }),
      "server_error",
    );
  }

  function providerClientId(): string {
    if (!opts.clientId) {
      throw new OAuthError("server_error", "WorkOS client id is not configured");
    }
    return opts.clientId;
  }

  return {
    async authorizeDevice(params) {
      const json = await expectJson(
        await fetcher(`${baseUrl}/authorize/device`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: providerClientId(),
            ...(params.scope ? { scope: params.scope } : {}),
          }),
        }),
      );
      return deviceAuthorizationResult(json);
    },

    async exchangeDeviceCode(params) {
      const json = (await expectJson(
        await fetcher(`${baseUrl}/authenticate`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: DEVICE_CODE_GRANT,
            device_code: params.deviceCode,
            client_id: providerClientId(),
          }),
        }),
      )) as WorkOsDeviceTokenBody;
      return deviceTokenResult(json);
    },

    async refreshProviderToken(params) {
      if (!opts.apiKey) {
        throw new OAuthError("server_error", "WorkOS API key missing for refresh token exchange");
      }
      const json = (await expectJson(
        await fetcher(`${baseUrl}/authenticate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: REFRESH_TOKEN_GRANT,
            refresh_token: params.refreshToken,
            client_id: providerClientId(),
            client_secret: opts.apiKey,
            ...(params.organizationId ? { organization_id: params.organizationId } : {}),
          }),
        }),
      )) as WorkOsDeviceTokenBody;
      return deviceTokenResult(json);
    },

    async revokeProviderToken({ sessionId }) {
      await revokeSession(sessionId);
    },
  };
}
