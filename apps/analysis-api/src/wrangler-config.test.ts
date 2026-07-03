import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();
const hourlySnapshotCron = "0 * * * *";

describe("Analysis Worker Wrangler runtime config", () => {
  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares the SESSION_STORE binding required by /results auth for %s", (_target, target) => {
    expect(target?.kv_namespaces).toContainEqual(
      expect.objectContaining({ binding: "SESSION_STORE" }),
    );
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares auth and Tinybird config for %s", (_target, target) => {
    const vars = target?.vars ?? {};
    expect(vars).toMatchObject({
      AUTH_API_ORIGIN: expect.any(String),
      AUTH_JWKS_URI: expect.any(String),
      CONTROL_PLANE_ORIGIN: expect.any(String),
      TINYBIRD_API_URL: "https://api.us-west-2.aws.tinybird.co",
    });
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares the Tinybird read token as a required secret for %s", (_target, target) => {
    expect(target?.secrets?.required).toContain("TINYBIRD_READ_TOKEN");
    expect(target?.vars?.TINYBIRD_READ_TOKEN).toBeUndefined();
  });

  it.each([
    ["local", generatedConfig()],
    ["production", generatedConfig("production")],
  ])("carries the hourly snapshot refresh cron into the %s generated config", (_target, target) => {
    expect(target.triggers?.crons).toEqual([hourlySnapshotCron]);
  });

  it("keeps shared-preview free of scheduled snapshot refreshes", () => {
    expect(generatedConfig("shared-preview").triggers?.crons).toEqual([]);
  });

  it.each([
    ["local", config],
    ["production", config.env?.production],
  ])("declares the Tinybird copy token for scheduled snapshots in %s", (_target, target) => {
    expect(target?.secrets?.required).toContain("TINYBIRD_COPY_TOKEN");
    expect(target?.vars?.TINYBIRD_COPY_TOKEN).toBeUndefined();
  });
});

interface WranglerConfig {
  env?: Record<string, WranglerTarget | undefined>;
  kv_namespaces?: unknown[];
  secrets?: { required?: string[] };
  triggers?: { crons?: string[] };
  vars?: Record<string, unknown>;
}

interface WranglerTarget {
  kv_namespaces?: unknown[];
  secrets?: { required?: string[] };
  triggers?: { crons?: string[] };
  vars?: Record<string, unknown>;
}

function generatedConfig(envName?: string): WranglerTarget {
  if (envName === undefined) {
    return config;
  }
  const target = config.env?.[envName];
  if (target === undefined) {
    throw new Error(`missing Wrangler env ${envName}`);
  }
  return {
    ...config,
    ...target,
  };
}

function readWranglerConfig(): WranglerConfig {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const parsed = parseConfigFileTextToJson(path.pathname, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}
