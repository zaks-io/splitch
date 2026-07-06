import type { ControlPlaneApiEnv } from "./env";

export function authJwksUri(env: ControlPlaneApiEnv): string {
  if (env.AUTH_JWKS_URI) {
    return env.AUTH_JWKS_URI;
  }
  if (env.SPLITCH_PLATFORM_TARGET === undefined || env.SPLITCH_PLATFORM_TARGET === "local") {
    return "http://localhost:8791/.well-known/jwks.json";
  }
  throw new Error("control-plane-api: AUTH_JWKS_URI is required outside local targets");
}
