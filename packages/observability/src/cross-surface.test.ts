import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSurfaceEmitter, surfaceKindFor } from "./surface-wiring.js";
import {
  OBSERVABILITY_SURFACE_KINDS,
  OBSERVABILITY_SURFACES,
  observabilitySurfaceIds,
} from "./surfaces.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

describe("cross-surface observability wiring", () => {
  it("enumerates Worker, CLI, MCP, and SDK-harness boundaries", () => {
    expect(observabilitySurfaceIds()).toEqual([
      "control-plane-api",
      "evaluation-api",
      "event-ingest-api",
      "analysis-api",
      "auth-api",
      "control-panel",
      "marketing",
      "mcp-server",
      "cli",
      "sdk-harness",
    ]);
    expect(new Set(OBSERVABILITY_SURFACES.map((surface) => surface.kind))).toEqual(
      new Set(OBSERVABILITY_SURFACE_KINDS),
    );
  });

  for (const surface of OBSERVABILITY_SURFACES) {
    it(`${surface.id} registers scrubbed Sentry and structured-log emitters`, () => {
      const sentryEvents: Record<string, unknown>[] = [];
      const structuredLogEvents: Record<string, unknown>[][] = [];
      const emitter = createSurfaceEmitter(surface.id)({
        onSentryEvent: (event) => {
          sentryEvents.push(event);
        },
        onStructuredLogEvents: (events) => {
          structuredLogEvents.push(events);
        },
      });

      emitter.captureException(new Error("wiring check"), {
        targeting: { email: "leak@example.com" },
      });
      emitter.log("info", "wiring check", { targetingKey: "tk-should-redact" });

      expect(sentryEvents[0]?.extra).toMatchObject({ targeting: "[Redacted]" });
      expect(JSON.stringify(structuredLogEvents)).not.toContain("leak@example.com");
      expect(JSON.stringify(structuredLogEvents)).not.toContain("tk-should-redact");
    });

    it(`${surface.id} is wired in its owning workspace entrypoint`, () => {
      const marker = "@splitch/observability";
      if (surface.kind === "worker") {
        expect(
          existsSync(join(repoRoot, "apps", surface.id, "wrangler.jsonc")),
          `missing apps/${surface.id}/wrangler.jsonc; hosted wrap is checked from Wrangler discovery`,
        ).toBe(true);
        return;
      }
      if (surface.id === "cli") {
        const cliSource = readFileSync(join(repoRoot, "apps/cli/src/cli.ts"), "utf8");
        expect(cliSource).toContain(marker);
        return;
      }
      if (surface.id === "sdk-harness") {
        const harnessSource = readFileSync(
          join(repoRoot, "packages/observability/src/sdk-harness.ts"),
          "utf8",
        );
        expect(harnessSource).toContain("createScrubbedEmitter");
      }
    });

    it(`${surface.id} kind is ${surface.kind}`, () => {
      expect(surfaceKindFor(surface.id)).toBe(surface.kind);
    });
  }

  it("applies the shared Worker baseline from wrapWorkerHandler so a new Worker cannot omit it", () => {
    const wrapperSource = readFileSync(
      join(repoRoot, "packages/observability/src/worker.ts"),
      "utf8",
    );
    expect(wrapperSource).toContain("applyResponseHeaders");
    expect(wrapperSource).toContain("WORKER_BASELINE_SECURITY_HEADERS");
    expect(wrapperSource).toContain("applyWorkerBaselineHeaders");
  });
});
