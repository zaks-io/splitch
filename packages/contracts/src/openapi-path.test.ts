import { describe, expect, it } from "vitest";
import { flagRoutes } from "./routes/routes-flags";

describe("openapi paths for hc", () => {
  it("uses brace params in derived openapi config", () => {
    expect(flagRoutes[0].openapi.path).toBe("/apps/{appId}/flags");
  });
});
