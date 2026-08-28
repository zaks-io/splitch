import { describe, expect, it } from "vitest";
import {
  activateCompromisedAppIdentityEpoch,
  beginCompromisedAppIdentityRotation,
  makeMemoryAppIdentityStore,
  provisionAppIdentity,
} from "./app-identity-store";
import { makeIdentitySaltStore } from "./derived-salt-store";
import { computeTargetingKeyHash } from "./hash";

const ROOT = "test-root-secret-do-not-use";
const INPUT = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

describe("App identity compromised lifecycle", () => {
  it("blocks current-epoch Evaluation and Event Ingest until activation", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const store = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    const current = await computeTargetingKeyHash(store, INPUT);
    const historical = await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "v1" });

    await beginCompromisedAppIdentityRotation(identityStore, INPUT.appId);

    await expect(store.currentKeyVersion(INPUT.appId)).rejects.toThrow(/traffic is blocked/);
    await expect(computeTargetingKeyHash(store, INPUT)).rejects.toThrow(/traffic is blocked/);
    expect(await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "v1" })).toBe(historical);
    expect(await computeTargetingKeyHash(store, { ...INPUT, keyVersion: "app-v1" })).toBe(current);
  });

  it("refuses activation while the App is still serving traffic", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    await provisionAppIdentity(identityStore, INPUT.appId, ROOT);
    await expect(activateCompromisedAppIdentityEpoch(identityStore, INPUT.appId)).rejects.toThrow(
      /block traffic before activation/,
    );
  });
});
