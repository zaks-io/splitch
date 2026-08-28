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
});
