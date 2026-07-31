import type { PolicyChangeType } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model";
import { makeOtherApprovalApplication } from "./approval-application";
import { createApproval, replayApprovalIfExists } from "./approval-service";
import {
  environmentPolicyContexts,
  requiresReview,
  servableVariantEnvironments,
} from "./approval-target";
import { flagNotFound, variantNotFound, variantRunFrozenError } from "./flag-definition-errors";
import {
  type FlagDefinitionDeps,
  loadWritableFlag,
  resyncFlagSnapshots,
} from "./flag-definition-handler-utils";
import { flagResponse } from "./flag-definition-model";
import {
  prepareUpdateVariant,
  type VariantPatch,
  type VariantRow,
} from "./flag-definition-variant-prepare";
import { objectBody, pathParam } from "./handler-input";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validation and multi-Environment Approval contexts must be resolved before mutation
export async function updateVariant(
  deps: FlagDefinitionDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const loaded = await loadWritableFlag(deps, args);
  if (!loaded.ok) return loaded.response;

  const variantName = pathParam(args.input, "variantName");
  const variant = await deps.repo.flags.getVariantByName(
    loaded.value.scope,
    loaded.value.flag.id,
    variantName,
  );
  if (!variant) return variantNotFound(args.requestId);

  const body = objectBody(args.input);
  const replay = await replayApprovalIfExists(
    {
      ...deps,
      applyOther: makeOtherApprovalApplication(deps),
    },
    {
      appId: loaded.value.appId,
      operation: "flag_variants_update",
      target: { type: "flag_variant", id: variant.id },
      proposalInput: variantProposalInput(body),
      principal: args.principal,
      idempotencyKey: body.idempotency_key as string,
      inlineReview: body.review !== undefined,
      requestId: args.requestId,
    },
    { ignoreMismatch: true },
  );
  if (replay) {
    if (!replay.ok) return replay.response;
    const applied = await deps.repo.flags.getFlag(loaded.value.scope, loaded.value.flag.id);
    if (!applied) return flagNotFound(args.requestId);
    return Response.json({
      flag: await flagResponse(deps.repo, loaded.value.appId, applied),
      approvalRequest: replay.approvalRequest,
    });
  }
  const prepared = await prepareUpdateVariant(
    deps,
    loaded.value,
    variantName,
    variant,
    body,
    args.requestId,
  );
  if (!prepared.ok) return prepared.response;

  const contexts = await variantPolicyContexts(
    deps.repo,
    loaded.value.appId,
    loaded.value.flag.id,
    variantName,
    variantPatchGates(prepared.value.patch),
  );
  if (requiresReview(contexts)) {
    const current = variantProjection(loaded.value.flag.id, variant);
    const proposed = {
      ...current,
      ...prepared.value.patch,
      ...(prepared.value.patch.value !== undefined
        ? { value: JSON.parse(prepared.value.patch.value) }
        : {}),
    };
    const approval = await createApproval(
      {
        ...deps,
        applyOther: makeOtherApprovalApplication(deps),
      },
      {
        appId: loaded.value.appId,
        operation: "flag_variants_update",
        target: { type: "flag_variant", id: variant.id },
        policyContexts: contexts,
        current,
        proposed,
        proposalInput: variantProposalInput(body),
        principal: args.principal,
        idempotencyKey: body.idempotency_key as string,
        inlineReview: body.review !== undefined,
        requestId: args.requestId,
      },
    );
    if (!approval.ok) return approval.response;
    const applied = await deps.repo.flags.getFlag(loaded.value.scope, loaded.value.flag.id);
    if (!applied) return flagNotFound(args.requestId);
    return Response.json({
      flag: await flagResponse(deps.repo, loaded.value.appId, applied),
      approvalRequest: approval.approvalRequest,
    });
  }

  if (Object.keys(prepared.value.patch).length > 0) {
    const now = nowIso(deps);
    const written = await deps.repo.flags.updateVariant(
      loaded.value.scope,
      loaded.value.flag.id,
      variantName,
      prepared.value.patch,
      { updatedAt: now, updatedBy: args.principal.id },
    );
    if (!written.ok && written.reason === "RUN_FROZEN") {
      return variantRunFrozenError(written, args.requestId);
    }
    await resyncFlagSnapshots(deps, loaded.value.appId, loaded.value.flag.id);
  }

  const updated = await deps.repo.flags.getFlag(loaded.value.scope, loaded.value.flag.id);
  if (!updated) return flagNotFound(args.requestId);
  return Response.json({
    flag: await flagResponse(deps.repo, loaded.value.appId, updated),
    approvalRequest: null,
  });
}

/**
 * A Variant's served identity is its NAME (`flag_configs.available_variant_names`
 * and the Flag's Variant catalog key off it) and its VALUE. Renaming therefore
 * changes which Variant name each Environment can serve — the `variant_availability`
 * change type — and is gated exactly like widening the available set. Leaving it
 * ungated let a rename-then-edit chain launder an arbitrary value change past the
 * value gate. `description` is not served and stays ungated.
 */
function variantPatchGates(patch: VariantPatch): PolicyChangeType[] {
  const gates: PolicyChangeType[] = [];
  if (patch.name !== undefined) gates.push("variant_availability");
  if (patch.value !== undefined) gates.push("targeting_rollout_value");
  return gates;
}

export async function variantPolicyContexts(
  repo: Repository,
  appId: string,
  flagId: string,
  variantName: string,
  changeTypes: readonly PolicyChangeType[],
) {
  if (changeTypes.length === 0) return [];
  const servable = await servableVariantEnvironments(repo, appId, flagId, variantName);
  return servable.flatMap((environment) =>
    environmentPolicyContexts(environment.environmentId, environment.policy, changeTypes),
  );
}

export function variantProjection(flagId: string, variant: VariantRow): Record<string, unknown> {
  return {
    flagId,
    name: variant.name,
    value: JSON.parse(variant.value),
    description: variant.description,
  };
}

function variantProposalInput(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.value !== undefined ? { value: body.value } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
  };
}
