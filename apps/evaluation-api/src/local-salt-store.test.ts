import {
  computeTargetingKeyHash,
  LOCAL_PRIVACY_SALT_FIXTURE,
  makeMemoryIdentityKeyPersist,
  makePersistedIdentitySaltStore,
  mintAppIdentityEpoch,
} from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { hashedAssignmentIdentity } from "./assignment/assignment-store";
import { makeEnvSaltStore } from "./local-salt-store";

const ROOT = "test-root-secret-do-not-use";
const TARGETING_KEY = "user-123";
const HISTORICAL = "local-v1:485bdba84f840c9627db32bcc99a6f00722b5253754e513ff473c90a8febc588";

describe("makeEnvSaltStore", () => {
  it("hashes the same Targeting Key identically within one App", async () => {
    const store = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: ROOT,
      SPLITCH_PLATFORM_TARGET: "production",
    });
    const input = { appId: "app_1", idType: "user", targetingKey: TARGETING_KEY };
    expect(await computeTargetingKeyHash(store, input)).toBe(
      await computeTargetingKeyHash(store, input),
    );
    expect(await computeTargetingKeyHash(store, input)).toBe(HISTORICAL);
  });

  it("bootstraps a shared-root compat epoch until each App identity key is minted", async () => {
    const store = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: ROOT,
      SPLITCH_PLATFORM_TARGET: "shared-preview",
    });
    const appA = await hashedAssignmentIdentity(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: TARGETING_KEY,
    });
    const appB = await hashedAssignmentIdentity(store, {
      appId: "app_2",
      idType: "user",
      targetingKey: TARGETING_KEY,
    });
    expect(appA.targetingKeyHash).toBe(HISTORICAL);
    expect(appB.targetingKeyHash).toBe(HISTORICAL);
    expect(appA.entityKey).not.toBe(appB.entityKey);
    expect(appA.targetingKeyHash).not.toContain(TARGETING_KEY);
  });

  it("isolates two Apps after minting independent identity keys under one KEK", async () => {
    const persist = makeMemoryIdentityKeyPersist();
    await mintAppIdentityEpoch({
      persist,
      appId: "app_1",
      kekMaterial: ROOT,
      epochId: "epoch-a",
    });
    await mintAppIdentityEpoch({
      persist,
      appId: "app_2",
      kekMaterial: ROOT,
      epochId: "epoch-b",
    });
    const store = makePersistedIdentitySaltStore({
      persist,
      rootSecret: ROOT,
      currentKeyVersion: "local-v1",
    });
    const appA = await hashedAssignmentIdentity(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: TARGETING_KEY,
    });
    const appB = await hashedAssignmentIdentity(store, {
      appId: "app_2",
      idType: "user",
      targetingKey: TARGETING_KEY,
    });
    expect(appA.targetingKeyHash).not.toBe(appB.targetingKeyHash);
    expect(appA.targetingKeyHash.startsWith("epoch-a:")).toBe(true);
    expect(appB.targetingKeyHash.startsWith("epoch-b:")).toBe(true);
  });

  it("keeps historical prefixes resolvable and rejects unknown versions", async () => {
    const store = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: ROOT,
      SPLITCH_PLATFORM_TARGET: "production",
    });
    const current = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: TARGETING_KEY,
    });
    expect(current).toBe(HISTORICAL);
    const leftover = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: TARGETING_KEY,
      keyVersion: "app-v1",
    });
    expect(leftover).toBe(
      "app-v1:45f18403be72b778d418f62c9a0283fc4ab44bee3bc6fba1a5927543e021c01a",
    );
    expect(leftover).not.toBe(current);
    await expect(
      computeTargetingKeyHash(store, {
        appId: "app_1",
        idType: "user",
        targetingKey: TARGETING_KEY,
        keyVersion: "v2",
      }),
    ).rejects.toThrow(/unknown salt version/);
  });

  it("uses the committed local fixture only for explicit local and pr-ci targets", async () => {
    const localStore = makeEnvSaltStore({ SPLITCH_PLATFORM_TARGET: "local" });
    const prCiStore = makeEnvSaltStore({ SPLITCH_PLATFORM_TARGET: "pr-ci" });
    const configuredLocal = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: LOCAL_PRIVACY_SALT_FIXTURE,
      SPLITCH_PLATFORM_TARGET: "local",
    });
    const input = { appId: "app_1", idType: "user", targetingKey: TARGETING_KEY };
    const localHash = await computeTargetingKeyHash(localStore, input);
    expect(localHash).toBe(await computeTargetingKeyHash(prCiStore, input));
    expect(localHash).toBe(await computeTargetingKeyHash(configuredLocal, input));
    expect(localHash.startsWith("local-v1:")).toBe(true);
    expect(localHash).not.toBe(
      await computeTargetingKeyHash(
        makeEnvSaltStore({
          EVALUATION_PRIVACY_SALT: ROOT,
          SPLITCH_PLATFORM_TARGET: "local",
        }),
        input,
      ),
    );
  });

  it("fails closed when the platform target or hosted root salt is missing", () => {
    expect(() => makeEnvSaltStore({})).toThrow(/SPLITCH_PLATFORM_TARGET is required/);
    expect(() => makeEnvSaltStore({ SPLITCH_PLATFORM_TARGET: "staging" })).toThrow(
      /not a platform target/,
    );
    expect(() => makeEnvSaltStore({ SPLITCH_PLATFORM_TARGET: "shared-preview" })).toThrow(
      /EVALUATION_PRIVACY_SALT/,
    );
    expect(() => makeEnvSaltStore({ SPLITCH_PLATFORM_TARGET: "production" })).toThrow(
      /EVALUATION_PRIVACY_SALT/,
    );
    expect(() =>
      makeEnvSaltStore({
        EVALUATION_PRIVACY_SALT: "",
        SPLITCH_PLATFORM_TARGET: "production",
      }),
    ).toThrow(/EVALUATION_PRIVACY_SALT/);
  });
});
