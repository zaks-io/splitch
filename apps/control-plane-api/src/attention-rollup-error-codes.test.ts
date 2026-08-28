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
  it("keeps handler and resolver emitted errors inside the declared set", async () => {
    const emittedByHandler = new Set<string>(
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

    const emittedByResolver = new Set<string>(["APP_NOT_FOUND", "SELECTOR_AMBIGUOUS"]);
    const declared = new Set<string>(getRoute("app_attention_rollup_get")?.errors ?? []);
    expect([...emittedByHandler].every((code) => declared.has(code))).toBe(true);
    expect([...emittedByResolver].every((code) => declared.has(code))).toBe(true);
    expect(declared).toEqual(new Set([...emittedByHandler, ...emittedByResolver]));
  });
});
