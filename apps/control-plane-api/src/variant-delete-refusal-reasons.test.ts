import { describe, expect, it } from "vitest";
import { variantDeleteApplicationRefusal } from "./approval-application";
import { type VariantDeleteRefusal, variantDeleteRefusal } from "./flag-definition-errors";

/**
 * One case per `RemoveVariantResult` failure reason, on BOTH consumers.
 *
 * A reason added to the union without a case here fails to TYPECHECK.
 */

type Reason = VariantDeleteRefusal["reason"];

const REFUSALS: Record<Reason, VariantDeleteRefusal> = {
  NOT_FOUND: { ok: false, reason: "NOT_FOUND" },
  NOT_APPLIED: { ok: false, reason: "NOT_APPLIED" },
  TARGETING_RULE_REFS: {
    ok: false,
    reason: "TARGETING_RULE_REFS",
    variantName: "treatment",
    targetingRules: [{ id: "rule_prod", environmentId: "env_prod" }],
  },
};

const HTTP: Record<Reason, { status: number; code: string }> = {
  NOT_FOUND: { status: 404, code: "VARIANT_NOT_FOUND" },
  NOT_APPLIED: { status: 500, code: "INTERNAL_SERVER_ERROR" },
  TARGETING_RULE_REFS: { status: 409, code: "RESOURCE_NOT_EMPTY" },
};

const OUTCOME: Record<Reason, Record<string, unknown>> = {
  NOT_FOUND: {
    ok: false,
    targetState: "rolled_back",
    error: { code: "VARIANT_NOT_FOUND", details: {} },
  },
  NOT_APPLIED: { ok: false, notApplied: true },
  TARGETING_RULE_REFS: {
    ok: false,
    unapplicable: {
      code: "RESOURCE_NOT_EMPTY",
      message:
        "Targeting Rules still reference this Variant (rule_prod); remove or retarget them before deleting it",
      details: {
        resourceType: "variant",
        resourceId: "treatment",
        childType: "flag-targeting-rules",
        childCount: 1,
        attemptedOp: "DELETE_VARIANT",
        targetingRuleIds: ["rule_prod"],
        targetingRules: [{ id: "rule_prod", environmentId: "env_prod" }],
      },
    },
  },
};

const REASONS = Object.keys(REFUSALS) as Reason[];

describe("the direct route gives every delete refusal reason its own status code", () => {
  for (const reason of REASONS) {
    it(`renders ${reason} as ${HTTP[reason].status} ${HTTP[reason].code}`, async () => {
      const response = variantDeleteRefusal(REFUSALS[reason], "req_spl207");
      const body = (await response.json()) as { code: string };

      expect({ status: response.status, code: body.code }).toEqual(HTTP[reason]);
    });
  }

  it("never renders a refusal as a success", async () => {
    for (const reason of REASONS) {
      expect(variantDeleteRefusal(REFUSALS[reason], "req_spl207").ok, reason).toBe(false);
    }
  });
});

describe("the Approval application gives every delete refusal reason its own outcome", () => {
  for (const reason of REASONS) {
    it(`records ${reason} distinctly`, () => {
      expect(variantDeleteApplicationRefusal(REFUSALS[reason])).toEqual(OUTCOME[reason]);
    });
  }

  it("never resolves a refusal as applied", () => {
    for (const reason of REASONS) {
      expect(variantDeleteApplicationRefusal(REFUSALS[reason]).ok, reason).toBe(false);
    }
  });
});
