import type { ApprovalPolicyContext } from "@splitch/contracts";
import { ApprovalDiffSchema, ApprovalTargetSchema } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { ApprovalRequestRow } from "./approval-service-types";
import { approvalTargetVersion } from "./approval-target";

/**
 * The CURRENT target version of a stored Approval Request.
 *
 * Every staleness check must go through here rather than calling
 * `approvalTargetVersion` with the raw row, because a `flag_variants_create`
 * proposal names a Variant that does not exist yet: without the hint its token
 * would collapse to the generic "target absent" hash and the proposal could
 * never render stale.
 */
export function rowTargetVersion(
  repo: Repository,
  row: Pick<
    ApprovalRequestRow,
    "appId" | "operation" | "targetType" | "targetId" | "targetVersion"
  >,
  contexts: readonly ApprovalPolicyContext[],
  diff: string,
) {
  const type = ApprovalTargetSchema.parse({
    type: row.targetType,
    id: row.targetId,
    version: row.targetVersion,
  }).type;
  return approvalTargetVersion(repo, row.appId, { type, id: row.targetId }, contexts, {
    ...(absentVariantHint(row.operation, diff) ?? {}),
  });
}

/** `{ absentVariant }` for a create proposal, nothing for any other operation. */
export function absentVariantHint(
  operation: string,
  diff: string,
): { absentVariant: { flagId: string; name: string } } | undefined {
  if (operation !== "flag_variants_create") return undefined;
  const proposed = ApprovalDiffSchema.parse(JSON.parse(diff)).proposed;
  if (typeof proposed.flagId !== "string" || typeof proposed.name !== "string") {
    throw new Error("flag_variants_create proposal is missing flagId/name");
  }
  return { absentVariant: { flagId: proposed.flagId, name: proposed.name } };
}
