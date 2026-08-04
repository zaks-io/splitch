import { describe, expect, it } from "vitest";
import { type EvaluateDeps, runEvaluate } from "./evaluate";
import { SeenSet } from "./seen-set";
import { FakeLogger, FakeTransport, httpError, ok, verifyOk } from "./test-fixtures";

const T0 = 1_000_000;
const TTL = 60_000;
const EVALUATION_ID = "test-evaluation";

/** A mutable injected clock so tests can advance time past the seen-set TTL. */
function clock(start = T0) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function deps(transport: FakeTransport, now: () => number, ttlMs = TTL): EvaluateDeps {
  return { transport, seenSet: new SeenSet(10_000, ttlMs), logger: new FakeLogger(), now };
}

describe("seen-set short-circuit: repeat within a Run is CACHED, no call, no second Exposure", () => {
  it("a second evaluate (same flag/targetingKey, within TTL) is CACHED with no transport call", async () => {
    const transport = new FakeTransport([ok("treatment", "run-1")]);
    const c = clock();
    const bag = deps(transport, c.now);

    const first = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(first.reason).toBe("SPLIT");
    expect(transport.calls).toHaveLength(1); // first call fires the Exposure

    c.advance(1); // still well within the TTL
    const second = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(second.reason).toBe("CACHED");
    expect(second.value).toBe("treatment");
    // No transport call -> no second Exposure. Queue was length 1; a second call
    // would have thrown "queue exhausted".
    expect(transport.calls).toHaveLength(1);
    const logger = bag.logger as FakeLogger;
    expect(logger.debugs).toHaveLength(1);
    expect(logger.debugs[0]?.message).toContain("seen-set hit");
  });

  it("a CACHED replay names the same arm the live resolution did", async () => {
    // The name is not derivable client-side (two arms may share a value), so an
    // unstored name would make evaluateDetails report null on every repeat call.
    const transport = new FakeTransport([ok(true, "run-1", "treatment")]);
    const c = clock();
    const bag = deps(transport, c.now);

    const first = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(first).toMatchObject({ reason: "SPLIT", variantName: "treatment" });

    c.advance(1);
    const second = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(second).toMatchObject({ reason: "CACHED", variantName: "treatment" });
  });

  it("reports a cache hit without billing, exposure, or Targeting Key telemetry", async () => {
    const transport = new FakeTransport([ok("treatment", "run-1")]);
    const cached = [] as { flagKey: string; idempotencyKey: string }[];
    transport.recordCachedEvaluation = async (event) => {
      cached.push(event);
    };
    const c = clock();
    const bag = deps(transport, c.now);

    await runEvaluate(bag, "flag", { targetingKey: "private-user", idempotencyKey: EVALUATION_ID });
    c.advance(1);
    await runEvaluate(bag, "flag", { targetingKey: "private-user", idempotencyKey: EVALUATION_ID });
    await Promise.resolve();

    expect(cached).toEqual([{ flagKey: "flag", idempotencyKey: EVALUATION_ID }]);
    expect(JSON.stringify(cached)).not.toContain("private-user");
  });
});

describe("Run boundary (SAME instance): past the TTL the SDK re-contacts the server and fires a fresh Exposure", () => {
  it("caches run-1, advances past the TTL, then evaluates again -> fresh call returns run-2, NOT CACHED", async () => {
    // Two scripted results in ONE long-lived instance: run-1, then run-2 after the
    // assignment edit opens a new Run. A fresh Exposure MUST fire under run-2.
    const transport = new FakeTransport([ok("a", "run-1"), ok("b", "run-2")]);
    const c = clock();
    const bag = deps(transport, c.now);

    const r1 = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(r1.reason).toBe("SPLIT");
    expect(r1.value).toBe("a");
    expect(transport.calls).toHaveLength(1);

    // BEFORE FIX this short-circuited to CACHED("a") forever (no second call).
    // AFTER FIX: past the revalidation window the entry is stale -> a fresh call.
    c.advance(TTL); // step to exactly the TTL boundary -> entry is stale
    const r2 = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(r2.reason).toBe("SPLIT"); // a fresh resolution, NOT CACHED
    expect(r2.value).toBe("b");
    expect(transport.calls).toHaveLength(2); // fresh Exposure fired under run-2
  });

  it("the new Run is re-cached, so an immediate repeat is CACHED under run-2 (dedup preserved)", async () => {
    const transport = new FakeTransport([ok("a", "run-1"), ok("b", "run-2")]);
    const c = clock();
    const bag = deps(transport, c.now);

    await runEvaluate(bag, "flag", { targetingKey: "u1", idempotencyKey: EVALUATION_ID });
    c.advance(TTL);
    await runEvaluate(bag, "flag", { targetingKey: "u1", idempotencyKey: EVALUATION_ID }); // re-cache under run-2

    c.advance(1);
    const repeat = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(repeat.reason).toBe("CACHED");
    expect(repeat.value).toBe("b");
    expect(transport.calls).toHaveLength(2); // no third call within the window
  });
});

describe("Entity identity: the seen-set keys on (idType, targetingKey), not the bare key", () => {
  it("a different idType with the same targetingKey is a MISS (its own resolution + Exposure)", async () => {
    // "user 42" and "workspace 42" are different Entities and may bucket to
    // different Variants — one must never replay the other's cached value.
    const transport = new FakeTransport([ok("a", "run-1"), ok("b", "run-1")]);
    const c = clock();
    const bag = deps(transport, c.now);

    const user = await runEvaluate(bag, "flag", {
      targetingKey: "42",
      idType: "user",
      idempotencyKey: EVALUATION_ID,
    });
    expect(user.value).toBe("a");

    c.advance(1);
    const workspace = await runEvaluate(bag, "flag", {
      targetingKey: "42",
      idType: "workspace",
      idempotencyKey: EVALUATION_ID,
    });
    expect(workspace.reason).toBe("SPLIT"); // NOT CACHED — a distinct Entity
    expect(workspace.value).toBe("b");
    expect(transport.calls).toHaveLength(2);
  });
});

describe("a cached 200 no-match replays with the CURRENT call's Default Variant", () => {
  it("does not leak one call site's defaultValue into another's CACHED replay", async () => {
    // 200 with variant:null (reason DEFAULT) + a runId -> the no-match is cached.
    const transport = new FakeTransport([ok(null, "run-1")]);
    const c = clock();
    const bag = deps(transport, c.now);

    const first = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      defaultValue: "v1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(first.reason).toBe("DEFAULT");
    expect(first.value).toBe("v1");

    c.advance(1);
    const second = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      defaultValue: "v2",
      idempotencyKey: EVALUATION_ID,
    });
    expect(second.reason).toBe("CACHED");
    expect(second.value).toBe("v2"); // THIS call's default, not the first caller's
    expect(transport.calls).toHaveLength(1); // dedup preserved
  });
});

describe("never cache an ERROR result", () => {
  it("an ERROR does not populate the seen-set; the next evaluate retries the wire (fresh resolution)", async () => {
    const transport = new FakeTransport([httpError(503), ok("treatment", "run-1")]);
    const c = clock();
    const bag = deps(transport, c.now);

    const failed = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(failed.reason).toBe("ERROR");
    expect(bag.seenSet.size).toBe(0); // nothing cached

    // The next evaluate is NOT served from cache (the error was never cached): a
    // NEW logical evaluate, not a retry of the failed one.
    const recovered = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      idempotencyKey: EVALUATION_ID,
    });
    expect(recovered.reason).toBe("SPLIT");
    expect(transport.calls).toHaveLength(2);
  });
});

describe("attributes participate in value replay (SPL-308)", () => {
  it("same targetingKey, different attributes, within TTL → transport re-resolves; not CACHED from the earlier context", async () => {
    const transport = new FakeTransport([ok("free-arm", "run-1", "free")], {
      verify: [
        verifyOk({
          value: "enterprise-arm",
          variantName: "enterprise",
          reason: "SPLIT",
        }),
      ],
    });
    const c = clock();
    const bag = deps(transport, c.now);

    const first = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "free" },
      idempotencyKey: EVALUATION_ID,
    });
    expect(first).toMatchObject({ reason: "SPLIT", value: "free-arm" });
    expect(transport.evaluateCalls).toHaveLength(1);

    c.advance(1);
    const second = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "enterprise" },
      idempotencyKey: "eval-enterprise",
    });
    // Must not replay the free-plan Variant. Transport is consulted again
    // (verify) so Targeting sees the new attributes.
    expect(second.reason).not.toBe("CACHED");
    expect(second.value).toBe("enterprise-arm");
    expect(second.variantName).toBe("enterprise");
    expect(transport.verifyCalls).toHaveLength(1);
    expect(transport.verifyCalls[0]?.attributes).toEqual({ plan: "enterprise" });
  });

  it("same targetingKey, identical attributes, within TTL → cache hit, no transport, no second Exposure", async () => {
    const transport = new FakeTransport([ok("free-arm", "run-1", "free")]);
    const c = clock();
    const bag = deps(transport, c.now);

    await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "free", tier: 1 },
      idempotencyKey: EVALUATION_ID,
    });
    c.advance(1);
    const second = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "free", tier: 1 },
      idempotencyKey: EVALUATION_ID,
    });
    expect(second).toMatchObject({ reason: "CACHED", value: "free-arm", variantName: "free" });
    expect(transport.evaluateCalls).toHaveLength(1);
    expect(transport.verifyCalls).toHaveLength(0);
  });

  it("attribute maps that differ only in property order are treated as identical", async () => {
    const transport = new FakeTransport([ok("v", "run-1", "arm")]);
    const c = clock();
    const bag = deps(transport, c.now);

    await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { z: true, a: "one", m: 2 },
      idempotencyKey: EVALUATION_ID,
    });
    c.advance(1);
    const second = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { a: "one", m: 2, z: true },
      idempotencyKey: EVALUATION_ID,
    });
    expect(second.reason).toBe("CACHED");
    expect(second.value).toBe("v");
    expect(transport.evaluateCalls).toHaveLength(1);
    expect(transport.verifyCalls).toHaveLength(0);
  });
});

describe("Exposure suppression stays attribute-independent (SPL-308)", () => {
  it("a context change does not produce a duplicate Exposure for the same (flag, run, targetingKey)", async () => {
    // Mutation proof (with the first test): if attributes were folded into the
    // Exposure key, this second call would be a full miss and fire evaluate
    // again. If attributes were omitted from value replay, the first test
    // would accept a stale CACHED Variant. Both must hold together.
    const transport = new FakeTransport([ok("free-arm", "run-1", "free")], {
      verify: [
        verifyOk({
          value: "enterprise-arm",
          variantName: "enterprise",
          reason: "SPLIT",
        }),
      ],
    });
    const c = clock();
    const bag = deps(transport, c.now);

    await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "free" },
      idempotencyKey: EVALUATION_ID,
    });
    c.advance(1);
    const second = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "enterprise" },
      idempotencyKey: "eval-enterprise",
    });

    expect(second.value).toBe("enterprise-arm");
    // Exactly one Exposure-bearing evaluate for this (flag, run, targetingKey).
    expect(transport.evaluateCalls).toHaveLength(1);
    expect(bag.seenSet.size).toBe(1);

    // Both contexts remain cached under the single Exposure slot.
    c.advance(1);
    const replayFree = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "free" },
      idempotencyKey: "replay-free",
    });
    const replayEnt = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "enterprise" },
      idempotencyKey: "replay-ent",
    });
    expect(replayFree).toMatchObject({ reason: "CACHED", value: "free-arm" });
    expect(replayEnt).toMatchObject({ reason: "CACHED", value: "enterprise-arm" });
    expect(transport.evaluateCalls).toHaveLength(1);
    expect(transport.verifyCalls).toHaveLength(1);
  });

  it("DISABLED context-miss preserves the served value across a later CACHED replay", async () => {
    // Server returns DISABLED with value "control"; the caller supplies a
    // different defaultValue. Both the live resolve and the within-TTL replay
    // must return "control" — never substitute the caller's default.
    const transport = new FakeTransport([ok("free-arm", "run-1", "free")], {
      verify: [
        verifyOk({
          value: "control",
          variantName: null,
          reason: "DISABLED",
        }),
      ],
    });
    const c = clock();
    const bag = deps(transport, c.now);

    await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "free" },
      idempotencyKey: EVALUATION_ID,
    });
    c.advance(1);
    const disabled = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "enterprise" },
      defaultValue: false,
      idempotencyKey: "eval-disabled",
    });
    expect(disabled).toMatchObject({ reason: "DISABLED", value: "control" });

    c.advance(1);
    const replay = await runEvaluate(bag, "flag", {
      targetingKey: "u1",
      attributes: { plan: "enterprise" },
      defaultValue: false,
      idempotencyKey: "replay-disabled",
    });
    expect(replay.reason).toBe("CACHED");
    expect(replay.value).toBe("control");
    expect(transport.evaluateCalls).toHaveLength(1);
    expect(transport.verifyCalls).toHaveLength(1);
  });
});
