import { describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { purgeEntityBatch } from "./evaluation_state";
import { purgeBatchHandler } from "./integration_cleanup";

describe("Metric Event cleanup", () => {
  it("suppresses queued events before completing Entity deletion", async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const deleteRow = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockResolvedValue("deletion");
    let deletionLookup = 0;
    const query = vi.fn((table: string) =>
      entityCleanupQuery(table, () => {
        deletionLookup += 1;
        return deletionLookup;
      }),
    );
    const ctx = {
      db: { query, insert, patch, delete: deleteRow },
      scheduler: { runAfter: vi.fn() },
    } as unknown as MutationCtx;

    await purgeEntityBatch(ctx, "user", "targeting-key-hash");

    expect(patch).toHaveBeenCalledWith("claim", {
      state: "suppressed",
      completedAt: expect.any(Number),
      lastError: "Entity deletion suppressed delivery",
    });
    expect(deleteRow).toHaveBeenCalledWith("metric-outbox");
    expect(deleteRow).toHaveBeenCalledWith("deletion");
  });

  it("purges local Metric Event payloads before other component tables on uninstall", async () => {
    const deleteRow = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn((table: string) => ({
      take: vi
        .fn()
        .mockResolvedValue(table === "metricEventOutbox" ? [{ _id: "metric-outbox" }] : []),
    }));
    const ctx = { db: { query, delete: deleteRow } } as unknown as MutationCtx;

    await expect(purgeBatchHandler(ctx)).resolves.toBe(1);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("metricEventOutbox");
    expect(deleteRow).toHaveBeenCalledWith("metric-outbox");
  });
});

function metricOutboxQuery() {
  return {
    withIndex: vi.fn((index: string, applyIndex: (query: unknown) => unknown) => {
      let state: string | undefined;
      const indexQuery = {
        eq: vi.fn((field: string, value: unknown) => {
          if (field === "state") state = String(value);
          return indexQuery;
        }),
      };
      applyIndex(indexQuery);
      return {
        first: vi.fn().mockResolvedValue(null),
        take: vi
          .fn()
          .mockResolvedValue(
            index === "by_entity_state" && state === undefined
              ? [{ _id: "metric-outbox", eventId: "event-id" }]
              : [],
          ),
      };
    }),
  };
}

function entityCleanupQuery(table: string, nextDeletionLookup: () => number) {
  if (table === "metricEventOutbox") return metricOutboxQuery();
  if (table === "metricEventClaims") return uniqueQuery({ _id: "claim" });
  if (table === "entityDeletions")
    return uniqueQuery(nextDeletionLookup() === 1 ? null : { _id: "deletion" });
  if (table === "integrations") return uniqueQuery(null);
  return emptyQuery();
}

function uniqueQuery(value: unknown) {
  return { withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(value) })) };
}

function emptyQuery() {
  return {
    withIndex: vi.fn(() => ({
      first: vi.fn().mockResolvedValue(null),
      take: vi.fn().mockResolvedValue([]),
    })),
  };
}
