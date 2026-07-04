import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

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
const SENTRY_DSN =
  "https://3ab6a31eedba4a3aff8720d2b4442368@o4509987229859840.ingest.us.sentry.io/4511677909762048";
const GITHUB_SENTRY_SECRET_REFERENCE = "SENTRY_DSN: $" + "{{ secrets.SENTRY_DSN }}";
const WORKER_SECRET_SYNC_NAMES = [
  "ACCESS_TOKEN_SECRET",
  "ASSERTION_SIGNING_SECRET",
  "SENTRY_DSN",
  "EVALUATION_PRIVACY_SALT",
] as const;

interface WranglerTarget {
  upload_source_maps?: boolean;
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
  upload_source_maps?: boolean;
  vars?: Record<string, unknown>;
}

describe("Worker Wrangler observability secrets", () => {
  for (const [surfaceId, wranglerPath] of Object.entries(WORKER_WRANGLER_PATHS)) {
    const config = readWranglerConfig(join(repoRoot, wranglerPath));

    it.each(
      wranglerTargets(config),
    )(`${surfaceId} declares SENTRY_DSN and stays Axiom token-free for %s`, (_target, target) => {
      const requiredSecrets = target?.secrets?.required ?? [];
      const sentryVar = target?.vars?.SENTRY_DSN;

      expect(requiredSecrets.includes("SENTRY_DSN") || sentryVar === SENTRY_DSN).toBe(true);
      expect(requiredSecrets).not.toContain("AXIOM_TOKEN");
      expect(target?.vars?.SENTRY_RELEASE).toBeUndefined();
      expect(target?.vars?.AXIOM_TOKEN).toBeUndefined();
      expect(target?.vars?.AXIOM_DATASET).toBeUndefined();
    });
  }
});

describe("Deploy workflow observability secrets", () => {
  it.each([
    ".github/workflows/deploy-shared-preview.yml",
    ".github/workflows/deploy-production.yml",
  ])("%s provides SENTRY_DSN to Worker secret sync", (workflowPath) => {
    const workflow = readFileSync(join(repoRoot, workflowPath), "utf8");

    expect(workflow).toContain(GITHUB_SENTRY_SECRET_REFERENCE);
    for (const secretName of WORKER_SECRET_SYNC_NAMES) {
      expect(workflow).toContain(secretName);
    }
  });
});

describe("Worker Wrangler source maps", () => {
  for (const [surfaceId, wranglerPath] of Object.entries(WORKER_WRANGLER_PATHS)) {
    const config = readWranglerConfig(join(repoRoot, wranglerPath));

    it.each(
      wranglerTargets(config),
    )(`${surfaceId} enables Cloudflare source map upload for %s`, (_target, target) => {
      expect(target?.upload_source_maps ?? config.upload_source_maps).toBe(true);
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
