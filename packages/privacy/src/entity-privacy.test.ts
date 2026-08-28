import { describe, expect, it } from "vitest";
import { advanceAppIdentityEpoch, makeMemoryAppIdentityStore } from "./app-identity-store";
import { makeIdentitySaltStore } from "./derived-salt-store";
import {
  analysisRowsForEntity,
  canonicalizeAnalysisEntityHash,
  computeRetainedTargetingKeyHashes,
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

  it("joins analysis rows written under every retained epoch", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const store = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    const v1 = await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "v1" });
    const current = await computeTargetingKeyHash(store, INPUT);
    await advanceAppIdentityEpoch(identityStore, INPUT.appId);
    const next = await computeTargetingKeyHash(store, INPUT);
    const hashes = await computeRetainedTargetingKeyHashes(store, INPUT);

    const rows = analysisRowsForEntity(
      [
        { targeting_key_hash: v1, metric: "signup" },
        { targeting_key_hash: current, metric: "checkout" },
        { targeting_key_hash: next, metric: "refund" },
        { targeting_key_hash: "app-v1:deadbeef", metric: "other-entity" },
      ],
      hashes,
    );

    expect(rows.map((row) => row.metric)).toEqual(["signup", "checkout", "refund"]);
    expect(hashes).toContain(v1);
    expect(hashes).toContain(current);
    expect(hashes).toContain(next);
  });

  it("fails loud when analysis is asked to canonicalize an empty hash set", () => {
    expect(() => canonicalizeAnalysisEntityHash([])).toThrow(/no retained/);
  });
});
