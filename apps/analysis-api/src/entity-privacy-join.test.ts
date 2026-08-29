import { computeTargetingKeyHash, makeDerivedSaltStore } from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { joinRetainedEntityAnalysis } from "./entity-privacy-join";

const ROOT = "test-root-secret-do-not-use";
const INPUT = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

describe("joinRetainedEntityAnalysis", () => {
  it("joins a retained-epoch Exposure to a later-epoch Metric Event for one Entity", async () => {
    const saltStore = makeDerivedSaltStore({ rootSecret: ROOT });
    const historical = await computeTargetingKeyHash(saltStore, { ...INPUT, keyVersion: "v1" });
    const current = await computeTargetingKeyHash(saltStore, INPUT);
    const otherApp = await computeTargetingKeyHash(saltStore, { ...INPUT, appId: "app_2" });

    const joined = await joinRetainedEntityAnalysis(
      saltStore,
      INPUT,
      [
        { targeting_key_hash: historical, kind: "exposure" },
        { targeting_key_hash: otherApp, kind: "other-app" },
      ],
      [
        { targeting_key_hash: current, kind: "metric" },
        { targeting_key_hash: otherApp, kind: "leak" },
      ],
    );

    expect(joined.appId).toBe(INPUT.appId);
    expect(joined.exposures.map((row) => row.kind)).toEqual(["exposure"]);
    expect(joined.metricEvents.map((row) => row.kind)).toEqual(["metric"]);
    expect(JSON.stringify(joined)).not.toContain(INPUT.targetingKey);
  });
});
