import { describe, expect, it, vi } from "vitest";
import { journaledConfigStoreKv } from "./config-store-projection-journal";
import { makeConfigStoreProjectionJournalFixture } from "./config-store-projection-journal-fixture";

describe("Config Store projection registration", () => {
  it("awaits durable registration before publishing a KV value", async () => {
    let finishRegistration: () => void = () => {};
    const registered = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    const put = vi.fn(async () => {});
    const journal = { record: vi.fn(() => registered), list: async () => [] };
    const kv = journaledConfigStoreKv({ put } as unknown as KVNamespace, journal);

    const publication = kv.put("flag:pending", "snapshot");
    expect(journal.record).toHaveBeenCalledWith("flag:pending");
    expect(put).not.toHaveBeenCalled();
    finishRegistration();
    await publication;
    expect(put).toHaveBeenCalledWith("flag:pending", "snapshot");
  });

  it("refuses publication when registration fails", async () => {
    const put = vi.fn(async () => {});
    const journal = {
      record: async () => {
        throw new Error("journal unavailable");
      },
      list: async () => [],
    };
    const kv = journaledConfigStoreKv({ put } as unknown as KVNamespace, journal);

    await expect(kv.put("flag:unregistered", "snapshot")).rejects.toThrow("journal unavailable");
    expect(put).not.toHaveBeenCalled();
  });

  it("retains registered keys after failed publications and failed deletions", async () => {
    const journal = makeConfigStoreProjectionJournalFixture();
    const kv = journaledConfigStoreKv(
      {
        put: async () => {
          throw new Error("KV unavailable");
        },
        delete: async () => {
          throw new Error("delete unavailable");
        },
      } as unknown as KVNamespace,
      journal,
    );

    await expect(kv.put("flag:retry", "snapshot")).rejects.toThrow("KV unavailable");
    await expect(kv.delete("flag:retry")).rejects.toThrow("delete unavailable");
    expect(await journal.list()).toEqual(["flag:retry"]);
  });
});
