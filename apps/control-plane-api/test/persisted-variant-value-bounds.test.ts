import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  createFlag,
  errorBody,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("control-plane Variant value root arrays", () => {
  it("rejects a root-array catalog value on Flag create before any Flag write", async () => {
    const created = await createDefaultApp(h);
    const jwt = await appToken(h, created.app.id);
    const before = await count("flags", created.app.id);
    const res = await request(h, "POST", `/apps/${created.app.id}/flags`, jwt, {
      appId: created.app.id,
      name: "Array value",
      key: "array-value-flag",
      variants: [{ name: "control", value: [], isDefault: true }],
      idempotency_key: "idem-root-array-flag",
    });

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(
      err.details.issues.some((issue) => issue.path.join(".") === "body.variants.0.value"),
    ).toBe(true);
    expect(await count("flags", created.app.id)).toBe(before);
  });

  it("rejects a root-array Variant value on create before any catalog write", async () => {
    const created = await createDefaultApp(h);
    const jwt = await appToken(h, created.app.id);
    const flag = await createFlag(h, created.app.id, jwt);
    const before = await variantCount(flag.id);
    const res = await request(h, "POST", `/apps/${created.app.id}/flags/${flag.id}/variants`, jwt, {
      appId: created.app.id,
      flagId: flag.id,
      name: "list",
      value: ["x"],
      idempotency_key: "idem-root-array-variant",
    });

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues.some((issue) => issue.path.join(".") === "body.value")).toBe(true);
    expect(await variantCount(flag.id)).toBe(before);
  });

  it("rejects a root-array Variant value on patch before any catalog write", async () => {
    const created = await createDefaultApp(h);
    const jwt = await appToken(h, created.app.id);
    const flag = await createFlag(h, created.app.id, jwt);
    const variant = flag.variants.find((entry) => entry.name === "treatment");
    if (!variant) throw new Error("expected treatment Variant");
    const beforeValue = await variantValue(variant.id);
    const res = await request(
      h,
      "PATCH",
      `/apps/${created.app.id}/flags/${flag.id}/variants/treatment`,
      jwt,
      { value: [], idempotency_key: "idem-root-array-variant-patch" },
    );

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues.some((issue) => issue.path.join(".") === "body.value")).toBe(true);
    expect(await variantValue(variant.id)).toBe(beforeValue);
  });
});

async function count(table: "flags", appId: string): Promise<number> {
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

async function variantValue(variantId: string): Promise<string | null> {
  const row = await h.bindings.d1
    .prepare("SELECT value FROM variants WHERE id = ?")
    .bind(variantId)
    .first<{ value: string }>();
  return row?.value ?? null;
}
