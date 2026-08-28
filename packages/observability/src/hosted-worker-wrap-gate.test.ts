import { describe, expect, it } from "vitest";
import {
  classFetchIsWrapped,
  defaultExportIsWrapped,
  WRAP_WORKER_HANDLER as WRAPPER,
} from "./hosted-worker-wrap-gate";

describe("hosted Worker wrap-gate AST fixtures", () => {
  it("fails an unwrapped fetch whose only wrap mention is a comment", () => {
    const commented = `
      export default {
        fetch() {
          /* return wrapWorkerHandler( */
          return new Response("ok");
        },
      };
    `;
    expect(commented.includes(`return ${WRAPPER}(`)).toBe(true);
    expect(defaultExportIsWrapped(commented)).toBe(false);
  });

  it("fails when wrapWorkerHandler appears only in a helper or string", () => {
    const mentioned = `
      import { ${WRAPPER} } from "@splitch/observability/worker";
      const note = "${WRAPPER}";
      function helper() {
        return ${WRAPPER}({ fetch() { return new Response(note); } }, { surface: "fixture" });
      }
      export default {
        fetch() {
          return new Response(note);
        },
      };
    `;
    expect(mentioned.includes(WRAPPER)).toBe(true);
    expect(defaultExportIsWrapped(mentioned)).toBe(false);
  });

  it("accepts wrapped object, class, and delegated entrypoints", () => {
    const wrapped = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/observability/worker";
      const handler = { fetch() { return new Response("ok"); } };
      export default ${WRAPPER}(handler, { surface: "fixture" });
      const delegated = ${WRAPPER}(
        { fetch() { return new Response("delegated"); } },
        { surface: "fixture" },
      );
      function bindingHandler() {
        return ${WRAPPER}(
          { fetch() { return new Response("bound"); } },
          { surface: "fixture" },
        );
      }
      const bound = bindingHandler();
      export class DelegatedDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          return delegated.fetch(request, this.env, this.ctx);
        }
      }
      export class BoundDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          return bound.fetch(request, this.env, this.ctx);
        }
      }
    `;
    expect(defaultExportIsWrapped(wrapped)).toBe(true);
    expect(classFetchIsWrapped(wrapped, "DelegatedDoor")).toBe(true);
    expect(classFetchIsWrapped(wrapped, "BoundDoor")).toBe(true);
  });

  it("fails a local wrapWorkerHandler that shadows the official import name", () => {
    const shadowed = `
      function ${WRAPPER}(handler: { fetch(): Response }) {
        return handler;
      }
      export default ${WRAPPER}({ fetch() { return new Response("ok"); } });
    `;
    expect(shadowed.includes(`${WRAPPER}(`)).toBe(true);
    expect(defaultExportIsWrapped(shadowed)).toBe(false);
  });

  it("fails wrapWorkerHandler imported from a non-official module", () => {
    const localImport = `
      import { ${WRAPPER} } from "./local-wrapper";
      export default ${WRAPPER}({ fetch() { return new Response("ok"); } }, { surface: "fixture" });
    `;
    expect(defaultExportIsWrapped(localImport)).toBe(false);
  });

  it("fails a switch fetch path that returns one unwrapped response", () => {
    const mixed = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/observability/worker";
      const wrapped = ${WRAPPER}(
        { fetch() { return new Response("ok"); } },
        { surface: "fixture" },
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
    `;
    expect(classFetchIsWrapped(mixed, "SwitchDoor")).toBe(false);
  });

  it("fails when finally returns an unwrapped response over a wrapped try", () => {
    const leaked = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/observability/worker";
      const wrapped = ${WRAPPER}(
        { fetch() { return new Response("ok"); } },
        { surface: "fixture" },
      );
      export class FinallyDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          try {
            return wrapped.fetch(request, this.env, this.ctx);
          } finally {
            return new Response("ok");
          }
        }
      }
    `;
    expect(classFetchIsWrapped(leaked, "FinallyDoor")).toBe(false);
  });

  it("accepts switch and try/catch/finally when every reachable path is wrapped", () => {
    const covered = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/observability/worker";
      const wrapped = ${WRAPPER}(
        { fetch() { return new Response("ok"); } },
        { surface: "fixture" },
      );
      export class CoveredDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          switch (request.method) {
            case "GET":
              return wrapped.fetch(request, this.env, this.ctx);
            default:
              try {
                return wrapped.fetch(request, this.env, this.ctx);
              } catch {
                return wrapped.fetch(request, this.env, this.ctx);
              } finally {
                void request;
              }
          }
        }
      }
    `;
    expect(classFetchIsWrapped(covered, "CoveredDoor")).toBe(true);
  });

  it("fails an unwrapped default WorkerEntrypoint class like packages/cloudflare", () => {
    const unwrapped = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      export default class SplitchCloudflareWorker extends WorkerEntrypoint {
        fetch(request: Request) {
          return handleConfigurationPush(request, this.env);
        }
      }
    `;
    expect(defaultExportIsWrapped(unwrapped)).toBe(false);
    expect(classFetchIsWrapped(unwrapped, "SplitchCloudflareWorker")).toBe(false);
  });

  it("accepts a default WorkerEntrypoint class that applies the official baseline", () => {
    const wrapped = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { applyResponseHeaders, WORKER_BASELINE_SECURITY_HEADERS } from "@splitch/worker-runtime";
      export default class SplitchCloudflareWorker extends WorkerEntrypoint {
        async fetch(request: Request) {
          return applyResponseHeaders(
            await handleConfigurationPush(request, this.env),
            WORKER_BASELINE_SECURITY_HEADERS,
          );
        }
      }
    `;
    expect(defaultExportIsWrapped(wrapped)).toBe(true);
    expect(classFetchIsWrapped(wrapped, "SplitchCloudflareWorker")).toBe(true);
  });
});
