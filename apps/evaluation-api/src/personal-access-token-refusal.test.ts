import { describe, expect, it } from "vitest";
import { makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

describe("Personal Access Tokens are refused by the Evaluation public door", () => {
  it("refuses a PAT where an SDK credential is required", async () => {
    const { app } = await makeSdkRouteHarness();
    const response = await app.request(
      "/api/sdk/evaluate",
      sdkRouteInit(`spl_pat_${"a".repeat(64)}`),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });
});
