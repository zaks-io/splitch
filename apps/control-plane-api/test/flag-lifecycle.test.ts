import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

async function ownerSession() {
  const created = await createDefaultApp(h);
  return { appId: created.app.id, jwt: await appToken(h, created.app.id) };
}

function flagBody(appId: string, key: string, lifecycle: Record<string, unknown>) {
  const { lifecycleClass: _, ...rest } = baseFlag(appId);
  return { ...rest, key, name: key, ...lifecycle };
}

describe("Flag lifecycle class (D9)", () => {
  it("refuses a release Flag with no owner or expiry and names both inputs", async () => {
    const { appId, jwt } = await ownerSession();
    const res = await request(
      h,
      "POST",
      `/apps/${appId}/flags`,
      jwt,
      flagBody(appId, "release-bare", { lifecycleClass: "release" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "FLAG_LIFECYCLE_INCOMPLETE",
      details: { lifecycleClass: "release", missing: ["owner", "expiresAt"] },
    });
    const list = await request(h, "GET", `/apps/${appId}/flags`, jwt);
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("refuses an experiment Flag that names an owner but no expiry", async () => {
    const { appId, jwt } = await ownerSession();
    const res = await request(
      h,
      "POST",
      `/apps/${appId}/flags`,
      jwt,
      flagBody(appId, "experiment-no-expiry", { lifecycleClass: "experiment", owner: "growth" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "FLAG_LIFECYCLE_INCOMPLETE",
      details: { missing: ["expiresAt"] },
    });
  });

  it("refuses a Flag with no lifecycle class, naming the missing input", async () => {
    const { appId, jwt } = await ownerSession();
    const { lifecycleClass: _, ...unclassified } = baseFlag(appId);
    const res = await request(h, "POST", `/apps/${appId}/flags`, jwt, unclassified);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: ["body", "lifecycleClass"] }] },
    });
  });

  it("creates a permission Flag with no owner and no expiry", async () => {
    const { appId, jwt } = await ownerSession();
    const flag = await createFlag(
      h,
      appId,
      jwt,
      flagBody(appId, "permission-flag", { lifecycleClass: "permission" }),
    );
    expect(flag).toMatchObject({ lifecycleClass: "permission", owner: null, expiresAt: null });
  });

  it("stores a release Flag's expiry as UTC", async () => {
    const { appId, jwt } = await ownerSession();
    const flag = await createFlag(
      h,
      appId,
      jwt,
      flagBody(appId, "release-flag", {
        lifecycleClass: "release",
        owner: "checkout-team",
        expiresAt: "2026-12-31T02:00:00+02:00",
      }),
    );
    expect(flag).toMatchObject({ owner: "checkout-team", expiresAt: "2026-12-31T00:00:00.000Z" });
  });

  it("classifies an existing Flag and refuses to clear an expiry the class requires", async () => {
    const { appId, jwt } = await ownerSession();
    const flag = await createFlag(
      h,
      appId,
      jwt,
      flagBody(appId, "ops-flag", { lifecycleClass: "ops" }),
    );
    const path = `/apps/${appId}/flags/${flag.id}`;

    const incomplete = await request(h, "PATCH", path, jwt, { lifecycleClass: "release" });
    expect(incomplete.status).toBe(400);
    expect(await incomplete.json()).toMatchObject({
      code: "FLAG_LIFECYCLE_INCOMPLETE",
      details: { missing: ["owner", "expiresAt"] },
    });

    const classified = await request(h, "PATCH", path, jwt, {
      lifecycleClass: "release",
      owner: "checkout-team",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    expect(classified.status).toBe(200);
    expect(await classified.json()).toMatchObject({
      lifecycleClass: "release",
      owner: "checkout-team",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });

    const cleared = await request(h, "PATCH", path, jwt, { expiresAt: null });
    expect(cleared.status).toBe(400);
    expect(await cleared.json()).toMatchObject({ details: { missing: ["expiresAt"] } });

    const permanent = await request(h, "PATCH", path, jwt, {
      lifecycleClass: "permission",
      expiresAt: null,
    });
    expect(permanent.status).toBe(200);
    expect(await permanent.json()).toMatchObject({ lifecycleClass: "permission", expiresAt: null });
  });
});

describe("expired_flags_list", () => {
  it("returns a Flag past its expiry and leaves an unexpired one out", async () => {
    const { appId, jwt } = await ownerSession();
    const release = (key: string, expiresAt: string) =>
      flagBody(appId, key, { lifecycleClass: "release", owner: "checkout-team", expiresAt });
    expect(NOW_ISO).toBe("2026-07-02T12:00:00.000Z");
    const expired = await createFlag(
      h,
      appId,
      jwt,
      release("expired-flag", "2026-06-01T00:00:00Z"),
    );
    await createFlag(h, appId, jwt, release("current-flag", "2026-08-01T00:00:00Z"));
    await createFlag(h, appId, jwt, flagBody(appId, "ops-flag", { lifecycleClass: "ops" }));

    const res = await request(h, "GET", `/apps/${appId}/expired-flags`, jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      items: [{ id: expired.id, key: "expired-flag", owner: "checkout-team" }],
      readTruncated: false,
      cursor: null,
    });
  });
});
