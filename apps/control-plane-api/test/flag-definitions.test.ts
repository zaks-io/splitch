import { appScope, createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowAllPolicies,
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
    // CRUD round-trip, not the Approval gate: prod ships `confirm`, which would
    // otherwise turn the DELETE below into an Approval Request.
    await allowAllPolicies(h, createdApp.app.id);

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
      undefined,
      `idem-delete-flag-${crypto.randomUUID()}`,
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

  it("lists multiple Flags with one Environment's configuration inline", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const first = await createFlag(h, createdApp.app.id, jwt);
    const second = await createFlag(h, createdApp.app.id, jwt, {
      ...baseFlag(createdApp.app.id),
      idempotency_key: `idem-create-flag-${crypto.randomUUID()}`,
      key: "recommendations",
      name: "Recommendations",
    });
    const dev = createdApp.environments.find((environment) => environment.key === "dev");
    const prod = createdApp.environments.find((environment) => environment.key === "prod");
    if (!dev || !prod) throw new Error("fixture App is missing dev or prod Environment");

    await h.bindings.d1
      .prepare(
        "UPDATE flag_configs SET enabled = 1, rollout = ? WHERE app_id = ? AND environment_id = ? AND flag_id = ?",
      )
      .bind(
        JSON.stringify({ percentage: 35, salt: "prod-rollout" }),
        createdApp.app.id,
        prod.id,
        first.id,
      )
      .run();

    const prodList = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/flags?environmentId=${prod.id}`,
      jwt,
    );
    expect(prodList.status).toBe(200);
    const prodItems = (await prodList.json()) as {
      items: Array<{
        id: string;
        flagConfiguration?: {
          enabled: boolean;
          rollout: number | null;
          defaultVariant: string;
        };
      }>;
    };
    expect(prodItems.items).toHaveLength(2);
    expect(prodItems.items.find((flag) => flag.id === first.id)?.flagConfiguration).toEqual({
      enabled: true,
      rollout: 35,
      defaultVariant: "control",
    });
    expect(prodItems.items.find((flag) => flag.id === second.id)?.flagConfiguration).toEqual({
      enabled: false,
      rollout: null,
      defaultVariant: "control",
    });

    const devList = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/flags?environmentId=${dev.id}`,
      jwt,
    );
    expect(devList.status).toBe(200);
    expect(
      ((await devList.json()) as typeof prodItems).items.find((flag) => flag.id === first.id)
        ?.flagConfiguration,
    ).toMatchObject({ enabled: false, rollout: null });

    const bareList = await request(h, "GET", `/apps/${createdApp.app.id}/flags`, jwt);
    expect(bareList.status).toBe(200);
    expect(
      ((await bareList.json()) as { items: Array<Record<string, unknown>> }).items.every(
        (flag) => !("flagConfiguration" in flag),
      ),
    ).toBe(true);
  });

  it("rejects an empty Environment ID on the Flag list", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);

    const response = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/flags?environmentId=`,
      jwt,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("resumes the Flag when catalog Variant insertion fails", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const repo = createRepository(h.bindings.d1);
    const originalEnsureVariant = repo.flags.ensureCreateVariant.bind(repo.flags);
    let addAttempt = 0;
    repo.flags.ensureCreateVariant = async (...args) => {
      addAttempt += 1;
      if (addAttempt === 2) throw new Error("injected catalog insert failure");
      return originalEnsureVariant(...args);
    };
    const failingApp = makeAppForRepo(h, repo);
    const idempotencyKey = `idem-create-flag-${crypto.randomUUID()}`;
    const body = baseFlag(createdApp.app.id);

    const res = await failingApp.request(`/apps/${createdApp.app.id}/flags`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(500);
    const durableRepo = createRepository(h.bindings.d1);
    const flags = await durableRepo.flags.flags.findMany(appScope(createdApp.app.id));
    const partial = flags.find((flag) => flag.key === "checkout-redesign");
    expect(partial).toBeDefined();
    expect(
      await durableRepo.flags.listVariants(appScope(createdApp.app.id), partial?.id ?? "missing"),
    ).toHaveLength(1);

    const recovered = await request(
      h,
      "POST",
      `/apps/${createdApp.app.id}/flags`,
      jwt,
      body,
      idempotencyKey,
    );
    expect(recovered.status).toBe(200);
    expect(((await recovered.json()) as { variants: unknown[] }).variants).toHaveLength(2);
  });
});
