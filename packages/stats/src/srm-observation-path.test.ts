import { describe, expect, it } from "vitest";
import {
  compareSrmPathEntities,
  sortEntitiesByArrival,
  type SrmPathEntity,
} from "./srm-observation-path";

describe("SRM observation arrival order", () => {
  it("orders by arrival timestamp then Entity pseudonym", () => {
    const entities: SrmPathEntity[] = [
      entity("treatment", "t_late", "2026-07-01T18:00:00.000Z"),
      entity("control", "c_b", "2026-07-01T08:00:00.000Z"),
      entity("control", "c_a", "2026-07-01T08:00:00.000Z"),
      entity("treatment", "t_early", "2026-07-01T09:00:00.000Z"),
    ];

    expect(sortEntitiesByArrival(entities).map((row) => row.targeting_key_hash)).toEqual([
      "c_a",
      "c_b",
      "t_early",
      "t_late",
    ]);
  });

  it("fails loud on conflicting variants at the same arrival key", () => {
    expect(() =>
      compareSrmPathEntities(
        entity("control", "same", "2026-07-01T08:00:00.000Z"),
        entity("treatment", "same", "2026-07-01T08:00:00.000Z"),
      ),
    ).toThrow(/conflicting variants/);
  });

  it("fails loud on non-ISO arrival timestamps", () => {
    expect(() =>
      compareSrmPathEntities(
        entity("control", "c0", "not-a-timestamp"),
        entity("control", "c1", "2026-07-01T08:00:00.000Z"),
      ),
    ).toThrow(/arrival_ts must be an ISO timestamp/);
  });
});

function entity(variant: string, targeting_key_hash: string, arrival_ts: string): SrmPathEntity {
  return { variant, targeting_key_hash, arrival_ts };
}
