import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPanelBindings } from "#lib/shared/bindings";
import {
  CLAIM_CONSENT_MAX_BODY_BYTES,
  consentLoginRedirect,
  forwardClaimConsent,
  renderConsentPage,
} from "#lib/claims/claim-consent";
import { createSession } from "#lib/sessions/session";

const SAME_ORIGIN = "https://app.splitch.dev";

afterEach(() => vi.unstubAllGlobals());

describe("claim consent browser ceremony", () => {
  it("returns an AuthKit login redirect that returns to the opaque consent URL", () => {
    const response = consentLoginRedirect(
      new Request("https://app.splitch.dev/claim/consent/ccons_123?x=1"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/auth/login?returnTo=%2Fclaim%2Fconsent%2Fccons_123%3Fx%3D1",
    );
  });

  it("renders authenticated approve and refusal POST controls with escaped attempt ids", async () => {
    const response = renderConsentPage('ccons_123"><script>');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<title>Approve account linking · splitch</title>");
    expect(body).toContain('method="post"');
    expect(body).toContain('name="decision" value="approve"');
    expect(body).toContain('name="decision" value="deny"');
    expect(body).not.toContain("<script>");
  });

  it("forwards the browser's refusal decision with the server-only WorkOS access token", async () => {
    const kv = new MemoryKv();
    const session = await createSession(
      kv.namespace(),
      { userId: "user_existing", orgs: [], workosAccessToken: "workos-jwt" },
      Date.now(),
    );
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await forwardClaimConsent(
      bindings(kv.namespace()),
      new Request("https://app.splitch.dev/claim/consent/ccons_123", {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: SAME_ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "decision=deny",
      }),
      "ccons_123",
    );

    expect(response.status).toBe(204);
    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.splitch.dev/claim/consent/ccons_123",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer workos-jwt" }),
        body: JSON.stringify({ decision: "deny" }),
      }),
    );
  });

  it("rejects a missing decision without calling Auth API", async () => {
    const kv = new MemoryKv();
    const session = await createSession(
      kv.namespace(),
      { userId: "user_existing", orgs: [], workosAccessToken: "workos-jwt" },
      Date.now(),
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await forwardClaimConsent(
      bindings(kv.namespace()),
      new Request("https://app.splitch.dev/claim/consent/ccons_123", {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: SAME_ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
        },
      }),
      "ccons_123",
    );

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin POST before reading the session", async () => {
    const { request, fetcher } = await consentRequest({
      origin: "https://evil.example",
      headers: { "sec-fetch-site": "cross-site" },
    });
    const response = await request();

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("claim consent input bounds", () => {
  it("rejects an oversized consent body before buffering or calling Auth API", async () => {
    const kv = new MemoryKv();
    const session = await createSession(
      kv.namespace(),
      { userId: "user_existing", orgs: [], workosAccessToken: "workos-jwt" },
      Date.now(),
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await forwardClaimConsent(
      bindings(kv.namespace()),
      new Request("https://app.splitch.dev/claim/consent/ccons_123", {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: SAME_ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(CLAIM_CONSENT_MAX_BODY_BYTES + 1),
        },
        body: "decision=approve",
      }),
      "ccons_123",
    );

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a bounded multipart consent form", async () => {
    const kv = new MemoryKv();
    const session = await createSession(
      kv.namespace(),
      { userId: "user_existing", orgs: [], workosAccessToken: "workos-jwt" },
      Date.now(),
    );
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await forwardClaimConsent(
      bindings(kv.namespace()),
      new Request("https://app.splitch.dev/claim/consent/ccons_123", {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: SAME_ORIGIN,
          "content-type": "multipart/form-data; boundary=test",
        },
        body: '--test\r\nContent-Disposition: form-data; name="decision"\r\n\r\napprove\r\n--test--\r\n',
      }),
      "ccons_123",
    );

    expect(response.status).toBe(204);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects an unsupported body with the existing 400 contract", async () => {
    const { request, fetcher } = await consentRequest({
      headers: { "content-type": "application/json" },
      body: '{"decision":"approve"}',
    });
    const response = await request();

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels a chunked body as soon as it crosses the byte cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CLAIM_CONSENT_MAX_BODY_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { request, fetcher } = await consentRequest({ body });
    const response = await request();

    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

async function consentRequest(options: {
  origin?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
}) {
  const kv = new MemoryKv();
  const session = await createSession(
    kv.namespace(),
    { userId: "user_existing", orgs: [], workosAccessToken: "workos-jwt" },
    Date.now(),
  );
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    request: () =>
      forwardClaimConsent(
        bindings(kv.namespace()),
        new Request("https://app.splitch.dev/claim/consent/ccons_123", {
          method: "POST",
          headers: {
            cookie: session.cookie,
            origin: options.origin ?? SAME_ORIGIN,
            "content-type": "application/x-www-form-urlencoded",
            ...options.headers,
          },
          body: options.body ?? "decision=approve",
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
        "ccons_123",
      ),
  };
}

function bindings(sessionStore: KVNamespace): ControlPanelBindings {
  return {
    DB: {} as D1Database,
    SESSION_STORE: sessionStore,
    WORKOS_API_KEY: "workos-api-key",
    WORKOS_CLIENT_ID: "client_123",
    AUTH_API_ORIGIN: "https://auth.splitch.dev",
    EVALUATION_API_ORIGIN: "https://edge.splitch.dev",
  };
}

class MemoryKv {
  readonly store = new Map<string, string>();

  namespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
