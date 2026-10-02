import { describeObjectFields, getRoute, unwrapToObject } from "@splitch/sdk/control-plane";
import type { z } from "zod";
import { SplitchCliError } from "./errors.js";
import { RESERVED_CLI_FLAG_KEBABS } from "./reserved-flags.js";

/**
 * Query fields the CLI already maps through specialized flags or path context.
 * Derivation skips these so help and parsing do not grow a second spelling.
 */
const HAND_MANAGED_QUERY_FIELDS = new Set([
  "by",
  "dryRun",
  "force",
  "environmentId",
  "include",
  "envs",
]);

export interface QueryFlagSpec {
  readonly name: string;
  readonly kebab: string;
  readonly required: boolean;
  readonly typeLabel: string;
  readonly defaultValue: string;
  readonly description: string;
  readonly fieldSchema: z.ZodTypeAny;
}

/**
 * Collision rule: a route query field whose kebab-case name matches a reserved
 * global or hand-mapped CLI flag is never derived. Use the reserved flag (for
 * example `--env` for Environment scope, `--dry-run` for App delete). Query
 * fields that keep a distinct kebab (for example `--cursor`, `--from`) are
 * derived from the route OpenAPI query schema.
 */
export function queryFlagSpecs(operationId: string): readonly QueryFlagSpec[] {
  const querySchema = routeQuerySchema(operationId);
  if (!querySchema) return [];
  return specsFromSchema(querySchema);
}

export function queryHelpFlags(operationId: string): Array<{
  readonly syntax: string;
  readonly type: string;
  readonly defaultValue: string;
  readonly description: string;
}> {
  return queryFlagSpecs(operationId).map((spec) => ({
    syntax: `--${spec.kebab} <${spec.kebab}>`,
    type: spec.typeLabel,
    defaultValue: spec.defaultValue,
    description: spec.description,
  }));
}

/** Merge derived query flags into the flat operation input; fail loud on gaps. */
export function applyRouteQueryFlags(
  operationId: string,
  queryFlags: Readonly<Record<string, string>>,
  input: Record<string, unknown>,
  commandPath: readonly string[],
): void {
  const querySchema = routeQuerySchema(operationId);
  if (!querySchema) {
    assertNoQueryFlags(queryFlags, commandPath);
    return;
  }
  applyQueryFlagsForSchema(querySchema, queryFlags, input, commandPath);
}

/** Apply flags against an explicit query schema (production + required-flag tests). */
export function applyQueryFlagsForSchema(
  querySchema: z.ZodTypeAny,
  queryFlags: Readonly<Record<string, string>>,
  input: Record<string, unknown>,
  commandPath: readonly string[],
): void {
  const specs = specsFromSchema(querySchema);
  assertKnownQueryFlags(specs, queryFlags, commandPath);
  for (const spec of specs) {
    applyOneQueryFlag(spec, queryFlags, input, commandPath);
  }
}

export function fieldNameToKebab(name: string): string {
  return name
    .replaceAll("_", "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/** Hand-mapped `--by` selector; kept separate from derived query flags. */
export function applyByFlag(
  command: { readonly operationId: string; readonly path: readonly string[] },
  by: string | undefined,
  input: Record<string, unknown>,
): void {
  if (!by) return;
  const querySchema = routeQuerySchema(command.operationId);
  const objectSchema = querySchema ? unwrapToObject(querySchema) : undefined;
  if (!objectSchema || !Object.hasOwn(objectSchema.shape, "by")) {
    throw usageError(
      `--by is not accepted by splitch ${command.path.join(" ")}`,
      `Drop --by, or run splitch ${command.path.join(" ")} --help to list the accepted flags`,
    );
  }
  input.by = by;
}

function specsFromSchema(querySchema: z.ZodTypeAny): QueryFlagSpec[] {
  const objectSchema = unwrapToObject(querySchema);
  if (!objectSchema) return [];
  const shape = objectSchema.shape as Record<string, z.ZodTypeAny>;
  return describeObjectFields(objectSchema).flatMap((field) => {
    const spec = specFromHelpField(field, shape);
    return spec ? [spec] : [];
  });
}

function specFromHelpField(
  field: {
    readonly name: string;
    readonly required: boolean;
    readonly typeLabel: string;
    readonly defaultValue?: unknown;
  },
  shape: Record<string, z.ZodTypeAny>,
): QueryFlagSpec | undefined {
  if (HAND_MANAGED_QUERY_FIELDS.has(field.name)) return undefined;
  const kebab = fieldNameToKebab(field.name);
  if (RESERVED_CLI_FLAG_KEBABS.has(kebab)) return undefined;
  const fieldSchema = shape[field.name];
  if (!fieldSchema) return undefined;
  return {
    name: field.name,
    kebab,
    required: field.required,
    typeLabel: field.typeLabel,
    defaultValue: helpDefault(field),
    description: fieldDescription(fieldSchema, field.name),
    fieldSchema,
  };
}

function helpDefault(field: {
  readonly required: boolean;
  readonly defaultValue?: unknown;
}): string {
  if (field.defaultValue !== undefined) return JSON.stringify(field.defaultValue);
  return field.required ? "required" : "none";
}

function assertKnownQueryFlags(
  specs: readonly QueryFlagSpec[],
  queryFlags: Readonly<Record<string, string>>,
  commandPath: readonly string[],
): void {
  const byKebab = new Set(specs.map((spec) => spec.kebab));
  for (const kebab of Object.keys(queryFlags)) {
    if (byKebab.has(kebab)) continue;
    throw usageError(
      `--${kebab} is not accepted by splitch ${commandPath.join(" ")}`,
      `Drop --${kebab}, or run splitch ${commandPath.join(" ")} --help to list the accepted flags`,
    );
  }
}

function applyOneQueryFlag(
  spec: QueryFlagSpec,
  queryFlags: Readonly<Record<string, string>>,
  input: Record<string, unknown>,
  commandPath: readonly string[],
): void {
  const raw = queryFlags[spec.kebab];
  if (raw === undefined) {
    if (spec.required && !Object.hasOwn(input, spec.name)) {
      throw usageError(
        `--${spec.kebab} is required by splitch ${commandPath.join(" ")}`,
        `Pass --${spec.kebab} <${spec.kebab}>`,
      );
    }
    return;
  }
  const parsed = spec.fieldSchema.safeParse(raw);
  if (!parsed.success) {
    throw usageError(
      `--${spec.kebab} is invalid for splitch ${commandPath.join(" ")}: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
      `Pass a value matching ${spec.typeLabel}, or run splitch ${commandPath.join(" ")} --help`,
    );
  }
  input[spec.name] = parsed.data;
}

function assertNoQueryFlags(
  queryFlags: Readonly<Record<string, string>>,
  commandPath: readonly string[],
): void {
  const unexpected = Object.keys(queryFlags)[0];
  if (!unexpected) return;
  throw usageError(
    `--${unexpected} is not accepted by splitch ${commandPath.join(" ")}`,
    `Drop --${unexpected}, or run splitch ${commandPath.join(" ")} --help to list the accepted flags`,
  );
}

function routeQuerySchema(operationId: string): z.ZodTypeAny | undefined {
  const query = getRoute(operationId)?.openapi.request?.query;
  return query && typeof query === "object" && "safeParse" in query
    ? (query as z.ZodTypeAny)
    : undefined;
}

function fieldDescription(schema: z.ZodTypeAny, name: string): string {
  let current: z.ZodTypeAny | undefined = schema;
  for (let guard = 0; guard < 8 && current; guard += 1) {
    const description = (current as { description?: string }).description;
    if (typeof description === "string" && description.length > 0) return description;
    const def = (current as unknown as { def?: Record<string, unknown> }).def;
    current = (def?.innerType ?? def?.schema ?? def?.in) as z.ZodTypeAny | undefined;
  }
  return `Query parameter ${name}.`;
}

function usageError(causeSummary: string, remediation: string): SplitchCliError {
  return new SplitchCliError({ code: "CLI_USAGE_INVALID", causeSummary, remediation });
}
