import { describe, expect, it } from "vitest";
import {
  AssignmentStoreEntrySchema,
  AssignmentStoreValueSchema,
  FlagConfigKVSchema,
  kvEnvelope,
  LiveRunKVSchema,
} from "./storage-schemas-kv.js";

// AssignmentStoreValue is the CANONICAL Map<experimentId, { runId, variant }>
// the holdover read path (S14/S22) consumes — serialized to a record in KV.
const validAssignmentValue = {
  exp_1: { runId: "run_10", variant: "treatment" },
  exp_2: { runId: "run_22", variant: "control" },
};

describe("AssignmentStoreEntrySchema", () => {
  it("parses an entry that is EXACTLY { runId, variant }", () => {
    const e = AssignmentStoreEntrySchema.parse({ runId: "run_10", variant: "treatment" });
    expect(e).toEqual({ runId: "run_10", variant: "treatment" });
  });

  it("REJECTS a per-entry schemaVersion — versioning lives on the envelope ONLY", () => {
    const withPerEntryVersion = { runId: "run_10", variant: "treatment", schemaVersion: 1 };
    expect(AssignmentStoreEntrySchema.safeParse(withPerEntryVersion).success).toBe(false);
  });

  it("rejects any other extra key on the entry", () => {
    const bad = { runId: "run_10", variant: "treatment", environmentId: "env_prod" };
    expect(AssignmentStoreEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a partial entry missing runId (original Run attribution is required)", () => {
    expect(AssignmentStoreEntrySchema.safeParse({ variant: "treatment" }).success).toBe(false);
  });

  it("rejects a partial entry missing variant", () => {
    expect(AssignmentStoreEntrySchema.safeParse({ runId: "run_10" }).success).toBe(false);
  });
});

describe("AssignmentStoreValueSchema", () => {
  it("parses a multi-Experiment holdover map keyed by experimentId", () => {
    const v = AssignmentStoreValueSchema.parse(validAssignmentValue);
    expect(Object.keys(v)).toEqual(["exp_1", "exp_2"]);
    expect(v.exp_1).toEqual({ runId: "run_10", variant: "treatment" });
  });

  it("parses an empty map (Entity with no holdovers yet)", () => {
    expect(AssignmentStoreValueSchema.parse({})).toEqual({});
  });

  it("fails if ANY entry carries a per-entry schemaVersion", () => {
    const bad = {
      exp_1: { runId: "run_10", variant: "treatment", schemaVersion: 1 },
    };
    expect(AssignmentStoreValueSchema.safeParse(bad).success).toBe(false);
  });

  it("fails if any entry is partial (no half-valid holdover flows to evaluation)", () => {
    const bad = { exp_1: { runId: "run_10" } };
    expect(AssignmentStoreValueSchema.safeParse(bad).success).toBe(false);
  });
});

// The schemaVersion envelope is the ONLY carrier of the version number.
describe("kvEnvelope", () => {
  it("round-trips schemaVersion + data for a FlagConfigKV payload", () => {
    const FlagConfigEnvelope = kvEnvelope(FlagConfigKVSchema);
    const raw = {
      schemaVersion: 3,
      data: {
        id: "flag_1",
        key: "checkout-redesign",
        environmentId: "env_prod",
        experimentId: null,
        enabled: true,
        defaultVariantId: "var_1",
        variants: [{ id: "var_1", name: "control", value: false }],
        availableVariantNames: ["control"],
        targetingRules: [],
        updatedAt: "2024-01-01T00:00:00Z",
      },
    };
    const parsed = FlagConfigEnvelope.parse(raw);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.data.experimentId).toBeNull();
    expect(parsed).toEqual(raw);
  });

  it("wraps the AssignmentStoreValue payload — version on envelope, not per entry", () => {
    const AssignmentEnvelope = kvEnvelope(AssignmentStoreValueSchema);
    const parsed = AssignmentEnvelope.parse({ schemaVersion: 1, data: validAssignmentValue });
    expect(parsed.schemaVersion).toBe(1);
    const entry = parsed.data.exp_1;
    expect(entry).toEqual({ runId: "run_10", variant: "treatment" });
    // The payload entries themselves carry no version field.
    expect("schemaVersion" in (entry as object)).toBe(false);
  });

  it("rejects a non-integer schemaVersion (monotonic integer only)", () => {
    const envelope = kvEnvelope(LiveRunKVSchema);
    expect(envelope.safeParse({ schemaVersion: 1.5, data: { runId: "run_1" } }).success).toBe(
      false,
    );
  });

  it("rejects schemaVersion below 1", () => {
    const envelope = kvEnvelope(LiveRunKVSchema);
    expect(envelope.safeParse({ schemaVersion: 0, data: { runId: "run_1" } }).success).toBe(false);
  });

  it("rejects an envelope missing schemaVersion (every KV blob is versioned)", () => {
    const envelope = kvEnvelope(LiveRunKVSchema);
    expect(envelope.safeParse({ data: { runId: "run_1" } }).success).toBe(false);
  });

  it("fails loud when the inner payload is malformed", () => {
    const envelope = kvEnvelope(LiveRunKVSchema);
    expect(envelope.safeParse({ schemaVersion: 1, data: { runId: 123 } }).success).toBe(false);
  });

  it("rejects an extra key alongside schemaVersion/data (strict envelope)", () => {
    const envelope = kvEnvelope(LiveRunKVSchema);
    expect(
      envelope.safeParse({ schemaVersion: 1, data: { runId: "run_1" }, etag: "x" }).success,
    ).toBe(false);
  });
});
