import { canonicalHash } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { createRequestHash } from "./create-idempotency";

describe("create request hashing", () => {
  it("returns the canonical hash for valid input", async () => {
    const input = { name: "Checkout", key: "checkout" };

    await expect(createRequestHash(input, "request_hash")).resolves.toEqual({
      ok: true,
      hash: await canonicalHash(input),
    });
  });

  it("maps canonical JSON input failures to VALIDATION_ERROR", async () => {
    const result = await createRequestHash({ name: "\ud800" }, "request_hash");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toMatchObject({
        code: "VALIDATION_ERROR",
        details: {
          issues: [{ path: ["body"], message: "canonical JSON rejects lone Unicode surrogates" }],
        },
      });
    }
  });

  it("rethrows unexpected canonical hash failures", async () => {
    const cause = new Error("unexpected object traversal failure");
    const input = new Proxy(
      {},
      {
        ownKeys() {
          throw cause;
        },
      },
    );

    await expect(createRequestHash(input, "request_hash")).rejects.toBe(cause);
  });
});
