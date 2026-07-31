import type { ApprovalCommit } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import {
  type Harness,
  ids,
  NOW,
  NOW_MS,
  startSeededExperiment,
} from "../src/config-store-harness-core";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

/**
 * The structural half of the freeze. The two point fixes in
 * `flag-config-run-freeze-writers.test.ts` prove the two doors the reviewer
 * walked through are shut; this file exists so the NEXT door cannot be added
 * without someone deciding, in writing, whether a live Run may pass through it.
 *
 * Every method on `ConfigStoreWriter` is either frozen — and is then EXECUTED
 * here against `env_prod` while `run_live` is live and asserted to refuse — or is
 * listed as exempt with the reason it touches nothing a Run owns. A method that
 * appears on the writer and in neither table fails the first test, which is the
 * whole point: the route layer could never make that guarantee, because a route
 * that does not exist yet cannot fail a test.
 */

let h: Harness;
let store: ConfigStoreWriter;

const APPROVAL: ApprovalCommit = {
  requestId: "apr_sweep",
  reviewId: "aprv_sweep",
  action: "approve_and_apply",
  reviewedBy: "user_config_admin",
  reviewedVia: "anonymous",
  reviewedAt: NOW,
  reason: null,
  idempotencyKey: "idem_sweep",
  requestHash: "sha256:sweep",
  resultingTargetVersion: "2",
  resultingResourceType: "flag_configuration",
  resultingResourceId: ids.configId,
  policyContexts: [],
};

/**
 * Exempt, with the reason each one owns no frozen field. `syncExperimentConfig`
 * and `resyncFlagConfig` are the sharpest case: they rewrite the KV snapshot from
 * D1 and mutate no Flag Configuration row at all, so freezing them would break
 * the Run's own publication path.
 */
const EXEMPT_WRITERS: Record<string, string> = {
  readFlagConfig: "read-only",
  syncExperimentConfig: "republishes D1 to KV; writes no Flag Configuration row",
  resyncFlagConfig: "republishes D1 to KV; writes no Flag Configuration row",
  deleteFlagConfig: "removes the KV snapshot after the Flag rows are already gone",
};

beforeEach(async () => {
  h = await makeHarness();
  await narrowSeededAvailability(h.d1, ["control", "treatment"]);
  await startSeededExperiment(h.d1);
  store = makeConfigStore({
    repo: h.repo,
    kv: h.kv,
    broadcaster: { broadcast: () => undefined },
    now: () => new Date(NOW_MS),
  });
});

afterEach(async () => {
  await h.dispose();
});

function frozenWriterCalls(): Record<string, () => Promise<{ ok: boolean }>> {
  const target = { appId: ids.appId, environmentId: ids.environmentId, flagId: ids.flagId };
  const promotion = {
    appId: ids.appId,
    targetEnvironmentId: ids.environmentId,
    fromEnvironmentId: ids.devEnvironmentId,
    flagId: ids.flagId,
    select: { availability: ["treatment"] },
  };
  return {
    writeFlagConfig: () => store.writeFlagConfig({ ...target, availableVariantNames: ["control"] }),
    previewFlagConfig: () =>
      store.previewFlagConfig({ ...target, availableVariantNames: ["control"] }),
    replaceTargetingRules: () => store.replaceTargetingRules({ ...target, targetingRules: [] }),
    previewTargetingRules: () => store.previewTargetingRules({ ...target, targetingRules: [] }),
    promoteFlagConfig: () => store.promoteFlagConfig(promotion),
    previewPromotion: () => store.previewPromotion(promotion),
    applyApprovedFlagConfig: () =>
      store.applyApprovedFlagConfig({
        ...target,
        proposed: {
          flagId: ids.flagId,
          environmentId: ids.environmentId,
          version: 1,
          enabled: false,
          availableVariantNames: ["control"],
          targetingRules: [],
          rollout: null,
          experiment: null,
        },
        approval: APPROVAL,
      }),
  };
}

describe("every ConfigStore writer is classified against the freeze", () => {
  it("leaves no method unaccounted for", () => {
    const classified = [...Object.keys(frozenWriterCalls()), ...Object.keys(EXEMPT_WRITERS)];

    expect(classified.sort()).toEqual(Object.keys(store).sort());
  });

  it.each(Object.keys(frozenWriterCalls()))("%s refuses while a Run is live", async (name) => {
    const call = frozenWriterCalls()[name];
    if (!call) throw new Error(`unclassified writer ${name}`);

    expect(await call()).toMatchObject({ ok: false, reason: "RUN_FROZEN" });
  });
});
