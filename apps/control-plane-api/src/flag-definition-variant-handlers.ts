import type { Repository } from "@splitch/db";
import { appScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model";
import { makeOtherApprovalApplication } from "./approval-application";
import { createApproval, replayApprovalIfExists } from "./approval-service";
import { environmentPolicyContexts, requiresReview } from "./approval-target";
import { randomHex } from "./credential-cache";
import { readEnvironmentPolicy } from "./flag-config-policy";
import {
  flagNotFound,
  resourceNotEmpty,
  runFrozenError,
  runningExperimentError,
  validationError,
  validationErrors,
  variantNotFound,
} from "./flag-definition-errors";
import {
  availableVariantReferenceCount,
  runningExperimentForVariant,
} from "./flag-definition-guards";
import {
  type FlagDefinitionDeps,
  fail,
  type LoadedFlag,
  loadWritableFlag,
  ok,
  type Result,
  resyncFlagSnapshots,
} from "./flag-definition-handler-utils";
import { flagResponse, parseStoredSchema, pathBodyMismatch } from "./flag-definition-model";
import { validateJsonSchema } from "./flag-definition-schema";
import { objectBody, pathParam } from "./handler-input";

type VariantRow = NonNullable<Awaited<ReturnType<Repository["flags"]["getVariantByName"]>>>;
type VariantPatch = Parameters<Repository["flags"]["updateVariant"]>[3];

export async function createVariant(
  deps: FlagDefinitionDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const loaded = await loadWritableFlag(deps, args);
  if (!loaded.ok) return loaded.response;

  const body = objectBody(args.input);
  const prepared = await prepareCreateVariant(deps, loaded.value, body, args.requestId);
  if (!prepared.ok) return prepared.response;

  const now = nowIso(deps);
  const variant = await deps.repo.flags.addVariant(loaded.value.scope, loaded.value.flag.id, {
    id: `var_${randomHex(12)}`,
    name: body.name as string,
    value: JSON.stringify(body.value),
    ...(body.description ? { description: body.description as string } : {}),
    createdAt: now,
  });

  const updatedFlag = body.isDefault
    ? await deps.repo.flags.updateFlag(loaded.value.scope, loaded.value.flag.id, {
        defaultVariantId: variant.id,
        updatedAt: now,
        updatedBy: args.principal.id,
      })
    : loaded.value.flag;
  await resyncFlagSnapshots(deps, loaded.value.appId, loaded.value.flag.id);
  return Response.json(
    await flagResponse(deps.repo, loaded.value.appId, updatedFlag ?? loaded.value.flag),
  );
}

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

  const contexts =
    prepared.value.patch.value === undefined
      ? []
      : await variantPolicyContexts(
          deps.repo,
          loaded.value.appId,
          loaded.value.flag.id,
          variantName,
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
    await deps.repo.flags.updateVariant(
      loaded.value.scope,
      loaded.value.flag.id,
      variantName,
      prepared.value.patch,
      { updatedAt: now, updatedBy: args.principal.id },
    );
    await resyncFlagSnapshots(deps, loaded.value.appId, loaded.value.flag.id);
  }

  const updated = await deps.repo.flags.getFlag(loaded.value.scope, loaded.value.flag.id);
  if (!updated) return flagNotFound(args.requestId);
  return Response.json({
    flag: await flagResponse(deps.repo, loaded.value.appId, updated),
    approvalRequest: null,
  });
}

async function variantPolicyContexts(
  repo: Repository,
  appId: string,
  flagId: string,
  variantName: string,
) {
  const contexts = [];
  const environments = await repo.identity.listEnvironments(appScope(appId));
  for (const environment of environments) {
    const config = await repo.flags.getFlagConfig(envScope(appId, environment.id), flagId);
    if (!config) continue;
    const available = JSON.parse(config.availableVariantNames) as string[];
    if (available.length > 0 && !available.includes(variantName)) continue;
    const policy = await readEnvironmentPolicy(repo, appId, environment.id);
    if (!policy) continue;
    contexts.push(
      ...environmentPolicyContexts(environment.id, policy, ["targeting_rollout_value"]),
    );
  }
  return contexts;
}

function variantProjection(flagId: string, variant: VariantRow): Record<string, unknown> {
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

  const blocked = await variantDeleteBlocker(
    deps,
    loaded.value,
    variantName,
    variant,
    args.requestId,
  );
  if (blocked) return blocked;

  await deps.repo.flags.removeVariant(loaded.value.scope, loaded.value.flag.id, variantName);
  await resyncFlagSnapshots(deps, loaded.value.appId, loaded.value.flag.id);
  const updated = await deps.repo.flags.getFlag(loaded.value.scope, loaded.value.flag.id);
  if (!updated) return flagNotFound(args.requestId);
  return Response.json(await flagResponse(deps.repo, loaded.value.appId, updated));
}

async function prepareCreateVariant(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Result<true>> {
  const mismatch = pathBodyMismatch(body, { appId: loaded.appId, flagId: loaded.flag.id });
  if (mismatch) return fail(validationError(requestId, mismatch));

  const existing = await deps.repo.flags.listVariants(loaded.scope, loaded.flag.id);
  if (existing.some((variant) => variant.name === body.name)) {
    return fail(validationError(requestId, [["body", "name"], "Variant name already exists"]));
  }

  const issues = validateJsonSchema(parseStoredSchema(loaded.flag.schema), body.value, [
    "body",
    "value",
  ]);
  return issues.length > 0 ? fail(validationErrors(requestId, issues)) : ok(true);
}

async function prepareUpdateVariant(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  variantName: string,
  variant: VariantRow,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Result<{ patch: VariantPatch }>> {
  const namePatch = await prepareVariantNamePatch(deps, loaded, variant, body, requestId);
  if (!namePatch.ok) return namePatch;

  const valuePatch = await prepareVariantValuePatch(
    deps,
    loaded,
    variantName,
    variant,
    body,
    requestId,
  );
  if (!valuePatch.ok) return valuePatch;

  return ok({
    patch: {
      ...namePatch.value,
      ...valuePatch.value,
      ...descriptionPatch(body),
    },
  });
}

async function prepareVariantNamePatch(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  variant: VariantRow,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Result<VariantPatch>> {
  if (!("name" in body) || body.name === variant.name) return ok({});

  const existing = await deps.repo.flags.getVariantByName(
    loaded.scope,
    loaded.flag.id,
    body.name as string,
  );
  if (existing) {
    return fail(validationError(requestId, [["body", "name"], "Variant name already exists"]));
  }
  return ok({ name: body.name as string });
}

async function prepareVariantValuePatch(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  variantName: string,
  variant: VariantRow,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Result<VariantPatch>> {
  if (!("value" in body)) return ok({});

  const issues = validateJsonSchema(parseStoredSchema(loaded.flag.schema), body.value, [
    "body",
    "value",
  ]);
  if (issues.length > 0) return fail(validationErrors(requestId, issues));

  const nextValue = JSON.stringify(body.value);
  if (nextValue === variant.value) return ok({});

  const envs = await deps.repo.identity.listEnvironments(loaded.scope);
  const running = await runningExperimentForVariant(
    deps.repo,
    loaded.appId,
    loaded.flag.id,
    variant,
    envs,
  );
  return running
    ? fail(runFrozenError(running, ["variant.value"], `PATCH_VARIANT:${variantName}`, requestId))
    : ok({ value: nextValue });
}

function descriptionPatch(body: Record<string, unknown>): VariantPatch {
  return "description" in body ? { description: body.description as string } : {};
}

async function variantDeleteBlocker(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  variantName: string,
  variant: VariantRow,
  requestId: string,
): Promise<Response | null> {
  if (variant.id === loaded.flag.defaultVariantId) {
    return validationError(requestId, [
      ["params", "variantName"],
      "cannot delete the default Variant; a Flag must have exactly one default Variant",
    ]);
  }

  const envs = await deps.repo.identity.listEnvironments(loaded.scope);
  const availableCount = await availableVariantReferenceCount(
    deps.repo,
    loaded.appId,
    loaded.flag.id,
    variantName,
    envs,
  );
  if (availableCount > 0) {
    return resourceNotEmpty(
      "variant",
      variantName,
      "flag_configs",
      availableCount,
      "DELETE_VARIANT",
      requestId,
    );
  }

  const running = await runningExperimentForVariant(
    deps.repo,
    loaded.appId,
    loaded.flag.id,
    variant,
    envs,
  );
  return running ? runningExperimentError(running, "DELETE_VARIANT", requestId) : null;
}
