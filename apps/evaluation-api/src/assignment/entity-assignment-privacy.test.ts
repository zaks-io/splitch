import { assignmentKey } from "@splitch/contracts";
import {
  analysisRowsForEntity,
  canonicalizeAnalysisEntityHash,
  computeRetainedTargetingKeyHashes,
  computeTargetingKeyHash,
  makeDerivedSaltStore,
} from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { serializeAssignmentValue } from "./assignment-store";
import { basePut, RAW_TARGETING_KEY, RecordingKv } from "./assignment-store-test-fixtures";
import { deleteEntityAssignments, exportEntityAssignments } from "./entity-assignment-privacy";

const ROOT = "test-root-secret-do-not-use";

describe("entity assignment privacy consumers", () => {
  it("exports and deletes every retained-epoch Assignment Store blob", async () => {
    const saltStore = makeDerivedSaltStore({ rootSecret: ROOT });
    const identity = {
      appId: basePut.appId,
      idType: basePut.idType,
      targetingKey: basePut.targetingKey,
    };
    const historical = await computeTargetingKeyHash(saltStore, {
      ...identity,
      keyVersion: "local-v1",
    });
    const current = await computeTargetingKeyHash(saltStore, identity);
    const kv = new RecordingKv();
    kv.putRaw(
      assignmentKey(identity.appId, identity.idType, historical),
      serializeAssignmentValue({ "exp-old": { runId: "run-old", variant: "control" } }),
    );
    kv.putRaw(
      assignmentKey(identity.appId, identity.idType, current),
      serializeAssignmentValue({ "exp-new": { runId: "run-new", variant: "treatment" } }),
    );

    const deletionCalls: string[] = [];
    const deleteBodies: unknown[] = [];
    const outboxes = holdoverOutboxes({ historical, deletionCalls, deleteBodies });
    const writers = assignmentWriters(deletionCalls, kv, {
      [current]: { "exp-writer-only": { runId: "run-writer", variant: "treatment" } },
    });
    const exported = await exportEntityAssignments(kv, writers, outboxes, saltStore, identity);
    expect(exported.records).toEqual([
      {
        targetingKeyHash: historical,
        assignments: { "exp-old": { runId: "run-old", variant: "control" } },
        assignmentWriterAssignments: {},
        holdoverWrites: [
          expect.objectContaining({
            experimentId: "exp-old",
            targetingKeyHash: historical,
            status: "pending",
          }),
        ],
        holdoverSuppression: null,
      },
      {
        targetingKeyHash: current,
        assignments: { "exp-new": { runId: "run-new", variant: "treatment" } },
        assignmentWriterAssignments: {
          "exp-writer-only": { runId: "run-writer", variant: "treatment" },
        },
        holdoverWrites: [],
        holdoverSuppression: null,
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain(RAW_TARGETING_KEY);

    const deleted = await deleteEntityAssignments(
      writers,
      outboxes,
      saltStore,
      identity,
      "2026-07-18T12:00:00.000Z",
    );
    expect(deleted.deletedKeyCount).toBe(deleted.targetingKeyHashes.length);
    expect(deleted.deletedWriterCount).toBe(deleted.targetingKeyHashes.length);
    expect(deleted.deletedOutboxCount).toBe(deleted.targetingKeyHashes.length);
    expect(deletionCalls).toEqual(
      deleted.targetingKeyHashes.flatMap((hash) => [`writer:${hash}`, `outbox:${hash}`]),
    );
    expect(deleteBodies).toEqual(
      deleted.targetingKeyHashes.map((targetingKeyHash) => ({
        appId: identity.appId,
        idType: identity.idType,
        targetingKeyHash,
        deleteBeforeTsMs: Date.parse("2026-07-18T12:00:00.000Z"),
      })),
    );
    expect(kv.has(assignmentKey(identity.appId, identity.idType, historical))).toBe(false);
    expect(kv.has(assignmentKey(identity.appId, identity.idType, current))).toBe(false);
    expect(JSON.stringify(deleted)).not.toContain(RAW_TARGETING_KEY);

    const hashes = await computeRetainedTargetingKeyHashes(saltStore, identity);
    const joined = analysisRowsForEntity(
      [
        { targeting_key_hash: historical, runId: "run-old" },
        { targeting_key_hash: current, runId: "run-new" },
        { targeting_key_hash: "app-v1:other-entity", runId: "other" },
      ],
      hashes,
    );
    expect(joined.map((row) => row.runId)).toEqual(["run-old", "run-new"]);
    expect(canonicalizeAnalysisEntityHash(hashes)).toBe(current);
  });

  it("does not unregister an Entity outbox when the writer tombstone fails", async () => {
    const saltStore = makeDerivedSaltStore({ rootSecret: ROOT });
    const calls: string[] = [];
    const identity = {
      appId: basePut.appId,
      idType: basePut.idType,
      targetingKey: basePut.targetingKey,
    };

    await expect(
      deleteEntityAssignments(
        failingAssignmentWriters(calls),
        holdoverOutboxes({ historical: "none", deletionCalls: calls, deleteBodies: [] }),
        saltStore,
        identity,
        "2026-07-18T12:00:00.000Z",
      ),
    ).rejects.toThrow("Assignment writer delete failed with HTTP 503");
    expect(calls).toEqual([expect.stringMatching(/^writer:/u)]);
  });
});

function assignmentWriters(
  calls: string[],
  kv: RecordingKv,
  exports: Record<string, Record<string, { runId: string; variant: string }>> = {},
) {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
        const hash = targetingHashFromName(String(id));
        if (new URL(String(request)).pathname === "/export") {
          return Response.json({
            assignments: exports[hash] ?? {},
            tombstoned: false,
            proof: "assignment-do-winners-exported-v1",
          });
        }
        calls.push(`writer:${hash}`);
        const body = JSON.parse(String(init?.body)) as {
          appId: string;
          idType: string;
          targetingKeyHash: string;
        };
        await kv.delete(assignmentKey(body.appId, body.idType, body.targetingKeyHash));
        return Response.json({ deleted: true, proof: "assignment-do-cutoff-tombstone-v2" });
      },
    }),
  };
}

function failingAssignmentWriters(calls: string[]) {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: async () => {
        calls.push(`writer:${targetingHashFromName(String(id))}`);
        return new Response("failed", { status: 503 });
      },
    }),
  };
}

function holdoverOutboxes(input: {
  historical: string;
  deletionCalls: string[];
  deleteBodies: unknown[];
}) {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
        const targetingKeyHash = targetingHashFromName(String(id));
        if (new URL(String(request)).pathname === "/export") {
          return Response.json({
            jobs:
              targetingKeyHash === input.historical
                ? [
                    {
                      appId: basePut.appId,
                      experimentId: "exp-old",
                      idType: basePut.idType,
                      targetingKeyHash,
                      runId: "run-old",
                      variant: basePut.variant,
                      status: "pending",
                      attempt: 1,
                      createdAtMs: 1_000,
                      updatedAtMs: 1_000,
                    },
                  ]
                : [],
            suppression: null,
          });
        }
        input.deletionCalls.push(`outbox:${targetingKeyHash}`);
        input.deleteBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, remainingJobs: false });
      },
    }),
  };
}

function targetingHashFromName(name: string): string {
  return name.split(":").slice(2).join(":");
}
