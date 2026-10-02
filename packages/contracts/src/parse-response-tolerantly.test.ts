import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseResponseBody, parseResponseTolerantly } from "./parse-response-tolerantly";

const NestedSchema = z
  .object({
    variant: z.string(),
    sample_size_n: z.number().int(),
  })
  .strict();

const EnvelopeSchema = z
  .object({
    run_id: z.string(),
    arm_results: z.array(NestedSchema),
  })
  .strict();

const ReadySchema = z
  .object({
    state: z.literal("ready"),
    value: z.number(),
    meta: z.object({ ok: z.boolean() }).strict(),
  })
  .strict();

const EmptySchema = z.object({ state: z.literal("empty") }).strict();
const UnionSchema = z.discriminatedUnion("state", [ReadySchema, EmptySchema]);

describe("parseResponseTolerantly", () => {
  it("drops unknown keys at the top level and re-parses", () => {
    const parsed = parseResponseTolerantly(EnvelopeSchema, {
      run_id: "run_1",
      arm_results: [{ variant: "control", sample_size_n: 10 }],
      run_commitments: { locked: true },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({
      run_id: "run_1",
      arm_results: [{ variant: "control", sample_size_n: 10 }],
    });
  });

  it("drops unknown keys nested in arrays (arm_results[].estimand)", () => {
    const parsed = parseResponseTolerantly(EnvelopeSchema, {
      run_id: "run_1",
      arm_results: [
        {
          variant: "treatment",
          sample_size_n: 20,
          estimand: {
            label: "capped_additive_mean",
            decision_label: "capped_additive_mean",
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.arm_results[0]).toEqual({
      variant: "treatment",
      sample_size_n: 20,
    });
  });

  it("drops unknown keys inside discriminated unions", () => {
    const parsed = parseResponseTolerantly(UnionSchema, {
      state: "ready",
      value: 3,
      future_gate: "new_check",
      meta: { ok: true, nested_future: 1 },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ state: "ready", value: 3, meta: { ok: true } });
  });

  it("fails loud when a known field has the wrong type", () => {
    const parsed = parseResponseTolerantly(EnvelopeSchema, {
      run_id: "run_1",
      arm_results: [{ variant: "control", sample_size_n: "ten", future: true }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error?.issues?.some((issue) => issue.code === "invalid_type")).toBe(true);
  });

  it("fails loud when a required field is missing", () => {
    const parsed = parseResponseTolerantly(EnvelopeSchema, {
      arm_results: [{ variant: "control", sample_size_n: 10 }],
      future: true,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error?.issues?.some((issue) => issue.code === "invalid_type")).toBe(true);
  });

  it("does not mutate the caller input when stripping keys", () => {
    const input = {
      run_id: "run_1",
      arm_results: [{ variant: "control", sample_size_n: 10, estimand: { label: "x" } }],
      extra: 1,
    };
    const snapshot = structuredClone(input);
    const parsed = parseResponseTolerantly(EnvelopeSchema, input);
    expect(parsed.success).toBe(true);
    expect(input).toEqual(snapshot);
  });

  it("parseResponseBody returns data or throws the Zod error", () => {
    expect(
      parseResponseBody(EnvelopeSchema, {
        run_id: "run_1",
        arm_results: [],
        additive: true,
      }),
    ).toEqual({ run_id: "run_1", arm_results: [] });

    expect(() =>
      parseResponseBody(EnvelopeSchema, {
        run_id: 7,
        arm_results: [],
      }),
    ).toThrow();
  });
});
