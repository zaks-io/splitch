import { createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  errorBody,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  orgToken,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const ORG_ID = "org_flag_definition_crud";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("control-plane persisted request bounds", () => {
  it("rejects an unknown apps_create field with its path and writes no App", async () => {
    const before = (await createRepository(h.bindings.d1).identity.listAppsForOrg(ORG_ID)).length;
    const res = await request(h, "POST", `/orgs/${ORG_ID}/apps`, await orgToken(h), {
      organizationId: ORG_ID,
      name: "Checkout",
      key: "strict-app",
    });

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      { path: ["body", "organizationId"], message: 'Unrecognized key: "organizationId"' },
    ]);
    expect((await createRepository(h.bindings.d1).identity.listAppsForOrg(ORG_ID)).length).toBe(
      before,
    );
  });

  it("rejects an over-limit App name before D1 write", async () => {
    const before = (await createRepository(h.bindings.d1).identity.listAppsForOrg(ORG_ID)).length;
    const res = await request(h, "POST", `/orgs/${ORG_ID}/apps`, await orgToken(h), {
      name: "n".repeat(201),
      key: "over-limit-app",
    });

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues.some((issue) => issue.path.join(".") === "body.name")).toBe(true);
    expect((await createRepository(h.bindings.d1).identity.listAppsForOrg(ORG_ID)).length).toBe(
      before,
    );
  });
});
