import { describe, expect, it } from "vitest";
import { advanceAppIdentityEpoch, makeMemoryAppIdentityStore } from "./app-identity-store";
import {
  DEFAULT_PRIVACY_KEY_VERSION,
  HISTORICAL_SHARED_ROOT_KEY_VERSIONS,
  makeDerivedSaltStore,
  makeIdentitySaltStore,
} from "./derived-salt-store";
import { computeTargetingKeyHash, keyVersionOf } from "./hash";

/** Frozen HMAC-SHA256 vectors. Root secret is a test fixture, not a live secret. */
const ROOT = "test-root-secret-do-not-use";
const INPUT = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

/** Shared-root digest for `HMAC(root, "user:user-123")` — identical across Apps. */
const HISTORICAL_DIGEST = "485bdba84f840c9627db32bcc99a6f00722b5253754e513ff473c90a8febc588";

describe("privacy identity epoch", () => {
  const identityStore = makeMemoryAppIdentityStore();
  const store = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });

  it("keeps retained shared-root hashes comparable under their original prefixes", async () => {
    const evaluation = await computeTargetingKeyHash(store, {
      ...INPUT,
      keyVersion: "local-v1",
    });
    const ingest = await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "v1" });
    const otherApp = await computeTargetingKeyHash(store, {
      ...INPUT,
      appId: "app_2",
      keyVersion: "v1",
    });

    expect(evaluation).toBe(`local-v1:${HISTORICAL_DIGEST}`);
    expect(ingest).toBe(`v1:${HISTORICAL_DIGEST}`);
    expect(otherApp).toBe(`v1:${HISTORICAL_DIGEST}`);
    expect(keyVersionOf(evaluation)).toBe("local-v1");
    expect(keyVersionOf(ingest)).toBe("v1");
    expect(HISTORICAL_SHARED_ROOT_KEY_VERSIONS).toEqual(["local-v1", "v1"]);
  });

  it("does not silently remap retained identities onto the current write epoch", async () => {
    const current = await computeTargetingKeyHash(store, INPUT);
    const historicalIngest = await computeTargetingKeyHash(store, {
      ...INPUT,
      keyVersion: "v1",
    });
    const historicalEvaluation = await computeTargetingKeyHash(store, {
      ...INPUT,
      keyVersion: "local-v1",
    });

    expect(current.startsWith("app-v1:")).toBe(true);
    expect(keyVersionOf(current)).toBe(DEFAULT_PRIVACY_KEY_VERSION);
    expect(current).not.toBe(historicalIngest);
    expect(current).not.toBe(historicalEvaluation);
    expect(current.startsWith("v1:")).toBe(false);
    expect(current.startsWith("local-v1:")).toBe(false);
  });

  it("starts the App identity epoch only after historical prefixes stay reserved", async () => {
    expect(await store.currentKeyVersion(INPUT.appId)).toBe("app-v1");
    expect(DEFAULT_PRIVACY_KEY_VERSION).not.toBe("v1");
    expect(DEFAULT_PRIVACY_KEY_VERSION).not.toBe("local-v1");
  });

  it("keeps the same Targeting Key stable across salt-store reconstruction of one identity store", async () => {
    const first = await computeTargetingKeyHash(store, INPUT);
    const reconstructed = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    expect(await computeTargetingKeyHash(reconstructed, INPUT)).toBe(first);
  });

  it("advances one App independently without changing another App or historical rows", async () => {
    const beforeA = await computeTargetingKeyHash(store, INPUT);
    const beforeB = await computeTargetingKeyHash(store, { ...INPUT, appId: "app_2" });
    const historical = await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "v1" });

    await advanceAppIdentityEpoch(identityStore, INPUT.appId);
    const afterA = await computeTargetingKeyHash(store, INPUT);
    const afterB = await computeTargetingKeyHash(store, { ...INPUT, appId: "app_2" });

    expect(afterA.startsWith("app-v2:")).toBe(true);
    expect(afterA).not.toBe(beforeA);
    expect(afterB).toBe(beforeB);
    expect(await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "app-v1" })).toBe(beforeA);
    expect(await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "v1" })).toBe(historical);
    expect(await store.retainedKeyVersions(INPUT.appId)).toEqual([
      "local-v1",
      "v1",
      "app-v1",
      "app-v2",
    ]);
  });
});

describe("makeDerivedSaltStore", () => {
  it("mints independent current-epoch keys unless callers share an identity store", async () => {
    const first = makeDerivedSaltStore({ rootSecret: ROOT });
    const second = makeDerivedSaltStore({ rootSecret: ROOT });
    const left = await computeTargetingKeyHash(first, INPUT);
    const right = await computeTargetingKeyHash(second, INPUT);
    expect(left.startsWith("app-v1:")).toBe(true);
    expect(right.startsWith("app-v1:")).toBe(true);
    expect(left).not.toBe(right);
  });

  it("rejects making a historical shared-root prefix the current write epoch", () => {
    expect(() => makeDerivedSaltStore({ rootSecret: ROOT, currentKeyVersion: "v1" })).toThrow(
      /historical shared-root/,
    );
    expect(() => makeDerivedSaltStore({ rootSecret: ROOT, currentKeyVersion: "local-v1" })).toThrow(
      /historical shared-root/,
    );
  });
});
