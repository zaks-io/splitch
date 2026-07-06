import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();

describe("Control Plane API Wrangler runtime config", () => {
  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("carries the daily demo-reaper cron for %s", (_target, target) => {
    expect(effectiveCrons(target)).toEqual(["0 8 * * *"]);
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares the DB binding used by the demo reaper for %s", (_target, target) => {
    expect(target?.d1_databases).toContainEqual(expect.objectContaining({ binding: "DB" }));
  });

  it.each([
    [
      "shared-preview",
      config.env?.["shared-preview"],
      "https://auth.preview.splitch.dev/.well-known/jwks.json",
    ],
    ["production", config.env?.production, "https://auth.splitch.dev/.well-known/jwks.json"],
  ])("declares the Auth API JWKS trust root for %s", (_target, target, jwksUri) => {
    expect(target?.vars?.AUTH_JWKS_URI).toBe(jwksUri);
  });
});

interface WranglerConfig {
  d1_databases?: unknown[];
  env?: Record<string, WranglerTarget | undefined>;
  triggers?: { crons?: string[] };
}

interface WranglerTarget {
  d1_databases?: unknown[];
  triggers?: { crons?: string[] };
  vars?: Record<string, unknown>;
}

function effectiveCrons(target: WranglerTarget | undefined): string[] | undefined {
  return target?.triggers?.crons ?? config.triggers?.crons;
}

function readWranglerConfig(): WranglerConfig {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const parsed = parseConfigFileTextToJson(path.pathname, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}
