import { FlagResponseSchema, schemaDefinitionIssues } from "@splitch/contracts";
import { appScope, type CreateFlagResult, type TenantScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model";
import { randomHex } from "./credential-cache";
import {
  createIdempotencyConflict,
  createIdempotencyKey,
  createRequestHash,
} from "./create-idempotency";
import { initializeFlagConfigsForFlag } from "./flag-config-lifecycle";
import { validationError, validationErrors } from "./flag-definition-errors";
import {
  type FlagDefinitionDeps,
  fail,
  ok,
  type Result,
  requireWritableApp,
  serializeSchema,
} from "./flag-definition-handler-utils";
import {
  type CreateVariantInput,
  duplicateVariantNameIssue,
  exactlyOneDefaultIssue,
  flagResponse,
  pathBodyMismatch,
  schemaFromBody,
  variantSchemaIssues,
} from "./flag-definition-model";
import { objectBody, pathParam } from "./handler-input";

export async function createFlag(
  deps: FlagDefinitionDeps,
  { input, principal, requestId, request }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const body = objectBody(input);
  const writeError = await requireWritableApp(deps, appId, principal, requestId);
  if (writeError) return writeError;

  const idempotencyKey = createIdempotencyKey(body, request);
  if (!idempotencyKey) throw new Error("flags_create requires an idempotency key");
  const { idempotency_key: _idempotencyKey, ...createPayload } = body;
  const requestHash = await createRequestHash(createPayload);
  const replay = await replayCreatedFlag(
    deps,
    appId,
    principal.id,
    idempotencyKey,
    requestHash,
    requestId,
    body,
  );
  if (replay) return replay;

  const prepared = await prepareCreateFlag(deps, appId, body, requestId);
  if (!prepared.ok) return prepared.response;

  const now = nowIso(deps);
  const inserted = await insertFlag(
    deps,
    appId,
    body,
    prepared.value,
    now,
    principal.id,
    idempotencyKey,
    requestHash,
  );
  if (!inserted.ok) {
    return (
      (await replayCreatedFlag(
        deps,
        appId,
        principal.id,
        idempotencyKey,
        requestHash,
        requestId,
        body,
      )) ?? flagKeyTakenError(requestId)
    );
  }
  const flag = inserted.flag;
  const defaultVariantId =
    prepared.value.variantRows.find((variant) => variant.input.isDefault)?.id ??
    flag.defaultVariantId;
  if (!defaultVariantId) throw new Error("createFlag: catalog has no default Variant");
  await insertVariants(deps, prepared.value.scope, flag.id, prepared.value.variantRows, now);
  await initializeFlagConfigsForFlag(deps, { appId, flagId: flag.id, defaultVariantId });
  const response = FlagResponseSchema.parse(await flagResponse(deps.repo, appId, flag));
  await deps.repo.flags.completeFlagCreate(prepared.value.scope, flag.id, JSON.stringify(response));
  return Response.json(response);
}

async function replayCreatedFlag(
  deps: FlagDefinitionDeps,
  appId: string,
  actorId: string,
  idempotencyKey: string,
  requestHash: string,
  requestId: string,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const scope = appScope(appId);
  const flag = await deps.repo.flags.getFlagCreateByIdempotency(scope, actorId, idempotencyKey);
  if (!flag) return null;
  if (flag.createRequestHash !== requestHash) {
    return createIdempotencyConflict("flag", idempotencyKey, requestId);
  }
  if (flag.createResponse) {
    return Response.json(FlagResponseSchema.parse(JSON.parse(flag.createResponse)));
  }
  await resumeFlagCreateProvisioning(deps, appId, flag, body);
  const response = FlagResponseSchema.parse(await flagResponse(deps.repo, appId, flag));
  await deps.repo.flags.completeFlagCreate(scope, flag.id, JSON.stringify(response));
  return Response.json(response);
}

async function resumeFlagCreateProvisioning(
  deps: FlagDefinitionDeps,
  appId: string,
  flag: NonNullable<Awaited<ReturnType<FlagDefinitionDeps["repo"]["flags"]["getFlag"]>>>,
  body: Record<string, unknown>,
): Promise<void> {
  const scope = appScope(appId);
  const expected = body.variants as Array<{
    name: string;
    value: unknown;
    description?: string;
    isDefault?: boolean;
  }>;
  const current = await deps.repo.flags.listVariants(scope, flag.id);
  const expectedNames = new Set(expected.map((variant) => variant.name));
  if (current.some((variant) => !expectedNames.has(variant.name))) {
    throw new Error("flags_create replay found a Variant outside the original request");
  }
  for (const variant of expected) {
    const existing = current.find((candidate) => candidate.name === variant.name);
    if (existing) {
      assertReplayedVariant(existing, variant, flag.defaultVariantId);
      continue;
    }
    await addReplayedVariant(deps, scope, flag.id, flag.defaultVariantId, variant);
  }
  if (!flag.defaultVariantId) throw new Error("flags_create replay has no Default Variant id");
  await initializeFlagConfigsForFlag(deps, {
    appId,
    flagId: flag.id,
    defaultVariantId: flag.defaultVariantId,
  });
}

function assertReplayedVariant(
  existing: { id: string; value: string; description: string | null },
  expected: { value: unknown; description?: string; isDefault?: boolean },
  defaultVariantId: string | null,
): void {
  const valueDiffers = existing.value !== JSON.stringify(expected.value);
  const descriptionDiffers = existing.description !== (expected.description ?? null);
  const defaultDiffers = (expected.isDefault === true) !== (existing.id === defaultVariantId);
  if (valueDiffers || descriptionDiffers || defaultDiffers) {
    throw new Error("flags_create replay found a Variant that differs from the request");
  }
}

async function addReplayedVariant(
  deps: FlagDefinitionDeps,
  scope: TenantScope,
  flagId: string,
  defaultVariantId: string | null,
  variant: { name: string; value: unknown; description?: string; isDefault?: boolean },
): Promise<void> {
  const id = variant.isDefault ? defaultVariantId : `var_${randomHex(12)}`;
  if (!id) throw new Error("flags_create replay has no Default Variant id");
  const existing = await deps.repo.flags.ensureCreateVariant(scope, flagId, {
    id,
    name: variant.name,
    value: JSON.stringify(variant.value),
    ...(variant.description ? { description: variant.description } : {}),
    createdAt: nowIso(deps),
  });
  assertReplayedVariant(existing, variant, defaultVariantId);
}

interface PreparedCreateFlag {
  scope: TenantScope;
  schema: Record<string, unknown> | null;
  variantRows: Array<{ input: CreateVariantInput; id: string }>;
}

async function prepareCreateFlag(
  deps: FlagDefinitionDeps,
  appId: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Result<PreparedCreateFlag>> {
  const mismatch = pathBodyMismatch(body, { appId });
  if (mismatch) return fail(validationError(requestId, mismatch));

  const variants = body.variants as CreateVariantInput[];
  const catalogIssue = exactlyOneDefaultIssue(variants) ?? duplicateVariantNameIssue(variants);
  if (catalogIssue) return fail(validationError(requestId, catalogIssue));

  const scope = appScope(appId);
  if (await deps.repo.flags.getFlagByKey(scope, body.key as string)) {
    return fail(flagKeyTakenError(requestId));
  }

  const schema = schemaFromBody(body.schema);
  const schemaErrors = [
    ...schemaDefinitionIssues(schema, ["body", "schema"]),
    ...variantSchemaIssues(schema, variants),
  ];
  if (schemaErrors.length > 0) return fail(validationErrors(requestId, schemaErrors));
  return ok({
    scope,
    schema,
    variantRows: variants.map((variant) => ({ input: variant, id: `var_${randomHex(12)}` })),
  });
}

function flagKeyTakenError(requestId: string): Response {
  return validationError(requestId, [["body", "key"], "flag key already exists in this App"]);
}

async function insertFlag(
  deps: FlagDefinitionDeps,
  appId: string,
  body: Record<string, unknown>,
  prepared: PreparedCreateFlag,
  now: string,
  actorId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<CreateFlagResult> {
  const defaultVariant = prepared.variantRows.find((variant) => variant.input.isDefault);
  if (!defaultVariant) throw new Error("createFlag: prepared catalog has no default Variant");
  return deps.repo.flags.createFlag(prepared.scope, {
    id: `flag_${randomHex(12)}`,
    appId,
    key: body.key as string,
    name: body.name as string,
    ...(body.description ? { description: body.description as string } : {}),
    schema: serializeSchema(prepared.schema),
    defaultVariantId: defaultVariant.id,
    createIdempotencyKey: idempotencyKey,
    createRequestHash: requestHash,
    createdAt: now,
    updatedAt: now,
    createdBy: actorId,
  });
}

async function insertVariants(
  deps: FlagDefinitionDeps,
  scope: TenantScope,
  flagId: string,
  variants: PreparedCreateFlag["variantRows"],
  now: string,
): Promise<void> {
  const defaultVariantId = variants.find((item) => item.input.isDefault)?.id ?? null;
  for (const variant of variants) {
    const existing = await deps.repo.flags.ensureCreateVariant(scope, flagId, {
      id: variant.id,
      name: variant.input.name,
      value: JSON.stringify(variant.input.value),
      ...(variant.input.description ? { description: variant.input.description } : {}),
      createdAt: now,
    });
    assertReplayedVariant(existing, variant.input, defaultVariantId);
  }
}
