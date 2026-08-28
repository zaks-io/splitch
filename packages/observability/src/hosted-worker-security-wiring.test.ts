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

  it("resolves every configured service entrypoint to a wrapped exported class", () => {
    const wrappedClasses = new Set(
      workers.flatMap((worker) =>
        exportedWorkerEntrypoints(worker.source).filter((className) =>
          classFetchIsWrapped(worker.source, className),
        ),
      ),
    );
    const referenced = new Set(workers.flatMap((worker) => worker.referencedEntrypoints));
    expect(referenced.size).toBeGreaterThan(0);
    for (const entrypoint of referenced) {
      expect(
        wrappedClasses.has(entrypoint),
        `configured entrypoint ${entrypoint} is unwrapped`,
      ).toBe(true);
    }
  });
});
