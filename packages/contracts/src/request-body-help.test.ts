import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvironmentPolicySchema } from "./leaf-schemas-runtime";
import { describeRequestBody, requestBodySchemaForOperation } from "./request-body-help";
import {
  CreateExperimentRequestSchema,
  PatchExperimentRequestSchema,
} from "./resource-envelopes-experiment";
import {
  PatchFlagConfigRequestSchema,
  ReplaceTargetingRulesRequestSchema,
} from "./routes/route-shapes";
import { ReviewApprovalRequestSchema } from "./routes/route-shapes-approval-request";

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
});
