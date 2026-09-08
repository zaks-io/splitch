import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import type { EntityPrivacyConsumer } from "./entity-privacy-consumer";
import { initialEntityDeleteStoreStatus, runEntityDeleteJob } from "./entity-privacy-delete-job";

const entity = {
  appId: "app_privacy_delete",
  idType: "user",
  targetingKeyHashes: ["app-v1:subject"],
  entityFamilyHash: "app-v1:subject",
  actorId: "user_admin",
  orgId: "org_privacy_delete",
  requestId: "prv_delete",
};

describe("Entity privacy delete job", () => {
  it("renews its fenced lease around every effect and checkpoints each store", async () => {
    const effects: string[] = [];
    const updates: Array<{ status: string; storeStatusJson: string }> = [];
    const renewLease = vi.fn(async () => undefined);
    const repo = repository(updates);
    await runEntityDeleteJob({
      repo,
      coordinator: {
        async recordEntityDeletionSuppression() {
          effects.push("d1-tombstone");
        },
      },
      consumer: consumer(effects),
      input: entity,
      identity: entity,
      requestId: entity.requestId,
      job: {
        status: "running",
        storeStatusJson: JSON.stringify(initialEntityDeleteStoreStatus()),
        deleteBeforeTs: "2026-07-18T12:00:00.000Z",
        identityVersion: "app-v1",
      },
      renewLease,
    });

    expect(effects).toEqual([
      "analysis-suppression",
      "event-ingest-suppression",
      "d1-tombstone",
      "assignments",
      "analysis",
      "event-ingest",
    ]);
    expect(renewLease).toHaveBeenCalledTimes(effects.length * 2);
    expect(updates).toHaveLength(effects.length + 1);
    expect(updates.at(-1)?.status).toBe("completed");
    expect(Object.values(JSON.parse(updates.at(-1)?.storeStatusJson ?? "{}"))).toEqual(
      Array(effects.length).fill("done"),
    );
  });

  it("does not checkpoint an effect after losing its lease", async () => {
    const effects: string[] = [];
    const updates: Array<{ status: string; storeStatusJson: string }> = [];
    const renewLease = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("privacy job lease was lost"));

    await expect(
      runEntityDeleteJob({
        repo: repository(updates),
        coordinator: { recordEntityDeletionSuppression: async () => undefined },
        consumer: consumer(effects),
        input: entity,
        identity: entity,
        requestId: entity.requestId,
        job: {
          status: "running",
          storeStatusJson: JSON.stringify(initialEntityDeleteStoreStatus()),
          deleteBeforeTs: "2026-07-18T12:00:00.000Z",
          identityVersion: "app-v1",
        },
        renewLease,
      }),
    ).rejects.toThrow("privacy job lease was lost");

    expect(effects).toEqual(["analysis-suppression"]);
    expect(updates).toHaveLength(0);
  });
});

function repository(updates: Array<{ status: string; storeStatusJson: string }>): Repository {
  return {
    privacy: {
      async updatePrivacyJob(input: { status: string; storeStatusJson: string }) {
        updates.push(input);
        return {};
      },
    },
  } as unknown as Repository;
}

function consumer(effects: string[]): EntityPrivacyConsumer {
  const result = () => ({ ...entity, proofs: [] });
  return {
    async suppressAnalysis() {
      effects.push("analysis-suppression");
      return result();
    },
    async suppressEvents() {
      effects.push("event-ingest-suppression");
      return result();
    },
    async deleteAssignments() {
      effects.push("assignments");
      return { ...result(), deletedKeyCount: 1, deletedWriterCount: 1, deletedOutboxCount: 1 };
    },
    async deleteAnalysis() {
      effects.push("analysis");
      return result();
    },
    async deleteEvents() {
      effects.push("event-ingest");
      return result();
    },
  } as EntityPrivacyConsumer;
}
