interface DeviceAuthorizationAppRequest {
  readonly client_id: string;
  readonly app: string;
}

/**
 * The shared-preview smoke's device_authorization request. It authenticates
 * as the first-party CLI client: the OAuth surface rejects unknown client_ids
 * before touching the provider (device-oauth.ts FIRST_PARTY_CLIENT_IDS).
 */
export function deviceAuthorizationRequestForApp(app: string): DeviceAuthorizationAppRequest {
  if (app.length === 0) {
    throw new Error("auth-api: device authorization requires an App selector");
  }
  return { client_id: "splitch-cli", app };
}
