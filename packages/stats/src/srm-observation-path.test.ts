import { describe, expect, it } from "vitest";
import { buildDailyCumulativeSnapshots, type SrmPathEntity } from "./srm-observation-path";

const VARIANTS = ["control", "treatment"] as const;

describe("buildDailyCumulativeSnapshots", () => {
  it("builds monotone cumulative counts by UTC first-Exposure day", () => {
    const entities: SrmPathEntity[] = [
      entity("control", "c0", "2026-07-01T10:00:00.000Z"),
      entity("treatment", "t0", "2026-07-01T12:00:00.000Z"),
      entity("treatment", "t1", "2026-07-02T08:00:00.000Z"),
      entity("control", "c1", "2026-07-03T01:00:00.000Z"),
    ];

    expect(buildDailyCumulativeSnapshots(entities, VARIANTS)).toEqual([
      { control: 1, treatment: 1 },
      { control: 1, treatment: 2 },
      { control: 2, treatment: 2 },
    ]);
  });

  it("dedupes the same Entity within a day without decreasing counts", () => {
    const entities: SrmPathEntity[] = [
      entity("control", "c0", "2026-07-01T10:00:00.000Z"),
      entity("control", "c0", "2026-07-01T11:00:00.000Z"),
      entity("treatment", "t0", "2026-07-01T12:00:00.000Z"),
    ];

    expect(buildDailyCumulativeSnapshots(entities, VARIANTS)).toEqual([
      { control: 1, treatment: 1 },
    ]);
  });

  it("fails loud on conflicting variants for one Entity on one day", () => {
    expect(() =>
      buildDailyCumulativeSnapshots(
        [
          entity("control", "same", "2026-07-01T10:00:00.000Z"),
          entity("treatment", "same", "2026-07-01T11:00:00.000Z"),
        ],
        VARIANTS,
      ),
    ).toThrow(/conflicting variants/);
  });
});

function entity(
  variant: string,
  targeting_key_hash: string,
  first_exposure_ts: string,
): SrmPathEntity {
  return { variant, targeting_key_hash, first_exposure_ts };
}
