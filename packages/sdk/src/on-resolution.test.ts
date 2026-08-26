import { describe, expect, it } from "vitest";
import { createSplitchClient } from "./client";
import type { SdkResolutionDetails } from "./resolution";
import { evaluateAllOk, FakeTransport, httpError, ok, transportFailure } from "./test-fixtures";

/**
 * `onResolution` is the seam the Sentry reporter (and any other APM mirror)
 * hangs off. What matters here is coverage and honesty: every resolution the
 * caller actually received is offered exactly once, and nothing else is.
 */

type Reported = { flagKey: string; details: SdkResolutionDetails };

function clientWith(transport: FakeTransport) {
  const reported: Reported[] = [];
  const client = createSplitchClient({
    clientKey: "pk_test",
    transport,
    onResolution: (flagKey, details) => reported.push({ flagKey, details }),
  });
  return { client, reported };
}

const CONTEXT = { targetingKey: "user-1", defaultValue: false };

describe("SplitchClientOptions.onResolution", () => {
  it("reports the resolution evaluate() returned", async () => {
    const { client, reported } = clientWith(new FakeTransport([ok(true, "run-1", "treatment")]));
    await client.evaluate("checkout-v2", CONTEXT);
    expect(reported).toEqual([
      { flagKey: "checkout-v2", details: expect.objectContaining({ value: true }) },
    ]);
  });

  it("reports the same details evaluateDetails() hands back", async () => {
    const { client, reported } = clientWith(new FakeTransport([ok("blue", "run-1", "treatment")]));
    const details = await client.evaluateDetails("theme", {
      targetingKey: "user-1",
      defaultValue: "red",
    });
    // Identity, not equality: a reporter that saw a different object than the
    // caller did would be reporting a story the app never lived.
    expect(reported[0]?.details).toBe(details);
  });

  it("reports failed evaluations too, marked as ERROR", async () => {
    const { client, reported } = clientWith(
      new FakeTransport([transportFailure("SDK_TRANSPORT_TIMEOUT")]),
    );
    await client.evaluate("checkout-v2", CONTEXT);
    // Swallowing these would hide a served default from every consumer; each
    // reporter decides what an ERROR means for its own sink.
    expect(reported[0]?.details).toMatchObject({
      reason: "ERROR",
      errorCode: "SDK_TRANSPORT_TIMEOUT",
    });
  });

  it("reports every resolved entry of a precomputed payload", async () => {
    const transport = new FakeTransport([], {
      evaluateAll: [
        evaluateAllOk({
          "new-checkout": {
            variant: true,
            variantName: "treatment",
            reason: "SPLIT",
            errorCode: null,
            exposureIdentity: "identity-1",
            exposureTicket: "ticket-1",
          },
          theme: {
            variant: "blue",
            variantName: "cool",
            reason: "DEFAULT",
            errorCode: null,
            exposureIdentity: null,
            exposureTicket: null,
          },
        }),
      ],
    });
    const { client, reported } = clientWith(transport);
    await client.evaluateAll({ targetingKey: "user-1" });
    expect(reported).toEqual([
      {
        flagKey: "new-checkout",
        details: { value: true, variantName: "treatment", reason: "SPLIT" },
      },
      { flagKey: "theme", details: { value: "blue", variantName: "cool", reason: "DEFAULT" } },
    ]);
  });

  it("skips a precomputed entry that resolved to no variant", async () => {
    const transport = new FakeTransport([], {
      evaluateAll: [
        evaluateAllOk({
          "new-checkout": {
            variant: null,
            variantName: null,
            reason: "ERROR",
            errorCode: "FLAG_NOT_FOUND",
            exposureIdentity: null,
            exposureTicket: null,
          },
        }),
      ],
    });
    const { client, reported } = clientWith(transport);
    await client.evaluateAll({ targetingKey: "user-1" });
    // The entry carries no value and the payload has no per-flag default, so
    // there is nothing to report that would not be invented.
    expect(reported).toEqual([]);
  });

  it("stays silent for peekVariant and verify", async () => {
    const transport = new FakeTransport([], {
      peek: [ok(true, "run-1", "treatment")],
      verify: [
        {
          status: 200,
          details: { value: true, variantName: "treatment", reason: "SPLIT" },
        },
      ],
    });
    const { client, reported } = clientWith(transport);
    await client.peekVariant("checkout-v2", CONTEXT);
    await client.verify("checkout-v2", CONTEXT);
    // Both are non-exposing diagnostics. Attaching their flags to an error would
    // claim the user path resolved something it never asked for.
    expect(reported).toEqual([]);
  });

  it("reports a rejected evaluation once, not once per return path", async () => {
    const { client, reported } = clientWith(new FakeTransport([httpError(404, "FLAG_NOT_FOUND")]));
    await client.evaluate("missing", CONTEXT);
    expect(reported).toHaveLength(1);
  });

  it("lets a throwing reporter throw out of the evaluation it observed", async () => {
    const client = createSplitchClient({
      clientKey: "pk_test",
      transport: new FakeTransport([ok(true, "run-1", "treatment")]),
      onResolution: () => {
        throw new Error("reporter is down");
      },
    });
    // Pinned deliberately, both directions. An observability sink that fails
    // must fail where it fails; swallowing it here would leave a host app
    // reporting flags to nowhere with nothing to say so. A future try/catch
    // around the reporter is a behavior change, not a cleanup.
    await expect(client.evaluate("checkout-v2", CONTEXT)).rejects.toThrow("reporter is down");
  });
});
