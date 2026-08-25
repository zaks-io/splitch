import { describe, expect, it, vi } from "vitest";
import { panelServerFnCsrfMiddleware, startInstance } from "./start";

vi.mock("@sentry/react", () => ({
  startSpan: () => {
    throw new Error("browser tracing must not run during SSR");
  },
}));

type CsrfMiddleware = typeof panelServerFnCsrfMiddleware;

const FORGED_CROSS_SITE = new Request("https://app.splitch.dev/_server/fn", {
  method: "POST",
  headers: {
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  },
});

/**
 * Server-fn CSRF must be pinned by behaviour, not by the accidental absence of
 * `src/start.ts`. Adding start.ts without createCsrfMiddleware in
 * requestMiddleware silently drops Origin checks on every panel write.
 *
 * Locate the middleware by behaviour (refuses a forged cross-site POST), not by
 * `csrfSymbol` — that marker is only attached when `NODE_ENV !== "production"`.
 * Displacing CSRF from requestMiddleware makes the cross-site 403 red.
 */
async function invokeMiddlewareServer(
  middleware: CsrfMiddleware,
  request: Request,
): Promise<{ result: unknown; nextCalled: boolean }> {
  const server = middleware.options.server;
  if (!server) throw new Error("expected CSRF middleware server handler");

  let nextCalled = false;
  // biome-ignore lint/suspicious/noExplicitAny: CSRF probe only needs request + handlerType
  const result = await (server as any)({
    request,
    handlerType: "serverFn",
    context: {},
    next: async () => {
      nextCalled = true;
      return { context: { ok: true } };
    },
  });
  return { result, nextCalled };
}

async function installedCsrfMiddleware(): Promise<CsrfMiddleware> {
  const options = await startInstance.getOptions();
  const middlewares = options.requestMiddleware ?? [];

  for (const middleware of middlewares) {
    const candidate = middleware as CsrfMiddleware;
    if (!candidate.options?.server) continue;
    const { result, nextCalled } = await invokeMiddlewareServer(candidate, FORGED_CROSS_SITE);
    if (result instanceof Response && result.status === 403 && !nextCalled) {
      return candidate;
    }
  }

  throw new Error(
    "No requestMiddleware entry refuses a forged cross-site serverFn POST with 403 (CSRF missing or displaced)",
  );
}

async function runServerFnCsrf(
  request: Request,
): Promise<{ result: unknown; nextCalled: boolean }> {
  return invokeMiddlewareServer(await installedCsrfMiddleware(), request);
}

describe("panel server-fn CSRF middleware", () => {
  it("installs CSRF middleware that refuses forged cross-site serverFn POSTs", async () => {
    const options = await startInstance.getOptions();
    const middlewares = options.requestMiddleware ?? [];

    expect(middlewares).toContain(panelServerFnCsrfMiddleware);
    const installed = await installedCsrfMiddleware();
    expect(installed).toBe(panelServerFnCsrfMiddleware);
  });

  it("rejects a cross-site serverFn POST with 403 via the installed middleware", async () => {
    const { result, nextCalled } = await runServerFnCsrf(FORGED_CROSS_SITE);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it("rejects a same-site sibling Origin on a serverFn POST via the installed middleware", async () => {
    const { result, nextCalled } = await runServerFnCsrf(
      new Request("https://app.splitch.dev/_server/fn", {
        method: "POST",
        headers: {
          origin: "https://auth.splitch.dev",
          "sec-fetch-site": "same-site",
        },
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it("rejects a serverFn POST with no Sec-Fetch-Site, Origin, or Referer (403)", async () => {
    // Pins allowRequestsWithoutOriginCheck unset/false — that option would allow this.
    const { result, nextCalled } = await runServerFnCsrf(
      new Request("https://app.splitch.dev/_server/fn", { method: "POST" }),
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it("allows a same-origin serverFn POST through the installed middleware", async () => {
    const { result, nextCalled } = await runServerFnCsrf(
      new Request("https://app.splitch.dev/_server/fn", {
        method: "POST",
        headers: {
          origin: "https://app.splitch.dev",
          "sec-fetch-site": "same-origin",
        },
      }),
    );

    expect(nextCalled).toBe(true);
    expect(result).toEqual({ context: { ok: true } });
  });
});

describe("panel server-function tracing middleware", () => {
  it("is installed globally alongside CSRF", async () => {
    const options = await startInstance.getOptions();

    expect(options.functionMiddleware).toHaveLength(1);
    expect(options.requestMiddleware).toContain(panelServerFnCsrfMiddleware);
  });

  it("does not create a browser span while rendering on the server", async () => {
    const options = await startInstance.getOptions();
    const client = options.functionMiddleware?.[0]?.options.client;
    if (!client) throw new Error("expected function tracing client middleware");

    const expected = { context: { rendered: true } };
    // biome-ignore lint/suspicious/noExplicitAny: the SSR probe only needs method + next
    const result = await (client as any)({
      method: "GET",
      next: async () => expected,
    });

    expect(result).toBe(expected);
  });
});
