import type { ApprovalPolicyContext } from "@splitch/contracts";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model";
import { makeOtherApprovalApplication } from "./approval-application";
import { canonicalHash } from "./approval-canonical";
import { createApproval, replayApprovalIfExists } from "./approval-service";
import { requiresReview } from "./approval-target";
import { flagNotFound, variantDeleteRefusal, variantNotFound } from "./flag-definition-errors";
import {
  type FlagDefinitionDeps,
  type LoadedFlag,
  loadWritableFlag,
  resyncFlagSnapshots,
} from "./flag-definition-handler-utils";
import { flagResponse } from "./flag-definition-model";
import { variantPolicyContexts, variantProjection } from "./flag-definition-variant-handlers";
import { prepareCreateVariant, variantDeleteBlocker } from "./flag-definition-variant-prepare";
import { objectBody, pathParam } from "./handler-input";

/**
 * Catalog membership is a `variant_availability` change, not free bookkeeping.
 * An Environment whose `available_variant_names` is empty serves the whole
 * catalog (`servesVariant`), so adding a Variant widens what that Environment
 * serves and removing one narrows it — exactly what the gate exists to review.
 * While both were ungated, `PATCH value` (gated) → `DELETE` → `POST` laundered
 * an arbitrary value change past the value gate in three ungated calls.
 */
export async function createVariant(
  deps: FlagDefinitionDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const loaded = await loadWritableFlag(deps, args);
  if (!loaded.ok) return loaded.response;

  const body = objectBody(args.input);
  const name = body.name as string;
  const idempotencyKey = body.idempotency_key as string;
  const variantId = await prospectiveVariantId(loaded.value.flag.id, name, idempotencyKey);
  const proposalInput = { name, value: body.value, description: body.description ?? null };

  const replay = await replayApprovalIfExists(
    { ...deps, applyOther: makeOtherApprovalApplication(deps) },
    {
      appId: loaded.value.appId,
      operation: "flag_variants_create",
      target: { type: "flag_variant", id: variantId },
      proposalInput,
      principal: args.principal,
      idempotencyKey,
      inlineReview: body.review !== undefined,
      requestId: args.requestId,
    },
    { ignoreMismatch: true },
  );
  if (replay) return replay.ok ? flagJson(deps, loaded.value, args.requestId) : replay.response;

  // `flag_variants_create` declares `idempotency: "required"`, and `variantId` is
  // derived from (flagId, name, idempotencyKey), so a row already carrying that id
  // can only be this same request landing twice. Without this, a retry after a
  // timeout answers "Variant name already exists" instead of replaying.
  const already = await deps.repo.flags.getVariantById(loaded.value.scope, variantId);
  if (already) return flagJson(deps, loaded.value, args.requestId);

  const prepared = await prepareCreateVariant(deps, loaded.value, body, args.requestId);
  if (!prepared.ok) return prepared.response;

  const contexts = await variantPolicyContexts(
    deps.repo,
    loaded.value.appId,
    loaded.value.flag.id,
    name,
    ["variant_availability"],
  );
  if (requiresReview(contexts)) {
    return proposeVariantCreate(deps, {
      loaded: loaded.value,
      args,
      body,
      contexts,
      variantId,
      proposalInput,
    });
  }
  return applyVariantCreate(deps, loaded.value, args, body, variantId);
}

async function proposeVariantCreate(
  deps: FlagDefinitionDeps,
  input: {
    loaded: LoadedFlag;
    args: HandlerArgs<unknown>;
    body: Record<string, unknown>;
    contexts: ApprovalPolicyContext[];
    variantId: string;
    proposalInput: Record<string, unknown>;
  },
): Promise<Response> {
  const name = input.body.name as string;
  const approval = await createApproval(
    { ...deps, applyOther: makeOtherApprovalApplication(deps) },
    {
      appId: input.loaded.appId,
      operation: "flag_variants_create",
      target: { type: "flag_variant", id: input.variantId },
      policyContexts: input.contexts,
      current: {},
      proposed: {
        flagId: input.loaded.flag.id,
        name,
        value: input.body.value,
        description: (input.body.description as string | undefined) ?? null,
      },
      proposalInput: input.proposalInput,
      principal: input.args.principal,
      idempotencyKey: input.body.idempotency_key as string,
      inlineReview: input.body.review !== undefined,
      requestId: input.args.requestId,
      absentVariant: { flagId: input.loaded.flag.id, name },
    },
  );
  if (!approval.ok) return approval.response;
  return flagJson(deps, input.loaded, input.args.requestId);
}

async function applyVariantCreate(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  args: HandlerArgs<unknown>,
  body: Record<string, unknown>,
  variantId: string,
): Promise<Response> {
  const now = nowIso(deps);
  const variant = await deps.repo.flags.addVariant(loaded.scope, loaded.flag.id, {
    id: variantId,
    name: body.name as string,
    value: JSON.stringify(body.value),
    ...(body.description ? { description: body.description as string } : {}),
    createdAt: now,
  });
  if (!variant) return flagNotFound(args.requestId);

  if (body.isDefault) {
    await deps.repo.flags.updateFlag(loaded.scope, loaded.flag.id, {
      defaultVariantId: variant.id,
      updatedAt: now,
      updatedBy: args.principal.id,
    });
  }
  await resyncFlagSnapshots(deps, loaded.appId, loaded.flag.id);
  return flagJson(deps, loaded, args.requestId);
}

export async function deleteVariant(
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

  // DELETE carries no body, so the Approval idempotency key is the header the
  // registrar already requires for this route.
  const idempotencyKey = args.request.headers.get("idempotency-key") ?? "";
  const replay = await replayApprovalIfExists(
    { ...deps, applyOther: makeOtherApprovalApplication(deps) },
    {
      appId: loaded.value.appId,
      operation: "flag_variants_delete",
      target: { type: "flag_variant", id: variant.id },
      proposalInput: { name: variantName },
      principal: args.principal,
      idempotencyKey,
      inlineReview: false,
      requestId: args.requestId,
    },
    { ignoreMismatch: true },
  );
  if (replay) return replay.ok ? flagJson(deps, loaded.value, args.requestId) : replay.response;

  // Fail-fast only. `removeVariant` (and the Approval apply path) re-checks
  // `targeting_rules.variant_id` on the DELETE itself so a concurrent rule
  // replace cannot sneak a dangler past this read.
  const blocked = await variantDeleteBlocker(
    deps,
    loaded.value,
    variantName,
    variant,
    args.requestId,
  );
  if (blocked) return blocked;

  const contexts = await variantPolicyContexts(
    deps.repo,
    loaded.value.appId,
    loaded.value.flag.id,
    variantName,
    ["variant_availability"],
  );
  if (requiresReview(contexts)) {
    const approval = await createApproval(
      { ...deps, applyOther: makeOtherApprovalApplication(deps) },
      {
        appId: loaded.value.appId,
        operation: "flag_variants_delete",
        target: { type: "flag_variant", id: variant.id },
        policyContexts: contexts,
        current: variantProjection(loaded.value.flag.id, variant),
        proposed: {},
        proposalInput: { name: variantName },
        principal: args.principal,
        idempotencyKey,
        inlineReview: false,
        requestId: args.requestId,
      },
    );
    if (!approval.ok) return approval.response;
    return flagJson(deps, loaded.value, args.requestId);
  }

  return applyUngatedVariantDelete(deps, loaded.value, variantName, args.requestId);
}

async function applyUngatedVariantDelete(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  variantName: string,
  requestId: string,
): Promise<Response> {
  const removed = await deps.repo.flags.removeVariant(loaded.scope, loaded.flag.id, variantName);
  if (!removed.ok) return variantDeleteRefusal(removed, requestId);
  await resyncFlagSnapshots(deps, loaded.appId, loaded.flag.id);
  return flagJson(deps, loaded, requestId);
}

async function flagJson(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  requestId: string,
): Promise<Response> {
  const flag = await deps.repo.flags.getFlag(loaded.scope, loaded.flag.id);
  if (!flag) return flagNotFound(requestId);
  return Response.json(await flagResponse(deps.repo, loaded.appId, flag));
}

/**
 * The Variant id a create proposal will materialize. It has to be minted before
 * the row exists (it is the Approval target) and it has to survive an
 * idempotent retry, so it is derived from the Flag, the proposed name, and the
 * caller's idempotency key rather than from randomness.
 */
async function prospectiveVariantId(
  flagId: string,
  name: string,
  idempotencyKey: string,
): Promise<string> {
  const digest = await canonicalHash({ flagId, idempotencyKey, name });
  return `var_${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}
