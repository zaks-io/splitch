import { describe, expect, it } from "vitest";
import {
  EVALUATION_IDENTITY_EPOCH,
  HISTORICAL_SHARED_ROOT_KEY_VERSIONS,
  INGEST_IDENTITY_EPOCH,
  LEFTOVER_APP_DERIVED_KEY_VERSION,
  makeMemoryIdentitySaltStore,
  makePersistedIdentitySaltStore,
} from "./derived-salt-store";
import { computeTargetingKeyHash, keyVersionOf, targetingKeyHashesForLookup } from "./hash";
import { toHex } from "./hmac";
import {
  makeMemoryIdentityKeyPersist,
  mintAppIdentityEpoch,
  rewrapAppIdentityKey,
} from "./identity-key-persist";

/** Frozen HMAC-SHA256 vectors. Root secret is a test fixture, not a live secret. */
const ROOT = "test-root-secret-do-not-use";
const NEXT_KEK = "rotated-root-secret-do-not-use";
const INPUT = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

/** Shared-root digest for `HMAC(root, "user:user-123")` — identical across Apps. */
const HISTORICAL_DIGEST = "485bdba84f840c9627db32bcc99a6f00722b5253754e513ff473c90a8febc588";
const LEFTOVER_APP_1 = "app-v1:45f18403be72b778d418f62c9a0283fc4ab44bee3bc6fba1a5927543e021c01a";

describe("privacy identity epoch", () => {
  it("bootstraps the persisted key from the root so retained hashes stay comparable", async () => {
    const evaluation = makeMemoryIdentitySaltStore({
      rootSecret: ROOT,
      currentKeyVersion: EVALUATION_IDENTITY_EPOCH,
    });
    const ingest = makeMemoryIdentitySaltStore({
      rootSecret: ROOT,
      currentKeyVersion: INGEST_IDENTITY_EPOCH,
    });

    expect(await computeTargetingKeyHash(evaluation, INPUT)).toBe(`local-v1:${HISTORICAL_DIGEST}`);
    expect(await computeTargetingKeyHash(ingest, INPUT)).toBe(`v1:${HISTORICAL_DIGEST}`);
    expect(await computeTargetingKeyHash(evaluation, { ...INPUT, appId: "app_2" })).toBe(
      `local-v1:${HISTORICAL_DIGEST}`,
    );
    expect(await evaluation.currentKeyVersion(INPUT.appId)).toBe(EVALUATION_IDENTITY_EPOCH);
    expect(await ingest.currentKeyVersion(INPUT.appId)).toBe(INGEST_IDENTITY_EPOCH);
    expect(HISTORICAL_SHARED_ROOT_KEY_VERSIONS).toEqual(["local-v1", "v1"]);
  });

  it("keeps pinned historical prefixes on the shared-root algorithm after mint", async () => {
    const persist = makeMemoryIdentityKeyPersist();
    await mintAppIdentityEpoch({
      persist,
      appId: INPUT.appId,
      kekMaterial: ROOT,
      epochId: "epoch-2",
    });
    const store = makePersistedIdentitySaltStore({
      persist,
      rootSecret: ROOT,
      currentKeyVersion: EVALUATION_IDENTITY_EPOCH,
    });
    const current = await computeTargetingKeyHash(store, INPUT);
    const historical = await computeTargetingKeyHash(store, {
      ...INPUT,
      keyVersion: "local-v1",
    });

    expect(current.startsWith("epoch-2:")).toBe(true);
    expect(historical).toBe(`local-v1:${HISTORICAL_DIGEST}`);
    expect(current).not.toBe(historical);
    expect(keyVersionOf(current)).toBe("epoch-2");
  });

  it("mints isolated per-App keys under one wrapping secret", async () => {
    const persist = makeMemoryIdentityKeyPersist();
    const first = await mintAppIdentityEpoch({
      persist,
      appId: "app_1",
      kekMaterial: ROOT,
      epochId: "epoch-a",
    });
    const second = await mintAppIdentityEpoch({
      persist,
      appId: "app_2",
      kekMaterial: ROOT,
      epochId: "epoch-b",
    });
    const store = makePersistedIdentitySaltStore({
      persist,
      rootSecret: ROOT,
      currentKeyVersion: EVALUATION_IDENTITY_EPOCH,
    });
    const app1 = await computeTargetingKeyHash(store, { ...INPUT, appId: "app_1" });
    const app2 = await computeTargetingKeyHash(store, { ...INPUT, appId: "app_2" });

    expect(toHex(first.identityKey)).not.toBe(toHex(second.identityKey));
    expect(app1).not.toBe(app2);
    expect(app1.startsWith("epoch-a:")).toBe(true);
    expect(app2.startsWith("epoch-b:")).toBe(true);
  });

  it("preserves the identity key and hashes across KEK rewrap", async () => {
    const persist = makeMemoryIdentityKeyPersist();
    const minted = await mintAppIdentityEpoch({
      persist,
      appId: INPUT.appId,
      kekMaterial: ROOT,
      epochId: "epoch-2",
    });
    const before = makePersistedIdentitySaltStore({
      persist,
      rootSecret: ROOT,
      currentKeyVersion: EVALUATION_IDENTITY_EPOCH,
    });
    const hashBefore = await computeTargetingKeyHash(before, INPUT);
    const rewrapped = await rewrapAppIdentityKey({
      persist,
      appId: INPUT.appId,
      previousKekMaterial: ROOT,
      currentKekMaterial: NEXT_KEK,
    });
    const after = makePersistedIdentitySaltStore({
      persist,
      rootSecret: NEXT_KEK,
      currentKeyVersion: EVALUATION_IDENTITY_EPOCH,
    });

    expect(toHex(rewrapped.identityKey)).toBe(toHex(minted.identityKey));
    expect(rewrapped.epochId).toBe("epoch-2");
    expect(await computeTargetingKeyHash(after, INPUT)).toBe(hashBefore);
    await expect(
      computeTargetingKeyHash(
        makePersistedIdentitySaltStore({
          persist,
          rootSecret: ROOT,
          currentKeyVersion: EVALUATION_IDENTITY_EPOCH,
        }),
        INPUT,
      ),
    ).rejects.toThrow(/failed to unwrap/);
  });

  it("lists leftover app-v1 hashes for lookup without writing them", async () => {
    const store = makeMemoryIdentitySaltStore({
      rootSecret: ROOT,
      currentKeyVersion: INGEST_IDENTITY_EPOCH,
    });
    const hashes = await targetingKeyHashesForLookup(store, INPUT);
    const current = await computeTargetingKeyHash(store, INPUT);

    expect(current).toBe(`v1:${HISTORICAL_DIGEST}`);
    expect(hashes).toEqual([
      `v1:${HISTORICAL_DIGEST}`,
      `local-v1:${HISTORICAL_DIGEST}`,
      LEFTOVER_APP_1,
    ]);
    expect(LEFTOVER_APP_1.startsWith(`${LEFTOVER_APP_DERIVED_KEY_VERSION}:`)).toBe(true);
    expect(await store.currentKeyVersion(INPUT.appId)).toBe(INGEST_IDENTITY_EPOCH);
  });
});
