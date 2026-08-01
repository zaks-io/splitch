import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthError, renderDoorFault } from "./oauth-errors";

/**
 * Door faults are the only place a bug on the door becomes an opaque
 * `server_error`. Production shipped a mint that threw on every request and the
 * cause never reached any log, so the collapse MUST stay observable.
 */
describe("renderDoorFault", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes an OAuthError through with its own code, status and description", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = renderDoorFault(new OAuthError("invalid_grant", "device grant expired"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_grant",
      error_description: "device grant expired",
    });
    expect(logged).not.toHaveBeenCalled();
  });

  it("logs the cause of an unknown fault before collapsing it to server_error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new Error("ACCESS_TOKEN_SECRET must be an RSA private JWK");

    const res = renderDoorFault(cause);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "server_error",
      error_description: "auth door fault",
    });
    expect(logged).toHaveBeenCalledWith("auth door fault", cause);
  });
});
