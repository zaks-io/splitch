import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();

describe("Control Plane API Wrangler runtime config", () => {
  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares Run Snapshot Tinybird delivery for %s", (targetName, target) => {
    expect(target?.secrets?.required).toContain("TINYBIRD_RUN_SNAPSHOT_TOKEN");
    expect(target?.vars?.TINYBIRD_API_URL).toBe(
      targetName === "local" ? "http://127.0.0.1:18788" : "https://api.us-west-2.aws.tinybird.co",
    );
    if (targetName !== "local") {
      expect(target?.vars?.TINYBIRD_RUN_SNAPSHOT_TOKEN).toBeUndefined();
    }
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares Approval Request archive Tinybird delivery for %s", (_targetName, target) => {
    expect(target?.secrets?.required).toContain("TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN");
    expect(target?.secrets?.required).toContain("TINYBIRD_APPROVAL_ARCHIVE_READ_TOKEN");
    expect(target?.vars?.TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN).toBeUndefined();
    expect(target?.vars?.TINYBIRD_APPROVAL_ARCHIVE_READ_TOKEN).toBeUndefined();
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("carries the daily demo-reaper cron for %s", (_target, target) => {
    expect(effectiveCrons(target)).toEqual(["* * * * *", "0 8 * * *"]);
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

  // Control Plane authorizes these routes and delegates execution (ADR-0046).
  // A binding added here also needs an ordering entry in
  // scripts/deploy-cloudflare-workers.mjs, or Control Plane deploys against an
  // entrypoint the live callee does not export yet.
  it.each([
    ["local", config, "ANALYSIS_API", "splitch-analysis-api"],
    [
      "shared-preview",
      config.env?.["shared-preview"],
      "ANALYSIS_API",
      "splitch-analysis-api-shared-preview",
    ],
    ["production", config.env?.production, "ANALYSIS_API", "splitch-analysis-api"],
    ["local", config, "EVALUATION_API", "splitch-evaluation-api"],
    [
      "shared-preview",
      config.env?.["shared-preview"],
      "EVALUATION_API",
      "splitch-evaluation-api-shared-preview",
    ],
    ["production", config.env?.production, "EVALUATION_API", "splitch-evaluation-api"],
  ])("binds %s %s to the delegated Worker's named entrypoint", (_t, target, binding, service) => {
    expect(target?.services).toContainEqual({
      binding,
      service,
      entrypoint: "ControlPlaneEntrypoint",
    });
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("binds the panel delegation replay object for %s", (_target, target) => {
    expect(target?.durable_objects?.bindings).toContainEqual({
      name: "PANEL_DELEGATION_REPLAY",
      class_name: "PanelDelegationReplayDurableObject",
    });
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declaratively provisions every Durable Object for %s", (_target, target) => {
    expect(effectiveExports(target)).toEqual({
      ConfigStoreDurableObject: { type: "durable-object", storage: "sqlite" },
      CredentialCacheWriterDurableObject: { type: "durable-object", storage: "sqlite" },
      CredentialCacheBackfillDurableObject: { type: "durable-object", storage: "sqlite" },
      PanelDelegationReplayDurableObject: { type: "durable-object", storage: "sqlite" },
      McpDelegationReplayDurableObject: { type: "durable-object", storage: "sqlite" },
    });
    expect(target?.migrations).toBeUndefined();
  });

  it("binds the actor-scoped limiter in production", () => {
    expect(config.env?.production?.ratelimits).toContainEqual({
      name: "CONTROL_PLANE_ACTOR_RATE_LIMITER",
      namespace_id: expect.stringMatching(/^\d+$/u),
      simple: { limit: 600, period: 60 },
    });
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("keeps predecessor session redemption disabled for %s", (_target, target) => {
    expect(target?.vars?.CONTROL_PANEL_LEGACY_SESSION_MODE).toBe("disabled");
    expect(target?.vars?.CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT).toBe("0");
  });
});

interface WranglerConfig {
  d1_databases?: unknown[];
  durable_objects?: DurableObjectsConfig;
  env?: Record<string, WranglerTarget | undefined>;
  services?: ServiceBinding[];
  exports?: DurableObjectExports;
  migrations?: unknown[];
  ratelimits?: RateLimitConfig[];
  triggers?: { crons?: string[] };
  vars?: Record<string, unknown>;
  secrets?: { required?: string[] };
}

interface WranglerTarget {
  d1_databases?: unknown[];
  durable_objects?: DurableObjectsConfig;
  services?: ServiceBinding[];
  exports?: DurableObjectExports;
  migrations?: unknown[];
  ratelimits?: RateLimitConfig[];
  triggers?: { crons?: string[] };
  vars?: Record<string, unknown>;
  secrets?: { required?: string[] };
}

interface DurableObjectsConfig {
  bindings?: Array<{ name: string; class_name: string }>;
}

interface RateLimitConfig {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}

interface ServiceBinding {
  binding: string;
  service: string;
  entrypoint: string;
}

type DurableObjectExports = Record<
  string,
  { type: "durable-object"; storage: "sqlite" | "legacy-kv" }
>;

function effectiveCrons(target: WranglerTarget | undefined): string[] | undefined {
  return target?.triggers?.crons ?? config.triggers?.crons;
}

function effectiveExports(target: WranglerTarget | undefined): DurableObjectExports | undefined {
  return target?.exports ?? config.exports;
}

function readWranglerConfig(): WranglerConfig {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const parsed = parseConfigFileTextToJson(path.pathname, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}
