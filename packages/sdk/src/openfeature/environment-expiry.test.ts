import { describe, expect, it, vi } from "vitest";
import { SplitchOfrepProvider } from "./provider";

const expiryBody = { code: "ENVIRONMENT_EXPIRED", message: "Temporary Environment has expired" };

describe("OpenFeature expiry compatibility", () => {
  it.each([
    expiryBody,
    { errorCode: "ENVIRONMENT_EXPIRED", errorDetails: "Temporary Environment has expired" },
  ])("uses GENERAL and a literal expiry message for %j without retrying", async (body) => {
    const fetch = vi.fn(async () => Response.json(body, { status: 410 }));
    const logger = { error: vi.fn() };
    const provider = new SplitchOfrepProvider({
      baseUrl: "https://edge.test",
      credential: "pk_test",
      fetch,
      logger,
    });
    for (let i = 0; i < 2; i += 1) {
      expect(
        await provider.resolveBooleanEvaluation("checkout", false, { targetingKey: "entity-1" }),
      ).toMatchObject({
        value: false,
        reason: "ERROR",
        errorCode: "GENERAL",
        errorMessage: expect.stringContaining("ENVIRONMENT_EXPIRED"),
      });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("shares the expiry log across tracking and resolution", async () => {
    const fetch = vi.fn(async () => Response.json(expiryBody, { status: 410 }));
    const logger = { error: vi.fn() };
    const provider = new SplitchOfrepProvider({
      baseUrl: "https://edge.test",
      credential: "pk_test",
      fetch,
      logger,
    });
    provider.track("signed_up", { targetingKey: "entity-1" });
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1));
    expect(logger.error.mock.calls[0]?.[0]).toContain("ENVIRONMENT_EXPIRED");
    await provider.resolveBooleanEvaluation("checkout", false, { targetingKey: "entity-1" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
