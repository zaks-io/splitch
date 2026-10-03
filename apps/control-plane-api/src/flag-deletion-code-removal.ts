import {
  DeleteFlagRequestSchema,
  type FlagCodeRemovalClaim,
  type FlagCodeRemovalRecord,
} from "@splitch/contracts";

/**
 * Resolve the request body claim (or explicit unknown) for audit/proposed.
 * Always records a state; never null-as-unknown. Fingerprinting excludes an
 * omitted claim so pre-upgrade pending Approvals stay byte-identical.
 */
export function codeRemovalRecordFromBody(
  body: { codeRemoval?: FlagCodeRemovalClaim } | undefined,
): FlagCodeRemovalRecord {
  if (body?.codeRemoval !== undefined) return body.codeRemoval;
  return { state: "unknown" };
}

/** Validate and normalize an optional flags_delete body before any mutation. */
export function parseFlagsDeleteBody(
  input: unknown,
): { codeRemoval?: FlagCodeRemovalClaim } | undefined {
  const value = (input as { body?: unknown } | null)?.body;
  if (value === undefined) return undefined;
  return DeleteFlagRequestSchema.parse(value);
}

/**
 * Idempotency fingerprint input. Omitted codeRemoval is absent from the hash
 * (pre-upgrade shape). Claimed codeRemoval is included.
 */
export function flagsDeleteProposalInput(
  flagId: string,
  body: { codeRemoval?: FlagCodeRemovalClaim } | undefined,
): Record<string, unknown> {
  if (body?.codeRemoval !== undefined) {
    return { flagId, codeRemoval: body.codeRemoval };
  }
  return { flagId };
}

export function codeRemovalRecordFromProposal(
  proposed: Record<string, unknown>,
): FlagCodeRemovalRecord {
  const raw = proposed.codeRemoval;
  if (raw === undefined) return { state: "unknown" };
  if (typeof raw !== "object" || raw === null) {
    throw new Error("flag-deletion-code-removal: malformed codeRemoval on Approval proposed");
  }
  const record = raw as { state?: unknown; reference?: unknown };
  if (record.state === "unknown") return { state: "unknown" };
  if (
    record.state === "claimed" &&
    typeof record.reference === "string" &&
    record.reference.length > 0
  ) {
    return { state: "claimed", reference: record.reference };
  }
  throw new Error("flag-deletion-code-removal: malformed codeRemoval on Approval proposed");
}
