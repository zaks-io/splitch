import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * The freeze predicate's own tests, in the package that owns it (SPL-267).
 *
 * These exist because of a specific gap: neutering the VALUE half of the guard
 * left `packages/db` entirely green, and the only suite that noticed lived in
 * `apps/control-plane-api`. A package cannot be trusted to defend a guard it
 * cannot detect being switched off, so both halves — name and value — are
 * asserted here, at the seam, without a route in the way.
 */

const NOW = "2026-07-31T10:00:00.000Z";

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

async function goLive(tenant: SeededTenants["a"]): Promise<void> {
  await local.d1
    .prepare("UPDATE experiments SET status = 'running', live_run_id = ? WHERE id = ?")
    .bind(tenant.runId, tenant.experimentId)
    .run();
  await local.d1
    .prepare("UPDATE runs SET status = 'running', ended_at = NULL WHERE id = ?")
    .bind(tenant.runId)
    .run();
}

function patch(tenant: SeededTenants["a"], values: { name?: string; value?: string }) {
  return createRepository(local.d1).flags.updateVariant(
    appScope(tenant.appId),
    tenant.flagId,
    "control",
    values,
    { updatedAt: NOW, updatedBy: "user_freeze_test" },
  );
}

function storedValue(tenant: SeededTenants["a"]): Promise<string | undefined> {
  return createRepository(local.d1)
    .flags.getVariantById(appScope(tenant.appId), tenant.variantId)
    .then((variant) => variant?.value);
}

describe("a live Run freezes both frozen properties of a Variant", () => {
  it("refuses a VALUE swap and reports it as the frozen change", async () => {
    await goLive(seed.a);

    expect(await patch(seed.a, { value: '"PWNED_MID_RUN"' })).toMatchObject({
      ok: false,
      reason: "RUN_FROZEN",
      variantName: "control",
      frozenChanges: ["value"],
      freeze: { runId: seed.a.runId, environmentId: seed.a.environmentId },
    });
    expect(await storedValue(seed.a)).toBe('"control"');
  });

  it("refuses a NAME move and reports it as the frozen change", async () => {
    await goLive(seed.a);

    expect(await patch(seed.a, { name: "control_renamed" })).toMatchObject({
      ok: false,
      reason: "RUN_FROZEN",
      frozenChanges: ["name"],
    });
  });

  it("reports both when one write moves both", async () => {
    await goLive(seed.a);

    expect(await patch(seed.a, { name: "control_renamed", value: '"PWNED"' })).toMatchObject({
      ok: false,
      reason: "RUN_FROZEN",
      frozenChanges: ["name", "value"],
    });
  });

  /**
   * A patch that names the frozen fields without MOVING them is not an edit, so
   * refusing it would be a false positive that blocks an idempotent retry.
   */
  it("allows a write that restates the current name and value unchanged", async () => {
    await goLive(seed.a);

    expect(await patch(seed.a, { name: "control", value: '"control"' })).toMatchObject({
      ok: true,
    });
  });

  it("allows the value swap once the Run has ended", async () => {
    await goLive(seed.a);
    await local.d1
      .prepare("UPDATE experiments SET status = 'completed' WHERE id = ?")
      .bind(seed.a.experimentId)
      .run();

    expect(await patch(seed.a, { value: '"NEW_PAYLOAD"' })).toMatchObject({ ok: true });
    expect(await storedValue(seed.a)).toBe('"NEW_PAYLOAD"');
  });

  it("does not let one App's live Run freeze another App's Variant value", async () => {
    await goLive(seed.a);

    expect(await patch(seed.b, { value: '"B_ONLY"' })).toMatchObject({ ok: true });
    expect(await storedValue(seed.b)).toBe('"B_ONLY"');
    expect(await storedValue(seed.a)).toBe('"control"');
  });
});
