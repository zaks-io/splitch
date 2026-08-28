import {
  computeTargetingKeyHash,
  LOCAL_PRIVACY_SALT_FIXTURE,
  makeMemoryAppIdentityStore,
} from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { hashedAssignmentIdentity } from "./assignment/assignment-store";
import { makeEnvSaltStore } from "./local-salt-store";

const ROOT = "test-root-secret-do-not-use";
const TARGETING_KEY = "user-123";
const HISTORICAL_LOCAL =
  "local-v1:485bdba84f840c9627db32bcc99a6f00722b5253754e513ff473c90a8febc588";

describe("makeEnvSaltStore", () => {
  it("hashes the same Targeting Key identically within one App", async () => {
    const store = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: ROOT,
      SPLITCH_PLATFORM_TARGET: "production",
    });
    const input = { appId: "app_1", idType: "user", targetingKey: TARGETING_KEY };
    const first = await computeTargetingKeyHash(store, input);
    expect(await computeTargetingKeyHash(store, input)).toBe(first);
    expect(first.startsWith("app-v1:")).toBe(true);
    expect(first).not.toContain(TARGETING_KEY);
  });

  it("hashes the same Targeting Key differently in two Apps under one deployment secret", async () => {
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
    expect(appA.targetingKeyHash.startsWith("app-v1:")).toBe(true);
    expect(appB.targetingKeyHash.startsWith("app-v1:")).toBe(true);
    expect(appA.entityKey).not.toBe(appB.entityKey);
    expect(appA.targetingKeyHash).not.toBe(appB.targetingKeyHash);
    expect(appA.targetingKeyHash).not.toContain(TARGETING_KEY);
    expect(appB.targetingKeyHash).not.toContain(TARGETING_KEY);
  });

  it("keeps pinned historical versions distinct and rejects unknown versions", async () => {
    const store = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: ROOT,
      SPLITCH_PLATFORM_TARGET: "production",
    });
    const current = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: TARGETING_KEY,
    });
    expect(current.startsWith("app-v1:")).toBe(true);
    const historical = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: TARGETING_KEY,
      keyVersion: "local-v1",
    });
    expect(historical).toBe(HISTORICAL_LOCAL);
    expect(historical).not.toBe(current);
    await expect(
      computeTargetingKeyHash(store, {
        appId: "app_1",
        idType: "user",
        targetingKey: TARGETING_KEY,
        keyVersion: "v2",
      }),
    ).rejects.toThrow(/unknown salt version/);
  });

  it("uses the committed local fixture only for explicit local and pr-ci historical hashes", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const localStore = makeEnvSaltStore({
      SPLITCH_PLATFORM_TARGET: "local",
      identityStore,
    });
    const prCiStore = makeEnvSaltStore({
      SPLITCH_PLATFORM_TARGET: "pr-ci",
      identityStore,
    });
    const configuredLocal = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: LOCAL_PRIVACY_SALT_FIXTURE,
      SPLITCH_PLATFORM_TARGET: "local",
      identityStore,
    });
    const input = { appId: "app_1", idType: "user", targetingKey: TARGETING_KEY };
    const historical = { ...input, keyVersion: "local-v1" as const };
    expect(await computeTargetingKeyHash(localStore, historical)).toBe(
      await computeTargetingKeyHash(prCiStore, historical),
    );
    expect(await computeTargetingKeyHash(localStore, historical)).toBe(
      await computeTargetingKeyHash(configuredLocal, historical),
    );
    expect(await computeTargetingKeyHash(localStore, input)).toBe(
      await computeTargetingKeyHash(prCiStore, input),
    );
    expect(await computeTargetingKeyHash(localStore, historical)).not.toBe(
      await computeTargetingKeyHash(
        makeEnvSaltStore({
          EVALUATION_PRIVACY_SALT: ROOT,
          SPLITCH_PLATFORM_TARGET: "local",
        }),
        historical,
      ),
    );
  });

  it("persists the current App identity key in CONFIG_STORE across store instances", async () => {
    const values = new Map<string, string>();
    const configStore = {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
    };
    const first = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: ROOT,
      SPLITCH_PLATFORM_TARGET: "production",
      CONFIG_STORE: configStore,
    });
    const input = { appId: "app_1", idType: "user", targetingKey: TARGETING_KEY };
    const hash = await computeTargetingKeyHash(first, input);
    const second = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: ROOT,
      SPLITCH_PLATFORM_TARGET: "production",
      CONFIG_STORE: configStore,
    });
    expect(await computeTargetingKeyHash(second, input)).toBe(hash);
    expect(values.size).toBe(1);
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
