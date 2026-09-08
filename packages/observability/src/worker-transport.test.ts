import { describe, expect, it, vi } from "vitest";
import { wrapWorkerHandler } from "./worker.js";

type WorkerFetchRequest = Parameters<NonNullable<ExportedHandler["fetch"]>>[0];

function workerFetchRequest(url: string, init?: RequestInit): WorkerFetchRequest {
  return new Request(url, init) as WorkerFetchRequest;
}

describe("hosted Worker transport policy", () => {
  it("redirects production HTTP before the handler can inspect credentials or the body", async () => {
    const innerFetch = vi.fn(async () => new Response("must not run"));
    const wrapped = wrapWorkerHandler({ fetch: innerFetch }, { surface: "auth-api" });

    const response = await wrapped.fetch(
      workerFetchRequest("http://auth.splitch.dev/oauth/token?source=test", {
        method: "POST",
        headers: {
          authorization: "Bearer must-not-be-read",
          "content-type": "application/json",
        },
        body: '{"secret":"must-not-be-read"}',
      }),
      { SPLITCH_PLATFORM_TARGET: "production" },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://auth.splitch.dev/oauth/token?source=test",
    );
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(innerFetch).not.toHaveBeenCalled();
  });

  it("adds host-scoped HSTS to production HTTPS responses", async () => {
    const wrapped = wrapWorkerHandler(
      { fetch: async () => new Response("ok") },
      { surface: "control-plane-api" },
    );

    const response = await wrapped.fetch(
      workerFetchRequest("https://api.splitch.dev/health"),
      { SPLITCH_PLATFORM_TARGET: "production" },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it.each(["http://localhost/", "http://127.0.0.1:8794/", "http://[::1]:8794/"])(
    "preserves a loopback prerender request in a production build at %s",
    async (url) => {
      const innerFetch = vi.fn(async () => new Response("prerendered"));
      const wrapped = wrapWorkerHandler({ fetch: innerFetch }, { surface: "marketing" });

      const response = await wrapped.fetch(
        workerFetchRequest(url),
        { SPLITCH_PLATFORM_TARGET: "production" },
        {} as ExecutionContext,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("strict-transport-security")).toBeNull();
      expect(innerFetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["local", "http://localhost:8787/health"],
    ["shared-preview", "http://api.preview.splitch.dev/health"],
  ])("preserves %s HTTP behavior without HSTS", async (platformTarget, url) => {
    const innerFetch = vi.fn(async () => new Response("ok"));
    const wrapped = wrapWorkerHandler({ fetch: innerFetch }, { surface: "control-plane-api" });

    const response = await wrapped.fetch(
      workerFetchRequest(url),
      { SPLITCH_PLATFORM_TARGET: platformTarget },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(innerFetch).toHaveBeenCalledOnce();
  });
});
