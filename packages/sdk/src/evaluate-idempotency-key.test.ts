import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("evaluate idempotency keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("generates distinct keys without mutating a reused context, including cache hits", async () => {
    const transport = new FakeTransport([ok("treatment", "run-1")]);
    const cached: string[] = [];
    transport.recordCachedEvaluation = async (request) => {
      cached.push(request.idempotencyKey);
    };
    const bag = deps(transport);
    const context = Object.freeze({ targetingKey: "u1" });
    await runEvaluate(bag, "flag", context);
    await runEvaluate(bag, "flag", context);
    await runEvaluate(bag, "flag", context);
    const keys = [transport.calls[0]?.idempotencyKey, ...cached];
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(context).toEqual({ targetingKey: "u1" });
  });

  it("fails loud without secure UUID support but still accepts caller keys", async () => {
    vi.stubGlobal("crypto", undefined);
    const transport = new FakeTransport([ok("treatment", "run-1")]);
    const bag = deps(transport);
    await expect(runEvaluate(bag, "flag", { targetingKey: "u1" })).rejects.toMatchObject({
      code: "SDK_IDEMPOTENCY_KEY_UNAVAILABLE",
    });
    expect(transport.calls).toHaveLength(0);
    expect((bag.logger as FakeLogger).errors).toHaveLength(1);
    await runEvaluate(bag, "flag", { targetingKey: "u1", idempotencyKey: "retry-1" });
    expect(transport.calls[0]?.idempotencyKey).toBe("retry-1");
  });

  it.each([
    ["null", null],
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
    await expect(
      runEvaluate(bag, "flag", untyped({ targetingKey: "u1", idempotencyKey: "" })),
    ).rejects.toThrow(/SDK_CONTEXT_INVALID/);
  });
});
