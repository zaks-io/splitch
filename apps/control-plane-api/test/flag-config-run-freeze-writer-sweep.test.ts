import { env, runInDurableObject } from "cloudflare:test";
import type { ApprovalCommit } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import { ConfigStoreDurableObject } from "../src/config-store-do";
import {
  makeSnapshotRevisionCounter,
  narrowSeededAvailability,
} from "../src/config-store-fixture-data";
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
 * `syncExperimentConfig` rewrites the Run's own publication path and therefore
 * cannot be frozen by the Run it is publishing.
 */
const EXEMPT_WRITERS: Record<string, string> = {
  readFlagConfig: "read-only",
  readFlagConfigPurgeTarget: "reads the stored evaluation owner before deletion",
  repairFlagConfigSnapshot: "repairs derived KV state without changing D1",
  syncExperimentConfig: "republishes D1 to KV; writes no Flag Configuration row",
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
    nextSnapshotRevision: makeSnapshotRevisionCounter(),
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
        diffEntries: [{ path: "/availableVariantNames" }],
        approval: APPROVAL,
      }),
    resyncFlagConfig: () => store.resyncFlagConfig(target),
  };
}

/**
 * The Durable Object is the actual network boundary: handlers hold a stub, not
 * the store. A mutating method added to the class instead of to the store would
 * never appear in `Object.keys(store)`, so the sweep above would not see it.
 * Everything here is either a delegation of a store method or DO machinery with
 * a written reason for touching no Flag Configuration row.
 */
const DURABLE_OBJECT_ONLY: Record<string, string> = {
  constructor: "DurableObject construction",
  ctx: "DurableObjectState the base class assigns",
  env: "bindings the base class assigns",
  fetch: "WebSocket upgrade only; refuses any other request with 426",
  readFlagConfigForEvaluation: "reads the committed Flag Configuration snapshot; no D1 write",
  webSocketMessage: "revalidates the socket's session",
  webSocketClose: "reschedules the expiry alarm",
  webSocketError: "no-op",
  alarm: "revalidates live sockets",
  setLiveUpdatesAvailable: "flips a DO storage flag and closes sockets",
  store: "constructs the guarded store; the guard it returns is the boundary",
  broadcast: "sends a delta nudge over open sockets",
  revalidate: "closes a socket whose authorization expired",
  isAuthorized: "reads the session; no D1 write",
  rescheduleExpiryAlarm: "DO alarm bookkeeping",
};

describe("every ConfigStore writer is classified against the freeze", () => {
  /**
   * Cheap boundary check: the DO's Flag Configuration surface must be exactly
   * the store's, so a new method has to be classified in one table or the other
   * before it can exist.
   */
  it("adds no Flag Configuration method to the Durable Object beyond the store's", async () => {
    // The prototype alone would miss a class FIELD holding an arrow function,
    // which Workers RPC exposes exactly like a method, so the live instance's own
    // properties are swept too.
    const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}`);
    const instanceOwn = await runInDurableObject(stub, (instance: object) =>
      Object.getOwnPropertyNames(instance),
    );
    const surface = [
      ...new Set([
        ...Object.getOwnPropertyNames(ConfigStoreDurableObject.prototype),
        ...instanceOwn,
      ]),
    ];

    const unclassified = surface.filter(
      (name) => !Object.hasOwn(DURABLE_OBJECT_ONLY, name) && !Object.hasOwn(store, name),
    );
    expect(unclassified).toEqual([]);
    // And the reverse: a store method the DO silently stopped exposing would
    // mean handlers reach D1 by some path this sweep never sees.
    expect(Object.keys(store).filter((name) => !surface.includes(name))).toEqual([]);
  });

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
