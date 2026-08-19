import { afterEach, describe, expect, it, vi } from "vitest";
import { createSplitchClient } from "./client";
import type { PrecomputedEvaluations } from "./evaluate-all";
import { type EvaluateAllEntry, EvaluateAllResponseSchema } from "./generated/contract-surface.js";
import {
  evaluateAllHttpError,
  evaluateAllOk,
  FakeLogger,
  FakeTransport,
  ok,
} from "./test-fixtures";

const EVALUATIONS: Record<string, EvaluateAllEntry> = {
  "new-checkout": {
    variant: true,
    variantName: "treatment",
    reason: "SPLIT",
    errorCode: null,
    exposureIdentity: "identity-1",
    exposureTicket: "ticket-1",
  },
  "legacy-banner": {
    variant: null,
    variantName: null,
    reason: "DISABLED",
    errorCode: null,
    exposureIdentity: null,
    exposureTicket: null,
  },
  "broken-flag": {
    variant: null,
    variantName: null,
    reason: "ERROR",
    errorCode: "SERVICE_UNAVAILABLE",
    exposureIdentity: null,
    exposureTicket: null,
  },
};

function clientWith(fake: FakeTransport, logger = new FakeLogger()) {
  return { logger, client: createSplitchClient({ apiKey: "ak_test", transport: fake, logger }) };
}

describe("evaluateAll: Precomputed Evaluations payload", () => {
  it("returns every Flag from one request, tagged with its ETag and its context", async () => {
    const fake = new FakeTransport([], { evaluateAll: [evaluateAllOk(EVALUATIONS, '"tag-1"')] });
    const { client } = clientWith(fake);

    const precomputed = await client.evaluateAll({
      targetingKey: "u1",
      idType: "workspace",
      attributes: { plan: "pro" },
      idempotencyKey: "batch-1",
    });

    expect(fake.evaluateAllCalls).toEqual([
      {
        targetingKey: "u1",
        idType: "workspace",
        attributes: { plan: "pro" },
        idempotencyKey: "batch-1",
      },
    ]);
    expect(precomputed.etag).toBe('"tag-1"');
    expect(precomputed.context).toEqual({
      targetingKey: "u1",
      idType: "workspace",
      attributes: { plan: "pro" },
    });
    expect(Object.keys(precomputed.evaluations)).toEqual([
      "new-checkout",
      "legacy-banner",
      "broken-flag",
    ]);
  });

  it("returns an object the shared payload schema accepts, so it is valid bootstrap input", async () => {
    const fake = new FakeTransport([], { evaluateAll: [evaluateAllOk(EVALUATIONS)] });
    const { client } = clientWith(fake);

    const precomputed = await client.evaluateAll({ targetingKey: "u1" });

    // The shared contract schema, not a copy: the browser client's bootstrap
    // accepts exactly what this parses.
    const parsed = EvaluateAllResponseSchema.parse({ evaluations: precomputed.evaluations });
    expect(parsed.evaluations).toEqual(EVALUATIONS);
    // Round-trips through page serialization unchanged.
    const rehydrated = JSON.parse(JSON.stringify(precomputed)) as PrecomputedEvaluations;
    expect(rehydrated).toEqual(precomputed);
  });

  it("defaults idType to 'user' and attributes to {} and reports the resolved context", async () => {
    const fake = new FakeTransport([], { evaluateAll: [evaluateAllOk(EVALUATIONS)] });
    const { client } = clientWith(fake);

    const precomputed = await client.evaluateAll({ targetingKey: "u1" });

    expect(fake.evaluateAllCalls[0]).toMatchObject({ idType: "user", attributes: {} });
    expect(precomputed.context.idType).toBe("user");
    expect(precomputed.context.attributes).toEqual({});
  });

  it("copies attributes so a later caller mutation cannot rewrite the resolved context", async () => {
    const fake = new FakeTransport([], { evaluateAll: [evaluateAllOk(EVALUATIONS)] });
    const { client } = clientWith(fake);
    const attributes: Record<string, string> = { plan: "pro" };

    const precomputed = await client.evaluateAll({ targetingKey: "u1", attributes });
    attributes.plan = "free";

    // The browser client deep-equality-checks this context against its own, so
    // an aliased object would silently invalidate a payload after the fact.
    expect(precomputed.context.attributes).toEqual({ plan: "pro" });
  });

  it("copies array attributes too, so mutating one through its reference cannot reach the payload", async () => {
    const fake = new FakeTransport([], { evaluateAll: [evaluateAllOk(EVALUATIONS)] });
    const { client } = clientWith(fake);
    // `AttributeValue` admits arrays, so a one-level spread leaves this shared.
    const cohorts = ["beta"];

    const precomputed = await client.evaluateAll({ targetingKey: "u1", attributes: { cohorts } });
    cohorts.push("internal");

    expect(precomputed.context.attributes.cohorts).toEqual(["beta"]);
  });

  it("mints a fresh Idempotency-Key per fetch when the caller supplies none", async () => {
    const fake = new FakeTransport([], {
      evaluateAll: [evaluateAllOk(EVALUATIONS), evaluateAllOk(EVALUATIONS)],
    });
    const { client } = clientWith(fake);

    await client.evaluateAll({ targetingKey: "u1" });
    await client.evaluateAll({ targetingKey: "u1" });

    const [first, second] = fake.evaluateAllCalls;
    expect(first?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  it("treats an empty-string Idempotency-Key as absent rather than sending it", async () => {
    const fake = new FakeTransport([], { evaluateAll: [evaluateAllOk(EVALUATIONS)] });
    const { client } = clientWith(fake);

    await client.evaluateAll({ targetingKey: "u1", idempotencyKey: "" });

    expect(fake.evaluateAllCalls[0]?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("fires no Exposure: no evaluate call, and no seen-set entry for a later evaluate", async () => {
    const fake = new FakeTransport([ok("exposed", "run-1")], {
      evaluateAll: [evaluateAllOk(EVALUATIONS)],
    });
    const { client, logger } = clientWith(fake);

    await client.evaluateAll({ targetingKey: "u1" });

    expect(fake.evaluateCalls).toHaveLength(0);
    expect(fake.peekCalls).toHaveLength(0);
    expect(fake.verifyCalls).toHaveLength(0);

    // A payload read never seeds the seen-set, so the next evaluate still goes
    // to the wire and fires its own Exposure rather than replaying as CACHED.
    const details = await client.evaluateDetails("new-checkout", {
      targetingKey: "u1",
      idempotencyKey: "evaluation-1",
    });
    expect(details.reason).toBe("SPLIT");
    expect(fake.evaluateCalls).toHaveLength(1);
    expect(logger.debugs).toHaveLength(0);
  });
});

describe("evaluateAll: runtimes without crypto.randomUUID", () => {
  // `crypto.randomUUID` is secure-context-only, so a Client Key caller on a
  // plain http:// page has `crypto` but not `randomUUID`. A Node suite cannot
  // reach that state on its own, which is exactly how SPL-321's unbound `fetch`
  // shipped, so the browser runtime is simulated here.
  /** `crypto` present, `randomUUID` absent: what an insecure context exposes. */
  function stubInsecureContextCrypto(): void {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws a typed error instead of a bare TypeError, and never calls the transport", async () => {
    stubInsecureContextCrypto();
    const fake = new FakeTransport([], { evaluateAll: [evaluateAllOk(EVALUATIONS)] });
    const { client, logger } = clientWith(fake);

    await expect(client.evaluateAll({ targetingKey: "u1" })).rejects.toMatchObject({
      name: "SplitchSdkError",
      code: "SDK_IDEMPOTENCY_KEY_UNAVAILABLE",
      status: null,
      docsUrl: "https://splitch.dev/docs/error/SDK_IDEMPOTENCY_KEY_UNAVAILABLE",
    });
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("idempotencyKey");
    expect(fake.evaluateAllCalls).toHaveLength(0);
  });

  it("succeeds anyway when the caller supplies their own idempotencyKey", async () => {
    stubInsecureContextCrypto();
    const fake = new FakeTransport([], { evaluateAll: [evaluateAllOk(EVALUATIONS)] });
    const { client } = clientWith(fake);

    const precomputed = await client.evaluateAll({ targetingKey: "u1", idempotencyKey: "mine-1" });

    expect(precomputed.evaluations).toEqual(EVALUATIONS);
    expect(fake.evaluateAllCalls[0]?.idempotencyKey).toBe("mine-1");
  });
});

describe("evaluateAll: fail-loud failure paths", () => {
  it("throws a typed SplitchSdkError on an HTTP failure and logs it loudly", async () => {
    const fake = new FakeTransport([], {
      evaluateAll: [evaluateAllHttpError(401, "UNAUTHORIZED", "credential is invalid")],
    });
    const { client, logger } = clientWith(fake);

    await expect(client.evaluateAll({ targetingKey: "u1" })).rejects.toMatchObject({
      name: "SplitchSdkError",
      code: "UNAUTHORIZED",
      status: 401,
      docsUrl: "https://splitch.dev/docs/error/UNAUTHORIZED",
    });
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("UNAUTHORIZED");
    expect(logger.errors[0]?.detail).toMatchObject({ targetingKey: "u1", status: 401 });
  });

  it("never returns a payload for a failure: no partial and no empty stand-in", async () => {
    const fake = new FakeTransport([], { evaluateAll: [evaluateAllHttpError(503)] });
    const { client } = clientWith(fake);

    const outcome = await client.evaluateAll({ targetingKey: "u1" }).then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ error }),
    );
    expect(outcome).not.toHaveProperty("resolved");
  });
});
