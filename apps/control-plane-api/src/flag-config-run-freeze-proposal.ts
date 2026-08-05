/**
 * Which frozen Flag Configuration fields an Approval Request actually changes.
 *
 * The request's own `diff.entries` is the changed-field set the operator already
 * reviewed. Re-deriving that set by re-diffing the complete proposed snapshot
 * against the live Configuration (SPL-304) is a different equality predicate
 * than the mint-time canonical diff, and can report a frozen field that appears
 * nowhere in the request — then refuse (and discard) an approved change that
 * never touched it.
 *
 * Fail closed: when the entries cannot be read as a Flag Configuration change
 * set, refuse rather than guess which fields move.
 */

import type { ApprovalDiffEntry } from "@splitch/contracts";

/** Names match the wire fields an operator is refused, so the error is self-locating. */
export const AVAILABILITY_FIELD = "flagConfig.availableVariantNames";
export const ROLLOUT_FIELD = "flagConfig.rollout";
export const TARGETING_FIELD = "flagConfig.targetingRules";

/** Top-level Flag Configuration response keys that a live Run never freezes. */
const NEVER_FROZEN_TOP_LEVEL = new Set([
  "enabled",
  "version",
  "experiment",
  "flagId",
  "environmentId",
]);

const FROZEN_TOP_LEVEL: Record<string, string> = {
  availableVariantNames: AVAILABILITY_FIELD,
  rollout: ROLLOUT_FIELD,
  targetingRules: TARGETING_FIELD,
};

export type ProposalChangedFrozenFields =
  | { ok: true; frozenFields: string[] }
  | { ok: false; reason: "CHANGED_FIELDS_UNDETERMINED" };

/**
 * Map an Approval Request's `diff.entries` to the Run-frozen fields that request
 * would move. Empty `frozenFields` means the proposal touches only never-frozen
 * fields (kill switch / version / experiment pointer) and must apply under a
 * live Run the same way the equivalent direct mutation does.
 */
export function frozenFieldsFromDiffEntries(
  entries: readonly Pick<ApprovalDiffEntry, "path">[] | null | undefined,
): ProposalChangedFrozenFields {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, reason: "CHANGED_FIELDS_UNDETERMINED" };
  }

  const frozen = new Set<string>();
  for (const entry of entries) {
    const mapped = mapEntryPath(entry?.path);
    if (mapped === "undetermined") {
      return { ok: false, reason: "CHANGED_FIELDS_UNDETERMINED" };
    }
    if (mapped !== null) frozen.add(mapped);
  }
  return { ok: true, frozenFields: [...frozen] };
}

/** Whether the request's entries touch a top-level Flag Configuration field. */
export function diffEntriesTouch(
  entries: readonly Pick<ApprovalDiffEntry, "path">[] | null | undefined,
  field: "availableVariantNames" | "rollout" | "targetingRules" | "enabled",
): boolean {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => topLevelPointerSegment(entry.path) === field);
}

/** `null` = never-frozen; a field name = frozen; `undetermined` = fail closed. */
function mapEntryPath(path: unknown): string | null | "undetermined" {
  if (typeof path !== "string") return "undetermined";
  const top = topLevelPointerSegment(path);
  if (top === null) return "undetermined";
  if (NEVER_FROZEN_TOP_LEVEL.has(top)) return null;
  return FROZEN_TOP_LEVEL[top] ?? "undetermined";
}

function topLevelPointerSegment(path: string): string | null {
  if (!path.startsWith("/") || path === "/") return null;
  const rest = path.slice(1);
  const slash = rest.indexOf("/");
  const raw = slash === -1 ? rest : rest.slice(0, slash);
  if (raw.length === 0) return null;
  return raw.replaceAll("~1", "/").replaceAll("~0", "~");
}
