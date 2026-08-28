import { computeTargetingKeyHash, LOCAL_PRIVACY_SALT_FIXTURE } from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { hashedAssignmentIdentity } from "./assignment/assignment-store";
import { makeEnvSaltStore } from "./local-salt-store";

const ROOT = "test-root-secret-do-not-use";
const TARGETING_KEY = "user-123";

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
    expect(await computeTargetingKeyHash(store, input)).toBe(
      "v1:c3c8eb207113cce7a3c68d7091a8daf3f65b1a83fb164822c78114dc06f8f28b",
    );
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
    expect(appA.targetingKeyHash).toBe(
      "v1:c3c8eb207113cce7a3c68d7091a8daf3f65b1a83fb164822c78114dc06f8f28b",
    );
    expect(appB.targetingKeyHash).toBe(
      "v1:a2903009a4ebba676f9a7b8231718dff12e45988a97981c26b07dbab480751d9",
    );
    expect(appA.entityKey).not.toBe(appB.entityKey);
    expect(appA.targetingKeyHash).not.toContain(TARGETING_KEY);
    expect(appB.targetingKeyHash).not.toContain(TARGETING_KEY);
  });

  it("keeps pinned key versions distinct and rejects unknown versions", async () => {
    const store = makeEnvSaltStore({
      EVALUATION_PRIVACY_SALT: ROOT,
      SPLITCH_PLATFORM_TARGET: "production",
    });
    const current = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: TARGETING_KEY,
    });
    expect(current.startsWith("v1:")).toBe(true);
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
