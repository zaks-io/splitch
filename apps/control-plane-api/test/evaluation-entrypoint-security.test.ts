import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { EvaluationEntrypoint } from "../src/index.js";

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("EvaluationEntrypoint security headers", () => {
  it("stamps the Worker baseline on an unrecognized-delegation 500", async () => {
    const entrypoint = new EvaluationEntrypoint(testCtx, env as ControlPlaneApiEnv);
    const response = await entrypoint.fetch(
      new Request("https://cp.splitch.test/not-a-delegated-route"),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "delegated request was not recognized by its owner",
    });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});
