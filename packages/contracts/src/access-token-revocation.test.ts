import { describe, expect, it } from "vitest";
import {
  accessTokenIssuedAt,
  accessTokenRevocationKey,
  accessTokenRevocationMarker,
  accessTokenRevocationTtl,
  isAccessTokenRevoked,
  readAccessTokenRevocation,
} from "./access-token-revocation";

const REVOKED_AT = 1_790_000_000;

describe("access-token revocation contract", () => {
  it("shares one subject key and Cloudflare KV-safe TTL floor", () => {
    expect(accessTokenRevocationKey("user_local")).toBe("revoked:user_local");
    expect(accessTokenRevocationTtl(1)).toBe(60);
    expect(accessTokenRevocationTtl(60.1)).toBe(61);
  });

  it("revokes tokens issued at or before the revocation and admits later ones", () => {
    const marker = accessTokenRevocationMarker(REVOKED_AT);

    expect(isAccessTokenRevoked(marker, REVOKED_AT - 1)).toBe(true);
    expect(isAccessTokenRevoked(marker, REVOKED_AT)).toBe(true);
    expect(isAccessTokenRevoked(marker, REVOKED_AT + 1)).toBe(false);
    expect(isAccessTokenRevoked(null, REVOKED_AT - 1)).toBe(false);
  });

  it("keeps a token without iat revoked while a marker exists", () => {
    expect(isAccessTokenRevoked(accessTokenRevocationMarker(REVOKED_AT), undefined)).toBe(true);
  });

  it("treats a legacy marker as revoking every token", () => {
    expect(isAccessTokenRevoked("1", REVOKED_AT + 1)).toBe(true);
  });

  it("fails loud on a malformed marker before applying the iat rule", () => {
    for (const marker of ["yes", "0", "0123", "-5", ""]) {
      expect(() => isAccessTokenRevoked(marker, REVOKED_AT + 1)).toThrow(/malformed/);
      expect(() => isAccessTokenRevoked(marker, undefined)).toThrow(/malformed/);
    }
    expect(() => accessTokenRevocationMarker(REVOKED_AT + 0.5)).toThrow(/invalid/);
    expect(() => accessTokenRevocationMarker(1)).toThrow(/invalid/);
  });

  it("reads the subject's marker and carries only a numeric iat", async () => {
    const entries = new Map([[accessTokenRevocationKey("user_kv"), String(REVOKED_AT)]]);
    const source = { get: async (key: string) => entries.get(key) ?? null };

    await expect(readAccessTokenRevocation(source, "user_kv", REVOKED_AT)).resolves.toBe(true);
    await expect(readAccessTokenRevocation(source, "user_kv", REVOKED_AT + 1)).resolves.toBe(false);
    await expect(readAccessTokenRevocation(source, "user_other", REVOKED_AT)).resolves.toBe(false);
    expect(accessTokenIssuedAt({ iat: REVOKED_AT })).toEqual({ issuedAt: REVOKED_AT });
    expect(accessTokenIssuedAt({ iat: String(REVOKED_AT) })).toEqual({});
  });
});
