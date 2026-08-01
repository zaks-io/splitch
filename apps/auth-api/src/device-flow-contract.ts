export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const REFRESH_TOKEN_GRANT = "refresh_token";

/**
 * Caller client_ids never cross this port. The splitch-facing OAuth surface
 * validates the caller's `client_id` against FIRST_PARTY_CLIENT_IDS
 * (device-oauth.ts); the provider conversation always authenticates as the
 * one configured WorkOS client. Forwarding a caller value upstream is how
 * production login broke ("Unknown client"), so the port's types make it
 * unrepresentable.
 */
interface DeviceAuthorizationParams {
  scope?: string;
}

export interface DeviceAuthorizationResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface DeviceTokenParams {
  deviceCode: string;
}

interface RefreshTokenParams {
  refreshToken: string;
  organizationId?: string;
}

export interface DeviceTokenResult {
  userId: string;
  /**
   * WorkOS Organization grant when the provider session carries one. Personal
   * AuthKit sign-ins have none; splitch authority always derives from live D1
   * membership keyed by userId, so this is observability-only.
   */
  organizationId?: string;
  refreshToken?: string;
  providerSessionId?: string;
}

interface RevokeProviderTokenParams {
  token: string;
  sessionId: string;
}

export interface DeviceFlowPort {
  authorizeDevice(params: DeviceAuthorizationParams): Promise<DeviceAuthorizationResult>;
  exchangeDeviceCode(params: DeviceTokenParams): Promise<DeviceTokenResult>;
  refreshProviderToken(params: RefreshTokenParams): Promise<DeviceTokenResult>;
  revokeProviderToken(params: RevokeProviderTokenParams): Promise<void>;
}

export interface WorkOsDeviceFlowOptions {
  clientId: string;
  apiKey?: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}
