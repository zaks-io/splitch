import {
  ConcludeRunRequestSchema,
  CreateConclusionPromotionRequestSchema,
  type TargetingRule,
} from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { approvalGateRecord } from "#lib/approval/approval-gate-record";
import {
  authorizedApprovalsClient,
  authorizedExperimentsClient,
  authorizedFlagDetailClients,
} from "#lib/auth/panel-authorized-clients";
import type { ConclusionTarget } from "./experiment-conclusion-model";

const TargetInputSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
  flagId: z.string().min(1),
});

export const loadControlPanelConclusionTarget = createServerFn({ method: "GET" })
  .validator((data: unknown) => TargetInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ControlPlaneOperationResult<ConclusionTarget>> => {
    if (!parsed.success) return malformed();
    const authorized = await authorizedFlagDetailClients(parsed.data.environmentId);
    if (!authorized.ok) return authorized.result;
    const [config, flag, segments] = await Promise.all([
      authorized.client.flags.getConfig(parsed.data),
      authorized.client.flags.get({
        appId: parsed.data.appId,
        flagId: parsed.data.flagId,
        by: "id",
      }),
      authorized.client.segments.list({ appId: parsed.data.appId }),
    ]);
    if (!config.ok) return config;
    if (!flag.ok) return flag;
    if (!segments.ok) return segments;
    if (segments.data.readTruncated || segments.data.unparseable.length > 0) {
      throw new Error(
        "The target Segment list is incomplete. Resolve it before concluding the Run.",
      );
    }
    return {
      ok: true,
      status: 200,
      data: {
        environmentId: parsed.data.environmentId,
        flagId: parsed.data.flagId,
        version: config.data.version,
        enabled: config.data.enabled,
        availableVariantNames: config.data.availableVariantNames,
        targetingRulesJson: JSON.stringify(authorableRules(config.data.targetingRules), null, 2),
        rolloutPercentage: config.data.rollout?.percentage ?? null,
        variants: flag.data.variants.map(({ id, name }) => ({ id, name })),
        segments: segments.data.items,
      },
    };
  });

function authorableRules(rules: readonly TargetingRule[]) {
  return rules.map((rule) =>
    rule.percentageRollout
      ? { ...rule, percentageRollout: { percentage: rule.percentageRollout.percentage } }
      : rule,
  );
}

const ConclusionInputSchema = ConcludeRunRequestSchema.extend({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
  experimentId: z.string().min(1),
  runId: z.string().min(1),
});

export const concludeControlPanelRun = createServerFn({ method: "POST" })
  .validator((data: unknown) => ConclusionInputSchema.safeParse(data))
  .handler(async ({ data: parsed }) => {
    if (!parsed.success) return malformed();
    const authorized = await authorizedExperimentsClient();
    if (!authorized.ok) return authorized.result;
    const result = await authorized.client.conclude(parsed.data);
    if (!result.ok) return result;
    return {
      ok: true as const,
      status: result.status,
      data: {
        runId: result.data.run.id,
        conclusion: result.data.conclusion,
        approvalRequest: approvalGateRecord(result.data.approvalRequest),
      },
    };
  });

const ConclusionApprovalInputSchema = z.object({
  appId: z.string().min(1),
  approvalRequestId: z.string().min(1),
  variantLabels: z.record(z.string(), z.string()),
});
const ConclusionLinkSchema = z.object({ decision: z.object({ conclusionId: z.string().min(1) }) });

export const loadControlPanelConclusionApproval = createServerFn({ method: "GET" })
  .validator((data: unknown) => ConclusionApprovalInputSchema.safeParse(data))
  .handler(async ({ data: parsed }) => {
    if (!parsed.success) return malformed();
    const authorized = await authorizedApprovalsClient();
    if (!authorized.ok) return authorized.result;
    const result = await authorized.client.get({
      appId: parsed.data.appId,
      id: parsed.data.approvalRequestId,
    });
    if (!result.ok) return result;
    const link = ConclusionLinkSchema.parse(result.data.diff.current);
    return {
      ok: true as const,
      status: result.status,
      data: {
        request: approvalGateRecord(result.data, parsed.data.variantLabels),
        conclusionId: link.decision.conclusionId,
      },
    };
  });

const ReplacementInputSchema = CreateConclusionPromotionRequestSchema.extend({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
  experimentId: z.string().min(1),
  runId: z.string().min(1),
  conclusionId: z.string().min(1),
});

export const replaceControlPanelConclusionPromotion = createServerFn({ method: "POST" })
  .validator((data: unknown) => ReplacementInputSchema.safeParse(data))
  .handler(async ({ data: parsed }) => {
    if (!parsed.success) return malformed();
    const authorized = await authorizedExperimentsClient();
    if (!authorized.ok) return authorized.result;
    const result = await authorized.client.createConclusionPromotionRequest(parsed.data);
    if (!result.ok) return result;
    return {
      ok: true as const,
      status: result.status,
      data: {
        conclusion: result.data.conclusion,
        approvalRequest: approvalGateRecord(result.data.approvalRequest),
      },
    };
  });

function malformed(): ControlPlaneOperationResult<never> {
  return {
    ok: false,
    status: 400,
    error: {
      code: "VALIDATION_ERROR",
      message: "The conclusion request is malformed.",
      details: { issues: [{ path: ["body"], message: "The conclusion request is malformed." }] },
    },
  };
}
