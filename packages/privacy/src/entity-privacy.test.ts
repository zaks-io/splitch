import { describe, expect, it } from "vitest";
import { ACTIVE_APP_IDENTITY_LIFECYCLE } from "./app-identity-lifecycle";
import { makeMemoryAppIdentityStore } from "./app-identity-store";
import { makeIdentitySaltStore } from "./derived-salt-store";
import {
  analysisRowsForEntity,
  canonicalizeAnalysisEntityHash,
  canonicalizeAnalysisRows,
  canonicalizeSharedRootTargetingKeyHash,
  computeRetainedTargetingKeyHashes,
  joinMetricEventsToExposures,
  resolveEntityPrivacyIdentity,
} from "./entity-privacy";
import { computeTargetingKeyHash } from "./hash";

const ROOT = "test-root-secret-do-not-use";
const INPUT = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

describe("entity privacy consumers", () => {
  it("resolves historical and current hashes without echoing the Targeting Key", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const store = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    const current = await computeTargetingKeyHash(store, INPUT);
    const historical = await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "v1" });
    const identity = await resolveEntityPrivacyIdentity(store, INPUT);

    expect(identity.targetingKeyHashes).toEqual([
      await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "local-v1" }),
      historical,
      current,
    ]);
    expect(JSON.stringify(identity)).not.toContain(INPUT.targetingKey);
    expect(canonicalizeAnalysisEntityHash(identity.targetingKeyHashes)).toBe(current);
  });

  it("keeps families joinable across one App's epochs without linking Apps", async () => {
    const identityStore = makeMemoryAppIdentityStore(
      new Map([
        [
          INPUT.appId,
          {
            currentVersion: "app-v2",
            lifecycle: ACTIVE_APP_IDENTITY_LIFECYCLE,
            epochs: [
              { version: "app-v1", role: "retained" as const, key: keyBytes(1) },
              { version: "app-v2", role: "active" as const, key: keyBytes(2) },
            ],
          },
        ],
      ]),
    );
    const store = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    const appA = await resolveEntityPrivacyIdentity(store, INPUT);
    const appACurrent = await computeTargetingKeyHash(store, INPUT);
    const appARetained = await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "app-v1" });
    expect(appA.entityFamilyHash).toBe(appARetained);
    expect(appA.entityFamilyHash).not.toBe(appACurrent);

    const appBInput = { ...INPUT, appId: "app_2" };
    const appB = await resolveEntityPrivacyIdentity(store, appBInput);
    const appBCurrent = await computeTargetingKeyHash(store, appBInput);
    expect(appBCurrent).not.toBe(appACurrent);
    expect(appB.entityFamilyHash).not.toBe(appA.entityFamilyHash);
  });

  it("joins analysis rows written under every retained epoch", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const store = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    const v1 = await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "v1" });
    const current = await computeTargetingKeyHash(store, INPUT);
    const hashes = await computeRetainedTargetingKeyHashes(store, INPUT);

    const rows = analysisRowsForEntity(
      [
        { targeting_key_hash: v1, metric: "signup" },
        { targeting_key_hash: current, metric: "checkout" },
        { targeting_key_hash: "app-v1:deadbeef", metric: "other-entity" },
      ],
      hashes,
    );

    expect(rows.map((row) => row.metric)).toEqual(["signup", "checkout"]);
    expect(hashes).toContain(v1);
    expect(hashes).toContain(current);

    const joined = joinMetricEventsToExposures(
      [
        { targeting_key_hash: current, experiment: "exp-a" },
        { targeting_key_hash: "app-v1:other-app", experiment: "exp-other" },
      ],
      [
        { targeting_key_hash: v1, metric: "signup" },
        { targeting_key_hash: "app-v1:other-app", metric: "leak" },
      ],
      hashes,
    );
    expect(joined.exposures.map((row) => row.experiment)).toEqual(["exp-a"]);
    expect(joined.metricEvents.map((row) => row.metric)).toEqual(["signup"]);
  });

  it("fails loud when analysis is asked to canonicalize an empty hash set", () => {
    expect(() => canonicalizeAnalysisEntityHash([])).toThrow(/no retained/);
  });

  it("joins historical shared-root prefixes that share one digest", () => {
    const digest = "485bdba84f840c9627db32bcc99a6f00722b5253754e513ff473c90a8febc588";
    const rows = canonicalizeAnalysisRows([
      { targeting_key_hash: `local-v1:${digest}`, metric: "exposure" },
      { targeting_key_hash: `v1:${digest}`, metric: "metric" },
      { targeting_key_hash: "app-v1:other", metric: "other" },
    ]);
    expect(canonicalizeSharedRootTargetingKeyHash(`local-v1:${digest}`)).toBe(`v1:${digest}`);
    expect(rows.map((row) => row.targeting_key_hash)).toEqual([
      `v1:${digest}`,
      `v1:${digest}`,
      "app-v1:other",
    ]);
  });
});

function keyBytes(fill: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(32).fill(fill) as Uint8Array<ArrayBuffer>;
}
