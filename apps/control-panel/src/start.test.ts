import { csrfSymbol } from "@tanstack/react-start";
import { describe, expect, it } from "vitest";
import { panelServerFnCsrfMiddleware, startInstance } from "./start";

type CsrfMiddleware = typeof panelServerFnCsrfMiddleware;

/**
 * Server-fn CSRF must be pinned by behaviour, not by the accidental absence of
 * `src/start.ts`. Adding start.ts without createCsrfMiddleware in
 * requestMiddleware silently drops Origin checks on every panel write.
 *
 * The cross-site 403 below is driven through whatever middleware is actually
 * installed on `startInstance` — displacing CSRF from requestMiddleware makes
 * this red, not only a file-existence check.
 */
async function installedCsrfMiddleware(): Promise<CsrfMiddleware> {
  const options = await startInstance.getOptions();
  const middlewares = options.requestMiddleware ?? [];
  const installed = middlewares.find((middleware) => csrfSymbol in middleware) as
    | CsrfMiddleware
    | undefined;
  expect(installed, "CSRF middleware missing from startInstance.requestMiddleware").toBeTruthy();
  if (!installed) throw new Error("CSRF middleware missing from startInstance.requestMiddleware");
  return installed;
}

/** Framework middleware ctx is wider than we need for a CSRF probe. */
async function runServerFnCsrf(
  request: Request,
): Promise<{ result: unknown; nextCalled: boolean }> {
  const installed = await installedCsrfMiddleware();
  const server = installed.options.server;
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

describe("panel server-fn CSRF middleware", () => {
  it("installs the CSRF middleware on the start instance requestMiddleware", async () => {
    const options = await startInstance.getOptions();
    const middlewares = options.requestMiddleware ?? [];

    expect(middlewares).toContain(panelServerFnCsrfMiddleware);
    expect(middlewares.some((middleware) => csrfSymbol in middleware)).toBe(true);
  });

  it("rejects a cross-site serverFn POST with 403 via the installed middleware", async () => {
    const { result, nextCalled } = await runServerFnCsrf(
      new Request("https://app.splitch.dev/_server/fn", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    );

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
