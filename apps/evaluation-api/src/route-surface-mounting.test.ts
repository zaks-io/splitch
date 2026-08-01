import { mountedOperationIds, routesMountedBy } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { makeSdkRouteHarness } from "./sdk-route-test-fixtures";

/**
 * The edge is the public surface for exactly the routes a customer's shipped
 * runtime calls with a Client Key or API Key. `flags_test_eval` stays mounted
 * here because this Worker executes it, but it is addressed at the Control Plane
 * and arrives over a service binding: it holds a control-plane token, and the
 * hostname follows the credential, not the implementation (ADR-0046).
 */
describe("evaluation-api mounts exactly its public surface plus what it executes", () => {
  it("mounts the four data-plane-credential routes and the delegated test-eval", async () => {
    const { app } = await makeSdkRouteHarness();
    const expected = routesMountedBy("evaluation-api").map((route) => route.operationId);

    expect([...mountedOperationIds(app.routes)].sort()).toEqual([...expected].sort());
  });
});
