/**
 * Durable-shape guarantee: a row destined for a durable Entity store (Assignment
 * Store / Tinybird / entity_deletions) carries `targeting_key_hash`, never the
 * raw Targeting Key. This asserts the contract the privacy lifecycle mandates:
 * KV keys, DO names, Tinybird rows, and ledgers must hold the derived hash only.
 */

import { describe, expect, it } from "vitest";
import { computeTargetingKeyHash, keyVersionOf } from "./hash";
import type { SaltStore } from "./salt-store";

const store: SaltStore = {
  async currentKeyVersion() {
    return "v1";
  },
  async saltFor() {
    // Obvious fake test salt — NOT a real secret.
    return new TextEncoder().encode("test-salt-durable-shape-v1");
  },
};

// Mirrors the entity_deletions durable row (storage-schemas-d1-privacy.md).
interface EntityDeletionRow {
  app_id: string;
  id_type: string;
  targeting_key_hash: string;
  delete_before_ts: string;
}

async function buildDeletionRow(
  appId: string,
  idType: string,
  targetingKey: string,
): Promise<EntityDeletionRow> {
  return {
    app_id: appId,
    id_type: idType,
    targeting_key_hash: await computeTargetingKeyHash(store, { appId, idType, targetingKey }),
    delete_before_ts: "2026-06-28T00:00:00Z",
  };
}

describe("durable Entity shapes", () => {
  it("store the version-prefixed targeting_key_hash, never the raw key", async () => {
    const rawKey = "user@example.com";
    const row = await buildDeletionRow("app_1", "email", rawKey);

    expect(keyVersionOf(row.targeting_key_hash)).toBe("v1");
    const serialized = JSON.stringify(row);
    expect(serialized.includes(rawKey)).toBe(false);
    expect(serialized.includes("user@")).toBe(false);
  });

  it("produce matching hashes for export/delete recomputation of the same Entity", async () => {
    const a = await buildDeletionRow("app_1", "user", "u-1");
    const b = await buildDeletionRow("app_1", "user", "u-1");
    expect(a.targeting_key_hash).toBe(b.targeting_key_hash);
  });
});
