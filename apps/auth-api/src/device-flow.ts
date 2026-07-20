import {
  DEVICE_CODE_GRANT as DEVICE_CODE_GRANT_VALUE,
  type DeviceFlowPort as DeviceFlowPortContract,
  REFRESH_TOKEN_GRANT as REFRESH_TOKEN_GRANT_VALUE,
  type WorkOsDeviceFlowOptions as WorkOsDeviceFlowOptionsContract,
} from "./device-flow-contract";
import { OAuthError } from "./oauth-errors";
import { makeWorkOsDeviceFlow as makeWorkOsDeviceFlowAdapter } from "./workos-device-flow";

export const DEVICE_CODE_GRANT = DEVICE_CODE_GRANT_VALUE;
export const REFRESH_TOKEN_GRANT = REFRESH_TOKEN_GRANT_VALUE;
export type DeviceFlowPort = DeviceFlowPortContract;
export type WorkOsDeviceFlowOptions = WorkOsDeviceFlowOptionsContract;

export function makeWorkOsDeviceFlow(opts: WorkOsDeviceFlowOptions): DeviceFlowPort {
  return makeWorkOsDeviceFlowAdapter(opts);
}

export function makeFixtureDeviceFlow(): DeviceFlowPort {
  const approvedDeviceCode = "fixture-approved-device-code";
  let refreshToken = "fixture-refresh-token";
  let refreshSequence = 0;
  const providerSessionId = "fixture-device-session";
  const revokedProviderSessions = new Set<string>();

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

    async exchangeDeviceCode({ deviceCode }) {
      if (deviceCode !== approvedDeviceCode || revokedProviderSessions.has(providerSessionId)) {
        throw new OAuthError("authorization_pending", "device grant is not approved");
      }
      return {
        userId: "user_device_fixture",
        organizationId: "org_device",
        refreshToken,
        providerSessionId,
      };
    },

    async refreshProviderToken({ refreshToken: presented, organizationId }) {
      if (
        presented !== refreshToken ||
        organizationId !== "org_device" ||
        revokedProviderSessions.has(providerSessionId)
      ) {
        throw new OAuthError("invalid_grant", "refresh token is invalid or expired");
      }
      refreshSequence += 1;
      refreshToken = `fixture-refresh-token-${refreshSequence}`;
      return {
        userId: "user_device_fixture",
        organizationId: "org_device",
        refreshToken,
        providerSessionId,
      };
    },

    async revokeProviderToken({ sessionId }) {
      revokedProviderSessions.add(sessionId);
    },
  };
}
