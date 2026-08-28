import { createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  createFlag,
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

  it("rejects an unknown nested Variant catalog field before any Flag write", async () => {
    const created = await createDefaultApp(h);
    const jwt = await appToken(h, created.app.id);
    const before = await count("flags", created.app.id);
    const res = await request(h, "POST", `/apps/${created.app.id}/flags`, jwt, {
      appId: created.app.id,
      name: "Feature",
      key: "nested-strict-flag",
      variants: [{ name: "control", value: false, isDefault: true, extra: true }],
      idempotency_key: "idem-nested-flag",
    });

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      { path: ["body", "variants", "0", "extra"], message: 'Unrecognized key: "extra"' },
    ]);
    expect(await count("flags", created.app.id)).toBe(before);
  });

  it("rejects an unknown Condition field before any Segment write", async () => {
    const created = await createDefaultApp(h);
    const jwt = await appToken(h, created.app.id);
    const before = await count("segments", created.app.id);
    const res = await request(h, "POST", `/apps/${created.app.id}/segments`, jwt, {
      name: "Paid",
      conditions: [{ attribute: "plan", operator: "eq", value: "paid", extra: true }],
    });

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      { path: ["body", "conditions", "0", "extra"], message: 'Unrecognized key: "extra"' },
    ]);
    expect(await count("segments", created.app.id)).toBe(before);
  });

  it("rejects an unknown Variant field before any catalog write", async () => {
    const created = await createDefaultApp(h);
    const jwt = await appToken(h, created.app.id);
    const flag = await createFlag(h, created.app.id, jwt);
    const before = await variantCount(flag.id);
    const res = await request(h, "POST", `/apps/${created.app.id}/flags/${flag.id}/variants`, jwt, {
      appId: created.app.id,
      flagId: flag.id,
      name: "beta",
      value: true,
      extra: true,
      idempotency_key: "idem-nested-variant",
    });

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      { path: ["body", "extra"], message: 'Unrecognized key: "extra"' },
    ]);
    expect(await variantCount(flag.id)).toBe(before);
  });
});

async function count(table: "flags" | "segments", appId: string): Promise<number> {
  const row = await h.bindings.d1
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ?`)
    .bind(appId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function variantCount(flagId: string): Promise<number> {
  const row = await h.bindings.d1
    .prepare("SELECT COUNT(*) AS n FROM variants WHERE flag_id = ?")
    .bind(flagId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
