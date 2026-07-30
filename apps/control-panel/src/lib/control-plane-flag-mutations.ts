import type { ApprovalRequest, ErrorResponse, TargetingRule } from "@splitch/contracts";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { type ApprovalGateRecord, approvalGateRecord } from "./approval-gate-record";
import { authorizedApprovalsClient, authorizedFlagsClient } from "./panel-authorized-clients";

/**
 * The Flag Configuration write path, and the Approval Request pair that a gated
 * write turns into.
 *
 * There is no Policy prediction here and none in the browser. The panel proposes
 * the change; the Worker decides whether it applies immediately or becomes a
 * pending Approval Request, and its refusal carries the request id. Mirroring
 * `flagConfigPatchGates` on this side would be a second, drifting reading of the
 * Environment Policy — the panel renders gates, the Worker enforces them
 * (ADR-0023).
 *
 * Everything that crosses back to the browser is primitives. The Configuration and
 * the Approval diff both carry `unknown`-typed values (arbitrary Variant values,
 * arbitrary condition operands), which a server-function boundary cannot prove
 * transferable, so the projection into rows happens here rather than in the
 * component that renders it.
 */

export type FlagWriteResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly approvalRequest: ApprovalGateRecord | null;
    }
  | { readonly ok: false; readonly status: number; readonly error: ErrorResponse };

export type ApprovalReadResult =
  | { readonly ok: true; readonly status: number; readonly data: ApprovalGateRecord }
  | { readonly ok: false; readonly status: number; readonly error: ErrorResponse };

const FlagScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
  flagId: z.string().min(1),
});

/**
 * Carried from the browser, never minted per handler invocation: a key minted here
 * would be fresh on every retry, leaving the Control Plane no way to recognize a
 * replay of the same submission.
 */
const IdempotencyKeySchema = z.string().min(1);

/** Variant id -> name, so the gate can name what a rule serves. */
const VariantLabelsSchema = z.record(z.string(), z.string()).optional();

const ConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    availableVariantNames: z.array(z.string()).optional(),
    // Percentage only. The bucketing salt is minted server-side and never
    // regenerated, so the operator neither sees nor sets it.
    rollout: z
      .object({ percentage: z.number().min(0).max(100) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const UpdateConfigInputSchema = FlagScopeSchema.extend({
  patch: ConfigPatchSchema,
  idempotencyKey: IdempotencyKeySchema,
  variantLabels: VariantLabelsSchema,
});

const TargetingEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove"), ruleId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("add"),
      ruleId: z.string().min(1),
      attribute: z.string().min(1),
      operator: z.literal("eq"),
      value: z.string().min(1),
      variantId: z.string().min(1),
    })
    .strict(),
]);

const TargetingEditInputSchema = FlagScopeSchema.extend({
  edit: TargetingEditSchema,
  idempotencyKey: IdempotencyKeySchema,
  variantLabels: VariantLabelsSchema,
});

const ApprovalRequestInputSchema = z.object({
  appId: z.string().min(1),
  approvalRequestId: z.string().min(1),
  variantLabels: VariantLabelsSchema,
});

const ReviewInputSchema = ApprovalRequestInputSchema.extend({
  action: z.enum(["approve_and_apply", "decline"]),
  idempotencyKey: IdempotencyKeySchema,
});

export const updateControlPanelFlagConfig = createServerFn({ method: "POST" })
  .validator((data: unknown) => UpdateConfigInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<FlagWriteResult> => {
    if (!parsed.success) {
      return malformed(parsed.error, "The Flag Configuration patch is malformed");
    }
    const { appId, environmentId, flagId, patch, idempotencyKey, variantLabels } = parsed.data;
    const authorized = await authorizedFlagsClient(environmentId);
    if (!authorized.ok) return authorized.result;
    // No inline `review`: the panel never self-approves on the operator's behalf.
    const result = await authorized.client.updateConfig({
      appId,
      environmentId,
      flagId,
      ...patch,
      idempotency_key: idempotencyKey,
    });
    return writeResult(result, variantLabels);
  });

/**
 * A Targeting change, applied to the Worker's own current rule list.
 *
 * The read-modify-write happens here and not in the browser so the list that goes
 * back is built from a Configuration read one call earlier, and so the existing
 * rules (bucketing salts included) are returned verbatim without ever being
 * serialized to the client and back.
 */
export const editControlPanelTargetingRules = createServerFn({ method: "POST" })
  .validator((data: unknown) => TargetingEditInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<FlagWriteResult> => {
    if (!parsed.success) return malformed(parsed.error, "The Targeting Rule change is malformed");
    const { appId, environmentId, flagId, edit, idempotencyKey, variantLabels } = parsed.data;
    const authorized = await authorizedFlagsClient(environmentId);
    if (!authorized.ok) return authorized.result;

    const current = await authorized.client.getConfig({ appId, environmentId, flagId });
    if (!current.ok) return { ok: false, status: current.status, error: current.error };

    const result = await authorized.client.replaceTargetingRules({
      appId,
      environmentId,
      flagId,
      targetingRules: applyTargetingEdit(current.data.targetingRules, edit, flagId),
      idempotency_key: idempotencyKey,
    });
    return writeResult(result, variantLabels);
  });

/**
 * Reads the pending proposal the Worker just recorded, so the confirm gate renders
 * the Worker's OWN canonical diff. A diff computed in the browser would be a second
 * opinion about what is being changed, and the operator would be confirming the
 * panel's guess rather than the proposal on file.
 */
export const loadControlPanelApprovalRequest = createServerFn({ method: "POST" })
  .validator((data: unknown) => ApprovalRequestInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ApprovalReadResult> => {
    if (!parsed.success) {
      return malformed(parsed.error, "The Approval Request reference is malformed");
    }
    const authorized = await authorizedApprovalsClient();
    if (!authorized.ok) return authorized.result;
    const result = await authorized.client.get({
      appId: parsed.data.appId,
      id: parsed.data.approvalRequestId,
    });
    return result.ok
      ? {
          ok: true,
          status: result.status,
          data: approvalGateRecord(result.data, parsed.data.variantLabels ?? {}),
        }
      : { ok: false, status: result.status, error: result.error };
  });

export const reviewControlPanelApprovalRequest = createServerFn({ method: "POST" })
  .validator((data: unknown) => ReviewInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ApprovalReadResult> => {
    if (!parsed.success) return malformed(parsed.error, "The Review is malformed");
    const { appId, approvalRequestId, action, idempotencyKey, variantLabels } = parsed.data;
    const authorized = await authorizedApprovalsClient();
    if (!authorized.ok) return authorized.result;
    const result = await authorized.client.review({
      appId,
      id: approvalRequestId,
      action,
      idempotency_key: idempotencyKey,
    });
    return result.ok
      ? {
          ok: true,
          status: result.status,
          data: approvalGateRecord(result.data, variantLabels ?? {}),
        }
      : { ok: false, status: result.status, error: result.error };
  });

/**
 * A new rule serves every request that matches and carries no percentage: a
 * rule-level rollout needs a bucketing salt, there is no minting path for one on
 * this route, and fabricating one would silently decide who gets bucketed
 * (SPL-245). Existing rules are passed through untouched.
 */
function applyTargetingEdit(
  rules: readonly TargetingRule[],
  edit: z.infer<typeof TargetingEditSchema>,
  flagId: string,
): TargetingRule[] {
  if (edit.kind === "remove") return rules.filter((rule) => rule.id !== edit.ruleId);
  const priority = rules.reduce((highest, rule) => Math.max(highest, rule.priority), -1) + 1;
  return [
    ...rules,
    {
      id: edit.ruleId,
      flagId,
      priority,
      conditions: [{ attribute: edit.attribute, operator: edit.operator, value: edit.value }],
      variantId: edit.variantId,
      percentageRollout: null,
    },
  ];
}

function writeResult(
  result:
    | { ok: true; status: number; data: { approvalRequest: ApprovalRequest | null } }
    | { ok: false; status: number; error: ErrorResponse },
  variantLabels: Record<string, string> | undefined,
): FlagWriteResult {
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  const { approvalRequest } = result.data;
  return {
    ok: true,
    status: result.status,
    approvalRequest: approvalRequest
      ? approvalGateRecord(approvalRequest, variantLabels ?? {})
      : null,
  };
}

/**
 * A malformed body is a 400 with the same VALIDATION_ERROR shape the Worker uses,
 * never a thrown 500: an unauthenticated caller can reach these functions and must
 * get a structured refusal (ADR-0036).
 */
function malformed(error: z.ZodError, message: string) {
  return {
    ok: false as const,
    status: 400,
    error: {
      code: "VALIDATION_ERROR" as const,
      message,
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      },
    },
  };
}
