import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverDeployableWorkers, omissionFailures } from "./hosted-worker-discovery.js";
import {
  classFetchIsWrapped,
  defaultExportIsWrapped,
  exportedWorkerEntrypoints,
  WRAP_WORKER_HANDLER,
} from "./hosted-worker-wrap-gate.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const WRAPPER = WRAP_WORKER_HANDLER;

describe("hosted Worker security-header wiring", () => {
  const workers = discoverDeployableWorkers(repoRoot);

  it("discovers every non-test Wrangler config that ships a fetch entrypoint", () => {
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.map((worker) => relative(repoRoot, worker.configPath)).sort()).toEqual([
      "apps/analysis-api/wrangler.jsonc",
      "apps/auth-api/wrangler.jsonc",
      "apps/control-panel/wrangler.jsonc",
      "apps/control-plane-api/wrangler.jsonc",
      "apps/evaluation-api/wrangler.jsonc",
      "apps/event-ingest-api/wrangler.jsonc",
      "apps/marketing/wrangler.jsonc",
      "apps/mcp-server/wrangler.jsonc",
      "packages/cloudflare/wrangler.jsonc",
    ]);
  });

  it("includes packages/cloudflare and requires its default class fetch to use the official wrap", () => {
    const cloudflare = workers.find((worker) =>
      worker.configPath.endsWith("packages/cloudflare/wrangler.jsonc"),
    );
    expect(cloudflare).toBeDefined();
    expect(defaultExportIsWrapped(cloudflare?.source ?? "", cloudflare?.mainPath)).toBe(true);
    expect(exportedWorkerEntrypoints(cloudflare?.source ?? "")).toContain(
      "SplitchCloudflareWorker",
    );
    expect(classFetchIsWrapped(cloudflare?.source ?? "", "SplitchCloudflareWorker")).toBe(true);
  });

  it("reports no omitted hosted fetch or binding handlers", () => {
    expect(omissionFailures(workers)).toEqual([]);
  });

  it("wraps each discovered default fetch export", () => {
    for (const worker of workers) {
      expect(
        defaultExportIsWrapped(worker.source, worker.mainPath),
        `${relative(repoRoot, worker.mainPath)} default export must be ${WRAPPER}(...)`,
      ).toBe(true);
    }
  });

  it("wraps every exported WorkerEntrypoint fetch handler", () => {
    for (const worker of workers) {
      for (const className of exportedWorkerEntrypoints(worker.source)) {
        expect(
          classFetchIsWrapped(worker.source, className, worker.mainPath),
          `${relative(repoRoot, worker.mainPath)} ${className}.fetch must delegate to ${WRAPPER}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the complete current Worker entrypoint corpus inside the canonical grammar", () => {
    expect(
      workers
        .map((worker) => [
          relative(repoRoot, worker.mainPath),
          exportedWorkerEntrypoints(worker.source).sort(),
        ])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      ["apps/analysis-api/src/index.ts", ["ControlPlaneEntrypoint"]],
      ["apps/auth-api/src/index.ts", []],
      ["apps/control-panel/src/server.ts", []],
      [
        "apps/control-plane-api/src/index.ts",
        [
          "ControlPanelEntrypoint",
          "EvaluationEntrypoint",
          "McpEntrypoint",
          "SignedControlPanelEntrypoint",
        ],
      ],
      ["apps/evaluation-api/src/index.ts", ["ControlPlaneEntrypoint"]],
      ["apps/event-ingest-api/src/index.ts", ["EvaluationEntrypoint"]],
      ["apps/marketing/src/server.ts", []],
      ["apps/mcp-server/src/index.ts", []],
      ["packages/cloudflare/src/worker.ts", ["SplitchCloudflareWorker"]],
    ]);
  });

  it("resolves every configured service entrypoint to a wrapped exported class", () => {
    const referenced = workers.flatMap((worker) => worker.referencedEntrypoints);
    expect(referenced.length).toBeGreaterThan(0);
    const bindingFailures = omissionFailures(workers).filter((failure) =>
      failure.includes("configured entrypoint"),
    );
    expect(bindingFailures).toEqual([]);
    for (const binding of referenced) {
      const target = workers.find((worker) => worker.serviceNames.includes(binding.service));
      expect(target, `service ${binding.service} is missing`).toBeDefined();
      expect(
        classFetchIsWrapped(target?.source ?? "", binding.entrypoint),
        `configured entrypoint ${binding.entrypoint} is unwrapped for service ${binding.service}`,
      ).toBe(true);
    }
  });
});
