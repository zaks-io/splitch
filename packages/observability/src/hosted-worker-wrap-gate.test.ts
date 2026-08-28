import { describe, expect, it } from "vitest";
import {
  classFetchIsWrapped,
  defaultExportIsWrapped,
  proveClassFetchWrapped,
  proveDefaultExportWrapped,
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

  it("fails a local wrapWorkerHandler that is not the official import binding", () => {
    const local = `
      function ${WRAPPER}(handler: unknown) {
        return handler;
      }
      export default ${WRAPPER}({
        fetch() {
          return new Response("ok");
        },
      }, { surface: "fixture" });
    `;
    expect(defaultExportIsWrapped(local)).toBe(false);
    expect(proveDefaultExportWrapped(local, "local-wrap.ts").wrapped).toBe(false);
  });

  it("fails when a nested const, function, or parameter shadows the official wrap", () => {
    const nestedConst = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      function factory() {
        const ${WRAPPER} = (handler: unknown) => handler;
        return ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
      }
      export default factory();
    `;
    const nestedFunction = `
      import { ${WRAPPER} } from "@splitch/observability/worker";
      export default function handler() {
        function ${WRAPPER}(inner: unknown) {
          return inner;
        }
        return ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
      }
    `;
    const parameterShadow = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      function factory(${WRAPPER}: (handler: unknown) => unknown) {
        return ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
      }
      export default factory((handler) => handler);
    `;
    expect(defaultExportIsWrapped(nestedConst)).toBe(false);
    expect(defaultExportIsWrapped(nestedFunction)).toBe(false);
    expect(defaultExportIsWrapped(parameterShadow)).toBe(false);
  });

  it("fails a throw-only factory and accepts a throw that a catch wraps", () => {
    const thrown = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      export default function factory() {
        throw new Error("nope");
      }
    `;
    const caught = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      export default function factory() {
        try {
          throw new Error("nope");
        } catch {
          return ${WRAPPER}({
            fetch() {
              return new Response("ok");
            },
          });
        }
      }
    `;
    expect(defaultExportIsWrapped(thrown)).toBe(false);
    expect(defaultExportIsWrapped(caught)).toBe(true);
  });

  it("fails when a local function shadows the official wrapWorkerHandler import", () => {
    const shadowed = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      function ${WRAPPER}(handler: unknown) {
        return handler;
      }
      export default ${WRAPPER}({
        fetch() {
          return new Response("ok");
        },
      });
    `;
    expect(shadowed.includes(`from "@splitch/worker-runtime"`)).toBe(true);
    expect(defaultExportIsWrapped(shadowed)).toBe(false);
  });

  it("fails an unwrapped switch return path", () => {
    const switched = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/observability/worker";
      const wrapped = ${WRAPPER}(
        { fetch() { return new Response("ok"); } },
        { surface: "fixture" },
      );
      export default ${WRAPPER}(
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
    expect(defaultExportIsWrapped(switched)).toBe(true);
    expect(classFetchIsWrapped(switched, "SwitchDoor")).toBe(false);
    expect(proveClassFetchWrapped(switched, "SwitchDoor", "switch.ts").location).toMatch(
      /switch\.ts:\d+:\d+/,
    );
  });

  it("fails when finally returns an unwrapped response", () => {
    const finalized = `
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
    `;
    expect(defaultExportIsWrapped(finalized)).toBe(false);
    expect(classFetchIsWrapped(finalized, "FinallyDoor")).toBe(false);
    expect(proveDefaultExportWrapped(finalized, "finally.ts").location).toMatch(
      /finally\.ts:\d+:\d+/,
    );
  });

  it("accepts wrapped object, class, aliased, namespaced, and delegated entrypoints", () => {
    const wrapped = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} as wrap } from "@splitch/observability/worker";
      import * as runtime from "@splitch/worker-runtime";
      const handler = { fetch() { return new Response("ok"); } };
      export default wrap(handler, { surface: "fixture" });
      const delegated = runtime.${WRAPPER}(
        { fetch() { return new Response("delegated"); } },
      );
      function bindingHandler() {
        return wrap(
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

  it("accepts a default-exported class that delegates fetch to the official wrap", () => {
    const cloudflare = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const configurationHandler = ${WRAPPER}({
        fetch(request: Request, env: Env) {
          return new Response(env.ok);
        },
      });
      export default class SplitchCloudflareWorker extends WorkerEntrypoint {
        fetch(request: Request) {
          return configurationHandler.fetch(request, this.env, this.ctx);
        }
      }
    `;
    expect(defaultExportIsWrapped(cloudflare)).toBe(true);
    expect(classFetchIsWrapped(cloudflare, "SplitchCloudflareWorker")).toBe(true);
  });

  it("fails closed on unsupported syntax with a file location", () => {
    const unsupported = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      export default function handler() {
        with (globalThis) {
          return ${WRAPPER}({ fetch() { return new Response("ok"); } });
        }
      }
    `;
    const proof = proveDefaultExportWrapped(unsupported, "with.ts");
    expect(proof.wrapped).toBe(false);
    expect(proof.reason).toMatch(/unsupported syntax/);
    expect(proof.location).toMatch(/with\.ts:\d+:\d+/);
  });
});
