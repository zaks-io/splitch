import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OAuthError } from "./oauth-errors";
import { makeDurableRateLimiter, type RateLimitDurableObjectNamespace } from "./rate-limit";

const T0 = Date.now();
const LATER_WINDOW = T0 + 2 * 60 * 60 * 1000;

function namespace(): RateLimitDurableObjectNamespace {
  return (env as unknown as { AUTH_ABUSE_RATE_LIMIT: DurableObjectNamespace })
    .AUTH_ABUSE_RATE_LIMIT;
}

describe("AuthAbuseRateLimitDurableObject", () => {
  it("serializes concurrent requests at the global ceiling", async () => {
    const limiter = makeDurableRateLimiter(namespace(), "anonymous-create", {
      perIpPerHour: 100,
      globalPerHour: 5,
    });
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        limiter.assertUnderCeiling(`203.0.113.${index}`, T0),
      ),
    );

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(5);
    expect(rejected.every((result) => result.reason instanceof OAuthError)).toBe(true);
  });

  it("persists the per-IP counter across independently constructed adapters", async () => {
    const config = { perIpPerHour: 1, globalPerHour: 100 };
    await makeDurableRateLimiter(namespace(), "device-authorization", config).assertUnderCeiling(
      "198.51.100.8",
      T0,
    );
    await expect(
      makeDurableRateLimiter(namespace(), "device-authorization", config).assertUnderCeiling(
        "198.51.100.8",
        T0,
      ),
    ).rejects.toMatchObject({ code: "too_many_requests", status: 429 });
  });

  it("keeps anonymous and device authorization budgets independent", async () => {
    const config = { perIpPerHour: 1, globalPerHour: 1 };
    await makeDurableRateLimiter(namespace(), "anonymous-create", config).assertUnderCeiling(
      "192.0.2.4",
      LATER_WINDOW,
    );
    await expect(
      makeDurableRateLimiter(namespace(), "device-authorization", config).assertUnderCeiling(
        "192.0.2.4",
        LATER_WINDOW,
      ),
    ).resolves.toBeUndefined();
  });
});
