import { describe, expect, it } from "vitest";
import { installRejected } from "./integration_remote";

describe("installRejected", () => {
  it("reports the response verbatim for a refusal that is not a scope refusal", () => {
    const body = JSON.stringify({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "conflict" });

    const error = installRejected(409, body);

    expect(error.message).toBe(`install Convex integration failed with HTTP 409: ${body}`);
  });

  it("reports a non-JSON body verbatim instead of guessing at a cause", () => {
    const error = installRejected(502, "<html>bad gateway</html>");

    expect(error.message).toBe(
      "install Convex integration failed with HTTP 502: <html>bad gateway</html>",
    );
  });
});
