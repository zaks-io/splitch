import { describe, expect, it } from "vitest";
import { clearPendingResync, markPendingResync, readPendingResync } from "./pending-resync";

/** The three operations this module actually calls, nothing more. */
function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (async (key: string) => store.get(key) ?? null) as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      store.set(key, value);
    }) as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key);
    }) as KVNamespace["delete"],
  } as KVNamespace;
}

describe("pending resync marker", () => {
  it("round-trips an App marker", async () => {
    const kv = fakeKv();
    await markPendingResync(kv, "hash_1", {
      resource: "app",
      orgId: "org_1",
      slug: "checkout-api",
      reason: "unknown App role in session materialization",
      remedy: "retry",
    });

    expect(await readPendingResync(kv, "hash_1")).toEqual({
      resource: "app",
      orgId: "org_1",
      slug: "checkout-api",
      reason: "unknown App role in session materialization",
      remedy: "retry",
    });
  });

  it("returns null when nothing is pending", async () => {
    expect(await readPendingResync(fakeKv(), "hash_missing")).toBeNull();
  });

  it("clears the marker so a later reload does not resurface a resolved failure", async () => {
    const kv = fakeKv();
    await markPendingResync(kv, "hash_1", {
      resource: "organization",
      slug: "kiln-works",
      reason: "boom",
      remedy: "retry",
    });

    await clearPendingResync(kv, "hash_1");

    expect(await readPendingResync(kv, "hash_1")).toBeNull();
  });

  it("does not scope by tokenHash accidentally: a different session sees nothing", async () => {
    const kv = fakeKv();
    await markPendingResync(kv, "hash_a", {
      resource: "app",
      orgId: "org_1",
      slug: "checkout-api",
      reason: "boom",
      remedy: "retry",
    });

    expect(await readPendingResync(kv, "hash_b")).toBeNull();
  });
});
