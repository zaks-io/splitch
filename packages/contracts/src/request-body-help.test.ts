import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DraftAllocationSchema } from "./draft-allocation";
import { PublishEventDefinitionVersionRequestSchema } from "./event-definition-write";
import { EnvironmentPolicySchema } from "./leaf-schemas-runtime";
import { EvaluateAllRequestSchema } from "./leaves/evaluate-all-wire";
import { describeRequestBody, requestBodySchemaForOperation } from "./request-body-help";
import {
  CreateExperimentRequestSchema,
  PatchExperimentRequestSchema,
  StartRunRequestSchema,
} from "./resource-envelopes-experiment";
import { CreateFlagRequestSchema } from "./resource-envelopes-flag";
import {
  PatchFlagConfigRequestSchema,
  ReplaceTargetingRulesRequestSchema,
} from "./routes/route-shapes";
import { ReviewApprovalRequestSchema } from "./routes/route-shapes-approval-request";
import { WriteVariantValueSchema } from "./write-persisted-schemas";

describe("requestBodySchemaForOperation", () => {
  it("returns the route body schema for known body operations", () => {
    expect(requestBodySchemaForOperation("flag_config_update")).toBe(PatchFlagConfigRequestSchema);
    expect(requestBodySchemaForOperation("flag_targeting_rules_replace")).toBe(
      ReplaceTargetingRulesRequestSchema,
    );
    expect(requestBodySchemaForOperation("experiments_create")).toBe(CreateExperimentRequestSchema);
    expect(requestBodySchemaForOperation("experiments_update")).toBe(PatchExperimentRequestSchema);
    expect(requestBodySchemaForOperation("approval_request_reviews_create")).toBe(
      ReviewApprovalRequestSchema,
    );
    expect(requestBodySchemaForOperation("environments_update")).toBeDefined();
  });

  it("returns undefined for routes without a JSON body", () => {
    expect(requestBodySchemaForOperation("flags_list")).toBeUndefined();
    expect(requestBodySchemaForOperation("not_a_real_tool")).toBeUndefined();
  });
});

describe("describeRequestBody", () => {
  it("lists required and optional fields with enum values from the schema", () => {
    const help = describeRequestBody(EnvironmentPolicySchema);
    expect(help.fields.map((field) => field.name).sort()).toEqual([
      "enabledState",
      "startExperimentRun",
      "targetingRolloutValue",
      "variantAvailability",
    ]);
    for (const field of help.fields) {
      expect(field.required).toBe(true);
      expect(field.typeLabel).toContain('"allow"');
      expect(field.typeLabel).toContain('"confirm"');
    }
    expect(EnvironmentPolicySchema.safeParse(help.example).success).toBe(true);
  });

  it("marks optional fields and keeps examples schema-valid", () => {
    const help = describeRequestBody(PatchFlagConfigRequestSchema);
    const byName = Object.fromEntries(help.fields.map((field) => [field.name, field]));
    expect(byName.idempotency_key?.required).toBe(true);
    expect(byName.enabled?.required).toBe(false);
    expect(byName.rollout?.typeLabel).toContain("null");
    expect(PatchFlagConfigRequestSchema.safeParse(help.example).success).toBe(true);
    expect(JSON.stringify(help.example)).not.toMatch(/secret|token|password|api[_-]?key/i);
  });

  it("derives new required fields into help without hand-written text", () => {
    const unique = `probe_field_${Date.now()}`;
    const schema = z
      .object({
        idempotency_key: z.string().min(1),
        [unique]: z.string(),
      })
      .strict();
    const help = describeRequestBody(schema);
    expect(help.fields.some((field) => field.name === unique && field.required)).toBe(true);
    expect(JSON.stringify(help.example)).toContain(unique);
  });

  it("describes review action enums for approval reviews", () => {
    const help = describeRequestBody(ReviewApprovalRequestSchema);
    const action = help.fields.find((field) => field.name === "action");
    expect(action?.typeLabel).toContain("approve_and_apply");
    expect(action?.typeLabel).toContain("decline");
    expect(ReviewApprovalRequestSchema.safeParse(help.example).success).toBe(true);
  });

  it("describes experiment create and allocation update bodies", () => {
    const create = describeRequestBody(CreateExperimentRequestSchema);
    expect(create.fields.some((field) => field.name === "flagId" && field.required)).toBe(true);
    expect(CreateExperimentRequestSchema.safeParse(create.example).success).toBe(true);

    const patch = describeRequestBody(PatchExperimentRequestSchema);
    expect(patch.fields.some((field) => field.name === "allocation")).toBe(true);
    expect(patch.fields.every((field) => !field.required)).toBe(true);
    expect(PatchExperimentRequestSchema.safeParse(patch.example).success).toBe(true);
    expect(JSON.stringify(patch.example)).toContain("allocation");
  });

  it("describes targeting-rules replace with a concrete rules example", () => {
    const help = describeRequestBody(ReplaceTargetingRulesRequestSchema);
    expect(help.fields.some((field) => field.name === "targetingRules" && field.required)).toBe(
      true,
    );
    expect(ReplaceTargetingRulesRequestSchema.safeParse(help.example).success).toBe(true);
  });

  it("expands nested Targeting Rule enums instead of collapsing to object", () => {
    const help = describeRequestBody(ReplaceTargetingRulesRequestSchema);
    const rules = help.fields.find((field) => field.name === "targetingRules");
    expect(rules?.typeLabel).toContain('"eq"');
    expect(rules?.typeLabel).toContain('"not_matches"');
    expect(rules?.typeLabel).toContain("percentage");
    expect(rules?.typeLabel).toContain("(boolean | string | number)[]");
    expect(rules?.typeLabel).not.toMatch(/conditions:\s*object\[\]/);
    expect(rules?.typeLabel).not.toMatch(/percentageRollout\?:?\s*object(\s|\||$)/);
  });

  it("uses schema defaults for numbers instead of field-name special cases", () => {
    const create = describeRequestBody(CreateExperimentRequestSchema);
    const confidence = create.fields.find((field) => field.name === "confidenceLevel");
    expect(confidence?.defaultValue).toBe(0.95);

    // Pin example numbers that actually reach the Example body. A field-name
    // special case returning 50 for percentage/confidenceLevel must fail here
    // (midpoints differ from 50, and 50 is out of range for these bounds).
    const percentageProbe = describeRequestBody(
      z.object({ percentage: z.number().min(0).max(10) }),
    );
    expect(percentageProbe.example).toEqual({ percentage: 5 });

    const confidenceProbe = describeRequestBody(
      z.object({ confidenceLevel: z.number().min(0).max(1) }),
    );
    expect(confidenceProbe.example).toEqual({ confidenceLevel: 0.5 });
  });

  it("labels DraftAllocationSchema keys as Variant names by schema identity", () => {
    const patch = describeRequestBody(PatchExperimentRequestSchema);
    const allocation = patch.fields.find((field) => field.name === "allocation");
    expect(allocation?.typeLabel).toBe("Record<Variant name, number>");

    // Rename the field — label follows the schema, not the string "allocation".
    const renamed = describeRequestBody(z.object({ weights: DraftAllocationSchema }));
    expect(renamed.fields[0]?.typeLabel).toBe("Record<Variant name, number>");

    // A fresh record does not inherit the Variant-name label.
    const anonymous = describeRequestBody(
      z.object({ allocation: z.record(z.string(), z.number()) }),
    );
    expect(anonymous.fields[0]?.typeLabel).toBe("Record<string, number>");
  });

  it("prefers constrained optionals over free-form strings for idempotency-only bodies", () => {
    const start = describeRequestBody(StartRunRequestSchema);
    const example = start.example as Record<string, unknown>;
    expect(example).toEqual(
      expect.objectContaining({
        idempotency_key: expect.any(String),
        horizon: "sequential",
      }),
    );
    expect(example).not.toHaveProperty("sampleSizeLocked");
    expect(example).not.toHaveProperty("reason");
  });

  it("fails loud for non-object request body roots", () => {
    expect(() => describeRequestBody(z.array(z.string()))).toThrow(/must be a Zod object/);
    expect(() => describeRequestBody(z.record(z.string(), z.number()))).toThrow(
      /must be a Zod object/,
    );
  });

  it("fails loud for unsupported Zod field types instead of printing raw def names", () => {
    const schema = z.object({ weird: z.custom<() => void>(() => true) });
    expect(() => describeRequestBody(schema)).toThrow(/unsupported Zod type/);
  });

  it("keeps proto-safe attributes as a Record label (refine, not transform)", () => {
    const help = describeRequestBody(EvaluateAllRequestSchema);
    const attributes = help.fields.find((field) => field.name === "attributes");
    expect(attributes).toEqual(
      expect.objectContaining({
        name: "attributes",
        required: false,
        typeLabel: "Record<string, boolean | string | number | unknown[]>",
        defaultValue: {},
      }),
    );
  });

  it("fails loud when object type expansion exceeds depth", () => {
    const cyclic = z.object({
      get self() {
        return cyclic;
      },
    });
    expect(() => describeRequestBody(cyclic)).toThrow(/max depth/);
  });
});

describe("write Variant value help labels", () => {
  it("labels the write Variant value schema by identity instead of unrolling JSON depth", () => {
    const create = describeRequestBody(CreateFlagRequestSchema);
    expect(create.fields.find((field) => field.name === "variants")?.typeLabel).toContain(
      "boolean | string | number | Record<string, unknown>",
    );
    expect(CreateFlagRequestSchema.safeParse(create.example).success).toBe(true);

    const renamed = describeRequestBody(z.object({ payload: WriteVariantValueSchema }));
    expect(renamed.fields[0]?.typeLabel).toBe(
      "boolean | string | number | Record<string, unknown>",
    );
  });
});

describe("Event Definition write help labels", () => {
  it("labels Closed JSON as closed JSON Schema without a Zod transform", () => {
    const help = describeRequestBody(PublishEventDefinitionVersionRequestSchema);
    expect(help.fields.find((field) => field.name === "fields")?.typeLabel).toContain(
      "closed JSON Schema",
    );
    expect(PublishEventDefinitionVersionRequestSchema.safeParse(help.example).success).toBe(true);
  });
});
