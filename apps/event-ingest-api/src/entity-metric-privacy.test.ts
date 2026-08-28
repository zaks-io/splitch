import { computeTargetingKeyHash, makeDerivedSaltStore } from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { deleteEntityMetricEvents, exportEntityMetricEvents } from "./entity-metric-privacy";

const ROOT = "test-root-secret-do-not-use";
const INPUT = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

describe("entity Metric Event privacy consumers", () => {
  it("exports and deletes every retained-epoch Metric Event for one Entity", async () => {
    const saltStore = makeDerivedSaltStore({ rootSecret: ROOT });
    const historical = await computeTargetingKeyHash(saltStore, { ...INPUT, keyVersion: "v1" });
    const current = await computeTargetingKeyHash(saltStore, INPUT);
    const other = await computeTargetingKeyHash(saltStore, { ...INPUT, appId: "app_2" });
    const rows = [
      { targeting_key_hash: historical, eventId: "evt_old" },
      { targeting_key_hash: current, eventId: "evt_new" },
      { targeting_key_hash: other, eventId: "evt_other" },
    ];

    const exported = await exportEntityMetricEvents(saltStore, INPUT, rows);
    expect(exported.records.map((row) => row.eventId)).toEqual(["evt_old", "evt_new"]);
    expect(JSON.stringify(exported)).not.toContain(INPUT.targetingKey);

    const deleted = await deleteEntityMetricEvents(saltStore, INPUT, rows);
    expect(deleted.deletedCount).toBe(2);
    expect(rows.map((row) => row.eventId)).toEqual(["evt_other"]);
    expect(JSON.stringify(deleted)).not.toContain(INPUT.targetingKey);
  });
});
