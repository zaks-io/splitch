import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "#lib/session";
import { MemoryKv, sessionPrincipal } from "#lib/session-test-harness";

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

vi.stubGlobal(
  "fetch",
  vi.fn(async () => new Response(null, { status: 204 })),
);

const { Route } = await import("./claim.consent.$attemptId");

const CONSENT_URL = "https://app.splitch.dev/claim/consent/ccons_123";
const SAME_ORIGIN = "https://app.splitch.dev";

// biome-ignore lint/suspicious/noExplicitAny: TanStack handler map is framework-typed
const handlers = (Route.options as any).server.handlers;

async function signIn(): Promise<string> {
  const created = await createSession(kv.namespace(), {
    ...sessionPrincipal(),
    workosAccessToken: "workos-jwt",
  });
  return created.cookie.split(";")[0] ?? "";
}

function postConsent(
  headers: Record<string, string>,
  body = "decision=approve",
): Promise<Response> {
  return handlers.POST({
    params: { attemptId: "ccons_123" },
    request: new Request(CONSENT_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    }),
  });
}

describe("/claim/consent rejects cross-origin form POSTs before Auth API", () => {
  beforeEach(() => {
    kv.store.clear();
    vi.mocked(fetch).mockClear();
  });

  it.each([
    ["cross-site evil Origin", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    [
      "same-site sibling Origin",
      { origin: "https://auth.splitch.dev", "sec-fetch-site": "same-site" },
    ],
    ["missing Origin", {}],
  ])("returns 403 for %s without forwarding", async (_name, headers) => {
    const cookie = await signIn();

    const response = await postConsent({ cookie, ...headers });

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards a same-origin approve POST", async () => {
    const cookie = await signIn();

    const response = await postConsent({ cookie, origin: SAME_ORIGIN });

    expect(response.status).toBe(204);
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.splitch.dev/claim/consent/ccons_123",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer workos-jwt" }),
      }),
    );
  });
});
