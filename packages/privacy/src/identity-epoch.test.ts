import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRIVACY_KEY_VERSION,
  HISTORICAL_SHARED_ROOT_KEY_VERSIONS,
  makeDerivedSaltStore,
} from "./derived-salt-store";
import { computeTargetingKeyHash, keyVersionOf } from "./hash";

/** Frozen HMAC-SHA256 vectors. Root secret is a test fixture, not a live secret. */
const ROOT = "test-root-secret-do-not-use";
const INPUT = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

/** Shared-root digest for `HMAC(root, "user:user-123")` — identical across Apps. */
const HISTORICAL_DIGEST = "485bdba84f840c9627db32bcc99a6f00722b5253754e513ff473c90a8febc588";

describe("privacy identity epoch", () => {
  const store = makeDerivedSaltStore({ rootSecret: ROOT });

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

    expect(current).toBe("app-v1:45f18403be72b778d418f62c9a0283fc4ab44bee3bc6fba1a5927543e021c01a");
    expect(keyVersionOf(current)).toBe(DEFAULT_PRIVACY_KEY_VERSION);
    expect(current).not.toBe(historicalIngest);
    expect(current).not.toBe(historicalEvaluation);
    expect(current.startsWith("v1:")).toBe(false);
    expect(current.startsWith("local-v1:")).toBe(false);
  });

  it("starts the App-derived epoch only after historical prefixes stay reserved", async () => {
    expect(await store.currentKeyVersion(INPUT.appId)).toBe("app-v1");
    expect(DEFAULT_PRIVACY_KEY_VERSION).not.toBe("v1");
    expect(DEFAULT_PRIVACY_KEY_VERSION).not.toBe("local-v1");
  });
});
