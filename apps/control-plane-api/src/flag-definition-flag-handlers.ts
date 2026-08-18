import type { Variant } from "@splitch/contracts";
import { appScope, type CreateFlagResult, type TenantScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import { randomHex } from "./credential-cache";
import {
  deleteFlagD1Cascade,
  initializeFlagConfigsForFlag,
  purgeFlagConfigsKvForFlag,
} from "./flag-config-lifecycle";
import { flagNotFound, validationError, validationErrors } from "./flag-definition-errors";
import {
  type FlagDefinitionDeps,
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
  flagFrom,
  flagResponse,
  pathBodyMismatch,
  schemaFromBody,
  variantSchemaIssues,
} from "./flag-definition-model";
import { schemaDefinitionIssues } from "./flag-definition-schema";
import { objectBody, pathParam } from "./handler-input";
import { FLAG_LIST_READ_LIMIT } from "./overview-thresholds";

/**
 * The App's Flag catalog: bounded, newest first, and honest about the bound.
 *
 * This is the screen the Overview's truncation notice sends an operator to, so
 * it is the one list that must not answer "too much data to show you" with
 * another read whose cost is the App's whole catalog plus a query per row.
 */
export async function listFlags(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);

  const scope = appScope(appId);
  // One row past the ceiling, so truncation is OBSERVED rather than inferred
  // from a full page — a page of exactly `readLimit` rows is what a complete
  // catalog of that size also looks like.
  const scanned = await deps.repo.flags.listFlagPage(scope, FLAG_LIST_READ_LIMIT + 1);
  const readTruncated = scanned.length > FLAG_LIST_READ_LIMIT;
  const rows = readTruncated ? scanned.slice(0, FLAG_LIST_READ_LIMIT) : scanned;
  // ONE catalog read for the whole page. Resolving Variants per row made this
  // list cost a D1 query per Flag, on exactly the App large enough to be sent
  // here in the first place.
  const catalogs = await deps.repo.flags.listVariantsForFlags(
    scope,
    rows.map((row) => row.id),
  );
  const items = rows.map((row) => flagFrom(row, catalogs.get(row.id) ?? []));
  return Response.json({ items, readTruncated, readLimit: FLAG_LIST_READ_LIMIT });
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
  const inserted = await insertFlag(deps, appId, body, prepared.value, now, principal.id);
  // The unique index, not the preceding lookup, is what makes the key unique. A
  // create that lost the race to a concurrent one lands here and is refused with
  // the same field error the pre-check produces, never a 500 and never a
  // duplicate.
  if (!inserted.ok) return flagKeyTakenError(requestId);
  const flag = inserted.flag;
  const defaultVariantId =
    prepared.value.variantRows.find((variant) => variant.input.isDefault)?.id ??
    flag.defaultVariantId;
  if (!defaultVariantId) {
    throw new Error("createFlag: catalog has no default Variant");
  }
  try {
    await insertVariants(deps, prepared.value.scope, flag.id, prepared.value.variantRows, now);
    await initializeFlagConfigsForFlag(deps, { appId, flagId: flag.id, defaultVariantId });
  } catch (cause) {
    await rollbackCreatedFlag(deps, appId, flag.id);
    throw cause;
  }
  return Response.json(await flagResponse(deps.repo, appId, flag));
}

export async function getFlag(
  deps: FlagDefinitionDeps,
  { input, requestId, request }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const selector = pathParam(input, "flagId");
  // Path is id-only by default. Key lookup is an explicit ?by=key so a Flag key
  // that equals another Flag's canonical id can never collide on one segment
  // (SPL-236). Write routes stay id-only via loadWritableFlag.
  //
  // Read `by` from URLSearchParams (first value), not from the parsed query
  // record: queryToRecord last-wins on duplicates, while the Panel claim parser
  // first-wins — `?by=id&by=key` would otherwise mint by:"id" and resolve as key.
  const flag =
    flagLookupBy(request) === "key"
      ? await deps.repo.flags.getFlagByKey(appScope(appId), selector)
      : await deps.repo.flags.getFlag(appScope(appId), selector);
  if (!flag) return flagNotFound(requestId);
  return Response.json(await flagResponse(deps.repo, appId, flag));
}

/** Same source as `parseControlPanelOperation`: URLSearchParams first value. */
function flagLookupBy(request: Request): "id" | "key" {
  return new URL(request.url).searchParams.get("by") === "key" ? "key" : "id";
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
  // Keyed on the `(app_id, key)` unique index rather than filtered out of the
  // App's Flag set. The set read cannot be bounded here: "is this key taken" has
  // no honest partial answer, and a row a LIMIT skipped reads back as a free key
  // (ADR-0036). The index probe answers it exactly, at fixed cost.
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

/** The one duplicate-key answer, shared by the pre-check and the index violation. */
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

async function rollbackCreatedFlag(
  deps: FlagDefinitionDeps,
  appId: string,
  flagId: string,
): Promise<void> {
  await purgeFlagConfigsKvForFlag(deps, appId, flagId);
  await deleteFlagD1Cascade(deps, appId, flagId);
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
