import { mountedOperationIds, routesMountedBy, routesSurfacedBy } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { makeSdkRouteHarness } from "./sdk-route-test-fixtures";

/**
 * The edge is the public surface for exactly the routes a customer's shipped
 * runtime calls with a Client Key or API Key. `flags_test_eval` is executed here
 * but addressed at the Control Plane: it holds a control-plane token, and the
 * hostname follows the credential, not the implementation (ADR-0046). So it is
 * mounted only on the door it arrives through.
 */
describe("evaluation-api mounts each door's routes and no others", () => {
  it("answers exactly the data-plane-credential routes on the public edge", async () => {
    const { app } = await makeSdkRouteHarness({ door: "public" });
    const expected = routesSurfacedBy("evaluation-api").map((route) => route.operationId);

    expect([...mountedOperationIds(app.routes)].sort()).toEqual([...expected].sort());
  });

  it("adds what it executes for another surface only on the binding door", async () => {
    const { app } = await makeSdkRouteHarness({ door: "binding" });
    const expected = routesMountedBy("evaluation-api").map((route) => route.operationId);

    expect([...mountedOperationIds(app.routes)].sort()).toEqual([...expected].sort());
  });

  it("does not answer a delegated route on the public edge", async () => {
    // The concrete regression: `edge.splitch.dev` accepting a control-plane token
    // gave `flags_test_eval` a second live address, reachable without going
    // through the authorization the Control Plane does before it delegates.
    const { app } = await makeSdkRouteHarness({ door: "public" });

    const response = await app.request(
      "/apps/app_1/envs/env_1/flags/flag_1/test-eval",
      { method: "POST", headers: { authorization: "Bearer stub" }, body: "{}" },
      {},
    );

    expect(response.status).toBe(404);
  });
});
