import { describe, expect, it } from "vitest";
import {
  classFetchIsWrapped,
  defaultExportIsWrapped,
  proveDefaultExportWrapped,
  WRAP_WORKER_HANDLER as WRAPPER,
} from "./hosted-worker-wrap-gate";

describe("hosted Worker wrap-gate lexical scope", () => {
  it("fails root, block, factory, and delegated wrapWorkerHandler shadows", () => {
    const rootShadow = `
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
    const blockShadow = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      export default function factory() {
        {
          const ${WRAPPER} = (handler: unknown) => handler;
          return ${WRAPPER}({
            fetch() {
              return new Response("ok");
            },
          });
        }
      }
    `;
    const factoryShadow = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      function makeWrapper() {
        const ${WRAPPER} = (handler: unknown) => handler;
        return ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
      }
      export default makeWrapper();
    `;
    const delegatedShadow = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      function ${WRAPPER}(handler: unknown) {
        return handler;
      }
      const delegated = ${WRAPPER}({
        fetch() {
          return new Response("ok");
        },
      });
      export default delegated;
      export class ShadowDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          return delegated.fetch(request, this.env, this.ctx);
        }
      }
    `;
    expect(defaultExportIsWrapped(rootShadow)).toBe(false);
    expect(defaultExportIsWrapped(blockShadow)).toBe(false);
    expect(defaultExportIsWrapped(factoryShadow)).toBe(false);
    expect(defaultExportIsWrapped(delegatedShadow)).toBe(false);
    expect(classFetchIsWrapped(delegatedShadow, "ShadowDoor")).toBe(false);
  });

  it("accepts only the direct root wrapper call and rejects indirect official uses", () => {
    const root = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      export default ${WRAPPER}({
        fetch() {
          return new Response("ok");
        },
      });
    `;
    const nested = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      function factory() {
        return ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
      }
      export default factory();
    `;
    const parameter = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      function factory(_other: (handler: unknown) => unknown) {
        return ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
      }
      export default factory((handler) => handler);
    `;
    const block = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      export default function factory() {
        {
          const unused = 1;
          return ${WRAPPER}({
            fetch() {
              return new Response(String(unused));
            },
          });
        }
      }
    `;
    const factory = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      function makeWrapper() {
        return ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
      }
      export default makeWrapper();
    `;
    const aliasedOfficial = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const wrap = ${WRAPPER};
      export default wrap({
        fetch() {
          return new Response("ok");
        },
      });
    `;
    const delegated = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const delegated = ${WRAPPER}({
        fetch() {
          return new Response("ok");
        },
      });
      export default delegated;
      export class OfficialDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          return delegated.fetch(request, this.env, this.ctx);
        }
      }
    `;
    expect(defaultExportIsWrapped(root)).toBe(true);
    expect(defaultExportIsWrapped(nested)).toBe(false);
    expect(defaultExportIsWrapped(parameter)).toBe(false);
    expect(defaultExportIsWrapped(block)).toBe(false);
    expect(defaultExportIsWrapped(factory)).toBe(false);
    expect(defaultExportIsWrapped(aliasedOfficial)).toBe(false);
    expect(defaultExportIsWrapped(delegated)).toBe(false);
    expect(classFetchIsWrapped(delegated, "OfficialDoor")).toBe(false);
  });

  it("rejects do...while factory exports regardless of their return", () => {
    const unwrapped = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      export default function factory() {
        do {
          return {
            fetch() {
              return new Response("ok");
            },
          };
        } while (false);
        return ${WRAPPER}({
          fetch() {
            return new Response("ok");
          },
        });
      }
    `;
    const wrapped = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      export default function factory() {
        do {
          return ${WRAPPER}({
            fetch() {
              return new Response("ok");
            },
          });
        } while (false);
      }
    `;
    expect(defaultExportIsWrapped(unwrapped)).toBe(false);
    expect(defaultExportIsWrapped(wrapped)).toBe(false);
  });

  it("rejects repeated aliases and true alias cycles", () => {
    const repeated = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const wrapped = ${WRAPPER}({
        fetch() {
          return new Response("ok");
        },
      });
      const alias = wrapped;
      export default function factory(flag: boolean) {
        if (flag) return alias;
        return wrapped;
      }
    `;
    const cycle = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const a = b;
      const b = a;
      export default a;
    `;
    expect(defaultExportIsWrapped(repeated)).toBe(false);
    expect(defaultExportIsWrapped(cycle)).toBe(false);
    expect(proveDefaultExportWrapped(cycle, "cycle.ts").reason).toMatch(/direct official wrapper/);
  });

  it.each([
    "=",
    "||=",
    "??=",
    "&&=",
  ])("rejects an official wrapper alias changed with %s", (operator) => {
    const source = `
        import { ${WRAPPER} } from "@splitch/worker-runtime";
        const raw = { fetch() { return new Response("raw"); } };
        const fake = (handler: unknown) => handler;
        let wrap = ${WRAPPER};
        wrap ${operator} fake;
        export default wrap(raw);
      `;
    expect(defaultExportIsWrapped(source)).toBe(false);
  });
});
