import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { loginRedirect } from "./login-redirect";

describe("loginRedirect", () => {
  it("sends the browser to the Worker's sign-in door as a full document navigation", () => {
    const result = loginRedirect("/acme-labs/checkout-api/dev/flags?tab=archived");

    expect(isRedirect(result)).toBe(true);
    expect(result.options.href).toBe(
      "/auth/login?returnTo=%2Facme-labs%2Fcheckout-api%2Fdev%2Fflags%3Ftab%3Darchived",
    );
    // The client route tree has no `/auth/login`; without this the client-side
    // branch of the redirect renders Not Found instead of reaching the handler.
    expect(result.options.reloadDocument).toBe(true);
    expect(result.headers.get("location")).toBe(result.options.href);
  });
});
