import { describe, expect, it } from "vitest";
import { toHex, utf8Bytes } from "./hmac";
import { parseAppIdentityKeyRecord, unwrapIdentityKey, wrapIdentityKey } from "./wrap-identity-key";

const KEK = "test-root-secret-do-not-use";
const IDENTITY = utf8Bytes(KEK);

describe("wrapIdentityKey", () => {
  it("round-trips the identity key under the wrapping secret", async () => {
    const record = await wrapIdentityKey({
      kekMaterial: KEK,
      identityKey: IDENTITY,
      epochId: "local-v1",
    });
    const unwrapped = await unwrapIdentityKey({ kekMaterial: KEK, record });
    expect(record.schemaVersion).toBe(1);
    expect(record.epochId).toBe("local-v1");
    expect(toHex(unwrapped)).toBe(toHex(IDENTITY));
    expect(record.iv).not.toBe(
      (
        await wrapIdentityKey({
          kekMaterial: KEK,
          identityKey: IDENTITY,
          epochId: "local-v1",
        })
      ).iv,
    );
  });

  it("fails loud when the wrapping secret does not match", async () => {
    const record = await wrapIdentityKey({
      kekMaterial: KEK,
      identityKey: IDENTITY,
      epochId: "v1",
    });
    await expect(unwrapIdentityKey({ kekMaterial: "other-root", record })).rejects.toThrow(
      /failed to unwrap/,
    );
  });

  it("rejects an empty key, empty wrapping secret, or epoch id with a separator", async () => {
    await expect(
      wrapIdentityKey({
        kekMaterial: "",
        identityKey: IDENTITY,
        epochId: "v1",
      }),
    ).rejects.toThrow(/empty identity-key wrapping secret/);
    await expect(
      wrapIdentityKey({
        kekMaterial: KEK,
        identityKey: new Uint8Array() as typeof IDENTITY,
        epochId: "v1",
      }),
    ).rejects.toThrow(/empty App identity key/);
    await expect(
      wrapIdentityKey({
        kekMaterial: KEK,
        identityKey: IDENTITY,
        epochId: "app:v1",
      }),
    ).rejects.toThrow(/invalid identity epoch id/);
  });
});

describe("parseAppIdentityKeyRecord", () => {
  it("accepts a wrapped record and rejects a malformed blob", () => {
    expect(
      parseAppIdentityKeyRecord({
        schemaVersion: 1,
        epochId: "v1",
        iv: "abc",
        ciphertext: "def",
      }),
    ).toEqual({
      schemaVersion: 1,
      epochId: "v1",
      iv: "abc",
      ciphertext: "def",
    });
    expect(() => parseAppIdentityKeyRecord(null)).toThrow(/malformed App identity key record/);
    expect(() =>
      parseAppIdentityKeyRecord({ schemaVersion: 2, epochId: "v1", iv: "a", ciphertext: "b" }),
    ).toThrow(/unknown App identity key record schema/);
  });
});
