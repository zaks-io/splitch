import type { z } from "zod";
import { exampleForObject, exampleValue } from "./request-body-help-example";
import {
  describeObjectFields,
  type RequestBodyFieldHelp,
  unwrapToObject,
} from "./request-body-help-unwrap";
import { getRoute } from "./route-registry";

/**
 * Derive CLI/MCP `--body-json` help from the route's request-body Zod schema
 * (ADR-0025). Help text is never hand-copied from field lists — callers render
 * {@link describeRequestBody} so a schema change changes help automatically.
 */

export type { RequestBodyFieldHelp };

export interface RequestBodyHelp {
  readonly fields: readonly RequestBodyFieldHelp[];
  /** One concrete body that satisfies the schema (no secrets). */
  readonly example: unknown;
}

/** OpenAPI JSON body schema for a registered operation, when the route has one. */
export function requestBodySchemaForOperation(operationId: string): z.ZodTypeAny | undefined {
  const schema =
    getRoute(operationId)?.openapi.request?.body?.content?.["application/json"]?.schema;
  return isZodType(schema) ? schema : undefined;
}

/** Field list + example body derived from a Zod request schema. */
export function describeRequestBody(schema: z.ZodTypeAny): RequestBodyHelp {
  const objectSchema = unwrapToObject(schema);
  if (!objectSchema) {
    return { fields: [], example: exampleValue(schema, "body") };
  }
  const fields = describeObjectFields(objectSchema);
  return { fields, example: exampleForObject(objectSchema, fields) };
}

function isZodType(value: unknown): value is z.ZodTypeAny {
  return Boolean(value && typeof value === "object" && "safeParse" in value);
}
