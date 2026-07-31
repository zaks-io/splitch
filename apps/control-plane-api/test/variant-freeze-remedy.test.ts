import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startSeededExperiment } from "../src/config-store-fixture-data";
import { type Harness, ids, setProdPolicy, token } from "../src/config-store-harness-core";
import { allowPolicy, patchVariant } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * SPL-267. A refusal is only fail-loud if the action it names actually completes
 * the operation. ADR-0036 forbids the impossible remedy, and this Variant freeze
 * used to emit `CREATE_NEW_RUN` for a value edit: a Variant is App-level
 * (ADR-0028) and a draft Run carries no Variant name or value, so following that
 * token produced a second running Run and the identical refusal, forever.
 *
 * So the token both branches now emit is FOLLOWED here, literally, through the
 * real routes, and the edit is asserted to land at the end of it.
 */

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, allowPolicy);
  await startSeededExperiment(h.d1);
});

afterEach(async () => {
  await h.dispose();
});

async function endLiveRun(idempotency: string): Promise<number> {
  const jwt = await token(h.signer);
  const response = await h.app.request(
    `/apps/${ids.appId}/envs/${ids.environmentId}/runs/${ids.liveRunId}/end`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": idempotency,
      },
      body: JSON.stringify({ reason: "following END_RUNNING_RUN_FIRST" }),
    },
  );
  return response.status;
}

function variantValue(): Promise<string | undefined> {
  return h.repo.flags
    .getVariantById(appScope(ids.appId), ids.treatmentVariantId)
    .then((variant) => variant?.value);
}

describe("END_RUNNING_RUN_FIRST is an achievable remedy for the Variant freeze", () => {
  it("completes the value edit that the live Run refused", async () => {
    const refused = await patchVariant(h, "treatment", "spl267_remedy_1", { value: "NEW_PAYLOAD" });
    console.log("REMEDY step 0 — value PATCH while live:", JSON.stringify(refused));
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("RUN_FROZEN");
    expect(await variantValue()).toBe(JSON.stringify("on"));

    const ended = await endLiveRun("spl267_remedy_end_a");
    console.log("REMEDY step 1 — END_RUNNING_RUN_FIRST:", ended);
    expect(ended).toBe(200);

    const applied = await patchVariant(h, "treatment", "spl267_remedy_2", { value: "NEW_PAYLOAD" });
    console.log("REMEDY step 2 — value PATCH after ending the Run:", JSON.stringify(applied));
    console.log("REMEDY variant value:", JSON.stringify(await variantValue()));

    expect(applied.status).toBe(200);
    expect(await variantValue()).toBe(JSON.stringify("NEW_PAYLOAD"));
  });

  it("completes the rename that the live Run refused, and names the same action", async () => {
    const refused = await patchVariant(h, "treatment", "spl267_remedy_3", { name: "treatment_v2" });
    expect(refused.status).toBe(409);

    expect(await endLiveRun("spl267_remedy_end_b")).toBe(200);

    const applied = await patchVariant(h, "treatment", "spl267_remedy_4", { name: "treatment_v2" });
    console.log("REMEDY rename after ending the Run:", JSON.stringify(applied));
    expect(applied.status).toBe(200);
    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.name).toBe("treatment_v2");
  });
});
