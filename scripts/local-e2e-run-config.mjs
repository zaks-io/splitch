import { createHash } from "node:crypto";

/**
 * The frozen assignment config of every seeded Run, plus the config hash the
 * Control Plane would have computed for it.
 *
 * This lives apart from the seed rows because it is the one part of the fixture
 * that is not arbitrary: `runConfigHash` has to mirror the Worker's hashing
 * algorithm exactly, or the seeded Runs carry hashes no code path would ever
 * produce and the e2e suite asserts against fiction. Keeping it next to a few
 * hundred lines of INSERT statements hid that obligation.
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
  }),
});

function variantPair(flag) {
  return [
    { id: `variant_${flag}_control_e2e`, name: "control", value: false },
    { id: `variant_${flag}_treatment_e2e`, name: "treatment", value: true },
  ];
}

function runConfigHash(runSalt, allocation, variantSet) {
  const config = {
    salt: runSalt,
    allocation,
    variantSet,
    targetingRules: checkoutTargetingRules,
  };
  return `sha256:${createHash("sha256").update(stableStringify(config)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
