import { describe, expect, it } from "vitest";
import { FlagRemovalBriefResponseSchema } from "./flag-removal";
import { PERSISTED_NAME_MAX_LENGTH } from "./persisted-field-limits";

describe("FlagRemovalBriefResponseSchema", () => {
  it("accepts retained Variant names over the write-side name bound", () => {
    const overLimitName = "v".repeat(PERSISTED_NAME_MAX_LENGTH + 1);
    const parsed = FlagRemovalBriefResponseSchema.safeParse({
      flagId: "flag_1",
      flagKey: "legacy-flag",
      variants: [{ id: "var_1", name: overLimitName, value: true }],
      lifecycleClass: "release",
      owner: null,
      expiresAt: null,
      environments: [
        {
          environmentId: "env_1",
          environmentKey: "prod",
          enabled: false,
          configurationServedVariant: overLimitName,
          servingEvidence: "configuration_unverified",
          blockers: [],
          evaluationError: null,
        },
      ],
      uniformAcrossEnvironments: true,
      keepVariant: overLimitName,
      removalSafe: true,
      removalBlockers: [],
      sdkCallShapes: ['evaluate("legacy-flag"'],
      caveats: ["splitch never writes customer code."],
    });
    expect(parsed.success).toBe(true);
  });
});
