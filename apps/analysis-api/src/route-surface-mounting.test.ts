import { mountedOperationIds, routesDelegatedTo, routesSurfacedBy } from "@splitch/contracts";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { type AnalysisDoor, createApp } from "./app";

/**
 * This Worker is nobody's public surface: every route it owns is addressed at
 * `api.splitch.dev` and reaches it over a service binding (ADR-0046). What it
 * must still do is mount every route it EXECUTES, which is what caught
 * `audit_log_list` sitting in the registry with no handler behind it.
 */
describe("analysis-api mounts exactly the routes it executes, on the binding door only", () => {
  it("mounts every Analysis-owned route the Control Plane can delegate to it", () => {
    const expected = routesDelegatedTo("analysis-api").map((route) => route.operationId);

    expect([...mountedOperationIds(createApp(stubDeps("binding")).routes)].sort()).toEqual(
      [...expected].sort(),
    );
  });

  it("answers no registry route on its public door", () => {
    // Analysis surfaces nothing, so this list is empty and must stay empty: if a
    // hostname is ever pointed at this Worker, it opens no address that the
    // Control Plane has not already authorized.
    expect(routesSurfacedBy("analysis-api")).toEqual([]);
    expect(mountedOperationIds(createApp(stubDeps("public")).routes)).toEqual([]);
  });
});

function stubDeps(door: AnalysisDoor) {
  const authResolver: AuthResolver = () => ({
    ok: false as const,
    reason: "UNAUTHORIZED" as const,
  });
  const rateLimiter: RateLimiter = () => ({ limited: false });
  return {
    door,
    authResolver,
    rateLimiter,
    tinybird: { readPipe: async () => [] },
  };
}
