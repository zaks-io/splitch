import type { Variant } from "@splitch/contracts";
import { appScope, type TenantScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import { randomHex } from "./credential-cache";
import {
  flagNotFound,
  resourceNotEmpty,
  runningExperimentError,
  validationError,
  validationErrors,
} from "./flag-definition-errors";
import { flagConfigReferenceCount, runningExperimentForFlag } from "./flag-definition-guards";
import {
  type FlagDefinitionDeps,
  type FlagRow,
  fail,
  type LoadedFlag,
  loadWritableFlag,
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
import { schemaDefinitionIssues } from "./flag-definition-schema";
import { objectBody, pathParam } from "./handler-input";

export async function listFlags(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);

  const rows = await deps.repo.flags.flags.findMany(appScope(appId));
  const items = await Promise.all(rows.map((row) => flagResponse(deps.repo, appId, row)));
  return Response.json({ items });
}

export async function createFlag(
  deps: FlagDefinitionDeps,
  { input, principal, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const body = objectBody(input);
  const writeError = await requireWritableApp(deps, appId, principal, requestId);
  if (writeError) return writeError;

  const prepared = await prepareCreateFlag(deps, appId, body, requestId);
  if (!prepared.ok) return prepared.response;

  const now = nowIso(deps);
  const flag = await insertFlag(deps, appId, body, prepared.value, now, principal.id);
  try {
    await insertVariants(deps, prepared.value.scope, flag.id, prepared.value.variantRows, now);
  } catch (cause) {
    await deps.repo.flags.removeVariantsForFlag(prepared.value.scope, flag.id);
    await deps.repo.flags.removeFlag(prepared.value.scope, flag.id);
    throw cause;
  }
  return Response.json(await flagResponse(deps.repo, appId, flag));
}

export async function getFlag(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const flagId = pathParam(input, "flagId");
  const flag = await deps.repo.flags.getFlag(appScope(appId), flagId);
  if (!flag) return flagNotFound(requestId);
  return Response.json(await flagResponse(deps.repo, appId, flag));
}

export async function updateFlag(
  deps: FlagDefinitionDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const loaded = await loadWritableFlag(deps, args);
  if (!loaded.ok) return loaded.response;

  const body = objectBody(args.input);
  const schema = await prepareSchemaPatch(deps, loaded.value, body, args.requestId);
  if (!schema.ok) return schema.response;

  const updated = await deps.repo.flags.updateFlag(loaded.value.scope, loaded.value.flag.id, {
    ...(body.name !== undefined ? { name: body.name as string } : {}),
    ...(body.description !== undefined ? { description: body.description as string } : {}),
    ...(schema.value !== undefined ? { schema: serializeSchema(schema.value) } : {}),
    updatedAt: nowIso(deps),
    updatedBy: args.principal.id,
  });
  if (!updated) return flagNotFound(args.requestId);
  return Response.json(await flagResponse(deps.repo, loaded.value.appId, updated));
}

export async function deleteFlag(
  deps: FlagDefinitionDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const loaded = await loadWritableFlag(deps, args);
  if (!loaded.ok) return loaded.response;

  const blocked = await flagDeleteBlocker(deps, loaded.value, args.requestId);
  if (blocked) return blocked;

  await deps.repo.flags.removeVariantsForFlag(loaded.value.scope, loaded.value.flag.id);
  await deps.repo.flags.removeFlag(loaded.value.scope, loaded.value.flag.id);
  return Response.json({ deleted: true });
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
  if (await flagKeyExists(deps, scope, body.key)) {
    return fail(
      validationError(requestId, [["body", "key"], "flag key already exists in this App"]),
    );
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

async function flagKeyExists(
  deps: FlagDefinitionDeps,
  scope: TenantScope,
  key: unknown,
): Promise<boolean> {
  const existing = await deps.repo.flags.flags.findMany(scope);
  return existing.some((flag) => flag.key === key);
}

async function insertFlag(
  deps: FlagDefinitionDeps,
  appId: string,
  body: Record<string, unknown>,
  prepared: PreparedCreateFlag,
  now: string,
  actorId: string,
): Promise<FlagRow> {
  const defaultVariant = prepared.variantRows.find((variant) => variant.input.isDefault);
  if (!defaultVariant) throw new Error("createFlag: prepared catalog has no default Variant");
  return deps.repo.flags.flags.insert(prepared.scope, {
    id: `flag_${randomHex(12)}`,
    appId,
    key: body.key as string,
    name: body.name as string,
    ...(body.description ? { description: body.description as string } : {}),
    schema: serializeSchema(prepared.schema),
    defaultVariantId: defaultVariant.id,
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
  for (const variant of variants) {
    await deps.repo.flags.addVariant(scope, flagId, {
      id: variant.id,
      name: variant.input.name,
      value: JSON.stringify(variant.input.value),
      ...(variant.input.description ? { description: variant.input.description } : {}),
      createdAt: now,
    });
  }
}

async function prepareSchemaPatch(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Result<Record<string, unknown> | null | undefined>> {
  const schema = body.schema === undefined ? undefined : schemaFromBody(body.schema);
  if (schema === undefined) return ok(undefined);

  const existing = await deps.repo.flags.listVariants(loaded.scope, loaded.flag.id);
  const issues = [
    ...schemaDefinitionIssues(schema, ["body", "schema"]),
    ...variantSchemaIssues(
      schema,
      existing.map((variant) => ({
        name: variant.name,
        value: JSON.parse(variant.value) as Variant["value"],
        isDefault: variant.id === loaded.flag.defaultVariantId,
      })),
    ),
  ];
  return issues.length > 0 ? fail(validationErrors(requestId, issues)) : ok(schema);
}

async function flagDeleteBlocker(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  requestId: string,
): Promise<Response | null> {
  const envs = await deps.repo.identity.listEnvironments(loaded.scope);
  const configCount = await flagConfigReferenceCount(deps.repo, loaded.appId, loaded.flag.id, envs);
  if (configCount > 0) {
    return resourceNotEmpty(
      "flag",
      loaded.flag.id,
      "flag_configs",
      configCount,
      "DELETE_FLAG",
      requestId,
    );
  }

  const running = await runningExperimentForFlag(deps.repo, loaded.appId, loaded.flag.id, envs);
  return running ? runningExperimentError(running, "DELETE_FLAG", requestId) : null;
}
