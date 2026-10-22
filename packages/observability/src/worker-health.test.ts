import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSentry } from "./sentry-module.js";
import { wrapWorkerHandler } from "./worker.js";

vi.mock("./sentry-module.js", () => ({ loadSentry: vi.fn() }));

const env = { SENTRY_DSN: "https://example@sentry.io/1", SPLITCH_PLATFORM_TARGET: "production" };
const ctx = {} as ExecutionContext;
const request = (path: string, method = "GET", protocol = "https") =>
  new Request(`${protocol}://worker.test${path}`, { method }) as never;

beforeEach(() => vi.resetAllMocks());

describe("Worker health fast path", () => {
  it("answers GET and HEAD before Sentry or the inner handler, with matching headers", async () => {
    const fetch = vi.fn();
    const respond = vi.fn(() =>
      Response.json({ ok: true }, { status: 202, headers: { "x-health": "ready" } }),
    );
    const worker = wrapWorkerHandler(
      { fetch },
      { surface: "auth-api", health: { paths: ["/health", "/"], respond } },
    );
    const get = await worker.fetch(request("/health?probe=1"), env, ctx);
    const head = await worker.fetch(request("/health", "HEAD"), env, ctx);
    expect(head.body).toBeNull();
    expect(head.status).toBe(get.status);
    expect([...head.headers]).toEqual([...get.headers]);
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(await get.json()).toEqual({ ok: true });
    expect(respond).toHaveBeenCalledWith(env);
    expect(loadSentry).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect((await worker.fetch(request("/"), env, ctx)).status).toBe(202);
  });

  it.each(["GET", "HEAD"])("redirects production HTTP %s before health", async (method) => {
    const respond = vi.fn();
    const worker = wrapWorkerHandler(
      { fetch: vi.fn() },
      { surface: "evaluation-api", health: { paths: ["/health"], respond } },
    );
    const setAttribute = vi.fn();
    const response = await worker.fetch(request("/health", method, "http"), env, {
      tracing: { getActiveSpan: () => ({ setAttribute }) },
    } as unknown as ExecutionContext);
    expect(setAttribute).toHaveBeenCalledWith("sentry.op", "function.cloudflare.invocation");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://worker.test/health");
    expect(respond).not.toHaveBeenCalled();
    expect(loadSentry).not.toHaveBeenCalled();
  });

  it.each([
    ["/other", "GET"],
    ["/health", "POST"],
    ["/health/", "GET"],
  ])("keeps %s %s in Sentry", async (path, method) => {
    const fetch = vi.fn(async () => new Response("inner"));
    const withSentry = vi.fn((_options, handler) => handler);
    vi.mocked(loadSentry).mockResolvedValue({ withSentry } as never);
    const respond = vi.fn();
    const worker = wrapWorkerHandler(
      { fetch },
      { surface: "marketing", health: { paths: ["/health"], respond } },
    );
    expect(await (await worker.fetch(request(path, method), env, ctx)).text()).toBe("inner");
    expect(loadSentry).toHaveBeenCalledOnce();
    expect(withSentry).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
  });
});
