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
 * `flags_get` accepts a canonical ID or slug. `?by=key` selects the key side of
 * an ID/key collision; otherwise a canonical-looking value keeps ID precedence
 * (SPL-236/SPL-524). The App scope remains the isolation boundary.
 */
let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

const OLDEST_SEEDED_KEY = "bulk-flag-0000";
const OLDEST_SEEDED_ID = "flag_bulk_0000";
const COLLIDING_ID = "flag_aaaa0000bbbb1111cccc2222";

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
    name: "Other App",
    key: "other-app",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { app: { id: string } }).app;
}

/** Flag A id === S, Flag B key === S — the collision fixture from the review. */
async function seedIdKeyCollision(appId: string): Promise<void> {
  const scope = appScope(appId);
  const repo = createRepository(h.bindings.d1);
  await repo.flags.flags.insert(scope, {
    id: COLLIDING_ID,
    appId,
    key: "shadow-key",
    name: "Shadow (id collides)",
    schema: JSON.stringify({ type: "boolean" }),
    defaultVariantId: "var_shadow",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.flags.addVariant(scope, COLLIDING_ID, {
    id: "var_shadow",
    name: "control",
    value: JSON.stringify(false),
    createdAt: NOW_ISO,
  });
  await repo.flags.flags.insert(scope, {
    id: "flag_keyed_elsewhere_0001",
    appId,
    key: COLLIDING_ID,
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
}

describe("flags_get by key past the catalog list ceiling", () => {
  it("returns the oldest Flag by ?by=key when the list page no longer contains it", async () => {
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

    const byKey = await request(h, "GET", `/apps/${appId}/flags/${OLDEST_SEEDED_KEY}?by=key`, jwt);
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

  it("unifies an ordinary Flag slug across omitted, by=key, and by=id forms", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedFlags(appId, 1);
    const jwt = await appToken(h, appId);

    const omitted = await request(h, "GET", `/apps/${appId}/flags/${OLDEST_SEEDED_KEY}`, jwt);
    const byKey = await request(h, "GET", `/apps/${appId}/flags/${OLDEST_SEEDED_KEY}?by=key`, jwt);
    const byId = await request(h, "GET", `/apps/${appId}/flags/${OLDEST_SEEDED_KEY}?by=id`, jwt);
    const bodies = await Promise.all([omitted.json(), byKey.json(), byId.json()]);

    expect([omitted.status, byKey.status, byId.status]).toEqual([200, 200, 200]);
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it("refuses a Flag key that only another App holds when asked ?by=key", async () => {
    const appA = await createDefaultApp(h);
    const appB = await createSecondApp();
    await seedFlags(appB.id, 1);
    const jwtA = await appToken(h, appA.app.id);

    const underA = await request(
      h,
      "GET",
      `/apps/${appA.app.id}/flags/${OLDEST_SEEDED_KEY}?by=key`,
      jwtA,
    );
    expect(underA.status).toBe(404);
    expect((await errorBody(underA)).code).toBe("FLAG_NOT_FOUND");

    const underB = await request(
      h,
      "GET",
      `/apps/${appB.id}/flags/${OLDEST_SEEDED_KEY}?by=key`,
      await appToken(h, appB.id),
    );
    expect(underB.status).toBe(200);
    expect(await underB.json()).toMatchObject({ key: OLDEST_SEEDED_KEY });
  });

  it("still answers FLAG_NOT_FOUND for an unknown canonical id", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);

    const res = await request(h, "GET", `/apps/${createdApp.app.id}/flags/no-such-flag`, jwt);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("FLAG_NOT_FOUND");
  });

  it("returns Flag A by canonical id when another Flag holds key = that id", async () => {
    // Regression: on the ambiguous-refusal design, id === S was unreadable
    // forever because retrying the canonical id re-entered the collision.
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedIdKeyCollision(appId);

    const res = await request(
      h,
      "GET",
      `/apps/${appId}/flags/${COLLIDING_ID}`,
      await appToken(h, appId),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: COLLIDING_ID,
      key: "shadow-key",
      name: "Shadow (id collides)",
    });
  });

  it("returns Flag B when the same selector is asked with ?by=key", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedIdKeyCollision(appId);

    const res = await request(
      h,
      "GET",
      `/apps/${appId}/flags/${COLLIDING_ID}?by=key`,
      await appToken(h, appId),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "flag_keyed_elsewhere_0001",
      key: COLLIDING_ID,
      name: "Keyed as the other's id",
    });
  });

  it("ignores flags_get's by=key query on mutation routes", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedIdKeyCollision(appId);
    const jwt = await appToken(h, appId);

    const updated = await request(h, "PATCH", `/apps/${appId}/flags/${COLLIDING_ID}?by=key`, jwt, {
      name: "Updated canonical Flag",
    });
    const keyed = await request(h, "GET", `/apps/${appId}/flags/${COLLIDING_ID}?by=key`, jwt);

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: COLLIDING_ID,
      name: "Updated canonical Flag",
    });
    expect(await keyed.json()).toMatchObject({
      id: "flag_keyed_elsewhere_0001",
      name: "Keyed as the other's id",
    });
  });

  it("does not let a trailing by=key override an earlier by=id on the same request", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedIdKeyCollision(appId);
    const jwt = await appToken(h, appId);

    const asId = await request(h, "GET", `/apps/${appId}/flags/${COLLIDING_ID}?by=id`, jwt);
    const duplicated = await request(
      h,
      "GET",
      `/apps/${appId}/flags/${COLLIDING_ID}?by=id&by=key`,
      jwt,
    );
    const asKey = await request(h, "GET", `/apps/${appId}/flags/${COLLIDING_ID}?by=key`, jwt);

    expect(await asId.json()).toMatchObject({ id: COLLIDING_ID, key: "shadow-key" });
    expect(await duplicated.json()).toMatchObject({ id: COLLIDING_ID, key: "shadow-key" });
    expect(await asKey.json()).toMatchObject({ id: "flag_keyed_elsewhere_0001" });
  });
});
