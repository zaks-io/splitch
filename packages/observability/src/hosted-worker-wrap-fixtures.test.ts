import { describe, expect, it } from "vitest";
import { discoverFixture, omissionFailures } from "./hosted-worker-discovery.js";
import {
  classFetchIsWrapped,
  defaultExportIsWrapped,
  WRAP_WORKER_HANDLER,
} from "./hosted-worker-wrap-gate.js";

const WRAPPER = WRAP_WORKER_HANDLER;

describe("hosted Worker wrap-gate inventory fixtures", () => {
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

  it("fails a local or shadowed wrapWorkerHandler that is not the official import binding", () => {
    const discovered = discoverFixture({
      wrangler: `{
        "name": "shadow-wrap-fixture",
        "main": "index.ts"
      }`,
      source: `
        import { ${WRAPPER} } from "@splitch/worker-runtime";
        function ${WRAPPER}(handler: unknown) {
          return handler;
        }
        export default ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
      `,
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.source.includes(`from "@splitch/worker-runtime"`)).toBe(true);
    expect(defaultExportIsWrapped(discovered[0]?.source ?? "")).toBe(false);
    expect(omissionFailures(discovered).length).toBeGreaterThan(0);
  });

  it("fails an unwrapped switch return path", () => {
    const discovered = discoverFixture({
      wrangler: `{
        "name": "unwrapped-switch-fixture",
        "main": "index.ts",
        "services": [{ "binding": "OTHER", "service": "other", "entrypoint": "SwitchDoor" }]
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
        export class SwitchDoor extends WorkerEntrypoint {
          fetch(request: Request) {
            switch (request.method) {
              case "GET":
                return new Response("ok");
              default:
                return wrapped.fetch(request, this.env, this.ctx);
            }
          }
        }
      `,
    });
    expect(discovered).toHaveLength(1);
    expect(defaultExportIsWrapped(discovered[0]?.source ?? "")).toBe(true);
    expect(classFetchIsWrapped(discovered[0]?.source ?? "", "SwitchDoor")).toBe(false);
    expect(omissionFailures(discovered).length).toBeGreaterThan(0);
  });

  it("fails when finally returns an unwrapped response", () => {
    const discovered = discoverFixture({
      wrangler: `{
        "name": "unwrapped-finally-fixture",
        "main": "index.ts"
      }`,
      source: `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { ${WRAPPER} } from "@splitch/worker-runtime";
        const wrapped = ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
        export default class FinallyDoor extends WorkerEntrypoint {
          fetch(request: Request) {
            try {
              return wrapped.fetch(request, this.env, this.ctx);
            } finally {
              return new Response("ok");
            }
          }
        }
      `,
    });
    expect(discovered).toHaveLength(1);
    expect(defaultExportIsWrapped(discovered[0]?.source ?? "")).toBe(false);
    expect(classFetchIsWrapped(discovered[0]?.source ?? "", "FinallyDoor")).toBe(false);
    expect(omissionFailures(discovered).length).toBeGreaterThan(0);
  });

  it("fails a packages/cloudflare-shaped fixture whose class fetch is unwrapped", () => {
    const discovered = discoverFixture({
      wrangler: `{
        "name": "cloudflare-unwrapped-fixture",
        "main": "src/worker.ts"
      }`,
      source: `
        import { WorkerEntrypoint } from "cloudflare:workers";
        export default class SplitchCloudflareWorker extends WorkerEntrypoint {
          fetch(request: Request) {
            return new Response("ok");
          }
        }
      `,
    });
    expect(discovered).toHaveLength(1);
    expect(defaultExportIsWrapped(discovered[0]?.source ?? "")).toBe(false);
    expect(classFetchIsWrapped(discovered[0]?.source ?? "", "SplitchCloudflareWorker")).toBe(false);
    expect(omissionFailures(discovered).length).toBeGreaterThan(0);
  });
});
