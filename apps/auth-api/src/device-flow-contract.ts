export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const REFRESH_TOKEN_GRANT = "refresh_token";

interface DeviceAuthorizationParams {
  clientId?: string;
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
  clientId?: string;
  deviceCode: string;
}

interface RefreshTokenParams {
  clientId?: string;
  refreshToken: string;
  organizationId: string;
}

export interface DeviceTokenResult {
  userId: string;
  organizationId: string;
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
