import { describe, expect, it } from "vitest";
import { memberProfileCacheKey } from "./storage-keys-kv";
import { rememberMemberProfile } from "./storage-schemas-kv";

describe("rememberMemberProfile", () => {
  it("writes MemberProfileCache under member-profile:{userId}", async () => {
    const values = new Map<string, string>();
    await rememberMemberProfile(
      {
        put: async (key, value) => {
          values.set(key, value);
        },
      },
      "user_01ABC",
      "owner@splitch.test",
    );
    expect(values.get(memberProfileCacheKey("user_01ABC"))).toBe(
      JSON.stringify({ email: "owner@splitch.test" }),
    );
  });

  it("rejects an empty email", async () => {
    await expect(
      rememberMemberProfile({ put: async () => {} }, "user_01ABC", ""),
    ).rejects.toThrow();
  });
});
