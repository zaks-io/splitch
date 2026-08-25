import { readFileSync } from "node:fs";
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

const WORKER_APP_ENTRYPOINTS: Record<string, string> = {
  "control-plane-api": "apps/control-plane-api/src/index.ts",
  "evaluation-api": "apps/evaluation-api/src/index.ts",
  "event-ingest-api": "apps/event-ingest-api/src/index.ts",
  "analysis-api": "apps/analysis-api/src/index.ts",
  "auth-api": "apps/auth-api/src/index.ts",
  "control-panel": "apps/control-panel/src/server.ts",
  marketing: "apps/marketing/src/server.ts",
  "mcp-server": "apps/mcp-server/src/index.ts",
};

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
        const entrypoint = WORKER_APP_ENTRYPOINTS[surface.id];
        expect(entrypoint, `missing worker entrypoint for ${surface.id}`).toBeDefined();
        const indexSource = readFileSync(join(repoRoot, entrypoint as string), "utf8");
        expect(
          indexSource.includes(marker) ||
            indexSource.includes("wrapWorkerHandler") ||
            indexSource.includes("workerObservabilityWithWaitUntil"),
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
});
