import { describe, expect, it } from "vitest";
import { mutateMembershipWithCacheInvalidation } from "./membership-cache";

describe("membership cache mutation boundary", () => {
  it("invalidates before the mutation and again after it commits", async () => {
    const events: string[] = [];
    const kv = {
      delete: async (key: string) => {
        events.push(`delete:${key}`);
      },
    } as unknown as KVNamespace;

    await mutateMembershipWithCacheInvalidation(kv, ["user_cache"], async () => {
      events.push("mutation");
    });

    expect(events).toEqual([
      "delete:memberships:user_cache",
      "mutation",
      "delete:memberships:user_cache",
    ]);
  });
});
