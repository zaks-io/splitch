import { describe, expect, it } from "vitest";
import { fetchTransport, stubFetch, TRANSPORT_REQUEST } from "./test-fixtures";

/**
 * The Variant name rides a header rather than the body, and header values are
 * ByteStrings while Variant names are user-authored Unicode. The edge therefore
 * percent-encodes it (apps/evaluation-api/src/evaluate.ts) and this adapter is
 * the only place that decodes.
 */
describe("createFetchTransport: the Variant name arrives percent-encoded in a header", () => {
  it("decodes an arm label the edge had to percent-encode to fit a header", async () => {
    // Reading the raw header instead would surface mojibake as the variantName.
    const name = "café 🚀";
    const transport = fetchTransport(
      stubFetch(
        new Response(JSON.stringify({ variant: "treatment" }), {
          status: 200,
          headers: { "x-run-id": "run-42", "x-variant-name": encodeURIComponent(name) },
        }),
      ),
    );

    expect((await transport.evaluate(TRANSPORT_REQUEST)).variantName).toBe(name);
  });

  it("fails loud on an undecodable arm label instead of reporting the raw bytes", async () => {
    const transport = fetchTransport(
      stubFetch(
        new Response(JSON.stringify({ variant: "treatment" }), {
          status: 200,
          headers: { "x-run-id": "run-42", "x-variant-name": "%E0%A4%A" },
        }),
      ),
    );

    const result = await transport.evaluate(TRANSPORT_REQUEST);

    // Same treatment as an unparseable body: status null, nothing guessed at.
    expect(result.status).toBeNull();
    expect(result.variantName).toBeNull();
  });
});
