import { describe, expect, it } from "vitest";
import { discoverFixture, omissionFailures } from "./hosted-worker-discovery";
import {
  classFetchIsWrapped,
  exportedWorkerEntrypoints,
  WRAP_WORKER_HANDLER as WRAPPER,
} from "./hosted-worker-wrap-gate";

describe("hosted Worker entrypoint binding discovery", () => {
  it("discovers an imported WorkerEntrypoint alias exported through an aliased export list", () => {
    const source = `
      import { WorkerEntrypoint as CloudflareEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const wrapped = ${WRAPPER}({
        fetch() {
          return new Response("ok");
        },
      });
      export default wrapped;
      class InternalDoor extends CloudflareEntrypoint {
        fetch(request: Request) {
          return wrapped.fetch(request, this.env, this.ctx);
        }
      }
      export { InternalDoor as PublicDoor };
    `;
    const discovered = discoverFixture({
      wrangler: `{
        "name": "aliased-entrypoint",
        "main": "index.ts",
        "services": [
          { "binding": "SELF", "service": "aliased-entrypoint", "entrypoint": "PublicDoor" }
        ]
      }`,
      source,
    });

    expect(exportedWorkerEntrypoints(source)).toEqual(["PublicDoor"]);
    expect(classFetchIsWrapped(source, "PublicDoor")).toBe(true);
    expect(omissionFailures(discovered)).toEqual([]);
  });

  it("discovers a namespace-qualified WorkerEntrypoint binding", () => {
    const source = `
      import * as CloudflareWorkers from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const wrapped = ${WRAPPER}({ fetch() { return new Response("ok"); } });
      export default wrapped;
      export class PublicDoor extends CloudflareWorkers.WorkerEntrypoint {
        fetch(request: Request) {
          return wrapped.fetch(request, this.env, this.ctx);
        }
      }
    `;
    expect(exportedWorkerEntrypoints(source)).toEqual(["PublicDoor"]);
    expect(classFetchIsWrapped(source, "PublicDoor")).toBe(true);
  });

  it("fails closed on an unsupported exported fetch-bearing class with its location", () => {
    const discovered = discoverFixture({
      wrangler: `{
        "name": "unsupported-entrypoint",
        "main": "src/worker.ts"
      }`,
      source: `
        import { ${WRAPPER} } from "@splitch/worker-runtime";
        const wrapped = ${WRAPPER}({ fetch() { return new Response("ok"); } });
        export default wrapped;
        class UnknownDoor extends unknownEntrypoint() {
          ["fetch"](request: Request) {
            return wrapped.fetch(request, this.env, this.ctx);
          }
        }
        export { UnknownDoor };
      `,
    });
    const failures = omissionFailures(discovered);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/unsupported exported fetch-bearing class UnknownDoor/);
    expect(failures[0]).toMatch(/src[/\\]worker\.ts:\d+:\d+/);
  });

  it("does not accept a local class merely named WorkerEntrypoint", () => {
    const source = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      class WorkerEntrypoint {}
      const wrapped = ${WRAPPER}({ fetch() { return new Response("ok"); } });
      export default wrapped;
      export class FalseDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          return wrapped.fetch(request, this.env, this.ctx);
        }
      }
    `;
    const discovered = discoverFixture({
      wrangler: `{ "name": "false-entrypoint", "main": "index.ts" }`,
      source,
    });

    expect(exportedWorkerEntrypoints(source)).toEqual([]);
    expect(omissionFailures(discovered)[0]).toMatch(
      /unsupported exported fetch-bearing class FalseDoor/,
    );
  });
});
