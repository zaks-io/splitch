import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();
const requiredSecrets = [
  "SENTRY_DSN",
  "SPLITCH_EVENT_INGEST_TOKEN",
  "TINYBIRD_INGEST_TOKEN",
  "TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN",
];

describe("Event Ingest Worker Wrangler runtime config", () => {
  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares the raw evaluation append token for %s", (_target, target) => {
    expect(target?.secrets?.required).toEqual(expect.arrayContaining(requiredSecrets));
    expect(target?.vars?.TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN).toBeUndefined();
  });
});

interface WranglerConfig {
  env?: Record<string, WranglerTarget | undefined>;
  secrets?: { required?: string[] };
  vars?: Record<string, unknown>;
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
