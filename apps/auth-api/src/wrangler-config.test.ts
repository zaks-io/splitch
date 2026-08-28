import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();

describe("Auth Worker Wrangler runtime config", () => {
  it("restricts global fetch to public Internet destinations", () => {
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
  });

  it.each([
    ["shared-preview", config.env?.["shared-preview"], "0x4AAAAAADsCXVP9TRrC6c6N"],
    ["production", config.env?.production, "0x4AAAAAADsCY8JNBv2vrTFC"],
  ])("declares the public Turnstile site key for %s", (_target, target, siteKey) => {
    expect(target?.vars?.TURNSTILE_SITE_KEY).toBe(siteKey);
  });

  it.each([
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares the Turnstile secret as a required hosted secret for %s", (_target, target) => {
    expect(target?.secrets?.required).toContain("TURNSTILE_SECRET");
    expect(target?.vars?.TURNSTILE_SECRET).toBeUndefined();
  });

  it.each([
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares real WorkOS device-flow bindings for %s", (_target, target) => {
    expect(target?.secrets?.required).toContain("WORKOS_CLIENT_ID");
    expect(target?.secrets?.required).toContain("WORKOS_API_KEY");
    expect(target?.vars?.WORKOS_CLIENT_ID).toBeUndefined();
    expect(target?.vars?.WORKOS_API_KEY).toBeUndefined();
  });

  it.each([
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("fails closed on missing WorkOS JWT verification configuration for %s", (_target, target) => {
    expect(target?.secrets?.required).toEqual(
      expect.arrayContaining(["WORKOS_JWKS_URI", "WORKOS_ISSUER", "WORKOS_CLIENT_ID"]),
    );
  });

  it.each([
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("requires a hosted access-token signing key for %s", (_target, target) => {
    expect(target?.secrets?.required).toContain("ACCESS_TOKEN_SECRET");
    expect(target?.vars?.ACCESS_TOKEN_SECRET).toBeUndefined();
  });

  it.each([
    ["shared-preview", config.env?.["shared-preview"], "https://app.preview.splitch.dev"],
    ["production", config.env?.production, "https://app.splitch.dev"],
  ])("configures the hosted Control Panel origin for %s", (_target, target, origin) => {
    expect(target?.vars?.CONTROL_PANEL_ORIGIN).toBe(origin);
    expect(target?.vars?.CONTROL_PANEL_ORIGIN).not.toBe(target?.vars?.CONTROL_PLANE_ORIGIN);
  });
});

interface WranglerConfig {
  compatibility_flags?: string[];
  env?: Record<string, WranglerTarget | undefined>;
}

interface WranglerTarget {
  secrets?: { required?: string[] };
  vars?: Record<string, unknown>;
}

function readWranglerConfig(): WranglerConfig {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const parsed = parseConfigFileTextToJson(path.pathname, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}
