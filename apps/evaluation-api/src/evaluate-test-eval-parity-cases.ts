/**
 * Shared case table for test-eval ↔ evaluate parity on Condition attributes.
 *
 * Both HTTP entry points and the shared evaluatePath policy layer consume this
 * table so the dry run and the edge cannot drift on missing / present attributes
 * again (SPL-303).
 */

export type ParityAttributes = Record<string, string | number | boolean | null>;

export type ParityCase = {
  readonly name: string;
  /**
   * Attribute bag for EvaluationContext. `null` is only reachable inside the
   * evaluatePath unit harness; the wire schema rejects null attribute values.
   */
  readonly attributes: ParityAttributes;
  /**
   * `path` = exercise evaluatePath / conditions policy.
   * `http` = exercise both HTTP entry points (null attributes are omitted —
   * use the dedicated wire-rejection case instead).
   */
  readonly surfaces: ReadonlyArray<"path" | "http">;
  readonly expect: {
    readonly ok: true;
    readonly variantName: string;
    readonly value: boolean;
    readonly reasonType: "rule_matched" | "baseline_rollout";
  };
};

/** Targeting Rule under test: `plan eq enterprise` → treatment. */
export const PARITY_PLAN_RULE_ID = "rule-plan-enterprise";

/**
 * Baseline at 0% so unmatched traffic resolves to the Default Variant
 * (`control` / false). A match on `plan=enterprise` still returns treatment.
 */
export const PARITY_BASELINE_ROLLOUT = { percentage: 0, salt: "parity-baseline-salt" } as const;

export const MISSING_ATTR_PARITY_CASES: readonly ParityCase[] = [
  {
    name: "absent plan is a non-match and falls through to baseline_rollout",
    attributes: {},
    surfaces: ["path", "http"],
    expect: {
      ok: true,
      variantName: "control",
      value: false,
      reasonType: "baseline_rollout",
    },
  },
  {
    name: "null plan is identical to absent at the policy layer",
    attributes: { plan: null },
    surfaces: ["path"],
    expect: {
      ok: true,
      variantName: "control",
      value: false,
      reasonType: "baseline_rollout",
    },
  },
  {
    name: "matching plan hits the Targeting Rule",
    attributes: { plan: "enterprise" },
    surfaces: ["path", "http"],
    expect: {
      ok: true,
      variantName: "treatment",
      value: true,
      reasonType: "rule_matched",
    },
  },
  {
    name: "present but non-matching plan falls through to baseline_rollout",
    attributes: { plan: "free" },
    surfaces: ["path", "http"],
    expect: {
      ok: true,
      variantName: "control",
      value: false,
      reasonType: "baseline_rollout",
    },
  },
];
