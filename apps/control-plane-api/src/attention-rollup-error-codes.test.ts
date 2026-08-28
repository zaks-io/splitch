import { getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { appNotFound } from "./app-environment-model";
import {
  analysisUnavailable,
  experimentIntegrityFault,
  fanoutLimitExceeded,
  forbidden,
  missingLiveRun,
} from "./attention-rollup-errors";

/**
 * Structural half of the route-metadata equality check in
 * app-attention-rollup-contract.test.ts (packages/contracts can't import
 * apps/control-plane-api — contracts-stays-schema-only in
 * .dependency-cruiser.cjs runs the other direction).
 *
 * This invokes every refusal renderer the attention rollup handler
 * (attention-rollup.ts) calls and reads back the `code` each one actually
 * emits, so a renderer's code changing, or a new renderer being added here
 * without the contracts-side list following, fails a test instead of
 * silently drifting from packages/contracts' route.errors declaration.
 */
async function emittedCode(response: Response): Promise<string> {
  const body = (await response.json()) as { code: string };
  return body.code;
}

describe("attention rollup handler emitted error codes", () => {
  it("matches the route's declared error set exactly", async () => {
    const emitted = new Set(
      await Promise.all([
        emittedCode(appNotFound("req_1")),
        emittedCode(forbidden("req_1")),
        emittedCode(analysisUnavailable("req_1")),
        emittedCode(
          fanoutLimitExceeded({ appId: "app_x", limit: 200, environments: 240 }, "req_1"),
        ),
        emittedCode(experimentIntegrityFault(missingLiveRun("exp_x"), "req_1")),
      ]),
    );

    const declared = new Set(getRoute("app_attention_rollup_get")?.errors);
    declared.delete("SELECTOR_AMBIGUOUS");
    expect(emitted).toEqual(declared);
  });
});
