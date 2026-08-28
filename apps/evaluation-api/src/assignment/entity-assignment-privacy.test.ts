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

    const exported = await exportEntityAssignments(kv, saltStore, identity);
    expect(exported.records).toEqual([
      {
        targetingKeyHash: historical,
        assignments: { "exp-old": { runId: "run-old", variant: "control" } },
      },
      {
        targetingKeyHash: current,
        assignments: { "exp-new": { runId: "run-new", variant: "treatment" } },
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain(RAW_TARGETING_KEY);

    const deleted = await deleteEntityAssignments(kv, saltStore, identity);
    expect(deleted.deletedKeyCount).toBe(deleted.targetingKeyHashes.length);
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
});
