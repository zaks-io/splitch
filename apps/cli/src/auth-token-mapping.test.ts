import { describe, expect, it } from "vitest";
import { isTokenBindingRefusal } from "./auth-binding.js";
import { mintFailureError, sessionExpiredError, tokenBindingRefusedError } from "./auth-token.js";

describe("refresh-grant fault mapping", () => {
  it("maps a genuine session-death invalid_grant to CLI_SESSION_EXPIRED with re-login remediation", () => {
    const error = mintFailureError({
      status: 400,
      error: "invalid_grant",
      description: "refresh token is invalid or expired",
    });

    expect(error.code).toBe("CLI_SESSION_EXPIRED");
    expect(error.causeSummary).toContain("refresh token is invalid or expired");
    expect(error.remediation.toLowerCase()).toContain("login");
    expect(
      isTokenBindingRefusal({
        status: 400,
        error: "invalid_grant",
        description: "refresh token is invalid or expired",
      }),
    ).toBe(false);
  });

  it("maps an opaque invalid_grant without a reason to CLI_SESSION_EXPIRED", () => {
    const error = mintFailureError({ status: 400, error: "invalid_grant" });

    expect(error.code).toBe("CLI_SESSION_EXPIRED");
    expect(error.remediation.toLowerCase()).toContain("login");
    expect(sessionExpiredError("HTTP 400: invalid_grant").code).toBe("CLI_SESSION_EXPIRED");
  });

  it("maps unrecognized invalid_grant text to CLI_SESSION_EXPIRED rather than inventing a binding refusal", () => {
    const error = mintFailureError({
      status: 400,
      error: "invalid_grant",
      description: "device flow failed",
    });

    expect(error.code).toBe("CLI_SESSION_EXPIRED");
    expect(error.remediation.toLowerCase()).toContain("login");
    expect(
      isTokenBindingRefusal({
        status: 400,
        error: "invalid_grant",
        description: "device flow failed",
      }),
    ).toBe(false);
  });

  it("maps a membership refusal to CLI_TOKEN_BINDING_REFUSED even without an explicit rebind param", () => {
    // Unbound refresh still reintersects the session's selected App server-side.
    const reason = "selected App is not authorized by live membership";
    const error = mintFailureError({
      status: 400,
      error: "invalid_grant",
      description: reason,
    });

    expect(error.code).toBe("CLI_TOKEN_BINDING_REFUSED");
    expect(error.causeSummary).toBe(`${reason}.`);
    expect(error.remediation.toLowerCase()).not.toMatch(/log ?in|authenticate/);
  });

  it("maps an app-binding membership refusal to CLI_TOKEN_BINDING_REFUSED with the server reason", () => {
    const reason = "selected App is not authorized by live membership";
    const error = mintFailureError({
      status: 400,
      error: "invalid_grant",
      description: reason,
    });

    expect(error.code).toBe("CLI_TOKEN_BINDING_REFUSED");
    expect(error.causeSummary).toBe(`${reason}.`);
    expect(error.remediation.toLowerCase()).not.toContain("login");
    expect(error.remediation.toLowerCase()).not.toContain("authenticate");
    expect(error.remediation).toMatch(/splitch use/i);
    expect(
      tokenBindingRefusedError({ status: 400, error: "invalid_grant", description: reason }).code,
    ).toBe("CLI_TOKEN_BINDING_REFUSED");
    expect(
      isTokenBindingRefusal({ status: 400, error: "invalid_grant", description: reason }),
    ).toBe(true);
  });

  it("maps an unreachable App refusal to CLI_TOKEN_BINDING_REFUSED naming splitch use", () => {
    const reason = "selected App is not reachable by live membership";
    const error = mintFailureError({
      status: 400,
      error: "invalid_grant",
      description: reason,
    });

    expect(error.code).toBe("CLI_TOKEN_BINDING_REFUSED");
    expect(error.remediation).toMatch(/splitch use --app/i);
    expect(error.remediation.toLowerCase()).not.toMatch(/log ?in/);
  });

  it("maps an org-binding refusal to CLI_TOKEN_BINDING_REFUSED without re-login remediation", () => {
    const reason = "selected Organization is not reachable by live membership";
    const error = mintFailureError({
      status: 400,
      error: "invalid_grant",
      description: reason,
    });

    expect(error.code).toBe("CLI_TOKEN_BINDING_REFUSED");
    expect(error.causeSummary).toContain(reason);
    expect(error.remediation.toLowerCase()).not.toMatch(/log ?in|authenticate/);
  });

  it("maps an ambiguous App-key selector to CLI_TOKEN_BINDING_REFUSED with a canonical-ID remediation", () => {
    const reason =
      'App selector "checkout" matches more than one App across your Organizations; pass the canonical App ID';
    const error = mintFailureError({
      status: 400,
      error: "invalid_grant",
      description: reason,
    });

    expect(error.code).toBe("CLI_TOKEN_BINDING_REFUSED");
    expect(error.causeSummary).toContain(reason);
    expect(
      isTokenBindingRefusal({ status: 400, error: "invalid_grant", description: reason }),
    ).toBe(true);
    expect(error.remediation.toLowerCase()).toContain("canonical app id");
    expect(error.remediation.toLowerCase()).not.toMatch(/log ?in|authenticate|membership/);
  });
});
