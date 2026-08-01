import { mountedOperationIds, routesMountedBy } from "@splitch/contracts";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

/**
 * This Worker is nobody's public surface: every route it owns is addressed at
 * `api.splitch.dev` and reaches it over a service binding (ADR-0046). What it
 * must still do is mount every route it EXECUTES, which is what caught
 * `audit_log_list` sitting in the registry with no handler behind it.
 */
describe("analysis-api mounts exactly the routes it executes", () => {
  it("mounts every Analysis-owned route the Control Plane can delegate to it", () => {
    const expected = routesMountedBy("analysis-api").map((route) => route.operationId);

    expect([...mountedOperationIds(createApp(stubDeps()).routes)].sort()).toEqual(
      [...expected].sort(),
    );
  });
});

function stubDeps() {
  const authResolver: AuthResolver = () => ({
    ok: false as const,
    reason: "UNAUTHORIZED" as const,
  });
  const rateLimiter: RateLimiter = () => ({ limited: false });
  return {
    authResolver,
    rateLimiter,
    tinybird: { readPipe: async () => [] },
  };
}
