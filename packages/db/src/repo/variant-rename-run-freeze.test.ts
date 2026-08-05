import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

const NOW = "2026-07-04T10:00:00.000Z";

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

function rename(tenant: SeededTenants["a"], to: string) {
  return createRepository(local.d1).flags.updateVariant(
    appScope(tenant.appId),
    tenant.flagId,
    "control",
    { name: to },
    { updatedAt: NOW, updatedBy: "user_sweep" },
  );
}

describe("the repository seam itself refuses the rename", () => {
  it("refuses while the App's own Run is live and allows it once ended", async () => {
    await goLive(seed.a);

    expect(await rename(seed.a, "control_renamed")).toMatchObject({
      ok: false,
      reason: "RUN_FROZEN",
      variantName: "control",
      freeze: { runId: seed.a.runId, environmentId: seed.a.environmentId },
    });

    await local.d1
      .prepare("UPDATE experiments SET status = 'completed' WHERE id = ?")
      .bind(seed.a.experimentId)
      .run();
    expect(await rename(seed.a, "control_renamed")).toMatchObject({
      ok: true,
      variant: { name: "control_renamed" },
    });
  });

  it("does not let one App's live Run freeze another App's Variant", async () => {
    await goLive(seed.a);

    expect(await rename(seed.b, "control_b_renamed")).toMatchObject({
      ok: true,
      variant: { name: "control_b_renamed" },
    });
    expect(await rename(seed.a, "control_a_renamed")).toMatchObject({
      ok: false,
      reason: "RUN_FROZEN",
    });
  });
});
