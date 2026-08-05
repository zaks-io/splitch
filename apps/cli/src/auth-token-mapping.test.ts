import { describe, expect, it } from "vitest";
import { isTokenBindingRefusal } from "./auth-binding.js";
import { mintFailureError, sessionExpiredError, tokenBindingRefusedError } from "./auth-token.js";

describe("refresh-grant fault mapping", () => {
  it("maps a genuine session-death invalid_grant to CLI_SESSION_EXPIRED with re-login remediation", () => {
    const error = mintFailureError(
      {
        status: 400,
        error: "invalid_grant",
        description: "refresh token is invalid or expired",
      },
      true,
    );

    expect(error.code).toBe("CLI_SESSION_EXPIRED");
    expect(error.causeSummary).toContain("refresh token is invalid or expired");
    expect(error.remediation.toLowerCase()).toContain("login");
    expect(
      isTokenBindingRefusal(
        { status: 400, error: "invalid_grant", description: "refresh token is invalid or expired" },
        true,
      ),
    ).toBe(false);
  });

  it("maps an opaque invalid_grant without a reason to CLI_SESSION_EXPIRED", () => {
    const error = mintFailureError({ status: 400, error: "invalid_grant" }, true);

    expect(error.code).toBe("CLI_SESSION_EXPIRED");
    expect(error.remediation.toLowerCase()).toContain("login");
    expect(sessionExpiredError("HTTP 400: invalid_grant").code).toBe("CLI_SESSION_EXPIRED");
  });

  it("maps unbound refresh failure to CLI_SESSION_EXPIRED even when the body names membership", () => {
    // Without an explicit binding the CLI has not established a binding refusal.
    const error = mintFailureError(
      {
        status: 400,
        error: "invalid_grant",
        description: "selected App is not authorized by live membership",
      },
      false,
    );

    expect(error.code).toBe("CLI_SESSION_EXPIRED");
    expect(error.remediation.toLowerCase()).toContain("login");
  });

  it("maps an app-binding membership refusal to CLI_TOKEN_BINDING_REFUSED with the server reason", () => {
    const reason = "selected App is not authorized by live membership";
    const error = mintFailureError(
      { status: 400, error: "invalid_grant", description: reason },
      true,
    );

    expect(error.code).toBe("CLI_TOKEN_BINDING_REFUSED");
    expect(error.causeSummary).toBe(`${reason}.`);
    expect(error.remediation.toLowerCase()).not.toContain("login");
    expect(error.remediation.toLowerCase()).not.toContain("authenticate");
    expect(error.remediation).toMatch(/membership/i);
    expect(
      tokenBindingRefusedError({ status: 400, error: "invalid_grant", description: reason }).code,
    ).toBe("CLI_TOKEN_BINDING_REFUSED");
    expect(
      isTokenBindingRefusal({ status: 400, error: "invalid_grant", description: reason }, true),
    ).toBe(true);
  });

  it("maps an org-binding refusal to CLI_TOKEN_BINDING_REFUSED without re-login remediation", () => {
    const reason = "selected Organization is not reachable by live membership";
    const error = mintFailureError(
      { status: 400, error: "invalid_grant", description: reason },
      true,
    );

    expect(error.code).toBe("CLI_TOKEN_BINDING_REFUSED");
    expect(error.causeSummary).toContain(reason);
    expect(error.remediation.toLowerCase()).not.toMatch(/log ?in|authenticate/);
  });
});
