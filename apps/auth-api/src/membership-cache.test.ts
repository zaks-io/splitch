import { describe, expect, it } from "vitest";
import { mutateMembershipWithCacheInvalidation } from "./membership-cache";

describe("membership cache mutation boundary", () => {
  it("invalidates once after the mutation commits", async () => {
    const events: string[] = [];
    const kv = {
      delete: async (key: string) => {
        events.push(`delete:${key}`);
      },
    } as unknown as KVNamespace;

    await mutateMembershipWithCacheInvalidation(kv, ["user_cache"], async () => {
      events.push("mutation");
    });

    expect(events).toEqual(["mutation", "delete:memberships:user_cache"]);
  });

  it("does not invalidate when the mutation does not commit", async () => {
    let deletes = 0;
    const kv = {
      delete: async () => {
        deletes += 1;
      },
    } as unknown as KVNamespace;

    await expect(
      mutateMembershipWithCacheInvalidation(kv, ["user_cache"], async () => {
        throw new Error("D1 mutation failed");
      }),
    ).rejects.toThrow("D1 mutation failed");
    expect(deletes).toBe(0);
  });
});
