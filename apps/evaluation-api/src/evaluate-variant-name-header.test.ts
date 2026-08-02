import { describe, expect, it } from "vitest";
import { CLIENT_KEY, makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

/**
 * Variant `name` is user-authored and unconstrained (`z.string()`), but the arm
 * label rides a response header, and header values are ByteStrings. Two distinct
 * failures follow from sending the raw name:
 *
 * - a non-ASCII name arrives corrupted, and that corrupted value is what the SDK
 *   reports as `variantName` and what it keys the cached-replay seen-set on;
 * - a name containing CR/LF makes `headers.set` THROW, which the registrar turns
 *   into a 500 -- after the Exposure has already been committed. The customer is
 *   billed for an Exposure the caller never got a value for.
 *
 * One name exercises both: it is non-ASCII, astral-plane, and carries a header
 * injection attempt.
 */
const HOSTILE_VARIANT_NAME = "café 🚀\r\nx-injected: 1";

const HOSTILE_CATALOG = {
  variants: [
    { id: "v-control", name: HOSTILE_VARIANT_NAME, value: false },
    { id: "v-treatment", name: "treatment", value: true },
  ],
  availableVariantNames: [HOSTILE_VARIANT_NAME, "treatment"],
  targetingRules: [],
};

const HOSTILE_RUN = {
  allocation: { [HOSTILE_VARIANT_NAME]: 100, treatment: 0 },
  variantSet: [
    { id: "v-control", name: HOSTILE_VARIANT_NAME, value: false },
    { id: "v-treatment", name: "treatment", value: true },
  ],
  targetingRules: [],
};

describe("a Variant name that is not header-safe", () => {
  it("is delivered percent-encoded instead of throwing or corrupting the label", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      flagOverrides: HOSTILE_CATALOG,
      runOverrides: HOSTILE_RUN,
    });

    const res = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));

    // Without encoding this is a 500: `set` rejects the CR/LF outright.
    expect(res.status).toBe(200);
    const header = res.headers.get("x-variant-name");
    expect(header).toBe(encodeURIComponent(HOSTILE_VARIANT_NAME));
    // The round trip is what the SDK performs, and it must be lossless -- the
    // emoji and the accented character included.
    expect(decodeURIComponent(header ?? "")).toBe(HOSTILE_VARIANT_NAME);
    // Percent-encoding leaves nothing that could terminate a header line.
    expect(header).not.toMatch(/[\r\n]/u);
    expect(exposureSink.writes).toHaveLength(1);
  });

  it("leaves an ordinary ASCII name byte-identical on the wire", async () => {
    // Encoding must not churn the common case: `treatment` is what every
    // existing consumer and fixture expects to read back.
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      flagOverrides: HOSTILE_CATALOG,
      runOverrides: { ...HOSTILE_RUN, allocation: { [HOSTILE_VARIANT_NAME]: 0, treatment: 100 } },
    });

    const res = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-variant-name")).toBe("treatment");
  });
});
