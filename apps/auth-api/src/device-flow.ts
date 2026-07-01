import { OAuthError, type OAuthErrorCode } from "./oauth-errors.js";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

interface DeviceAuthorizationParams {
  clientId?: string;
  scope?: string;
}

interface DeviceAuthorizationResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface DeviceTokenParams {
  clientId?: string;
  deviceCode: string;
  scope?: string;
}

interface DeviceTokenResult {
  userId: string;
  refreshToken?: string;
  scopes: string[];
}

export interface DeviceFlowPort {
  authorizeDevice(params: DeviceAuthorizationParams): Promise<DeviceAuthorizationResult>;
  exchangeDeviceCode(params: DeviceTokenParams): Promise<DeviceTokenResult>;
  revokeProviderToken(token: string): Promise<void>;
}

interface WorkOsDeviceFlowOptions {
  clientId: string;
  apiKey?: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

interface WorkOsDeviceTokenBody {
  user?: { id?: unknown };
  access_token?: unknown;
  refresh_token?: unknown;
  session_id?: unknown;
  scope?: unknown;
  scopes?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const DEFAULT_WORKOS_BASE_URL = "https://api.workos.com/user_management";

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function splitScopes(scope: string | undefined): string[] {
  return scope?.trim() ? scope.trim().split(/\s+/) : [];
}

function scopeList(body: WorkOsDeviceTokenBody, fallback: string | undefined): string[] {
  if (typeof body.scope === "string") {
    return splitScopes(body.scope);
  }
  if (Array.isArray(body.scopes)) {
    return body.scopes.filter((scope): scope is string => typeof scope === "string");
  }
  return splitScopes(fallback);
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
  if (typeof accessToken !== "string") {
    return undefined;
  }
  const parts = accessToken.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    return undefined;
  }
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
  if (typeof body.session_id === "string") {
    return body.session_id;
  }
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

async function expectJson(
  res: Response,
  fallbackCode: OAuthErrorCode = "invalid_grant",
): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    return body;
  }
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

  async function authenticateWithRefreshToken(
    refreshToken: string,
  ): Promise<WorkOsDeviceTokenBody> {
    if (!opts.apiKey) {
      throw new OAuthError("server_error", "WorkOS API key missing for refresh token revoke");
    }
    return (await expectJson(
      await fetcher(`${baseUrl}/authenticate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: opts.clientId,
          client_secret: opts.apiKey,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      }),
    )) as WorkOsDeviceTokenBody;
  }

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

  return {
    async authorizeDevice(params) {
      const clientId = params.clientId ?? opts.clientId;
      const body = new URLSearchParams({ client_id: clientId });
      if (params.scope) {
        body.set("scope", params.scope);
      }
      const json = await expectJson(
        await fetcher(`${baseUrl}/authorize/device`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      );
      return deviceAuthorizationResult(json);
    },

    async exchangeDeviceCode(params) {
      const clientId = params.clientId ?? opts.clientId;
      const json = (await expectJson(
        await fetcher(`${baseUrl}/authenticate`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: DEVICE_CODE_GRANT,
            device_code: params.deviceCode,
            client_id: clientId,
          }),
        }),
      )) as WorkOsDeviceTokenBody;

      if (!json.user || typeof json.user.id !== "string") {
        throw new OAuthError("invalid_grant", "device token response missing user");
      }
      return {
        userId: json.user.id,
        refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
        scopes: scopeList(json, params.scope),
      };
    },

    async revokeProviderToken(token) {
      const json = await authenticateWithRefreshToken(token);
      const sessionId = sessionIdFromTokenBody(json);
      if (!sessionId) {
        throw new OAuthError("server_error", "refresh token response missing session id");
      }
      await revokeSession(sessionId);
    },
  };
}

export function makeFixtureDeviceFlow(): DeviceFlowPort {
  const approvedDeviceCode = "fixture-approved-device-code";
  const refreshToken = "fixture-refresh-token";
  const revokedRefreshTokens = new Set<string>();

  return {
    async authorizeDevice() {
      return {
        device_code: approvedDeviceCode,
        user_code: "SPLT-CH25",
        verification_uri: "https://auth.splitch.test/device",
        verification_uri_complete: "https://auth.splitch.test/device?user_code=SPLT-CH25",
        expires_in: 300,
        interval: 5,
      };
    },

    async exchangeDeviceCode(params) {
      if (params.deviceCode !== approvedDeviceCode || revokedRefreshTokens.has(refreshToken)) {
        throw new OAuthError("authorization_pending", "device grant is not approved");
      }
      return {
        userId: "user_device_fixture",
        refreshToken,
        scopes: splitScopes(params.scope),
      };
    },

    async revokeProviderToken(token) {
      revokedRefreshTokens.add(token);
    },
  };
}
