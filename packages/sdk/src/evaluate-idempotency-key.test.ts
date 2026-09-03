import { describe, expect, it } from "vitest";
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
 * header only, so an absent key can only ever come back 400. Rejecting locally
 * keeps evaluate's fail-loud contract: the host app still renders the Default
 * Variant, but the reason names the caller's mistake instead of a round trip.
 */
describe("evaluate refuses a context with no idempotencyKey before the transport", () => {
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not a string", 7],
  ])("%s: no call, Default Variant, SDK_CONTEXT_INVALID", async (_label, key) => {
    const transport = new FakeTransport([ok("treatment", "run-1")]);
    const bag = deps(transport);

    const details = await runEvaluate(
      bag,
      "flag",
      untyped({ targetingKey: "u1", defaultValue: "fallback", idempotencyKey: key }),
    );

    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("SDK_CONTEXT_INVALID");
    expect(details.value).toBe("fallback");
    expect(transport.calls).toHaveLength(0);
    expect((bag.logger as FakeLogger).errors).toHaveLength(1);
  });

  it("does not depend on seen-set state: a cached entry is still refused", async () => {
    const transport = new FakeTransport([ok("treatment", "run-1")]);
    const bag = deps(transport);

    await runEvaluate(bag, "flag", { targetingKey: "u1", idempotencyKey: "eval-1" });
    expect(transport.calls).toHaveLength(1);

    const replay = await runEvaluate(bag, "flag", untyped({ targetingKey: "u1" }));

    // Without the pre-seen-set check this would replay as CACHED, so the same
    // malformed call would pass or fail depending on cache state.
    expect(replay.reason).toBe("ERROR");
    expect(replay.errorCode).toBe("SDK_CONTEXT_INVALID");
  });
});
