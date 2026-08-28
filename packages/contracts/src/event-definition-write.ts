import { z } from "@hono/zod-openapi";
import {
  BooleanDefinitionSchema,
  ClosedJsonSchemaSchema,
  EventDefinitionFamilySchema,
  NumberDefinitionSchema,
  ScalarDefinitionSchema,
  StringDefinitionSchema,
  TelemetryTokenSchema,
} from "./event-definition";
import { validatePropertyNames } from "./event-definition-validation";
import {
  IdempotencyKeySchema,
  PERSISTED_JSON_MAX_DEPTH,
  PERSISTED_NAME_MAX_LENGTH,
  PersistedDescriptionSchema,
  PersistedIdentifierSchema,
  PersistedNameSchema,
  persistedArray,
} from "./persisted-field-limits";
import { addClosedJsonWriteIssues, closedJsonSchemaDepthExceeds } from "./write-persisted-schemas";

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

export const CreateEventDefinitionRequestSchema = z
  .object({
    name: TelemetryTokenSchema,
    family: EventDefinitionFamilySchema,
    displayName: PersistedNameSchema,
    description: PersistedDescriptionSchema.optional(),
    idempotency_key: IdempotencyKeySchema.optional(),
  })
  .strict();

export const PatchEventDefinitionRequestSchema = z
  .object({
    displayName: PersistedNameSchema.optional(),
    description: PersistedDescriptionSchema.optional(),
  })
  .strict();

/**
 * `z.preprocess`, not `.transform`: MCP derives tool JSON Schema from this
 * request body. A transform cannot be represented and breaks tool derivation.
 * Overflow replaces the document with `null` so the lazy Closed JSON parser
 * never walks a 2000-deep tree.
 */
function writeClosedJsonSchemaInput(value: unknown): unknown {
  if (closedJsonSchemaDepthExceeds(value, PERSISTED_JSON_MAX_DEPTH)) {
    return null;
  }
  return value;
}

const WriteJsonFieldDefinitionSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("json"),
    required: z.boolean(),
    jsonSchema: z.preprocess(writeClosedJsonSchemaInput, ClosedJsonSchemaSchema),
  })
  .strict();

const WriteEventFieldDefinitionSchema = z.discriminatedUnion("type", [
  BooleanDefinitionSchema,
  StringDefinitionSchema,
  NumberDefinitionSchema,
  WriteJsonFieldDefinitionSchema,
]);

export const PublishEventDefinitionVersionRequestSchema = z
  .object({
    entityType: PersistedIdentifierSchema.nullable(),
    fields: persistedArray(WriteEventFieldDefinitionSchema),
    dimensions: persistedArray(ScalarDefinitionSchema),
    idempotency_key: IdempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    refinePublishedNames(value, context);
    refinePublishedFieldBounds(value, context);
  });

function refinePublishedNames(
  value: z.infer<typeof PublishEventDefinitionVersionRequestSchema>,
  context: z.RefinementCtx,
): void {
  const fieldNames = value.fields.map(({ name }) => name);
  const dimensionNames = value.dimensions.map(({ name }) => name);
  validatePropertyNames([...fieldNames, ...dimensionNames], context, []);
  if (!unique(fieldNames)) {
    context.addIssue({ code: "custom", path: ["fields"], message: "field names must be unique" });
  }
  if (!unique(dimensionNames)) {
    context.addIssue({
      code: "custom",
      path: ["dimensions"],
      message: "Dimension names must be unique",
    });
  }
  if (fieldNames.some((name) => dimensionNames.includes(name))) {
    context.addIssue({ code: "custom", message: "field and Dimension names must be disjoint" });
  }
}

function refinePublishedFieldBounds(
  value: z.infer<typeof PublishEventDefinitionVersionRequestSchema>,
  context: z.RefinementCtx,
): void {
  for (const [index, field] of value.fields.entries()) {
    addOverLimitNameIssue(field.name, context, ["fields", index, "name"]);
    if (field.type === "json") {
      addClosedJsonWriteIssues(field.jsonSchema, context, ["fields", index, "jsonSchema"]);
    }
  }
  for (const [index, dimension] of value.dimensions.entries()) {
    addOverLimitNameIssue(dimension.name, context, ["dimensions", index, "name"]);
  }
}

function addOverLimitNameIssue(
  name: string,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (name.length > PERSISTED_NAME_MAX_LENGTH) {
    context.addIssue({
      code: "custom",
      path,
      message: `must be at most ${PERSISTED_NAME_MAX_LENGTH} characters`,
    });
  }
}
