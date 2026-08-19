import { runConfigHash as hashRunConfig } from "./local-e2e-run-hash.mjs";

/**
 * The frozen assignment config of every seeded Run, plus the config hash the
 * Control Plane would have computed for it.
 *
 * This lives apart from the seed rows because it is the one part of the fixture
 * that is not arbitrary: the config hash has to mirror the Worker's hashing
 * algorithm exactly, or the seeded Runs carry hashes no code path would ever
 * produce and the e2e suite asserts against fiction. Keeping it next to a few
 * hundred lines of INSERT statements hid that obligation. The algorithm itself
 * lives in `local-e2e-run-hash.mjs` so every fixture module derives it once.
 */

const checkoutTargetingRules = [];
const checkoutAllocation = { control: 50, treatment: 50 };
const checkoutExpandedAllocation = { control: 70, treatment: 30 };

// A Run freezes its own Flag's Variants. Sharing one set across Flags would let a
// Run point at a control Variant that its Experiment does not own.
const variants = Object.freeze({
  checkout: variantPair("checkout"),
  significance: variantPair("significance"),
  guardrail: variantPair("guardrail"),
  ended: variantPair("ended"),
  srm: variantPair("srm"),
  integrity: variantPair("integrity"),
});

const salt = Object.freeze({
  dev: "local-e2e-dev",
  devPrevious: "local-e2e-dev-previous",
  prod: "local-e2e-prod",
  setup: "local-e2e-setup",
  significance: "local-e2e-significance",
  guardrail: "local-e2e-guardrail",
  ended: "local-e2e-ended",
  srm: "local-e2e-srm",
  integrity: "local-e2e-integrity",
});

export const LOCAL_E2E_RUN_CONFIG = Object.freeze({
  targetingRules: checkoutTargetingRules,
  allocation: Object.freeze({
    checkout: checkoutAllocation,
    checkoutExpanded: checkoutExpandedAllocation,
  }),
  variants,
  salt,
  hash: Object.freeze({
    dev: runConfigHash(salt.dev, checkoutExpandedAllocation, variants.checkout),
    devPrevious: runConfigHash(salt.devPrevious, checkoutAllocation, variants.checkout),
    prod: runConfigHash(salt.prod, checkoutAllocation, variants.checkout),
    setup: runConfigHash(salt.setup, checkoutAllocation, variants.checkout),
    significance: runConfigHash(salt.significance, checkoutAllocation, variants.significance),
    guardrail: runConfigHash(salt.guardrail, checkoutAllocation, variants.guardrail),
    ended: runConfigHash(salt.ended, checkoutAllocation, variants.ended),
    srm: runConfigHash(salt.srm, checkoutAllocation, variants.srm),
    integrity: runConfigHash(salt.integrity, checkoutAllocation, variants.integrity),
  }),
});

/**
 * D1's `runs.decision_family` / `runs.guardrail_decisions` hold `MetricRef[]`
 * — `[{"metricId": "..."}]` — which is what `experiment-start.ts` writes.
 *
 * Tinybird's `analysis_run_inputs` has columns with the SAME TWO NAMES holding a
 * different, snake_case shape (`metric_id`, `variant`, `downside_threshold_pct`, …),
 * because that one feeds `StatsInputSchema`. Two stores, two shapes, one pair of
 * names. Three seed rows had the Tinybird shape in the D1 column, which nothing
 * read until the Setup tab did, and then `metricIds` returned `[undefined]` and
 * failed the whole Experiment-detail parse.
 *
 * So D1 Run decisions are built here and only here. The Tinybird side has its own
 * builder in `local-e2e-analysis-inputs.mjs`; do not cross them.
 */
export function d1RunDecisions(...metricIds) {
  return JSON.stringify(metricIds.map((metricId) => ({ metricId })));
}

function variantPair(flag) {
  return [
    { id: `variant_${flag}_control_e2e`, name: "control", value: false },
    { id: `variant_${flag}_treatment_e2e`, name: "treatment", value: true },
  ];
}

function runConfigHash(runSalt, allocation, variantSet) {
  return hashRunConfig({
    salt: runSalt,
    allocation,
    variantSet,
    targetingRules: checkoutTargetingRules,
  });
}
