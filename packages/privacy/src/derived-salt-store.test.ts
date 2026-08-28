import { describe, expect, it } from "vitest";
import {
  LOCAL_PRIVACY_SALT_FIXTURE,
  makeDerivedSaltStore,
  resolvePrivacyRootSecret,
} from "./derived-salt-store";
import { computeTargetingKeyHash } from "./hash";

const ROOT = "test-root-secret-do-not-use";

describe("makeDerivedSaltStore", () => {
  it("hashes the same Targeting Key identically within one store instance", async () => {
    const store = makeDerivedSaltStore({ rootSecret: ROOT });
    const input = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;
    const first = await computeTargetingKeyHash(store, input);
    expect(await computeTargetingKeyHash(store, input)).toBe(first);
    expect(first.startsWith("app-v1:")).toBe(true);
  });

  it("hashes the same Targeting Key differently across Apps under one root", async () => {
    const store = makeDerivedSaltStore({ rootSecret: ROOT });
    const a = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: "user-123",
    });
    const b = await computeTargetingKeyHash(store, {
      appId: "app_2",
      idType: "user",
      targetingKey: "user-123",
    });
    expect(a).not.toBe(b);
  });

  it("fails loud on an unknown salt version", async () => {
    const store = makeDerivedSaltStore({ rootSecret: ROOT });
    await expect(
      computeTargetingKeyHash(store, {
        appId: "app_1",
        idType: "user",
        targetingKey: "user-123",
        keyVersion: "v9",
      }),
    ).rejects.toThrow(/unknown salt version/);
  });

  it("defaults the current version to the first App identity epoch", async () => {
    const store = makeDerivedSaltStore({ rootSecret: ROOT });
    expect(await store.currentKeyVersion("app_1")).toBe("app-v1");
  });
});

describe("resolvePrivacyRootSecret", () => {
  it("prefers a configured root and uses the local fixture only when allowed", () => {
    expect(
      resolvePrivacyRootSecret({ configuredSalt: "hosted-root", localFixtureAllowed: false }),
    ).toBe("hosted-root");
    expect(resolvePrivacyRootSecret({ localFixtureAllowed: true })).toBe(
      LOCAL_PRIVACY_SALT_FIXTURE,
    );
  });

  it("rejects a missing root when the local fixture is not allowed", () => {
    expect(() => resolvePrivacyRootSecret({ localFixtureAllowed: false })).toThrow(
      /EVALUATION_PRIVACY_SALT/,
    );
    expect(() =>
      resolvePrivacyRootSecret({ configuredSalt: "", localFixtureAllowed: false }),
    ).toThrow(/EVALUATION_PRIVACY_SALT/);
  });
});
