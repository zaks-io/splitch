import { describe, expect, it } from "vitest";
import {
  applyResponseHeaders,
  WORKER_BASELINE_SECURITY_HEADERS,
  wrapWorkerHandler,
} from "./security-headers";
import {
  cspAllowsFraming,
  cspHasDuplicateFrameAncestors,
  expectBaseline,
} from "./security-headers-test-support";

describe("applyResponseHeaders CSP duplicate normalization", () => {
  it("drops a later weaker frame-ancestors when extras are the only CSP", () => {
    const response = applyResponseHeaders(new Response("ok"), {
      "content-security-policy": "frame-ancestors 'none'; frame-ancestors https:",
    });

    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(
      cspHasDuplicateFrameAncestors(response.headers.get("content-security-policy") ?? ""),
    ).toBe(false);
    expect(cspAllowsFraming(response.headers.get("content-security-policy") ?? "")).toBe(false);
  });

  it("upgrades a first weaker frame-ancestors when a later deny is in the same policy", () => {
    const response = applyResponseHeaders(new Response("ok"), {
      "content-security-policy":
        "default-src 'self'; frame-ancestors https:; frame-ancestors 'none'",
    });

    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
    expect(
      cspHasDuplicateFrameAncestors(response.headers.get("content-security-policy") ?? ""),
    ).toBe(false);
    expect(cspAllowsFraming(response.headers.get("content-security-policy") ?? "")).toBe(false);
  });

  it("normalizes duplicate frame-ancestors even when extras do not include CSP", () => {
    const response = applyResponseHeaders(
      new Response("ok", {
        headers: {
          "content-security-policy": "frame-ancestors 'none'; frame-ancestors https:",
        },
      }),
      { ...WORKER_BASELINE_SECURITY_HEADERS },
    );

    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expectBaseline(response);
    expect(
      cspHasDuplicateFrameAncestors(response.headers.get("content-security-policy") ?? ""),
    ).toBe(false);
  });
});

describe("wrapWorkerHandler", () => {
  it("stamps the Worker baseline on success and error fetch responses", async () => {
    const wrapped = wrapWorkerHandler({
      fetch: async (request) =>
        request.url.endsWith("/boom")
          ? new Response("fault", { status: 500 })
          : Response.json({ ok: true }),
    });

    const success = await wrapped.fetch(
      new Request("https://worker.test/ok"),
      {},
      {} as ExecutionContext,
    );
    const error = await wrapped.fetch(
      new Request("https://worker.test/boom"),
      {},
      {} as ExecutionContext,
    );

    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ ok: true });
    expectBaseline(success);
    expect(error.status).toBe(500);
    expect(await error.text()).toBe("fault");
    expectBaseline(error);
  });

  it("does not overwrite CORS or redirect protocol headers", async () => {
    const wrapped = wrapWorkerHandler({
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://auth.splitch.dev/login",
            "access-control-allow-origin": "*",
          },
        }),
    });

    const response = await wrapped.fetch(
      new Request("https://worker.test/redirect"),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://auth.splitch.dev/login");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expectBaseline(response);
  });
});
