import { describe, expect, it } from "vitest";
import { installRejected } from "./integration_remote";

const insufficientScopes = (held: readonly string[]) =>
  JSON.stringify({
    code: "INSUFFICIENT_SCOPES",
    message: "credential lacks required scopes",
    details: { requiredScopes: ["data-plane:evaluate", "data-plane:write"], heldScopes: held },
  });

describe("installRejected", () => {
  it("names the missing write scope when the mounted Key cannot deliver Metric Events", () => {
    const error = installRejected(403, insufficientScopes(["data-plane:evaluate"]));

    expect(error.message).toContain("data-plane:write");
    expect(error.message).toContain("SPLITCH_API_KEY");
    expect(error.message).toContain("rerun install");
  });

  it("reports the response verbatim when the Key already holds the write scope", () => {
    const body = insufficientScopes(["data-plane:evaluate", "data-plane:write"]);

    const error = installRejected(403, body);

    expect(error.message).toBe(`install Convex integration failed with HTTP 403: ${body}`);
  });

  it("reports the response verbatim for a refusal that is not a scope refusal", () => {
    const body = JSON.stringify({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "conflict" });

    const error = installRejected(409, body);

    expect(error.message).toBe(`install Convex integration failed with HTTP 409: ${body}`);
  });

  it("reports a scope refusal that never listed the held scopes verbatim", () => {
    const body = JSON.stringify({
      code: "INSUFFICIENT_SCOPES",
      message: "credential lacks scopes",
    });

    const error = installRejected(403, body);

    expect(error.message).toBe(`install Convex integration failed with HTTP 403: ${body}`);
  });

  it("reports a non-JSON body verbatim instead of guessing at a cause", () => {
    const error = installRejected(502, "<html>bad gateway</html>");

    expect(error.message).toBe(
      "install Convex integration failed with HTTP 502: <html>bad gateway</html>",
    );
  });
});
