import { describe, expect, it } from "vitest";
import { convexRoutes } from "./routes/routes-convex";

const route = (operationId: string) => {
  const found = convexRoutes.find((candidate) => candidate.operationId === operationId);
  if (!found) throw new Error(`no Convex route named ${operationId}`);
  return found;
};

describe("Convex integration routes", () => {
  it("requires only evaluation scope because Metric Events bypass Convex", () => {
    expect(route("convex_installations_create").scopes).toEqual(["data-plane:evaluate"]);
  });

  it("leaves the read-only Convex routes on the evaluate scope alone", () => {
    for (const operationId of ["convex_installations_get", "convex_snapshot_get"]) {
      expect(route(operationId).scopes).toEqual(["data-plane:evaluate"]);
    }
  });
});
