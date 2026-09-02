import { describe, expect, it } from "vitest";
import { apiDocumentVersion } from "./api-document-version";
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

describe("Control Plane OpenAPI document version", () => {
  const sha = "b1f2639db0b495b1faa22b7a629e1ba731607305";

  it("stamps the deployed commit SHA the Worker was given", () => {
    expect(
      apiDocumentVersion(
        env({ SPLITCH_PLATFORM_TARGET: "production", SPLITCH_DEPLOYED_COMMIT_SHA: sha }),
      ),
    ).toBe(sha);
  });

  it("names the target when there is no deployment to version", () => {
    expect(apiDocumentVersion(env({ SPLITCH_PLATFORM_TARGET: "local" }))).toBe("local");
  });

  it("fails closed when a hosted target omits the commit SHA", () => {
    expect(() => apiDocumentVersion(env({ SPLITCH_PLATFORM_TARGET: "shared-preview" }))).toThrow(
      "SPLITCH_DEPLOYED_COMMIT_SHA is required",
    );
  });
});
