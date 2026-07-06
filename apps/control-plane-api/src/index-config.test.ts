import { describe, expect, it } from "vitest";
import { authJwksUri } from "./auth-jwks-config";
import type { ControlPlaneApiEnv } from "./env";

function env(input: Partial<ControlPlaneApiEnv>): ControlPlaneApiEnv {
  return input as ControlPlaneApiEnv;
}

describe("Control Plane Auth API JWKS config", () => {
  it("uses the explicit AUTH_JWKS_URI when configured", () => {
    expect(
      authJwksUri(
        env({
          SPLITCH_PLATFORM_TARGET: "shared-preview",
          AUTH_JWKS_URI: "https://auth.preview.splitch.dev/.well-known/jwks.json",
        }),
      ),
    ).toBe("https://auth.preview.splitch.dev/.well-known/jwks.json");
  });

  it("keeps the local fixture fallback only for local targets", () => {
    expect(authJwksUri(env({ SPLITCH_PLATFORM_TARGET: "local" }))).toBe(
      "http://localhost:8791/.well-known/jwks.json",
    );
  });

  it("fails closed when a hosted target omits AUTH_JWKS_URI", () => {
    expect(() => authJwksUri(env({ SPLITCH_PLATFORM_TARGET: "shared-preview" }))).toThrow(
      "AUTH_JWKS_URI is required",
    );
  });
});
