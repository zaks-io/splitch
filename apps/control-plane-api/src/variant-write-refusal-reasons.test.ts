import { describe, expect, it } from "vitest";
import { variantApplicationRefusal } from "./approval-application";
import { type VariantWriteRefusal, variantWriteRefusal } from "./flag-definition-errors";

/**
 * One case per `UpdateVariantResult` failure reason, on BOTH consumers (SPL-267,
 * round 4).
 *
 * The defect these pin: the direct route branched on `RUN_FROZEN` alone and let
 * `NOT_FOUND` and `NOT_APPLIED` fall through to the snapshot resync and a 200
 * flag body, and the Approval application folded `NOT_FOUND` into the
 * `notApplied` race. Both told the caller something other than what happened.
 *
 * The fixture tables are keyed by the reason UNION, so a reason added to
 * `UpdateVariantResult` without a case here fails to typecheck. A union member
 * with no test is how the fallthrough survived two audit rounds.
 */

type Reason = VariantWriteRefusal["reason"];

const REFUSALS: Record<Reason, VariantWriteRefusal> = {
  NOT_FOUND: { ok: false, reason: "NOT_FOUND" },
  NOT_APPLIED: { ok: false, reason: "NOT_APPLIED" },
  RUN_FROZEN: {
    ok: false,
    reason: "RUN_FROZEN",
    freeze: { experimentId: "exp_checkout", runId: "run_live", environmentId: "env_prod" },
    variantName: "treatment",
    frozenChanges: ["value"],
  },
};

const HTTP: Record<Reason, { status: number; code: string }> = {
  NOT_FOUND: { status: 404, code: "VARIANT_NOT_FOUND" },
  NOT_APPLIED: { status: 500, code: "INTERNAL_SERVER_ERROR" },
  RUN_FROZEN: { status: 409, code: "RUN_FROZEN" },
};

const OUTCOME: Record<Reason, Record<string, unknown>> = {
  NOT_FOUND: { ok: false, error: { code: "VARIANT_NOT_FOUND", details: {} } },
  NOT_APPLIED: { ok: false, notApplied: true },
  RUN_FROZEN: {
    ok: false,
    error: {
      code: "RUN_FROZEN",
      details: {
        frozenFields: ["variant.value"],
        currentRunId: "run_live",
        attemptedChange: "PATCH_VARIANT:treatment",
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    },
  },
};

const REASONS = Object.keys(REFUSALS) as Reason[];

describe("the direct route gives every refusal reason its own status code", () => {
  for (const reason of REASONS) {
    it(`renders ${reason} as ${HTTP[reason].status} ${HTTP[reason].code}`, async () => {
      const response = variantWriteRefusal(REFUSALS[reason], "req_spl267");
      const body = (await response.json()) as { code: string };

      expect({ status: response.status, code: body.code }).toEqual(HTTP[reason]);
    });
  }

  it("never renders a refusal as a success", async () => {
    for (const reason of REASONS) {
      expect(variantWriteRefusal(REFUSALS[reason], "req_spl267").ok, reason).toBe(false);
    }
  });
});

describe("the Approval application gives every refusal reason its own outcome", () => {
  for (const reason of REASONS) {
    it(`records ${reason} distinctly`, () => {
      expect(variantApplicationRefusal(REFUSALS[reason])).toEqual(OUTCOME[reason]);
    });
  }

  it("never resolves a refusal as applied", () => {
    for (const reason of REASONS) {
      expect(variantApplicationRefusal(REFUSALS[reason]).ok, reason).toBe(false);
    }
  });
});
