import { describe, expect, it } from "vitest";
import {
  AppAttentionRollupResponseSchema,
  EnvironmentAttentionRollupSchema,
  getRoute,
} from "./index";

describe("App attention rollup contract", () => {
  it("keeps Environment identity and no-data/clear/attention states explicit", () => {
    const response = AppAttentionRollupResponseSchema.parse({
      appId: "app_checkout",
      items: [
        { environmentId: "env_dev", state: "clear", srm: false, guardrail: false },
        { environmentId: "env_prod", state: "attention", srm: true, guardrail: true },
        { environmentId: "env_qa", state: "no_data", srm: false, guardrail: false },
      ],
    });

    expect(response.items.map((item) => item.environmentId)).toEqual([
      "env_dev",
      "env_prod",
      "env_qa",
    ]);
  });

  it("rejects fabricated failure flags outside the attention state", () => {
    expect(
      EnvironmentAttentionRollupSchema.safeParse({
        environmentId: "env_prod",
        state: "no_data",
        srm: true,
        guardrail: false,
      }).success,
    ).toBe(false);
    expect(
      EnvironmentAttentionRollupSchema.safeParse({
        environmentId: "env_prod",
        state: "attention",
        srm: false,
        guardrail: false,
      }).success,
    ).toBe(false);
  });

  it("registers the authenticated read-only Control Plane route", () => {
    expect(getRoute("app_attention_rollup_get")).toMatchObject({
      owner: "control-plane-api",
      method: "GET",
      path: "/apps/:appId/attention-rollup",
      auth: "control-plane-token",
      idempotency: "none",
    });
  });

  // The handler can refuse an oversized fan-out, so the route metadata has to
  // declare the code: it is the single list every derived surface reads from.
  //
  // The generated-document proof that this metadata emits the declared 409 and
  // excludes undeclared 409 codes lives in openapi-document.test.ts.
  //
  // Handler and resolver sets together close over the full declared set.
  // The handler set is the full set of codes
  // makeAttentionRollupHandler can emit (attention-rollup.ts +
  // attention-rollup-errors.ts) -- appNotFound, forbidden,
  // fanoutLimitExceeded, analysisUnavailable, and experimentIntegrityFault
  // (the ExperimentIntegrityError path, a genuine INTERNAL_SERVER_ERROR).
  //
  // This side is a literal list because packages/contracts cannot import
  // apps/control-plane-api (contracts-stays-schema-only,
  // .dependency-cruiser.cjs). The structural half lives in
  // apps/control-plane-api/src/attention-rollup-error-codes.test.ts, which
  // invokes the actual renderer functions and asserts their emitted codes
  // against this same route metadata -- a renderer drifting from this list,
  // or a new refusal added without one, fails that test.
  it("declares exactly the errors the attention rollup can return in its route metadata", () => {
    const declared = new Set<string>(getRoute("app_attention_rollup_get")?.errors ?? []);
    const emittedByHandler = new Set<string>([
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "SERVICE_UNAVAILABLE",
      "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      "INTERNAL_SERVER_ERROR",
    ]);
    const emittedByResolver = new Set<string>(["APP_NOT_FOUND", "SELECTOR_AMBIGUOUS"]);
    expect([...emittedByHandler].every((code) => declared.has(code))).toBe(true);
    expect([...emittedByResolver].every((code) => declared.has(code))).toBe(true);
    expect(declared).toEqual(new Set([...emittedByHandler, ...emittedByResolver]));
  });
});
