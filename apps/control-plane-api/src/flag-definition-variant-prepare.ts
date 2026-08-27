import type { Repository } from "@splitch/db";
import {
  resourceNotEmpty,
  runningExperimentError,
  validationError,
  validationErrors,
  variantRunFrozenError,
  variantTargetingRuleReferenceError,
} from "./flag-definition-errors";
import {
  explicitVariantReferenceCount,
  targetingRulesReferencingVariant,
} from "./flag-definition-guards";
import {
  type FlagDefinitionDeps,
  fail,
  type LoadedFlag,
  ok,
  type Result,
} from "./flag-definition-handler-utils";
import { parseStoredSchema, pathBodyMismatch } from "./flag-definition-model";
import { validateJsonSchema } from "@splitch/contracts";

export type VariantRow = NonNullable<Awaited<ReturnType<Repository["flags"]["getVariantByName"]>>>;
export type VariantPatch = Parameters<Repository["flags"]["updateVariant"]>[3];

export async function prepareCreateVariant(
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

export async function prepareUpdateVariant(
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

  // Fails fast on the SAME predicate `updateVariant` enforces, so this cannot
  // drift from the seam that actually refuses the write. Reading it here is not
  // permission: the repository re-checks before the batch.
  const freeze = await deps.repo.flags.liveRunUsingVariant(loaded.scope, loaded.flag.id, variant);
  return freeze
    ? fail(variantRunFrozenError({ freeze, variantName, frozenChanges: ["value"] }, requestId))
    : ok({ value: nextValue });
}

function descriptionPatch(body: Record<string, unknown>): VariantPatch {
  return "description" in body ? { description: body.description as string } : {};
}

export async function variantDeleteBlocker(
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
  const availableCount = await explicitVariantReferenceCount(
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

  // Fail-fast only. `removeVariant` re-checks this predicate on the DELETE
  // itself; reading it here is not permission to write.
  const targetingRules = await targetingRulesReferencingVariant(
    deps.repo,
    loaded.appId,
    loaded.flag.id,
    variant.id,
    envs,
  );
  if (targetingRules.length > 0) {
    return variantTargetingRuleReferenceError({ variantName, targetingRules }, requestId);
  }

  const running = await deps.repo.flags.liveRunUsingVariant(loaded.scope, loaded.flag.id, variant);
  return running ? runningExperimentError(running, "DELETE_VARIANT", requestId) : null;
}
