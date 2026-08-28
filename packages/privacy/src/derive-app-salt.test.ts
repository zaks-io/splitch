import { describe, expect, it } from "vitest";
import { appPrivacySaltMessage, deriveAppPrivacySalt } from "./derive-app-salt";
import {
  DEFAULT_PRIVACY_KEY_VERSION,
  LOCAL_PRIVACY_SALT_FIXTURE,
  makeDerivedSaltStore,
  resolvePrivacyRootSecret,
} from "./derived-salt-store";
import { computeTargetingKeyHash } from "./hash";
import { toHex, utf8Bytes } from "./hmac";

/** Frozen HMAC-SHA256 vectors. Root secret is a test fixture, not a live secret. */
const ROOT = "test-root-secret-do-not-use";
const VECTORS = {
  saltApp1V1: "c2c6a7099fb4bb90c940cdebddf5780871fa3dcd59c5d5effddf3ebdbf0c6e3a",
  saltApp2V1: "3e38a3ca690b6a34b3a2af293634e6b85a539d08f9d41a9b23d607e5cfe75c75",
  saltApp1V2: "384e0d8ddb66ff8d57684348a6363c5d1111161a8c0883d181694748c5e6b89a",
  hashApp1V1: "v1:c3c8eb207113cce7a3c68d7091a8daf3f65b1a83fb164822c78114dc06f8f28b",
  hashApp2V1: "v1:a2903009a4ebba676f9a7b8231718dff12e45988a97981c26b07dbab480751d9",
  hashApp1V2: "v2:aaa495c63d334b3772f9dfb524a17864c279b0f6b98627799405ba5129258069",
} as const;

describe("deriveAppPrivacySalt", () => {
  it("matches pinned vectors for two Apps and two key versions", async () => {
    expect(
      toHex(await deriveAppPrivacySalt({ rootSecret: ROOT, appId: "app_1", keyVersion: "v1" })),
    ).toBe(VECTORS.saltApp1V1);
    expect(
      toHex(await deriveAppPrivacySalt({ rootSecret: ROOT, appId: "app_2", keyVersion: "v1" })),
    ).toBe(VECTORS.saltApp2V1);
    expect(
      toHex(await deriveAppPrivacySalt({ rootSecret: ROOT, appId: "app_1", keyVersion: "v2" })),
    ).toBe(VECTORS.saltApp1V2);
  });

  it("is stable across routine reads of the same App and version", async () => {
    const first = await deriveAppPrivacySalt({
      rootSecret: ROOT,
      appId: "app_1",
      keyVersion: "v1",
    });
    const second = await deriveAppPrivacySalt({
      rootSecret: utf8Bytes(ROOT),
      appId: "app_1",
      keyVersion: "v1",
    });
    expect(toHex(first)).toBe(toHex(second));
    expect(toHex(first)).toBe(VECTORS.saltApp1V1);
  });

  it("uses a domain-separated derivation message", () => {
    expect(appPrivacySaltMessage("app_1", "v1")).toBe("app-privacy-salt:v1:app_1");
  });

  it("fails loud on empty root, empty App ID, or a separator in labels", async () => {
    await expect(
      deriveAppPrivacySalt({ rootSecret: "", appId: "app_1", keyVersion: "v1" }),
    ).rejects.toThrow(/empty root/);
    await expect(
      deriveAppPrivacySalt({ rootSecret: ROOT, appId: "", keyVersion: "v1" }),
    ).rejects.toThrow(/appId/);
    await expect(
      deriveAppPrivacySalt({ rootSecret: ROOT, appId: "app:1", keyVersion: "v1" }),
    ).rejects.toThrow(/appId/);
    await expect(
      deriveAppPrivacySalt({ rootSecret: ROOT, appId: "app_1", keyVersion: "v:1" }),
    ).rejects.toThrow(/keyVersion/);
  });
});

describe("makeDerivedSaltStore", () => {
  const store = makeDerivedSaltStore({
    rootSecret: ROOT,
    currentKeyVersion: "v1",
    allowedKeyVersions: ["v1", "v2"],
  });

  it("hashes the same Targeting Key identically within one App", async () => {
    const input = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;
    expect(await computeTargetingKeyHash(store, input)).toBe(VECTORS.hashApp1V1);
    expect(await computeTargetingKeyHash(store, input)).toBe(VECTORS.hashApp1V1);
  });

  it("hashes the same Targeting Key differently across Apps under one root", async () => {
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
    expect(a).toBe(VECTORS.hashApp1V1);
    expect(b).toBe(VECTORS.hashApp2V1);
    expect(a).not.toBe(b);
  });

  it("proves key-version behavior: pinned historical versions stay resolvable and distinct", async () => {
    const v1 = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: "user-123",
      keyVersion: "v1",
    });
    const v2 = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: "user-123",
      keyVersion: "v2",
    });
    expect(v1).toBe(VECTORS.hashApp1V1);
    expect(v2).toBe(VECTORS.hashApp1V2);
    expect(v1).not.toBe(v2);
    expect(await store.currentKeyVersion("app_1")).toBe("v1");
  });

  it("fails loud on an unknown salt version", async () => {
    await expect(
      computeTargetingKeyHash(store, {
        appId: "app_1",
        idType: "user",
        targetingKey: "user-123",
        keyVersion: "v9",
      }),
    ).rejects.toThrow(/unknown salt version/);
  });

  it("defaults the current version to v1", async () => {
    const defaulted = makeDerivedSaltStore({ rootSecret: ROOT });
    expect(await defaulted.currentKeyVersion("app_1")).toBe(DEFAULT_PRIVACY_KEY_VERSION);
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
