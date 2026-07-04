import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();

describe("Auth Worker Wrangler runtime config", () => {
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
});

interface WranglerConfig {
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
