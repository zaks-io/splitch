import { describe, expect, it } from "vitest";
import { discoverFixture, omissionFailures } from "./hosted-worker-discovery";
import {
  classFetchIsWrapped,
  exportedWorkerEntrypoints,
  proveClassFetchWrapped,
  WRAP_WORKER_HANDLER as WRAPPER,
} from "./hosted-worker-wrap-gate";

describe("hosted Worker entrypoint binding discovery", () => {
  it("inventories but rejects an aliased WorkerEntrypoint export list", () => {
    const source = `
      import { WorkerEntrypoint as CloudflareEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const handler = { fetch() { return new Response("ok"); } };
      export default ${WRAPPER}(handler);
      class InternalDoor extends CloudflareEntrypoint {
        fetch(request: Request) {
          return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
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
    expect(classFetchIsWrapped(source, "PublicDoor")).toBe(false);
    expect(omissionFailures(discovered)).toEqual([
      expect.stringMatching(/PublicDoor\.fetch is unwrapped/),
      expect.stringMatching(/configured entrypoint PublicDoor is unwrapped/),
    ]);
  });

  it("inventories but rejects a namespace-qualified WorkerEntrypoint binding", () => {
    const source = `
      import * as CloudflareWorkers from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const handler = { fetch() { return new Response("ok"); } };
      export default ${WRAPPER}(handler);
      export class PublicDoor extends CloudflareWorkers.WorkerEntrypoint {
        fetch(request: Request) {
          return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
        }
      }
    `;
    expect(exportedWorkerEntrypoints(source)).toEqual(["PublicDoor"]);
    expect(classFetchIsWrapped(source, "PublicDoor")).toBe(false);
  });

  it("fails closed on an unsupported exported fetch-bearing class with its location", () => {
    const discovered = discoverFixture({
      wrangler: `{
        "name": "unsupported-entrypoint",
        "main": "src/worker.ts"
      }`,
      source: `
        import { ${WRAPPER} } from "@splitch/worker-runtime";
        const handler = { fetch() { return new Response("ok"); } };
        export default ${WRAPPER}(handler);
        class UnknownDoor extends unknownEntrypoint() {
          ["fetch"](request: Request) {
            return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
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
      const handler = { fetch() { return new Response("ok"); } };
      export default ${WRAPPER}(handler);
      export class FalseDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
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

  it("discovers and proves an exported WorkerEntrypoint class expression", () => {
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const handler = { fetch() { return new Response("ok"); } };
      export default ${WRAPPER}(handler);
      export const PublicDoor = class extends WorkerEntrypoint {
        fetch(request: Request) {
          return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
        }
      };
    `;

    expect(exportedWorkerEntrypoints(source)).toEqual(["PublicDoor"]);
    expect(classFetchIsWrapped(source, "PublicDoor")).toBe(true);
  });

  it("fails an unsupported exported fetch-bearing class expression with its location", () => {
    const discovered = discoverFixture({
      wrangler: `{ "name": "class-expression", "main": "src/worker.ts" }`,
      source: `
        import { ${WRAPPER} } from "@splitch/worker-runtime";
        const handler = { fetch() { return new Response("ok"); } };
        export default ${WRAPPER}(handler);
        export const PublicDoor = class {
          fetch() {
            return new Response("unsupported");
          }
        };
      `,
    });

    expect(omissionFailures(discovered)).toEqual([
      expect.stringMatching(
        /unsupported exported fetch-bearing class PublicDoor \(.*src[/\\]worker\.ts:\d+:\d+\)/,
      ),
    ]);
  });

  it("fails when an exported WorkerEntrypoint class binding is reassigned", () => {
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const handler = { fetch() { return new Response("ok"); } };
      export default ${WRAPPER}(handler);
      export let PublicDoor = class extends WorkerEntrypoint {
        fetch(request: Request) {
          return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
        }
      };
      PublicDoor = class extends WorkerEntrypoint {
        fetch() { return new Response("raw"); }
      };
    `;

    expect(exportedWorkerEntrypoints(source)).toEqual(["PublicDoor"]);
    expect(classFetchIsWrapped(source, "PublicDoor")).toBe(false);
    expect(proveClassFetchWrapped(source, "PublicDoor", "reassigned.ts")).toMatchObject({
      wrapped: false,
      location: expect.stringMatching(/reassigned\.ts:\d+:\d+/),
    });
  });

  it.each([
    ["assignment", "PublicDoor.prototype.fetch = rawFetch;"],
    ["delete", "delete PublicDoor.prototype.fetch;"],
    ["update", "PublicDoor.prototype.fetch++;"],
    ["Object.assign", "Object.assign(PublicDoor.prototype, { fetch: rawFetch });"],
    [
      "Object.defineProperty",
      'Object.defineProperty(PublicDoor.prototype, "fetch", { value: rawFetch });',
    ],
  ])("fails after exported WorkerEntrypoint prototype fetch %s", (_name, mutation) => {
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const handler = { fetch() { return new Response("ok"); } };
      const rawFetch = () => new Response("raw");
      export default ${WRAPPER}(handler);
      export class PublicDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
        }
      }
      ${mutation}
    `;

    expect(classFetchIsWrapped(source, "PublicDoor")).toBe(false);
    expect(proveClassFetchWrapped(source, "PublicDoor", "prototype.ts")).toMatchObject({
      wrapped: false,
      location: expect.stringMatching(/prototype\.ts:\d+:\d+/),
    });
  });

  it.each([
    [
      "prototype alias mutation",
      `
        export class PublicDoor extends WorkerEntrypoint {
          fetch(request: Request) {
            return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
          }
        }
        const prototypeAlias = PublicDoor.prototype;
        prototypeAlias.fetch = rawFetch;
      `,
    ],
    [
      "constructor fetch assignment",
      `
        export class PublicDoor extends WorkerEntrypoint {
          constructor() {
            super();
            this.fetch = rawFetch;
          }
          fetch(request: Request) {
            return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
          }
        }
      `,
    ],
    [
      "static fetch ambiguity",
      `
        export class PublicDoor extends WorkerEntrypoint {
          static fetch(request: Request) {
            return ${WRAPPER}(handler).fetch(request, this.env, this.ctx);
          }
          fetch() {
            return rawFetch();
          }
        }
      `,
    ],
  ])("fails the canonical class grammar on %s with a location", (_name, classSource) => {
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const handler = { fetch() { return new Response("ok"); } };
      const rawFetch = () => new Response("raw");
      export default ${WRAPPER}(handler);
      ${classSource}
    `;

    expect(classFetchIsWrapped(source, "PublicDoor")).toBe(false);
    expect(proveClassFetchWrapped(source, "PublicDoor", "canonical-class.ts")).toMatchObject({
      wrapped: false,
      location: expect.stringMatching(/canonical-class\.ts:\d+:\d+/),
    });
  });
});
