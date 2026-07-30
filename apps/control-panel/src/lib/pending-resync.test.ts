import { describe, expect, it } from "vitest";
import {
  clearPendingResync,
  markPendingResync,
  markPendingResyncBestEffort,
  readPendingResync,
} from "./pending-resync";

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

/** A KV whose every write rejects, for proving `markPendingResyncBestEffort` never throws. */
function failingKv(): KVNamespace {
  return {
    get: (async (_key: string) => null) as KVNamespace["get"],
    put: (async (_key: string, _value: string) => {
      throw new Error("SESSION_STORE unavailable");
    }) as KVNamespace["put"],
    delete: (async (_key: string) => {}) as KVNamespace["delete"],
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

    expect(await readPendingResync(kv, "hash_1", "app")).toEqual({
      resource: "app",
      orgId: "org_1",
      slug: "checkout-api",
      reason: "unknown App role in session materialization",
      remedy: "retry",
    });
  });

  it("returns null when nothing is pending", async () => {
    expect(await readPendingResync(fakeKv(), "hash_missing", "app")).toBeNull();
  });

  it("clears both resource slots so a later reload does not resurface a resolved failure", async () => {
    const kv = fakeKv();
    await markPendingResync(kv, "hash_1", {
      resource: "organization",
      slug: "kiln-works",
      reason: "boom",
      remedy: "retry",
    });
    await markPendingResync(kv, "hash_1", {
      resource: "app",
      orgId: "org_1",
      slug: "checkout-api",
      reason: "boom",
      remedy: "retry",
    });

    await clearPendingResync(kv, "hash_1");

    expect(await readPendingResync(kv, "hash_1", "organization")).toBeNull();
    expect(await readPendingResync(kv, "hash_1", "app")).toBeNull();
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

    expect(await readPendingResync(kv, "hash_b", "app")).toBeNull();
  });

  it("lets an App marker and an Organization marker coexist under the same tokenHash", async () => {
    const kv = fakeKv();
    await markPendingResync(kv, "hash_1", {
      resource: "app",
      orgId: "org_1",
      slug: "checkout-api",
      reason: "app resync failed",
      remedy: "retry",
    });
    await markPendingResync(kv, "hash_1", {
      resource: "organization",
      slug: "kiln-works",
      reason: "org resync failed",
      remedy: "retry",
    });

    // The load-bearing assertion (SPL-203 review round 2, also-fix): the
    // second write must not have clobbered the first's slot.
    expect(await readPendingResync(kv, "hash_1", "app")).toMatchObject({ slug: "checkout-api" });
    expect(await readPendingResync(kv, "hash_1", "organization")).toMatchObject({
      slug: "kiln-works",
    });
  });

  it("markPendingResyncBestEffort never throws, even when the underlying write fails", async () => {
    await expect(
      markPendingResyncBestEffort(failingKv(), "hash_1", {
        resource: "app",
        orgId: "org_1",
        slug: "checkout-api",
        reason: "boom",
        remedy: "retry",
      }),
    ).resolves.toBeUndefined();
  });
});
