import { describe, expect, it } from "vitest";
import { SplitchSdkError } from "./errors";
import { type EvaluateDeps, runEvaluate } from "./evaluate";
import { SeenSet } from "./seen-set";
import { FakeLogger, FakeTransport, ok } from "./test-fixtures";

const NOW = 1_000_000;

function deps(transport: FakeTransport): EvaluateDeps {
  return {
    transport,
    seenSet: new SeenSet(10_000, 60_000),
    logger: new FakeLogger(),
    now: () => NOW,
  };
}

/** The type forbids these shapes, so only a JavaScript caller reaches the guard. */
function untyped(context: Record<string, unknown>): Parameters<typeof runEvaluate>[2] {
  return context as unknown as Parameters<typeof runEvaluate>[2];
}

/**
 * `sdk_evaluate` declares `idempotency: "required"` and the edge reads the
 * header only, so an absent key can only ever come back 400. The SDK refuses it
 * locally the way every other local guard here does: a `SplitchSdkError` naming
 * the missing field, not a Default Variant. `evaluate()` unwraps to the value
 * and discards `details`, so a degrade would leave that caller with a plausible
 * `false` and nothing naming the cause.
 */
describe("evaluate refuses a context with no idempotencyKey before the transport", () => {
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not a string", 7],
  ])("%s: throws SDK_CONTEXT_INVALID and never calls the transport", async (_label, key) => {
    const transport = new FakeTransport([ok("treatment", "run-1")]);
    const bag = deps(transport);

    const thrown = await runEvaluate(
      bag,
      "flag",
      untyped({ targetingKey: "u1", defaultValue: "fallback", idempotencyKey: key }),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(SplitchSdkError);
    const error = thrown as SplitchSdkError;
    expect(error.code).toBe("SDK_CONTEXT_INVALID");
    expect(error.message).toContain("idempotencyKey");
    expect(transport.calls).toHaveLength(0);
    expect((bag.logger as FakeLogger).errors).toHaveLength(1);
    // The log carries the same actionable text, so a caller who only reads logs
    // still learns which field is missing.
    expect((bag.logger as FakeLogger).errors[0]?.message).toContain("idempotencyKey");
  });

  it("does not depend on seen-set state: a cached entry is still refused", async () => {
    const transport = new FakeTransport([ok("treatment", "run-1")]);
    const bag = deps(transport);

    await runEvaluate(bag, "flag", { targetingKey: "u1", idempotencyKey: "eval-1" });
    expect(transport.calls).toHaveLength(1);

    // Without the pre-seen-set check this would replay as CACHED, so the same
    // malformed call would pass or fail depending on cache state.
    await expect(runEvaluate(bag, "flag", untyped({ targetingKey: "u1" }))).rejects.toThrow(
      /SDK_CONTEXT_INVALID/,
    );
  });
});
