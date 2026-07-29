import { appScope, createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("control-plane Flag definition CRUD", () => {
  it("round-trips App-level Flag CRUD and keeps enabled out of the response", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);

    const createdFlag = await createFlag(h, createdApp.app.id, jwt);
    expect(createdFlag.key).toBe("checkout-redesign");
    expect("enabled" in createdFlag).toBe(false);
    expect("environmentId" in createdFlag).toBe(false);
    expect(createdFlag.variants).toHaveLength(2);

    const list = await request(h, "GET", `/apps/${createdApp.app.id}/flags`, jwt);
    expect(list.status).toBe(200);
    expect((await list.json()) as { items: unknown[] }).toMatchObject({
      items: [{ id: createdFlag.id, key: "checkout-redesign" }],
    });

    const get = await request(h, "GET", `/apps/${createdApp.app.id}/flags/${createdFlag.id}`, jwt);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ id: createdFlag.id, name: "Checkout redesign" });

    const patch = await request(
      h,
      "PATCH",
      `/apps/${createdApp.app.id}/flags/${createdFlag.id}`,
      jwt,
      {
        name: "Checkout flow",
        description: "App-level definition only",
      },
    );
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ id: createdFlag.id, name: "Checkout flow" });

    const del = await request(
      h,
      "DELETE",
      `/apps/${createdApp.app.id}/flags/${createdFlag.id}`,
      jwt,
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect(
      await createRepository(h.bindings.d1).flags.listVariants(
        appScope(createdApp.app.id),
        createdFlag.id,
      ),
    ).toEqual([]);
  });

  it("rolls back the Flag when catalog Variant insertion fails", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const repo = createRepository(h.bindings.d1);
    const originalAddVariant = repo.flags.addVariant.bind(repo.flags);
    let addAttempt = 0;
    repo.flags.addVariant = async (...args) => {
      addAttempt += 1;
      if (addAttempt === 2) throw new Error("injected catalog insert failure");
      return originalAddVariant(...args);
    };
    const failingApp = makeAppForRepo(h, repo);

    const res = await failingApp.request(`/apps/${createdApp.app.id}/flags`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(baseFlag(createdApp.app.id)),
    });

    expect(res.status).toBe(500);
    const flags = await createRepository(h.bindings.d1).flags.flags.findMany(
      appScope(createdApp.app.id),
    );
    expect(flags.some((flag) => flag.key === "checkout-redesign")).toBe(false);
  });
});
