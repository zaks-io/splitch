/**
 * The pure promotion arithmetic behind the in-memory Control Plane double:
 * what a `select` proposes, which Variants that leaves dangling, and the
 * per-field diff an operator reads. No state, so it is safe to share.
 */

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Apply a Promotion `select` from a source config onto a target config. */
export function proposedFrom(select, source, target) {
  const next = clone(target);
  if (select.availability !== undefined) next.availableVariantNames = [...select.availability];
  if (select.targeting) next.targetingRules = clone(source.targetingRules);
  if (select.rollout) next.rollout = clone(source.rollout);
  if (select.enabled) next.enabled = source.enabled;
  return next;
}

/** Variant names a Targeting Rule references but the target does not offer. */
export function danglingVariants(proposed, flag) {
  const available = new Set(proposed.availableVariantNames);
  return proposed.targetingRules
    .map((rule) => flag.variants.find((variant) => variant.id === rule.variantId)?.name)
    .filter((name) => name && !available.has(name));
}

/**
 * Per-field diff entries, sorted by path and unique, matching ApprovalDiffSchema.
 * Real operators read THIS, not the whole-config blobs.
 */
function diffEntries(current, proposed) {
  const fields = ["availableVariantNames", "enabled", "rollout", "targetingRules"];
  return fields
    .filter((field) => JSON.stringify(current[field]) !== JSON.stringify(proposed[field]))
    .sort()
    .map((field) => ({
      path: `/${field}`,
      operation: "replace",
      current: current[field] ?? null,
      proposed: proposed[field] ?? null,
    }));
}

export function buildDiff(current, proposed) {
  return {
    current: clone(current),
    proposed: clone(proposed),
    entries: diffEntries(current, proposed),
  };
}
