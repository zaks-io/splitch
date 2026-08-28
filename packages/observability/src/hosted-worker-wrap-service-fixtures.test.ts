import { describe, expect, it } from "vitest";
import { discoverFixtures, omissionFailures } from "./hosted-worker-discovery.js";
import { classFetchIsWrapped, WRAP_WORKER_HANDLER } from "./hosted-worker-wrap-gate.js";

const WRAPPER = WRAP_WORKER_HANDLER;

describe("hosted Worker wrap-gate service-bound entrypoints", () => {
  it("fails a same-named entrypoint on an unrelated service", () => {
    const discovered = discoverFixtures([
      {
        directory: "caller",
        wrangler: `{
          "name": "caller",
          "main": "index.ts",
          "services": [{ "binding": "TARGET", "service": "target", "entrypoint": "SharedDoor" }],
          "env": {
            "production": {
              "name": "caller-prod",
              "services": [{ "binding": "TARGET", "service": "target-prod", "entrypoint": "SharedDoor" }]
            }
          }
        }`,
        source: `
          import { ${WRAPPER} } from "@splitch/worker-runtime";
          export default ${WRAPPER}({
            fetch() {
              return new Response("ok");
            },
          });
        `,
      },
      {
        directory: "unrelated",
        wrangler: `{
          "name": "unrelated",
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
          export default wrapped;
          export class SharedDoor extends WorkerEntrypoint {
            fetch(request: Request) {
              return wrapped.fetch(request, this.env, this.ctx);
            }
          }
        `,
      },
      {
        directory: "target",
        wrangler: `{
          "name": "target",
          "main": "index.ts",
          "env": { "production": { "name": "target-prod" } }
        }`,
        source: `
          import { WorkerEntrypoint } from "cloudflare:workers";
          import { ${WRAPPER} } from "@splitch/worker-runtime";
          export default ${WRAPPER}({
            fetch() {
              return new Response("ok");
            },
          });
          export class SharedDoor extends WorkerEntrypoint {
            fetch() {
              return new Response("ok");
            }
          }
        `,
      },
    ]);
    const failures = omissionFailures(discovered);
    expect(
      classFetchIsWrapped(
        discovered.find((worker) => worker.name === "unrelated")?.source ?? "",
        "SharedDoor",
      ),
    ).toBe(true);
    expect(
      classFetchIsWrapped(
        discovered.find((worker) => worker.name === "target")?.source ?? "",
        "SharedDoor",
      ),
    ).toBe(false);
    expect(
      failures.some((failure) => failure.includes("SharedDoor") && failure.includes("target")),
    ).toBe(true);
    expect(failures.some((failure) => failure.includes("target-prod"))).toBe(true);
  });
});
