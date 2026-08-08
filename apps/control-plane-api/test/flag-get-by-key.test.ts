import { appScope, createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  errorBody,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  NOW_ISO,
  orgToken,
  request,
} from "../src/flag-definition-test-harness";
import { FLAG_LIST_READ_LIMIT } from "../src/overview-thresholds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * `flags_get` accepts a Flag key as well as a canonical id so a Flag past the
 * catalog list ceiling stays reachable (SPL-236). The App scope remains the
 * isolation boundary: a key that only App B holds is absent under App A.
 */
let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

const OLDEST_SEEDED_KEY = "bulk-flag-0000";
const OLDEST_SEEDED_ID = "flag_bulk_0000";

async function seedFlags(appId: string, count: number): Promise<void> {
  const repo = createRepository(h.bindings.d1);
  const scope = appScope(appId);
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const variantId = `var_bulk_${suffix}`;
    await repo.flags.flags.insert(scope, {
      id: `flag_bulk_${suffix}`,
      appId,
      key: `bulk-flag-${suffix}`,
      name: `Bulk flag ${index}`,
      schema: JSON.stringify({ type: "boolean" }),
      defaultVariantId: variantId,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    await repo.flags.addVariant(scope, `flag_bulk_${suffix}`, {
      id: variantId,
      name: "control",
      value: JSON.stringify(false),
      createdAt: NOW_ISO,
    });
  }
}

async function createSecondApp(): Promise<{ id: string }> {
  const res = await request(h, "POST", "/orgs/org_flag_definition_crud/apps", await orgToken(h), {
    organizationId: "org_flag_definition_crud",
    name: "Other App",
    key: "other-app",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { app: { id: string } }).app;
}

describe("flags_get by key past the catalog list ceiling", () => {
  it("returns the oldest Flag by key when the list page no longer contains it", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedFlags(appId, FLAG_LIST_READ_LIMIT + 5);
    const jwt = await appToken(h, appId);

    const listed = await request(h, "GET", `/apps/${appId}/flags`, jwt);
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as {
      items: Array<{ key: string }>;
      readTruncated: boolean;
      readLimit: number;
    };
    expect(page.readTruncated).toBe(true);
    expect(page.readLimit).toBe(FLAG_LIST_READ_LIMIT);
    expect(page.items).toHaveLength(FLAG_LIST_READ_LIMIT);
    expect(page.items.some((flag) => flag.key === OLDEST_SEEDED_KEY)).toBe(false);

    const byKey = await request(h, "GET", `/apps/${appId}/flags/${OLDEST_SEEDED_KEY}`, jwt);
    expect(byKey.status).toBe(200);
    expect(await byKey.json()).toMatchObject({
      id: OLDEST_SEEDED_ID,
      key: OLDEST_SEEDED_KEY,
      name: "Bulk flag 0",
      variants: [{ name: "control" }],
    });

    const byId = await request(h, "GET", `/apps/${appId}/flags/${OLDEST_SEEDED_ID}`, jwt);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ id: OLDEST_SEEDED_ID, key: OLDEST_SEEDED_KEY });
  });

  it("refuses a Flag key that only another App holds", async () => {
    const appA = await createDefaultApp(h);
    const appB = await createSecondApp();
    await seedFlags(appB.id, 1);
    const jwtA = await appToken(h, appA.app.id);

    const underA = await request(h, "GET", `/apps/${appA.app.id}/flags/${OLDEST_SEEDED_KEY}`, jwtA);
    expect(underA.status).toBe(404);
    expect((await errorBody(underA)).code).toBe("FLAG_NOT_FOUND");

    const underB = await request(
      h,
      "GET",
      `/apps/${appB.id}/flags/${OLDEST_SEEDED_KEY}`,
      await appToken(h, appB.id),
    );
    expect(underB.status).toBe(200);
    expect(await underB.json()).toMatchObject({ key: OLDEST_SEEDED_KEY });
  });

  it("still answers FLAG_NOT_FOUND for a selector that matches neither id nor key", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);

    const res = await request(h, "GET", `/apps/${createdApp.app.id}/flags/no-such-flag`, jwt);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("FLAG_NOT_FOUND");
  });

  it("refuses a selector that matches one Flag by id and a different Flag by key", async () => {
    // Flag keys are unconstrained z.string() and may equal another Flag's
    // canonical id (SPL-288). Silent id-first OR key-first would return the
    // wrong Flag; refuse instead, naming both canonical ids.
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const scope = appScope(appId);
    const repo = createRepository(h.bindings.d1);
    const collidingId = "flag_aaaa0000bbbb1111cccc2222";

    await repo.flags.flags.insert(scope, {
      id: collidingId,
      appId,
      key: "shadow-key",
      name: "Shadow (id collides)",
      schema: JSON.stringify({ type: "boolean" }),
      defaultVariantId: "var_shadow",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    await repo.flags.addVariant(scope, collidingId, {
      id: "var_shadow",
      name: "control",
      value: JSON.stringify(false),
      createdAt: NOW_ISO,
    });
    await repo.flags.flags.insert(scope, {
      id: "flag_keyed_elsewhere_0001",
      appId,
      key: collidingId,
      name: "Keyed as the other's id",
      schema: JSON.stringify({ type: "boolean" }),
      defaultVariantId: "var_keyed",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    await repo.flags.addVariant(scope, "flag_keyed_elsewhere_0001", {
      id: "var_keyed",
      name: "control",
      value: JSON.stringify(false),
      createdAt: NOW_ISO,
    });

    const res = await request(
      h,
      "GET",
      `/apps/${appId}/flags/${collidingId}`,
      await appToken(h, appId),
    );
    expect(res.status).toBe(409);
    const body = await errorBody(res);
    expect(body).toEqual({
      code: "FLAG_SELECTOR_AMBIGUOUS",
      message: `Flag selector "${collidingId}" matches more than one Flag in this App: id ${collidingId} and key of flag_keyed_elsewhere_0001`,
      details: {
        selector: collidingId,
        idMatchFlagId: collidingId,
        keyMatchFlagId: "flag_keyed_elsewhere_0001",
        recommendedAction: "PASS_CANONICAL_FLAG_ID",
      },
    });
  });

  it("pins both-probe resolution: a single match still returns by id or by key", async () => {
    // After ambiguity refusal, id-first vs key-first only matters when exactly
    // one probe hits. Both must still work; swapping the probes must not
    // quietly drop either path.
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedFlags(appId, 1);
    const jwt = await appToken(h, appId);

    const byId = await request(h, "GET", `/apps/${appId}/flags/${OLDEST_SEEDED_ID}`, jwt);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ id: OLDEST_SEEDED_ID, key: OLDEST_SEEDED_KEY });

    const byKey = await request(h, "GET", `/apps/${appId}/flags/${OLDEST_SEEDED_KEY}`, jwt);
    expect(byKey.status).toBe(200);
    expect(await byKey.json()).toMatchObject({ id: OLDEST_SEEDED_ID, key: OLDEST_SEEDED_KEY });
  });
});
