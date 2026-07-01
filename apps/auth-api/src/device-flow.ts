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
  revokeProviderToken?(token: string): Promise<void>;
}

interface WorkOsDeviceFlowOptions {
  clientId: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

interface WorkOsDeviceTokenBody {
  user?: { id?: unknown };
  refresh_token?: unknown;
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

async function expectJson(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    return body;
  }
  throw new OAuthError(
    deviceErrorCode(body.error),
    typeof body.error_description === "string" ? body.error_description : "device flow failed",
  );
}

function deviceErrorCode(value: unknown): OAuthErrorCode {
  switch (value) {
    case "authorization_pending":
    case "slow_down":
    case "expired_token":
    case "access_denied":
    case "invalid_request":
    case "invalid_grant":
      return value;
    default:
      return "invalid_grant";
  }
}

export function makeWorkOsDeviceFlow(opts: WorkOsDeviceFlowOptions): DeviceFlowPort {
  const fetcher = opts.fetcher ?? fetch;
  const baseUrl = cleanBaseUrl(opts.baseUrl ?? DEFAULT_WORKOS_BASE_URL);

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
