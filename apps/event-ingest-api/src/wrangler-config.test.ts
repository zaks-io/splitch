import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";
import { METRIC_EVENT_MAX_RETRIES } from "./metric-event-queue";

const config = readWranglerConfig();
const requiredSecrets = ["SENTRY_DSN", "SPLITCH_EVENT_INGEST_TOKEN", "TINYBIRD_INGEST_TOKEN"];

describe("Event Ingest Worker Wrangler runtime config", () => {
  it.each([
    ["shared-preview", config.env?.["shared-preview"], "ingest.preview.splitch.dev"],
    ["production", config.env?.production, "ingest.splitch.dev"],
  ])("keeps %s on a public custom domain with no workers.dev fallback", (_target, target, host) => {
    expect(target?.workers_dev).toBe(false);
    expect(target?.routes).toEqual([{ pattern: host, custom_domain: true }]);
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("declares the Event Ingest append token for %s", (_target, target) => {
    expect(target?.secrets?.required).toEqual(expect.arrayContaining(requiredSecrets));
    expect(target?.vars?.TINYBIRD_INGEST_TOKEN).toBeUndefined();
  });

  /**
   * The discard log fires on the attempt after the last retry, so the consumer's
   * retry budget and the constant the handler counts against have to be the same
   * number. Raise one alone and the log calls an event permanently discarded
   * while Cloudflare is still retrying it.
   */
  it.each([
    ["local", config, "splitch-control-plane-api"],
    ["shared-preview", config.env?.["shared-preview"], "splitch-control-plane-api-shared-preview"],
    ["production", config.env?.production, "splitch-control-plane-api"],
  ])("subscribes to the Config Store identity coordinator for %s", (_target, target, scriptName) => {
    expect(target?.durable_objects?.bindings).toContainEqual({
      name: "CONFIG_STORE_WRITER",
      class_name: "ConfigStoreDurableObject",
      script_name: scriptName,
    });
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("binds the SQLite Ingest Admission Gate for %s", (_target, target) => {
    expect(target?.durable_objects?.bindings).toContainEqual({
      name: "INGEST_ADMISSION_GATE",
      class_name: "IngestAdmissionGateDurableObject",
    });
    expect(
      target?.migrations?.some(
        (migration) =>
          migration.tag === "v4_ingest_admission_gate" &&
          migration.new_sqlite_classes?.includes("IngestAdmissionGateDurableObject"),
      ),
    ).toBe(true);
  });

  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("retries Metric Event delivery as many times as the handler counts for %s", (target, env) => {
    const consumers = env?.queues?.consumers ?? [];

    expect(consumers.length, `${target} declares no Metric Event consumer`).toBeGreaterThan(0);
    for (const consumer of consumers) {
      expect(
        consumer.max_retries,
        `${target} max_retries disagrees with METRIC_EVENT_MAX_RETRIES`,
      ).toBe(METRIC_EVENT_MAX_RETRIES);
    }
  });
});

interface WranglerConfig {
  durable_objects?: DurableObjectsConfig;
  env?: Record<string, WranglerTarget | undefined>;
  migrations?: Migration[];
  queues?: { consumers?: Array<{ max_retries?: number }> };
  secrets?: { required?: string[] };
  vars?: Record<string, unknown>;
}

interface WranglerTarget {
  durable_objects?: DurableObjectsConfig;
  migrations?: Migration[];
  queues?: { consumers?: Array<{ max_retries?: number }> };
  routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
  secrets?: { required?: string[] };
  vars?: Record<string, unknown>;
  workers_dev?: boolean;
}

interface DurableObjectsConfig {
  bindings?: Array<{ name?: string; class_name?: string; script_name?: string }>;
}

interface Migration {
  tag?: string;
  new_sqlite_classes?: string[];
}

function readWranglerConfig(): WranglerConfig {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const parsed = parseConfigFileTextToJson(path.pathname, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}
