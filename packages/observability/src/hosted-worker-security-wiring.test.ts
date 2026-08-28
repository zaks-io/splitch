import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";
import {
  classFetchIsWrapped,
  defaultExportIsWrapped,
  exportedWorkerEntrypoints,
  WRAP_WORKER_HANDLER,
} from "./hosted-worker-wrap-gate.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const WRAPPER = WRAP_WORKER_HANDLER;

/** Customer-installable Worker, not a hosted Splitch surface. */
const NON_HOSTED_WRANGLER = new Set(["packages/cloudflare/wrangler.jsonc"]);

interface WranglerConfig {
  name?: string;
  main?: string;
  services?: Array<{ entrypoint?: string }>;
  env?: Record<string, { name?: string; services?: Array<{ entrypoint?: string }> } | undefined>;
}

interface HostedWorker {
  configPath: string;
  name: string;
  mainPath: string;
  source: string;
  referencedEntrypoints: string[];
}

describe("hosted Worker security-header wiring", () => {
  const workers = discoverHostedWorkers(repoRoot);

  it("discovers every Wrangler config that ships a fetch entrypoint", () => {
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
    ]);
  });

  it("reports no omitted hosted fetch or binding handlers", () => {
    expect(omissionFailures(workers)).toEqual([]);
  });

  it("wraps each discovered default fetch export", () => {
    for (const worker of workers) {
      expect(
        defaultExportIsWrapped(worker.source),
        `${relative(repoRoot, worker.mainPath)} default export must be ${WRAPPER}(...)`,
      ).toBe(true);
    }
  });

  it("wraps every exported WorkerEntrypoint fetch handler", () => {
    for (const worker of workers) {
      for (const className of exportedWorkerEntrypoints(worker.source)) {
        expect(
          classFetchIsWrapped(worker.source, className),
          `${relative(repoRoot, worker.mainPath)} ${className}.fetch must delegate to ${WRAPPER}`,
        ).toBe(true);
      }
    }
  });

  it("resolves every configured service entrypoint to a wrapped exported class", () => {
    const wrappedClasses = wrappedEntrypointNames(workers);
    const referenced = new Set(workers.flatMap((worker) => worker.referencedEntrypoints));
    expect(referenced.size).toBeGreaterThan(0);
    for (const entrypoint of referenced) {
      expect(
        wrappedClasses.has(entrypoint),
        `configured entrypoint ${entrypoint} is unwrapped`,
      ).toBe(true);
    }
  });

  it("fails a synthetic unwrapped Worker the name-contains check would miss", () => {
    const unwrapped = `
      import { ${WRAPPER} } from "@splitch/observability/worker";
      export default {
        fetch() {
          return new Response("ok");
        },
      };
    `;
    expect(unwrapped.includes(WRAPPER)).toBe(true);
    expect(defaultExportIsWrapped(unwrapped)).toBe(false);
  });

  it("fails a comment/helper fixture that only mentions wrapWorkerHandler in a comment", () => {
    const discovered = discoverFixture({
      wrangler: `{
        "name": "comment-helper-fixture",
        "main": "index.ts"
      }`,
      source: `
        import { ${WRAPPER} } from "@splitch/observability/worker";
        function helper() {
          /* return wrapWorkerHandler( */
          return {
            fetch() {
              return new Response("ok");
            },
          };
        }
        export default helper();
      `,
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.source.includes(`return ${WRAPPER}(`)).toBe(true);
    expect(defaultExportIsWrapped(discovered[0]?.source ?? "")).toBe(false);
    expect(omissionFailures(discovered).length).toBeGreaterThan(0);
  });

  it("fails a mixed-branch fixture that wraps only one fetch return path", () => {
    const discovered = discoverFixture({
      wrangler: `{
        "name": "mixed-branch-fixture",
        "main": "index.ts",
        "services": [{ "binding": "OTHER", "service": "other", "entrypoint": "MixedDoor" }]
      }`,
      source: `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { ${WRAPPER} } from "@splitch/observability/worker";
        const wrapped = ${WRAPPER}(
          { fetch() { return new Response("ok"); } },
          { surface: "control-plane-api" },
        );
        export default ${WRAPPER}(
          { fetch() { return new Response("ok"); } },
          { surface: "control-plane-api" },
        );
        export class MixedDoor extends WorkerEntrypoint {
          fetch(request: Request) {
            if (request.method === "GET") return new Response("ok");
            return wrapped.fetch(request, this.env, this.ctx);
          }
        }
      `,
    });
    expect(discovered).toHaveLength(1);
    expect(defaultExportIsWrapped(discovered[0]?.source ?? "")).toBe(true);
    expect(classFetchIsWrapped(discovered[0]?.source ?? "", "MixedDoor")).toBe(false);
    expect(omissionFailures(discovered).length).toBeGreaterThan(0);
  });

  it("fails when a deployable wrangler.jsonc fixture ships an unwrapped fetch", () => {
    const discovered = discoverFixture({
      wrangler: `{
        // deployable hosted Worker whose fetch is not wrapped
        "name": "unwrapped-fixture",
        "main": "index.ts",
        "services": [{ "binding": "OTHER", "service": "other", "entrypoint": "LooseDoor" }]
      }`,
      source: `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { ${WRAPPER} } from "@splitch/observability/worker";
        export default {
          fetch() {
            return new Response("ok");
          },
        };
        export class LooseDoor extends WorkerEntrypoint {
          fetch() {
            return new Response("ok");
          }
        }
      `,
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.source.includes(WRAPPER)).toBe(true);
    expect(omissionFailures(discovered).length).toBeGreaterThan(0);
    expect(defaultExportIsWrapped(discovered[0]?.source ?? "")).toBe(false);
    expect(classFetchIsWrapped(discovered[0]?.source ?? "", "LooseDoor")).toBe(false);
  });
});

function discoverFixture(files: { wrangler: string; source: string }): HostedWorker[] {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "unwrapped-worker-"));
  try {
    writeFileSync(join(fixtureRoot, "wrangler.jsonc"), files.wrangler);
    writeFileSync(join(fixtureRoot, "index.ts"), files.source);
    return discoverHostedWorkers(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function omissionFailures(discovered: HostedWorker[]): string[] {
  const wrappedClasses = wrappedEntrypointNames(discovered);
  return discovered.flatMap((worker) => [
    ...unwrappedDefaultFailures(worker),
    ...unwrappedClassFailures(worker),
    ...unwrappedBindingFailures(worker, wrappedClasses),
  ]);
}

function wrappedEntrypointNames(discovered: HostedWorker[]): Set<string> {
  return new Set(
    discovered.flatMap((worker) =>
      exportedWorkerEntrypoints(worker.source).filter((className) =>
        classFetchIsWrapped(worker.source, className),
      ),
    ),
  );
}

function unwrappedDefaultFailures(worker: HostedWorker): string[] {
  return defaultExportIsWrapped(worker.source)
    ? []
    : [`${worker.mainPath} default export is unwrapped`];
}

function unwrappedClassFailures(worker: HostedWorker): string[] {
  return exportedWorkerEntrypoints(worker.source)
    .filter((className) => !classFetchIsWrapped(worker.source, className))
    .map((className) => `${worker.mainPath} ${className}.fetch is unwrapped`);
}

function unwrappedBindingFailures(worker: HostedWorker, wrappedClasses: Set<string>): string[] {
  return worker.referencedEntrypoints
    .filter((entrypoint) => !wrappedClasses.has(entrypoint))
    .map((entrypoint) => `configured entrypoint ${entrypoint} is unwrapped`);
}

function discoverHostedWorkers(root: string): HostedWorker[] {
  const workers: HostedWorker[] = [];
  for (const configPath of listWranglerConfigs(root)) {
    const rel = relative(root, configPath);
    if (NON_HOSTED_WRANGLER.has(rel)) continue;
    const config = readWranglerConfig(configPath);
    if (!config.main) continue;
    const mainPath = join(dirname(configPath), config.main);
    workers.push({
      configPath,
      name: config.name ?? rel,
      mainPath,
      source: readFileSync(mainPath, "utf8"),
      referencedEntrypoints: collectReferencedEntrypoints(config),
    });
  }
  return workers;
}

const WRANGLER_WALK_SKIP = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  "coverage",
  ".wrangler",
  ".output",
]);

function listWranglerConfigs(root: string): string[] {
  return walkWranglerConfigs(root).sort();
}

function walkWranglerConfigs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!WRANGLER_WALK_SKIP.has(entry.name)) found.push(...walkWranglerConfigs(path));
      continue;
    }
    if (entry.name === "wrangler.jsonc") found.push(path);
  }
  return found;
}

function readWranglerConfig(path: string): WranglerConfig {
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}

function collectReferencedEntrypoints(config: WranglerConfig): string[] {
  const names = new Set(entrypointNames(config.services));
  for (const target of Object.values(config.env ?? {})) {
    for (const name of entrypointNames(target?.services)) names.add(name);
  }
  return [...names];
}

function entrypointNames(services: Array<{ entrypoint?: string }> | undefined): string[] {
  return (services ?? []).flatMap((service) => (service.entrypoint ? [service.entrypoint] : []));
}
