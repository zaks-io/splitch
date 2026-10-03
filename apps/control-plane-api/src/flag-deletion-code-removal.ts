import type { FlagCodeRemovalClaim, FlagCodeRemovalRecord } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";

/**
 * Resolve the request body claim (or explicit unknown) and persist it on the
 * Flag deletion audit row. Always records a state; never null-as-unknown.
 */
export function codeRemovalRecordFromBody(
  body: { codeRemoval?: FlagCodeRemovalClaim } | undefined,
): FlagCodeRemovalRecord {
  if (body?.codeRemoval !== undefined) return body.codeRemoval;
  return { state: "unknown" };
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

export async function recordFlagDeletionCodeRemoval(
  repo: Repository,
  appId: string,
  flagId: string,
  codeRemoval: FlagCodeRemovalRecord,
): Promise<void> {
  await repo.flagDeletionCodeRemoval.recordCodeRemovalClaim(appScope(appId), flagId, codeRemoval);
}
