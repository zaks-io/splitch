import { mountedOperationIds, routesMountedBy } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

/**
 * The address model and the mount model have to be the same model. Nothing
 * compared them, so four Analysis-owned routes shipped as CLI commands with no
 * Worker answering them, and `audit_log_list` shipped mounted by nobody
 * (ADR-0046).
 *
 * No handler runs here: this asserts the route table `createApp` builds, so stub
 * deps are the point rather than a shortcut. Every mount is unconditional, which
 * is what makes the table trustworthy without live bindings.
 */
describe("control-plane-api mounts exactly the routes addressed at its hostname", () => {
  it("mounts every control-plane-token route, including the ones another Worker executes", () => {
    const expected = routesMountedBy("control-plane-api").map((route) => route.operationId);

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
    door: "binding" as const,
    authResolver,
    rateLimiter,
    repo: {} as Repository,
    convex: {},
    cloudflare: {},
  };
}
