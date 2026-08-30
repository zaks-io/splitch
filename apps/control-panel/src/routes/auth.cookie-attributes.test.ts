import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "#lib/sessions/session-test-harness";

/**
 * Cookie attributes must appear on the Worker response Set-Cookie header, not
 * only on library return values. Deleting headers.append in auth.login /
 * auth.callback must turn these red (SPL-263 B5).
 */

const kv = new MemoryKv();

vi.mock("cloudflare:workers", () => ({
  env: {
    DB: {},
    SESSION_STORE: kv,
    WORKOS_API_KEY: "sk_test",
    WORKOS_CLIENT_ID: "client_test",
    AUTH_API_ORIGIN: "https://auth.splitch.dev",
    EVALUATION_API_ORIGIN: "https://edge.splitch.dev",
  },
}));

vi.mock("#lib/auth/authkit", async () => {
  const actual = await vi.importActual<typeof import("#lib/auth/authkit")>("#lib/auth/authkit");
  return {
    ...actual,
    createAuthKitClient: () => ({
      getAuthorizationUrl: () => "https://workos.example/authorize?state=x",
      getLogoutUrl: () => "https://workos.example/logout",
      authenticateWithCode: async () => {
        throw new Error("not used in login cookie test");
      },
    }),
  };
});

const { Route: LoginRoute } = await import("./auth.login");
const { Route: CallbackRoute } = await import("./auth.callback");

// biome-ignore lint/suspicious/noExplicitAny: TanStack handler map is framework-typed
const loginHandlers = (LoginRoute.options as any).server.handlers;
// biome-ignore lint/suspicious/noExplicitAny: TanStack handler map is framework-typed
const callbackHandlers = (CallbackRoute.options as any).server.handlers;

function assertProtectiveSetCookie(header: string | null, cookieName: string): void {
  expect(header, `${cookieName}: Set-Cookie header must be present`).toBeTruthy();
  const cookie = header ?? "";
  expect(cookie, `${cookieName}: must be HttpOnly`).toContain("HttpOnly");
  expect(cookie, `${cookieName}: must be Secure`).toContain("Secure");
  expect(cookie, `${cookieName}: must be SameSite=Lax`).toContain("SameSite=Lax");
  expect(cookie, `${cookieName}: must include Path=/`).toContain("Path=/");
  expect(cookie, `${cookieName}: must set Max-Age`).toMatch(/Max-Age=\d+/);
  expect(cookie, `${cookieName}: must not set Domain`).not.toMatch(/Domain=/i);
}

describe("auth routes set protective cookies on the response", () => {
  beforeEach(() => {
    kv.store.clear();
  });

  it("auth/login sets __session_state with protective attributes", async () => {
    const response = await loginHandlers.GET({
      request: new Request("https://app.splitch.dev/auth/login"),
    });

    expect(response.status).toBe(302);
    const setCookie = response.headers.get("set-cookie");
    assertProtectiveSetCookie(setCookie, "__session_state");
    expect(setCookie).toContain("__session_state=");
  });

  it("auth/callback clears __session_state with protective attributes on failure", async () => {
    const response = await callbackHandlers.GET({
      request: new Request("https://app.splitch.dev/auth/callback"),
    });

    expect(response.status).toBe(401);
    const setCookie = response.headers.get("set-cookie");
    assertProtectiveSetCookie(setCookie, "__session_state");
    expect(setCookie).toContain("__session_state=");
  });
});
