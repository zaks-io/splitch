import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";
import { OBSERVABILITY_SURFACES } from "./surfaces.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const WORKER_WRANGLER_PATHS: Record<string, string> = {
  "control-plane-api": "apps/control-plane-api/wrangler.jsonc",
  "evaluation-api": "apps/evaluation-api/wrangler.jsonc",
  "event-ingest-api": "apps/event-ingest-api/wrangler.jsonc",
  "analysis-api": "apps/analysis-api/wrangler.jsonc",
  "auth-api": "apps/auth-api/wrangler.jsonc",
  "mcp-server": "apps/mcp-server/wrangler.jsonc",
  "control-panel": "apps/control-panel/wrangler.jsonc",
  marketing: "apps/marketing/wrangler.jsonc",
};

const OBSERVABILITY_TARGETS = ["local", "shared-preview", "production"] as const;
const AXIOM_TRACE_DESTINATION = "axiom-traces";
const AXIOM_LOG_DESTINATION = "axiom-logs";

interface WranglerTarget {
  observability?: {
    traces?: {
      enabled?: boolean;
      destinations?: string[];
      persist?: boolean;
      head_sampling_rate?: number;
    };
    logs?: {
      enabled?: boolean;
      destinations?: string[];
      persist?: boolean;
      head_sampling_rate?: number;
    };
  };
  secrets?: { required?: string[] };
  vars?: Record<string, unknown>;
}

interface WranglerConfig {
  env?: Record<string, WranglerTarget | undefined>;
  secrets?: { required?: string[] };
  vars?: Record<string, unknown>;
}

describe("Worker Wrangler observability secrets", () => {
  for (const surface of OBSERVABILITY_SURFACES) {
    if (surface.kind !== "worker") {
      continue;
    }

    const wranglerPath = WORKER_WRANGLER_PATHS[surface.id];
    if (!wranglerPath) {
      continue;
    }

    const config = readWranglerConfig(join(repoRoot, wranglerPath));

    it.each(
      wranglerTargets(config),
    )(`${surface.id} declares SENTRY_DSN for %s`, (_target, target) => {
      expect(target?.secrets?.required).toContain("SENTRY_DSN");
      expect(target?.secrets?.required).not.toContain("AXIOM_TOKEN");
      expect(target?.vars?.SENTRY_DSN).toBeUndefined();
      expect(target?.vars?.AXIOM_TOKEN).toBeUndefined();
      expect(target?.vars?.AXIOM_DATASET).toBeUndefined();
    });
  }
});

describe("Worker Wrangler Cloudflare Observability destinations", () => {
  for (const [surfaceId, wranglerPath] of Object.entries(WORKER_WRANGLER_PATHS)) {
    const config = readWranglerConfig(join(repoRoot, wranglerPath));

    it.each(
      wranglerTargets(config),
    )(`${surfaceId} exports %s telemetry to Axiom destinations`, (_target, target) => {
      expect(target?.observability?.traces?.enabled).toBe(true);
      expect(target?.observability?.traces?.destinations).toContain(AXIOM_TRACE_DESTINATION);
      expect(target?.observability?.traces?.persist).toBe(false);
      expect(target?.observability?.traces?.head_sampling_rate).toBe(1);

      expect(target?.observability?.logs?.enabled).toBe(true);
      expect(target?.observability?.logs?.destinations).toContain(AXIOM_LOG_DESTINATION);
      expect(target?.observability?.logs?.persist).toBe(false);
      expect(target?.observability?.logs?.head_sampling_rate).toBe(1);
    });
  }
});

function wranglerTargets(config: WranglerConfig): Array<[string, WranglerTarget | undefined]> {
  return OBSERVABILITY_TARGETS.map((target) => [
    target,
    target === "local" ? config : config.env?.[target],
  ]);
}

function readWranglerConfig(path: string): WranglerConfig {
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}
