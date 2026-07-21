import { describe, expect, it } from "vitest";
import { accessTokenRevocationKey, accessTokenRevocationTtl } from "./access-token-revocation";

describe("access-token revocation contract", () => {
  it("shares one subject key and Cloudflare KV-safe TTL floor", () => {
    expect(accessTokenRevocationKey("user_local")).toBe("revoked:user_local");
    expect(accessTokenRevocationTtl(1)).toBe(60);
    expect(accessTokenRevocationTtl(60.1)).toBe(61);
  });
});
