import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHostedWorkOs } from "./workos";

describe("hosted WorkOS adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires an API key instead of constructing a fixture-capable adapter", () => {
    expect(() => makeHostedWorkOs({ apiKey: "" })).toThrow("WORKOS_API_KEY");
  });

  it("preflights verified email ownership through WorkOS user management", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: [{ id: "user_existing", email: "owner@example.com", email_verified: true }],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const workos = makeHostedWorkOs({
      apiKey: "sk_test",
      baseUrl: "https://workos.test",
    });

    await expect(workos.findVerifiedUserByEmail("owner@example.com")).resolves.toBe(
      "user_existing",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://workos.test/user_management/users?email=owner%40example.com",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer sk_test" },
      }),
    );
  });

  it("only changes a provisional user's email through the explicit verification send step", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    const workos = makeHostedWorkOs({ apiKey: "sk_test", baseUrl: "https://workos.test" });

    await workos.sendEmailVerification("user_provisional", "new@example.com");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://workos.test/user_management/users/user_provisional",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://workos.test/user_management/users/user_provisional/email_verification/send",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
