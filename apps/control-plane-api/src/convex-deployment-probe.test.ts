import { afterEach, describe, expect, it, vi } from "vitest";
import { probeConvexDeployment } from "./convex-deployment-probe";

const CALLBACK = "https://happy-mole-123.convex.site/splitch/configuration";
afterEach(() => vi.useRealTimers());

describe("Convex deployment probe", () => {
  it.each([
    [404, { "convex-usher": "usher" }, "deleted"],
    [200, {}, "live"],
    [404, {}, "inconclusive"],
    [500, { "convex-usher": "usher" }, "inconclusive"],
    [302, { location: "https://other.convex.cloud/version" }, "inconclusive"],
  ] as const)("classifies HTTP %s with headers %j as %s", async (status, headers, expected) => {
    const fetcher = vi.fn(async () => new Response(null, { status, headers }));
    expect(await probeConvexDeployment(CALLBACK, fetcher)).toBe(expected);
    expect(fetcher).toHaveBeenCalledWith("https://happy-mole-123.convex.cloud/version", {
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    "https://example.com/configuration",
    "https://convex.site/configuration",
    "https://nested.name.convex.site/configuration",
    "http://happy-mole-123.convex.site/configuration",
    "https://user:password@happy-mole-123.convex.site/configuration",
    "https://happy-mole-123.convex.site:8080/configuration",
    "invalid",
  ])("refuses %s without sending a request", async (callback) => {
    const fetcher = vi.fn();
    expect(await probeConvexDeployment(callback, fetcher)).toBe("inconclusive");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves network errors inconclusive", async () => {
    expect(
      await probeConvexDeployment(CALLBACK, async () => {
        throw new Error("network");
      }),
    ).toBe("inconclusive");
  });

  it("aborts the probe after five seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBe(timeout.mock.results[0]?.value);
      throw new DOMException("Timed out", "TimeoutError");
    });
    expect(await probeConvexDeployment(CALLBACK, fetcher)).toBe("inconclusive");
    expect(timeout).toHaveBeenCalledWith(5_000);
    timeout.mockRestore();
  });
});
