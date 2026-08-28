import { describe, expect, it } from "vitest";
import { appPrivacySaltMessage, deriveAppPrivacySalt } from "./derive-app-salt";
import {
  INGEST_IDENTITY_EPOCH,
  LOCAL_PRIVACY_SALT_FIXTURE,
  makeMemoryIdentitySaltStore,
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
  hashApp1Current: "app-v1:45f18403be72b778d418f62c9a0283fc4ab44bee3bc6fba1a5927543e021c01a",
  hashApp2Current: "app-v1:faeb3e98503b6d0a3d4c3174c6bf9090cd0222b823cdc95d8a3a9a16c9c24450",
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

describe("leftover App-derived hashes", () => {
  const store = makeMemoryIdentitySaltStore({
    rootSecret: ROOT,
    currentKeyVersion: INGEST_IDENTITY_EPOCH,
  });

  it("still recomputes pinned leftover app-v1 hashes for lookup", async () => {
    const leftover = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: "user-123",
      keyVersion: "app-v1",
    });
    const otherApp = await computeTargetingKeyHash(store, {
      appId: "app_2",
      idType: "user",
      targetingKey: "user-123",
      keyVersion: "app-v1",
    });
    expect(leftover).toBe(VECTORS.hashApp1Current);
    expect(otherApp).toBe(VECTORS.hashApp2Current);
    expect(leftover).not.toBe(otherApp);
  });

  it("does not write leftover app-v1 as the current epoch", async () => {
    const current = await computeTargetingKeyHash(store, {
      appId: "app_1",
      idType: "user",
      targetingKey: "user-123",
    });
    expect(current).toBe("v1:485bdba84f840c9627db32bcc99a6f00722b5253754e513ff473c90a8febc588");
    expect(await store.currentKeyVersion("app_1")).toBe(INGEST_IDENTITY_EPOCH);
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
