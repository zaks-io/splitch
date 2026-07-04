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
};

interface WranglerTarget {
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

    it.each([
      ["local", config],
      ["shared-preview", config.env?.["shared-preview"]],
      ["production", config.env?.production],
    ])(`${surface.id} declares SENTRY_DSN and AXIOM_TOKEN for %s`, (_target, target) => {
      expect(target?.secrets?.required).toContain("SENTRY_DSN");
      expect(target?.secrets?.required).toContain("AXIOM_TOKEN");
      expect(target?.vars?.SENTRY_DSN).toBeUndefined();
      expect(target?.vars?.AXIOM_TOKEN).toBeUndefined();
    });
  }
});

function readWranglerConfig(path: string): WranglerConfig {
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}
