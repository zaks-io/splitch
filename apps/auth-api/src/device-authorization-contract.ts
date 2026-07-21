interface DeviceAuthorizationAppRequest {
  readonly app: string;
}

export function deviceAuthorizationRequestForApp(app: string): DeviceAuthorizationAppRequest {
  if (app.length === 0) {
    throw new Error("auth-api: device authorization requires an App selector");
  }
  return { app };
}
