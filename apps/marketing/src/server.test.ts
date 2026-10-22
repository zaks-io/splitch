import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homepageLinkHeader } from "./agent-discovery";
import worker from "./server";

const { startFetch } = vi.hoisted(() => ({ startFetch: vi.fn() }));
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: startFetch } }));
beforeEach(() => vi.stubEnv("DEV", false));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const ctx = {} as ExecutionContext;

describe("marketing Worker", () => {
  it.each(["GET", "HEAD"])(
    "serves HTML homepage %s from assets with discovery and negotiation headers",
    async (method) => {
      const assetsFetch = vi.fn(
        async () =>
          new Response(method === "HEAD" ? null : "prerendered homepage", {
            headers: { "content-type": "text/html; charset=utf-8", vary: "Accept-Encoding" },
          }),
      );
      const request = new Request("https://splitch.dev/", {
        method,
        headers: { accept: "text/html" },
      });
      const response = await worker.fetch(
        request as never,
        { ASSETS: { fetch: assetsFetch } as unknown as Fetcher },
        ctx,
      );
      expect(assetsFetch).toHaveBeenCalledWith(request);
      expect(startFetch).not.toHaveBeenCalled();
      expect(response.headers.get("link")).toBe(homepageLinkHeader);
      expect(response.headers.get("vary")).toBe("Accept-Encoding, Accept");
      expect(await response.text()).toBe(method === "HEAD" ? "" : "prerendered homepage");
    },
  );

  it("renders through Start during development before the build has produced index.html", async () => {
    vi.stubEnv("DEV", true);
    startFetch.mockResolvedValueOnce(
      new Response("dev homepage", { headers: { "content-type": "text/html" } }),
    );
    const assetsFetch = vi.fn();
    const response = await worker.fetch(
      new Request("https://splitch.dev/") as never,
      { ASSETS: { fetch: assetsFetch } as unknown as Fetcher },
      ctx,
    );
    expect(await response.text()).toBe("dev homepage");
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("still negotiates the homepage to markdown before assets", async () => {
    const assetsFetch = vi.fn();
    const response = await worker.fetch(
      new Request("https://splitch.dev/", {
        headers: { accept: "text/markdown" },
      }) as never,
      { ASSETS: { fetch: assetsFetch } as unknown as Fetcher },
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("link")).toBe(homepageLinkHeader);
    expect(await response.text()).toContain("splitch");
    expect(assetsFetch).not.toHaveBeenCalled();
    expect(startFetch).not.toHaveBeenCalled();
  });

  it("answers health outside Start and assets, preserving deployment evidence", async () => {
    const assetsFetch = vi.fn();
    const response = await worker.fetch(
      new Request("https://splitch.dev/health") as never,
      {
        ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
        SENTRY_DSN: "https://example@sentry.io/1",
        SPLITCH_PLATFORM_TARGET: "production",
        SPLITCH_DEPLOYED_COMMIT_SHA: "a".repeat(40),
      },
      ctx,
    );
    expect(await response.json()).toEqual({
      ok: true,
      service: "splitch-marketing",
      platformTarget: "production",
      deployedCommitSha: "a".repeat(40),
    });
    expect(startFetch).not.toHaveBeenCalled();
    expect(assetsFetch).not.toHaveBeenCalled();
  });
});
